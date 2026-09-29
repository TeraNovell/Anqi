package io.github.teranovell.anqi.archive

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import kotlin.io.path.Path

data class ArchiveDescription(val prefix: String, val timestamp: String) {
    val name get() = "$prefix-$timestamp"
    val filename get() = name + ArchiveFiles.EXT_COMPLETE
    val partialFilename get() = name + ArchiveFiles.EXT_PARTIAL

    companion object {
        internal val TIMESTAMP_FORMAT: DateTimeFormatter =
            DateTimeFormatter.ofPattern("uuuuMMdd-HHmmss").withResolverStyle(ResolverStyle.STRICT)

        fun create(prefix: String): ArchiveDescription {
            val basename = Path(prefix).fileName?.toString().orEmpty().replace("\\", "")
            return ArchiveDescription(basename, LocalDateTime.now().format(TIMESTAMP_FORMAT))
        }
    }
}
