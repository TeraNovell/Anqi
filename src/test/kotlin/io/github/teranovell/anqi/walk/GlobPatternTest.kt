package io.github.teranovell.anqi.walk

import kotlin.io.path.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GlobPatternTest {
    @Test
    fun `detects patterns`() {
        assertFalse(GlobPattern.isPattern("/docs/file.txt"))
        assertTrue(GlobPattern.isPattern("/docs/*.txt"))
        assertTrue(GlobPattern.isPattern("/docs/file?.txt"))
        assertTrue(GlobPattern.isPattern("/docs/[ab].txt"))
        assertTrue(GlobPattern.isPattern("/docs/{a,b}.txt"))
    }

    @Test
    fun `starts at the fixed part of the pattern`() {
        assertEquals(Path("/docs"), GlobPattern("/docs/*/*.txt").base)
        assertEquals(Path("/"), GlobPattern("/*.txt").base)
        assertEquals(Path("").toAbsolutePath().resolve("docs"), GlobPattern("docs/*.txt").base)
        assertEquals(Path("").toAbsolutePath(), GlobPattern("*.txt").base)
    }

    @Test
    fun `matches files and the contents of matched directories`() {
        val glob = GlobPattern("/docs/*")
        assertTrue(glob.matches(Path("/docs/a.txt")))
        assertTrue(glob.matches(Path("/docs/.hidden")))
        assertTrue(glob.matches(Path("/docs/sub/deep/b.txt")))
        assertFalse(glob.matches(Path("/other/a.txt")))

        assertTrue(GlobPattern("/docs/{a,b}.txt").matches(Path("/docs/b.txt")))
        assertFalse(GlobPattern("/docs/[!b]?.txt").matches(Path("/docs/b1.txt")))
    }

    @Test
    fun `matches globstar without directories`() {
        val glob = GlobPattern("/docs/**/*.txt")
        assertTrue(glob.matches(Path("/docs/a.txt")))
        assertTrue(glob.matches(Path("/docs/x/y/a.txt")))
        assertFalse(glob.matches(Path("/docs/a.md")))

        assertTrue(GlobPattern("/a/**/b/**/*.txt").matches(Path("/a/b/c.txt")))
    }

    @Test
    fun `descends only as deep as the pattern reaches`() {
        val glob = GlobPattern("/docs/*/*.txt")
        assertTrue(glob.shouldDescend(Path("/docs/x")))
        assertFalse(glob.shouldDescend(Path("/docs/x/y")))

        // Matched directories are backed up with all of their contents.
        assertTrue(GlobPattern("/docs/*").shouldDescend(Path("/docs/x/y/z")))
        assertTrue(GlobPattern("/docs/**/*.txt").shouldDescend(Path("/docs/x/y/z")))
    }
}
