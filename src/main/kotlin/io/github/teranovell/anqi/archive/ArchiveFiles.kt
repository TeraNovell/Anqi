package io.github.teranovell.anqi.archive

import java.time.LocalDateTime
import java.time.format.DateTimeParseException

internal object ArchiveFiles {
    const val EXT_CHECKSUM = ".sha256"
    const val EXT_PARTIAL = ".part"
    const val EXT_COMPLETE = ".zip"
    const val EXT_MANIFEST = ".json"

    fun isArchiveFile(name: String?, prefix: String, extensions: Collection<String>): Boolean {
        val expectedPrefix = "$prefix-"
        val extension = extensions.firstOrNull { name?.endsWith(it) ?: false }

        if (name?.startsWith(expectedPrefix) != true || extension.isNullOrEmpty()) return false
        if (name.length < expectedPrefix.length + extension.length) return false

        val timestamp = name.substring(expectedPrefix.length, name.length - extension.length)

        return try {
            LocalDateTime.parse(timestamp, ArchiveDescription.TIMESTAMP_FORMAT)
            true
        } catch (_: DateTimeParseException) {
            false
        }
    }

    fun isArchiveFile(name: String?, prefix: String, extension: String) = isArchiveFile(name, prefix, listOf(extension))
}
