package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.PosixPath
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry
import org.apache.commons.compress.archivers.zip.ZipFile
import org.apache.commons.compress.utils.SeekableInMemoryByteChannel
import org.junit.jupiter.api.Assertions.assertTimeoutPreemptively
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import kotlin.io.path.*
import kotlin.test.*

class ArchiveWriterTest {
    @TempDir
    lateinit var root: Path

    private data class Archived(val entry: ZipArchiveEntry, val content: String)

    private val prefix get() = PosixPath.toPosixPath(root.root.relativize(root).toString())

    // Writes the archive to a buffer and reads the entries back from it in the order they are stored, so tests assert
    // on what writeArchive actually produced instead of just that it did not throw.
    private fun archiveEntries(sources: List<String>): Map<String, Archived> {
        val destination = ByteArrayOutputStream()

        writeArchive(sources, destination)

        return ZipFile.builder().setSeekableByteChannel(SeekableInMemoryByteChannel(destination.toByteArray())).get()
            .use { zip ->
                zip.entriesInPhysicalOrder.asSequence().associate { entry ->
                    entry.name to Archived(entry, zip.getInputStream(entry).readAllBytes().decodeToString())
                }
            }
    }

    @Test
    fun `writeArchive creates an archive with the expected files and directories`() {
        root.resolve("a.txt").writeText("hello")
        root.resolve("sub").createDirectory()
        root.resolve("sub/b.txt").writeText("world")

        val entries = archiveEntries(listOf(root.toString()))

        assertEquals("hello", entries["$prefix/a.txt"]?.content, "a.txt should be in the archive")
        assertEquals(true, entries["$prefix/sub/"]?.entry?.isDirectory, "sub should be stored as a directory entry")
        assertEquals("world", entries["$prefix/sub/b.txt"]?.content, "b.txt should be in the archive")
    }

    @Test
    fun `writeArchive keeps a broken symlink instead of dropping it`() {
        val target = root.resolve("does-not-exist")
        root.resolve("broken-link").createSymbolicLinkPointingTo(target)

        val link = assertNotNull(archiveEntries(listOf(root.toString()))["$prefix/broken-link"])

        assertTrue(link.entry.isUnixSymlink, "the entry should be marked as a symlink")
        assertEquals(target.toString(), link.content)
    }

    @Test
    fun `writeArchive matches glob patterns and includes matched directories`() {
        root.resolve("docs/sub").createDirectories()
        root.resolve("docs/a.txt").writeText("a")
        root.resolve("docs/a.md").writeText("a")
        root.resolve("docs/sub/b.md").writeText("b")

        val entries = archiveEntries(listOf(PosixPath.toPosixPath(root.toString()) + "/docs/{*.txt,sub}"))

        assertEquals(setOf("$prefix/docs/a.txt", "$prefix/docs/sub/", "$prefix/docs/sub/b.md"), entries.keys)
    }

    // Extractors like unzip only restore the metadata of a directory (e.g. permissions and timestamps) if they create
    // it from its own directory entry in the zip. A directory that is implicitly created for a file entry that appears
    // before the directory's own entry would lose its metadata.
    @Test
    fun `writeArchive writes directories before their contents`() {
        root.resolve("top/sub/empty").createDirectories()
        root.resolve("top/a.txt").writeText("a")
        root.resolve("top/sub/b.txt").writeText("b")

        for (source in listOf(root.resolve("top").toString(), PosixPath.toPosixPath(root.toString()) + "/top/*")) {
            val names = archiveEntries(listOf(source)).keys.toList()
            val previousNames = mutableSetOf<String>()

            for (name in names) {
                // Checking the direct parent is enough: if every entry comes after its parent, it also comes after
                // all directories above it.
                val parent = name.removeSuffix("/").substringBeforeLast("/") + "/"

                if (parent in names) {
                    assertTrue(parent in previousNames, "$parent should come before $name (source: $source)")
                }

                previousNames += name
            }
        }
    }

    // ZIP64 adds records at the end of the archive, which are needed for files larger than 4 GB or more than 65535
    // entries. The reported size is compared with the actual size of the destination file after writing.
    @Test
    fun `writeArchive reports the size and hash of ZIP64 archives`() {
        repeat(65_536) { root.resolve("file-$it").createFile() }

        val destination = ByteArrayOutputStream()
        val archiveData = writeArchive(listOf(root.toString()), destination)

        val bytes = destination.toByteArray()
        assertEquals(bytes.size.toLong(), archiveData.size)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(bytes).toHexString(), archiveData.hash)
    }

    @Test
    fun `writeArchive rejects with the real error when the destination fails`() {
        root.resolve("a.txt").writeText("hello")

        val failing = object : OutputStream() {
            private var received = 0

            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

            override fun write(b: ByteArray, off: Int, len: Int) {
                received += len
                if (received > 100) throw IOException("SIMULATED DEST FAILURE")
            }
        }

        val error = assertTimeoutPreemptively<IOException>(Duration.ofSeconds(5)) {
            assertFailsWith<IOException> { writeArchive(listOf(root.toString()), failing) }
        }
        assertEquals("SIMULATED DEST FAILURE", error.message)
    }
}
