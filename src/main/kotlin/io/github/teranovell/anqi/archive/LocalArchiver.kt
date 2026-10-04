package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import kotlin.io.path.*

class LocalArchiver(
    val sources: List<String>,
    destination: String,
    archive: ArchiveDescription,
    keep: Int
) : Archiver(destination, archive, keep) {

    override fun close() {}

    override fun readFile(path: String): String {
        return Path(path).readText()
    }

    override fun deleteFile(vararg paths: String) {
        paths.forEach {
            Path(it).deleteExisting()
        }
    }

    fun create(): ArchiveData {
        val directory = Path(destination)
        val partialPath = directory.resolve(archive.partialFilename)

        val archivePath = directory.resolve(archive.filename)
        val checksumPath = directory.resolve(archive.filename + ArchiveFiles.EXT_CHECKSUM)
        val manifestPath = directory.resolve(archive.filename + ArchiveFiles.EXT_MANIFEST)

        if (!directory.isDirectory()) {
            throw AnqiException(Message.ERR_NONE_EXIST_DESTINATION.get("path" to destination))
        }

        for (location in listOf(archivePath, partialPath, checksumPath, manifestPath)) {
            if (location.exists()) throw AnqiException(Message.ERR_DESTINATION_EXISTS.get("path" to location))
        }
        val output = partialPath.outputStream(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        val absDestination = directory.toAbsolutePath().normalize()

        val archiveData = try {
            val archiveData = writeArchive(sources, output) { entry ->
                // Exclude the created archive files to prevent them from being included in backups,
                // which could otherwise cause duplicates or recursive backup loops.
                val isArchive = listOf(
                    ArchiveFiles.EXT_COMPLETE,
                    ArchiveFiles.EXT_PARTIAL,
                    ArchiveFiles.EXT_COMPLETE + ArchiveFiles.EXT_CHECKSUM,
                    ArchiveFiles.EXT_COMPLETE + ArchiveFiles.EXT_MANIFEST,
                ).any { ArchiveFiles.isArchiveFile(entry.path.name, archive.prefix, it) }

                val parent = entry.path.parent
                isArchive && parent != null && (parent == absDestination || Files.isSameFile(parent, absDestination))
            }

            if (partialPath.fileSize() != archiveData.size) {
                throw AnqiException(Message.ERR_SIZE_MISMATCH.get("path" to partialPath))
            }

            checksumPath.writeText(
                getChecksumContent(archiveData),
                options = arrayOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
            )
            manifestPath.writeText(
                getManifestContent(archiveData),
                options = arrayOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
            )

            partialPath.moveTo(archivePath)

            Logger.logSuccess(
                Message.SUCCESS_ARCHIVE_CREATED.get(
                    "path" to archivePath,
                    "size" to Logger.formatBytes(archiveData.size)
                ),
            )

            archiveData
        } catch (e: Exception) {
            try {
                partialPath.deleteExisting()
            } catch (_: IOException) {
                Logger.logWarning(Message.WARN_DELETE_FAILED.get("path" to partialPath))
            }
            throw e
        }

        if (keep <= 0) return archiveData

        val archiveNames = directory
            .listDirectoryEntries()
            .filter {
                it.isRegularFile(LinkOption.NOFOLLOW_LINKS) && ArchiveFiles.isArchiveFile(
                    it.name,
                    archive.prefix,
                    ArchiveFiles.EXT_COMPLETE
                )
            }
            .map { it.name }
            .toSet()

        deleteStaleArchives(archiveNames, archiveData)

        return archiveData
    }
}
