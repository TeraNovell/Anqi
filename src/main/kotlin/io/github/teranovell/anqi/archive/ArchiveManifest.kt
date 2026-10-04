package io.github.teranovell.anqi.archive

import kotlinx.serialization.Serializable

@Serializable
internal data class ArchiveManifest(
    val timestamp: String,
    val hash: String,
    override val incompleteFiles: Set<String>,
    override val inaccessiblePaths: Set<String>
) : ArchiveStatus
