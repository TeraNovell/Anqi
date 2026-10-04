package io.github.teranovell.anqi.archive

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.PosixPath
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.RemoteFile
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import java.io.BufferedReader
import java.io.IOException
import java.util.*

// Number of SFTP write requests that may be in flight without waiting for the server to confirm them.
private const val MAX_UNCONFIRMED_WRITES = 16

class SftpArchiver(
    val sources: List<String>,
    destination: String,
    archive: ArchiveDescription,
    keep: Int,
    config: SftpConfig
) : Archiver(destination, archive, keep) {
    private val sshClient: SSHClient = SSHClient()
    private val sftpClient: SFTPClient

    init {
        if (config.skipHostKeyVerification) {
            Logger.logWarning(
                Message.WARN_HOST_KEY_VERIFICATION_DISABLED.get("host" to config.host, "port" to config.port),
            )
            sshClient.addHostKeyVerifier(PromiscuousVerifier())
        } else {
            try {
                sshClient.loadKnownHosts()
            } catch (_: IOException) {
                throw AnqiException(Message.ERR_KNOWN_HOSTS.get("host" to config.host, "port" to config.port))
            }
        }

        sshClient.connect(config.host, config.port)

        when {
            config.privateKey != null -> sshClient.authPublickey(
                config.username,
                sshClient.loadKeys(config.privateKey.toString())
            )

            config.password != null -> sshClient.authPassword(config.username, config.password)
            // Falls back to the default keys in ~/.ssh.
            else -> sshClient.authPublickey(config.username)
        }

        sftpClient = sshClient.newSFTPClient()
    }

    override fun close() {
        try {
            sftpClient.close()
            sshClient.close()
        } catch (_: Exception) {
        }
    }

    override fun readFile(path: String): String {
        return sftpClient.open(path, EnumSet.of(OpenMode.READ)).use { file: RemoteFile ->
            file.RemoteFileInputStream()
                .bufferedReader(Charsets.UTF_8)
                .use { reader: BufferedReader -> reader.readText() }
        }
    }

    override fun deleteFile(vararg paths: String) {
        paths.forEach {
            sftpClient.rm(it)
        }
    }

    fun create(): ArchiveData {
        val partialPath = PosixPath.join(destination, archive.partialFilename)

        val archivePath = PosixPath.join(destination, archive.filename)
        val checksumPath = archivePath + ArchiveFiles.EXT_CHECKSUM
        val manifestPath = archivePath + ArchiveFiles.EXT_MANIFEST

        if (sftpClient.statExistence(destination)?.type != FileMode.Type.DIRECTORY) {
            throw AnqiException(Message.ERR_NONE_EXIST_DESTINATION.get("path" to destination))
        }

        for (location in listOf(archivePath, partialPath, checksumPath, manifestPath)) {
            if (sftpClient.statExistence(location) != null) {
                throw AnqiException(Message.ERR_DESTINATION_EXISTS.get("path" to location))
            }
        }

        val file = sftpClient.open(partialPath, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL))

        val archiveData = try {
            val archiveData = file.use {
                writeArchive(sources, it.RemoteFileOutputStream(0, MAX_UNCONFIRMED_WRITES))
            }

            if (sftpClient.size(partialPath) != archiveData.size) {
                throw AnqiException(Message.ERR_SIZE_MISMATCH.get("path" to partialPath))
            }

            sftpClient.putExclusive(checksumPath, getChecksumContent(archiveData))
            sftpClient.putExclusive(manifestPath, getManifestContent(archiveData))

            sftpClient.rename(partialPath, archivePath)

            Logger.logSuccess(
                Message.SUCCESS_ARCHIVE_CREATED.get(
                    "path" to archivePath,
                    "size" to Logger.formatBytes(archiveData.size)
                )
            )

            archiveData
        } catch (e: Exception) {
            try {
                sftpClient.rm(partialPath)
            } catch (_: IOException) {
                Logger.logWarning(Message.WARN_DELETE_FAILED.get("path" to partialPath))
            }
            throw e
        }

        if (keep <= 0) return archiveData

        val archiveNames = sftpClient.ls(destination)
            .filter {
                it.isRegularFile && ArchiveFiles.isArchiveFile(
                    it.name,
                    archive.prefix,
                    ArchiveFiles.EXT_COMPLETE
                )
            }
            .mapNotNull { it.name }
            .toSet()

        deleteStaleArchives(archiveNames, archiveData, true)

        return archiveData
    }

    private fun SFTPClient.putExclusive(location: String, content: String) {
        val bytes = content.toByteArray()
        open(location, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL)).use {
            it.write(
                0,
                bytes,
                0,
                bytes.size
            )
        }
    }
}
