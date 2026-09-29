package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.PosixPaths
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.util.*
import kotlin.io.path.*

// Number of SFTP write requests that may be in flight without waiting for the server to confirm them.
private const val MAX_UNCONFIRMED_WRITES = 16

fun createLocalArchive(
    sources: List<String>,
    destination: String,
    archive: ArchiveDescription,
    keep: Int,
): ArchiveData {
    val directory = Path(destination)
    val partialPath = directory.resolve(archive.partialFilename)

    val archivePath = directory.resolve(archive.filename)
    val checksumPath = directory.resolve(archive.filename + ArchiveFiles.EXT_CHECKSUM)
    val manifestPath = directory.resolve(archive.filename + ArchiveFiles.EXT_MANIFEST)

    if (!directory.isDirectory()) {
        throw AnqiException(Message.ERR_NONE_EXIST_DESTINATION.get("path" to destination))
    }

    for (location in listOf(archivePath, partialPath, checksumPath, manifestPath)) {
        if (location.exists()) throw AnqiException(Message.ERR_DESTINATION_EXISTS.get("path" to location))
    }

    val output = partialPath.outputStream(CREATE_NEW, WRITE)
    val absDestination = directory.toAbsolutePath().normalize()

    val archiveData = try {
        val archiveData = writeArchive(sources, output) { entry ->
            // Exclude the created archive files to prevent them from being included in backups,
            // which could otherwise cause duplicates or recursive backup loops.
            val isArchive = listOf(
                ArchiveFiles.EXT_COMPLETE,
                ArchiveFiles.EXT_PARTIAL,
                ArchiveFiles.EXT_COMPLETE + ArchiveFiles.EXT_CHECKSUM,
                ArchiveFiles.EXT_COMPLETE + ArchiveFiles.EXT_MANIFEST,
            ).any { ArchiveFiles.isArchiveFile(entry.path.name, archive.prefix, it) }

            val parent = entry.path.parent
            isArchive && parent != null && (parent == absDestination || Files.isSameFile(parent, absDestination))
        }

        if (partialPath.fileSize() != archiveData.size) {
            throw AnqiException(Message.ERR_SIZE_MISMATCH.get("path" to partialPath))
        }

        checksumPath.writeText(checksum(archiveData, archive), options = arrayOf(CREATE_NEW, WRITE))
        manifestPath.writeText(manifest(archiveData, archive), options = arrayOf(CREATE_NEW, WRITE))

        partialPath.moveTo(archivePath)

        Logger.logSuccess(
            Message.SUCCESS_ARCHIVE_CREATED.get("path" to archivePath, "size" to Logger.formatBytes(archiveData.size)),
        )

        archiveData
    } catch (e: Exception) {
        try {
            partialPath.deleteExisting()
        } catch (_: IOException) {
            Logger.logWarning(Message.WARN_DELETE_FAILED.get("path" to partialPath))
        }
        throw e
    }

    if (keep <= 0) return archiveData

    val fileNames = directory.listDirectoryEntries()
        .filter { it.isRegularFile(NOFOLLOW_LINKS) }
        .map { it.name }
        .toSet()

    deleteOldArchives(fileNames, archive, keep, { directory.resolve(it).toString() }) { Path(it).deleteExisting() }

    return archiveData
}

fun createSftpArchive(
    sources: List<String>,
    destination: String,
    archive: ArchiveDescription,
    keep: Int,
    config: SftpConfig,
): ArchiveData {
    val partialPath = PosixPaths.join(destination, archive.partialFilename)

    val archivePath = PosixPaths.join(destination, archive.filename)
    val checksumPath = archivePath + ArchiveFiles.EXT_CHECKSUM
    val manifestPath = archivePath + ArchiveFiles.EXT_MANIFEST

    connect(config).use { ssh ->
        ssh.newSFTPClient().use { sftp ->
            if (sftp.statExistence(destination)?.type != FileMode.Type.DIRECTORY) {
                throw AnqiException(Message.ERR_NONE_EXIST_DESTINATION.get("path" to destination))
            }

            for (location in listOf(archivePath, partialPath, checksumPath, manifestPath)) {
                if (sftp.statExistence(location) != null) {
                    throw AnqiException(Message.ERR_DESTINATION_EXISTS.get("path" to location))
                }
            }

            val file = sftp.open(partialPath, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL))

            val archiveData = try {
                val archiveData = file.use {
                    writeArchive(sources, it.RemoteFileOutputStream(0, MAX_UNCONFIRMED_WRITES))
                }

                if (sftp.size(partialPath) != archiveData.size) {
                    throw AnqiException(Message.ERR_SIZE_MISMATCH.get("path" to partialPath))
                }

                sftp.putExclusive(checksumPath, checksum(archiveData, archive))
                sftp.putExclusive(manifestPath, manifest(archiveData, archive))

                sftp.rename(partialPath, archivePath)

                Logger.logSuccess(
                    Message.SUCCESS_ARCHIVE_CREATED.get(
                        "path" to archivePath,
                        "size" to Logger.formatBytes(archiveData.size)
                    )
                )

                archiveData
            } catch (e: Exception) {
                try {
                    sftp.rm(partialPath)
                } catch (_: IOException) {
                    Logger.logWarning(Message.WARN_DELETE_FAILED.get("path" to partialPath))
                }
                throw e
            }

            if (keep <= 0) return archiveData

            val fileNames = sftp.ls(destination).filter { it.isRegularFile }.map { it.name }.toSet()

            deleteOldArchives(fileNames, archive, keep, { PosixPaths.join(destination, it) }) { sftp.rm(it) }

            return archiveData
        }
    }
}

private fun connect(config: SftpConfig): SSHClient {
    val ssh = SSHClient()

    try {
        if (config.skipHostKeyVerification) {
            Logger.logWarning(
                Message.WARN_HOST_KEY_VERIFICATION_DISABLED.get("host" to config.host, "port" to config.port),
            )
            ssh.addHostKeyVerifier(PromiscuousVerifier())
        } else {
            try {
                ssh.loadKnownHosts()
            } catch (_: IOException) {
                throw AnqiException(Message.ERR_KNOWN_HOSTS.get("host" to config.host, "port" to config.port))
            }
        }

        ssh.connect(config.host, config.port)

        when {
            config.privateKey != null -> ssh.authPublickey(config.username, ssh.loadKeys(config.privateKey.toString()))
            config.password != null -> ssh.authPassword(config.username, config.password)
            // Falls back to the default keys in ~/.ssh.
            else -> ssh.authPublickey(config.username)
        }

        return ssh
    } catch (e: Exception) {
        ssh.close()
        throw e
    }
}

private fun SFTPClient.putExclusive(location: String, content: String) {
    val bytes = content.toByteArray()
    open(location, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL)).use { it.write(0, bytes, 0, bytes.size) }
}

private fun checksum(archiveData: ArchiveData, archive: ArchiveDescription) =
    "${archiveData.hash}  ${archive.filename}\n"

private fun manifest(archiveData: ArchiveData, archive: ArchiveDescription) =
    ArchiveManifest(
        archive.timestamp,
        archiveData.hash,
        archiveData.corruptedFiles,
        archiveData.inaccessiblePaths
    ).toJson()

private fun deleteOldArchives(
    fileNames: Set<String>,
    archive: ArchiveDescription,
    keep: Int,
    resolve: (String) -> String,
    delete: (String) -> Unit,
) {
    for (name in ArchiveFiles.findOldArchives(fileNames, archive.prefix, keep)) {
        var failed = false

        for (file in listOf(name, name + ArchiveFiles.EXT_CHECKSUM, name + ArchiveFiles.EXT_MANIFEST)) {
            if (file !in fileNames) continue

            val location = resolve(file)
            Logger.logDebug("Deleting: $location")

            try {
                delete(location)
            } catch (e: IOException) {
                failed = true
                Logger.logWarning(
                    Logger.formatKnownError(e, location) ?: Message.WARN_DELETE_FAILED.get("path" to location),
                )
            }
        }

        if (failed) continue

        Logger.logSuccess(Message.SUCCESS_ARCHIVE_DELETED.get("path" to resolve(name)))
    }
}
