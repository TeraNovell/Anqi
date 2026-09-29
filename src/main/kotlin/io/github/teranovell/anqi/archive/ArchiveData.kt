package io.github.teranovell.anqi.archive

data class ArchiveData(
    val hash: String,
    val size: Long,
    val corruptedFiles: Set<String>,
    val inaccessiblePaths: Set<String>
)
