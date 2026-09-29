package io.github.teranovell.anqi.walk

import io.github.teranovell.anqi.log.Logger
import java.nio.file.FileVisitResult
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import kotlin.io.path.Path
import kotlin.io.path.visitFileTree

/**
 * Visits all sources and the contents of directories, one entry at a time, so the visitor always sees the current
 * state of the filesystem. Paths are visited only once, even when several sources contain them.
 *
 * Symlinks are not followed, so they (also broken ones and those pointing to directories) are reported as entries
 * themselves and the same contents are not archived twice.
 */
fun walk(sources: List<String>, exclude: (WalkEntry) -> Boolean, visitor: (WalkEntry) -> Unit): WalkResult {
    val walker = Walker(exclude, visitor)

    for (source in sources) {
        if (GlobPattern.isPattern(source)) {
            val glob = GlobPattern(source)
            walker.walkTree(
                glob.base,
                includeStart = false,
                filter = glob::matches,
                descend = glob::shouldDescend
            )
        } else {
            walker.walkTree(Path(source).toAbsolutePath().normalize(), includeStart = true)
        }
    }

    return WalkResult(walker.inaccessiblePaths)
}

private class Walker(private val exclude: (WalkEntry) -> Boolean, private val visitor: (WalkEntry) -> Unit) {
    private val seenPaths = mutableSetOf<Path>()
    val inaccessiblePaths = mutableSetOf<String>()

    fun walkTree(
        start: Path,
        includeStart: Boolean,
        filter: (Path) -> Boolean = { true },
        descend: (Path) -> Boolean = { true },
    ) {
        start.visitFileTree {
            onPreVisitDirectory { directory, attributes ->
                if (directory == start) {
                    if (includeStart) visit(directory, attributes)
                } else {
                    if (isExcluded(directory, attributes)) return@onPreVisitDirectory FileVisitResult.SKIP_SUBTREE
                    if (filter(directory)) visit(directory, attributes)
                    if (!descend(directory)) return@onPreVisitDirectory FileVisitResult.SKIP_SUBTREE
                }

                Logger.logDebug("Walking: $directory")
                FileVisitResult.CONTINUE
            }

            onVisitFile { file, attributes ->
                if (file == start) {
                    if (includeStart) visit(file, attributes)
                } else if (!isExcluded(file, attributes) && filter(file)) {
                    visit(file, attributes)
                }

                FileVisitResult.CONTINUE
            }

            onVisitFileFailed { file, e ->
                Logger.warnOrThrow(e, file)
                inaccessiblePaths.add(file.toString())
                FileVisitResult.CONTINUE
            }

            onPostVisitDirectory { directory, e ->
                // Set if the directory could not be read completely.
                if (e != null) Logger.warnOrThrow(e, directory)
                FileVisitResult.CONTINUE
            }
        }
    }

    private fun isExcluded(path: Path, attributes: BasicFileAttributes): Boolean {
        if (!exclude(WalkEntry(path, attributes))) return false

        Logger.logDebug("Excluding: $path")
        return true
    }

    private fun visit(path: Path, attributes: BasicFileAttributes) {
        if (seenPaths.add(path)) visitor(WalkEntry(path, attributes))
    }
}
