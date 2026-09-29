package io.github.teranovell.anqi.archive

import com.google.gson.GsonBuilder

internal data class ArchiveManifest(
    val timestamp: String,
    val hash: String,
    val corruptedFiles: Set<String>,
    val inaccessiblePaths: Set<String>
) {
    fun toJson(): String = GSON.toJson(this)

    private companion object {
        val GSON = GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create()
    }
}
