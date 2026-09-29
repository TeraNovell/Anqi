package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.PosixPaths
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import io.github.teranovell.anqi.walk.WalkEntry
import io.github.teranovell.anqi.walk.WalkResult
import io.github.teranovell.anqi.walk.walk
import org.apache.commons.compress.archivers.zip.UnixStat
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry
import org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream
import org.apache.commons.io.output.CountingOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.SeekableByteChannel
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption.READ
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.security.DigestOutputStream
import java.security.MessageDigest
import kotlin.io.path.readAttributes
import kotlin.io.path.readSymbolicLink

// Small enough for a single SFTP write request.
private const val BUFFER_SIZE = 32 * 1024

// Available on Linux and macOS. Windows has no unix modes, so a default is used there.
private val hasUnixView = "unix" in FileSystems.getDefault().supportedFileAttributeViews()
private val DEFAULT_PERMISSIONS = "666".toInt(8)

/**
 * Writes a ZIP archive of all sources to the destination and closes it. The archive is streamed, so the destination
 * does not need to be seekable.
 */
internal fun writeArchive(
    sources: List<String>,
    destination: OutputStream,
    exclude: (WalkEntry) -> Boolean = { false },
): ArchiveData {
    val digest = MessageDigest.getInstance("SHA-256")
    // The size is counted on the stream, since ZipArchiveOutputStream.getBytesWritten() misses the ZIP64 end of
    // central directory records.
    val counter = CountingOutputStream(DigestOutputStream(destination, digest))
    val zip = ZipArchiveOutputStream(counter.buffered(BUFFER_SIZE))
    val writer = ArchiveWriter(zip)

    var walkResult: WalkResult

    try {
        walkResult = walk(sources, exclude, writer::add)

        if (writer.entryCount <= 0) throw AnqiException(Message.ERR_NOTHING_ADDED.get())

        // Writes the central directory, flushes and closes the destination.
        zip.close()
    } catch (e: Exception) {
        // Closing the zip stream would write the central directory, so only the destination is closed.
        runCatching { destination.close() }.exceptionOrNull()?.let(e::addSuppressed)
        throw e
    }

    println(Message.INFO_ADDED_FILES.get("count" to writer.fileCount))

    return ArchiveData(
        digest.digest().toHexString(),
        counter.byteCount,
        writer.corruptedFiles,
        walkResult.inaccessiblePaths
    )
}

private class ArchiveWriter(private val zip: ZipArchiveOutputStream) {
    private data class Stat(val mode: Int, val lastModifiedTime: FileTime)

    val corruptedFiles = mutableSetOf<String>()

    var entryCount = 0
        private set

    var fileCount = 0
        private set

    fun add(entry: WalkEntry) {
        val path = entry.path

        try {
            val name = getName(path)

            when {
                // Always perform a fresh lstat immediately before writing a zip entry instead of reusing the attributes
                // collected during the crawl. This ensures that the header reflects the current filesystem state.
                entry.attributes.isDirectory -> {
                    zip.putArchiveEntry(newEntry("$name/", lstat(path)))
                    zip.closeArchiveEntry()

                    entryCount++

                    Logger.logDebug("Adding Directory: $path")
                }

                entry.attributes.isSymbolicLink -> {
                    val stat = lstat(path)
                    val target = path.readSymbolicLink().toString().toByteArray()

                    zip.putArchiveEntry(newEntry(name, stat).also { it.size = target.size.toLong() })
                    zip.write(target)
                    zip.closeArchiveEntry()

                    entryCount++
                }

                entry.attributes.isRegularFile -> {
                    // NOFOLLOW_LINKS makes the open fail if the file has been replaced by a symlink in the meantime.
                    Files.newByteChannel(path, setOf<OpenOption>(READ, NOFOLLOW_LINKS)).use { channel ->
                        // Java has no fstat, so the size comes from the opened channel and the rest from the path.
                        val size = channel.size()
                        val stat = lstat(path)

                        // The size is only a hint to decide whether ZIP64 is needed, the actual size is written
                        // after the content.
                        zip.putArchiveEntry(newEntry(name, stat).also { it.size = size })
                        readContent(path, channel, size, stat)
                        zip.closeArchiveEntry()
                    }

                    entryCount++
                    fileCount++

                    Logger.logDebug("Adding file: $path")
                }

                else -> Logger.logWarning(Message.WARN_UNABLE_TO_PROCESS_UNKNOWN_TYPE.get("path" to path))
            }
        } catch (e: IOException) {
            Logger.warnOrThrow(e, path)
        }
    }

    // Reads the file up to the size it had when it was opened so that a file that keeps growing cannot make the entry
    // endless. Since ZIP stores the size and checksum after the content, the archive stays valid even if the file
    // changes while being read.
    private fun readContent(path: Path, channel: SeekableByteChannel, size: Long, stat: Stat) {
        val buffer = ByteBuffer.allocate(BUFFER_SIZE)
        var remaining = size

        while (remaining > 0) {
            buffer.clear().limit(minOf(buffer.capacity().toLong(), remaining).toInt())

            val read = try {
                channel.read(buffer)
            } catch (_: IOException) {
                // The entry is kept with the content read so far, so the archive stays valid.
                Logger.logWarning(Message.WARN_FILE_READ_FAILED.get("path" to path))
                corruptedFiles += path.toString()
                return
            }

            if (read < 0) break

            // Errors of the destination are thrown from here and abort the archive.
            zip.write(buffer.array(), 0, read)
            remaining -= read
        }

        if (channel.size() != size || lstat(path).lastModifiedTime != stat.lastModifiedTime) {
            Logger.logWarning(Message.WARN_FILE_CHANGED_WHILE_ARCHIVING.get("path" to path))
            corruptedFiles += path.toString()
        }
    }

    private fun newEntry(name: String, stat: Stat) = ZipArchiveEntry(name).apply {
        unixMode = stat.mode
        lastModifiedTime = stat.lastModifiedTime
    }

    // Convert all paths to relative paths. This prevents absolute paths inside the archive from overwriting system
    // files. For example, a /etc/passwd entry in the archive could otherwise overwrite /etc/passwd on the target
    // system during extraction.
    private fun getName(path: Path) = PosixPaths.toPosixPath((path.root?.relativize(path) ?: path).toString())

    private fun lstat(path: Path): Stat {
        if (hasUnixView) {
            val attributes = Files.readAttributes(path, "unix:mode,lastModifiedTime", NOFOLLOW_LINKS)
            return Stat(attributes["mode"] as Int, attributes["lastModifiedTime"] as FileTime)
        }

        val attributes = path.readAttributes<BasicFileAttributes>(NOFOLLOW_LINKS)
        val type = when {
            attributes.isDirectory -> UnixStat.DIR_FLAG
            attributes.isSymbolicLink -> UnixStat.LINK_FLAG
            else -> UnixStat.FILE_FLAG
        }

        return Stat(type or DEFAULT_PERMISSIONS, attributes.lastModifiedTime())
    }
}
