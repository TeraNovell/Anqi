package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.PosixPath
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import kotlinx.serialization.json.Json
import java.io.IOException
import kotlin.io.path.Path

abstract class Archiver(val destination: String, val archive: ArchiveDescription, val keep: Int) : AutoCloseable {
    abstract fun readFile(path: String): String
    abstract fun deleteFile(vararg paths: String)

    internal fun getChecksumContent(data: ArchiveData) =
        "${data.hash}  ${archive.filename}\n"

    internal fun getManifestContent(data: ArchiveData) =
        Json.encodeToString(
            ArchiveManifest(
                archive.timestamp,
                data.hash,
                data.incompleteFiles,
                data.inaccessiblePaths
            )
        )

    internal fun pathJoin(vararg parts: String, posix: Boolean = false) =
        if (posix) PosixPath.join(*parts) else Path(parts.first(), *parts.drop(1).toTypedArray()).toString()

    internal fun deleteStaleArchives(
        archiveNames: Set<String>,
        archiveData: ArchiveData,
        forcePosix: Boolean = false
    ) {
        if (keep <= 0) return

        val names = archiveNames.sortedDescending()

        var lastFlawlessArchive: String? = null

        if (archiveData.incompleteFiles.isNotEmpty() || archiveData.inaccessiblePaths.isNotEmpty()) {
            for (name in names) {
                var manifestPath: String? = null
                var manifest: ArchiveManifest? = null

                try {
                    manifestPath = pathJoin(
                        destination,
                        name + ArchiveFiles.EXT_MANIFEST,
                        posix = forcePosix
                    )

                    manifest = Json.decodeFromString<ArchiveManifest>(
                        readFile(manifestPath)
                    )
                } catch (e: IOException) {
                    // Abort cleanup if a manifest cannot be read, as its state is unknown. Deleting archives without this
                    // information could result in deleting the last known good backup.
                    throw AnqiException(Message.ERR_INVALID_MANIFEST.get("path" to manifestPath))
                }

                if (manifest.isComplete()) {
                    lastFlawlessArchive = name
                    break
                }
            }
        }

        val staleArchiveNames = names.drop(keep).filter { it != lastFlawlessArchive }

        for (name in staleArchiveNames) {
            var failed = false

            val archivePath = pathJoin(destination, name, posix = forcePosix)
            val checksumPath = pathJoin(destination, name + ArchiveFiles.EXT_CHECKSUM, posix = forcePosix)
            val manifestPath = pathJoin(destination, name + ArchiveFiles.EXT_MANIFEST, posix = forcePosix)

            listOf(archivePath, checksumPath, manifestPath).forEach {
                try {
                    deleteFile(it)
                    Logger.logDebug("Deleting: $it")
                } catch (e: IOException) {
                    failed = true
                    Logger.logWarning(Message.WARN_DELETE_FAILED.get("path" to it))
                }
            }

            if (failed) continue

            Logger.logSuccess(Message.SUCCESS_ARCHIVE_DELETED.get("path" to archivePath))
        }
    }

}
