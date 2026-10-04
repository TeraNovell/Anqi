package io.github.teranovell.anqi.walk

import io.github.teranovell.anqi.PosixPath
import java.nio.file.FileSystems
import java.nio.file.Path
import java.nio.file.PathMatcher
import kotlin.io.path.Path

/**
 * A glob pattern matched with the JDK's PathMatcher, which supports "*", "?", "[...]", "{a,b}" and "**".
 * The JDK requires a globstar segment (two asterisks) between separators to match at least one directory.
 */
internal class GlobPattern(source: String) {
    /**
     * The fixed directory prefix before the first wildcard. Nothing outside this directory can match,
     * so the walk starts here.
     */
    val base: Path

    private val matchers: List<PathMatcher>
    private val depth: Int
    private val hasGlobstar: Boolean

    init {
        val parts = PosixPath.toPosixPath(source).split("/")
        val fixed = parts.takeWhile { !isPattern(it) }
        val rest = parts.drop(fixed.size).joinToString("/")

        base = (if (fixed.isEmpty()) Path("") else Path(fixed.joinToString("/") + "/")).toAbsolutePath().normalize()

        val prefix = escape(PosixPath.toPosixPath(base.toString())).removeSuffix("/") + "/"
        val pattern = prefix + rest

        // If the pattern matches a directory, everything inside it should be backed up too, just like `--src <dir>`
        // would. For example the pattern "docs/*" matches the directory "docs/sub", so "docs/sub/file.txt" is included
        // as well.
        matchers = compile(pattern) + compile("$pattern/**")

        depth = rest.split("/").size
        hasGlobstar = "**" in rest
    }

    /** Whether the path matches the pattern or is inside a directory that matches it. */
    fun matches(path: Path) = matchers.any { it.matches(path) }

    /**
     * Whether the directory could contain matches. Without "**" a pattern only reaches as deep below the base as it
     * has segments, so the walker does not need to look any deeper, except for the contents of matched directories.
     */
    fun shouldDescend(directory: Path) =
        hasGlobstar || base.relativize(directory).nameCount < depth || matches(directory)

    companion object {
        private const val MAGIC_CHARACTERS = "*?[{"

        fun isPattern(source: String) = source.any { it in MAGIC_CHARACTERS }

        private fun compile(pattern: String) =
            withoutGlobstarDirectories(pattern).map { FileSystems.getDefault().getPathMatcher("glob:$it") }

        // Returns the pattern with every combination of its "/**/" kept or replaced by "/".
        private fun withoutGlobstarDirectories(pattern: String): List<String> {
            val index = pattern.indexOf("/**/")
            if (index < 0) return listOf(pattern)

            val head = pattern.substring(0, index)
            return withoutGlobstarDirectories(pattern.substring(index + 4)).flatMap { tail ->
                listOf("$head/**/$tail", "$head/$tail")
            }
        }

        // The base is a literal path, so characters with a special meaning in globs are escaped.
        private fun escape(location: String): String {
            if (PosixPath.IS_WINDOWS) return location

            return buildString(location.length) {
                for (character in location) {
                    if (character in "\\*?[]{}") append('\\')
                    append(character)
                }
            }
        }
    }
}
