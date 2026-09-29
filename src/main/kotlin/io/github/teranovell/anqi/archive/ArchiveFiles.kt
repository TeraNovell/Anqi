package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.log.Logger
import java.time.LocalDateTime
import java.time.format.DateTimeParseException

internal object ArchiveFiles {
    const val EXT_CHECKSUM = ".sha256"
    const val EXT_PARTIAL = ".part"
    const val EXT_COMPLETE = ".zip"
    const val EXT_MANIFEST = ".json"

    fun findOldArchives(fileNames: Collection<String>, prefix: String, keep: Int): List<String> {
        if (keep <= 0) return emptyList()

        val archives = mutableListOf<String>()
        val partials = mutableListOf<String>()

        for (name in fileNames) {
            if (isArchiveFile(name, prefix, EXT_COMPLETE)) {
                archives += name
                Logger.logDebug("Found $name")
            } else if (isArchiveFile(name, prefix, EXT_PARTIAL)) {
                partials += name
            }
        }

        archives.sort()

        val staleArchives = archives.dropLast(keep)

        // Partial archives are leftovers of interrupted runs. They are removed once they are older than
        // the most recent complete archive, but they never count towards `keep`, so they can never
        // evict a complete one.
        val newestArchive = archives.lastOrNull() ?: return staleArchives
        return staleArchives + partials.filter { it < newestArchive }
    }

    fun isArchiveFile(name: String, prefix: String, extension: String): Boolean {
        val expectedPrefix = "$prefix-"

        if (!name.startsWith(expectedPrefix) || !name.endsWith(extension)) return false
        if (name.length < expectedPrefix.length + extension.length) return false

        val timestamp = name.substring(expectedPrefix.length, name.length - extension.length)

        return try {
            LocalDateTime.parse(timestamp, ArchiveDescription.TIMESTAMP_FORMAT)
            true
        } catch (_: DateTimeParseException) {
            false
        }
    }
}
