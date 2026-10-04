package io.github.teranovell.anqi.archive

data class ArchiveData(
    val hash: String,
    val size: Long,
    override val incompleteFiles: Set<String>,
    override val inaccessiblePaths: Set<String>
) : ArchiveStatus
