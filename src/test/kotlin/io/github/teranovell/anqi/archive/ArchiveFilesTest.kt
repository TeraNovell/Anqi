package io.github.teranovell.anqi.archive

import kotlin.test.Test
import kotlin.test.assertEquals

class ArchiveFilesTest {
    @Test
    fun `findOldArchives returns the oldest archives beyond the retention count`() {
        val names = listOf("archive-20250103-000000.zip", "archive-20250101-000000.zip", "archive-20250102-000000.zip")
        assertEquals(
            listOf("archive-20250101-000000.zip", "archive-20250102-000000.zip"),
            ArchiveFiles.findOldArchives(names, "archive", 1),
        )
    }

    @Test
    fun `findOldArchives ignores files that do not match the configured prefix`() {
        val names = listOf(
            "archive-20250101-000000.zip",
            "archive-20250102-000000.zip",
            "other-20250102-000000.zip",
            "archive-20250101-000000.zip.sha256",
            "archive-test.zip",
        )
        assertEquals(listOf("archive-20250101-000000.zip"), ArchiveFiles.findOldArchives(names, "archive", 1))
    }

    @Test
    fun `findOldArchives deletes stale partial archives without counting them towards retention`() {
        val names = listOf(
            "archive-20250103-000000.zip",
            "archive-20250101-000000.zip",
            "archive-20250101-000000.part",
            "archive-20250102-000000.part",
            "archive-20250102-000000.zip",
        )
        assertEquals(
            listOf("archive-20250101-000000.zip", "archive-20250101-000000.part", "archive-20250102-000000.part"),
            ArchiveFiles.findOldArchives(names, "archive", 2),
        )
    }
}
