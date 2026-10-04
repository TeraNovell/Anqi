package io.github.teranovell.anqi.archive

interface ArchiveStatus {
    val incompleteFiles: Set<String>
    val inaccessiblePaths: Set<String>

    fun isComplete() = incompleteFiles.isEmpty() && inaccessiblePaths.isEmpty()
}
