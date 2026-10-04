package io.github.teranovell.anqi.cli

import io.github.teranovell.anqi.AnqiException
import io.github.teranovell.anqi.PosixPath
import io.github.teranovell.anqi.archive.ArchiveDescription
import io.github.teranovell.anqi.archive.LocalArchiver
import io.github.teranovell.anqi.archive.SftpArchiver
import io.github.teranovell.anqi.archive.SftpConfig
import io.github.teranovell.anqi.log.Logger
import io.github.teranovell.anqi.log.Message
import picocli.CommandLine
import picocli.CommandLine.*
import java.nio.file.Path
import java.util.*
import java.util.concurrent.Callable
import kotlin.io.path.Path
import kotlin.system.exitProcess

private const val EXIT_ERROR = 1
private const val EXIT_INCOMPLETE = 20

// The options are set by picocli when parsing the arguments. "\${...}" are placeholders of picocli, which must not be
// resolved as string templates of Kotlin.
@Command(
    name = "anqi",
    description = ["Anqi - A really simple backup tool"],
    versionProvider = Anqi.VersionProvider::class,
    sortOptions = false,
    exitCodeOnInvalidInput = EXIT_ERROR,
    exitCodeOnExecutionException = EXIT_ERROR,
)
class Anqi : Callable<Int> {
    enum class Target { LOCAL, SFTP }

    @Option(
        names = ["-s", "--src"],
        paramLabel = "<path>",
        required = true,
        description = [
            "File, directory or glob pattern to back up (repeatable). Directories are always backed up with all of " +
                "their contents, also when matched by a pattern. Patterns support *, ?, [...], {a,b} and **. Quote " +
                "patterns so the shell does not expand them",
        ],
    )
    private lateinit var src: List<String>

    @Option(
        names = ["-d", "--dst"],
        paramLabel = "<path>",
        required = true,
        description = ["Destination directory path where the backup archive will be stored"],
    )
    private lateinit var dst: String

    @Option(
        names = ["-t", "--target"],
        paramLabel = "<type>",
        defaultValue = "local",
        description = ["Backup destination type (choices: local, sftp, default: \${DEFAULT-VALUE})"],
    )
    private lateinit var target: Target

    @Option(
        names = ["-k", "--keep"],
        paramLabel = "<count>",
        defaultValue = "0",
        converter = [KeepConverter::class],
        description = [
            "Number of most recent backups to retain. Older archives are deleted (default: \${DEFAULT-VALUE})",
        ],
    )
    private var keep = 0

    @Option(
        names = ["--archive-prefix"],
        paramLabel = "<prefix>",
        defaultValue = "archive",
        description = ["Prefix for the generated archive filename (default: \${DEFAULT-VALUE})"],
    )
    private lateinit var archivePrefix: String

    @Option(names = ["--debug"], description = ["Enable verbose debug logging"])
    private var debug = false

    @Option(names = ["-v", "--version"], versionHelp = true, description = ["Output the version number"])
    private var versionRequested = false

    @Option(names = ["-h", "--help"], usageHelp = true, description = ["Display help for command"])
    private var helpRequested = false

    // Stays empty if no SFTP option is given, which is reported when the SFTP target is used.
    @ArgGroup(validate = false, heading = "%nSFTP target options:%n")
    private var sftp = SftpOptions()

    class SftpOptions {
        @Option(
            names = ["--sftp-host"],
            paramLabel = "<host>",
            description = ["Hostname or IP address of the SFTP server"],
        )
        var host: String? = null

        @Option(
            names = ["--sftp-port"],
            paramLabel = "<port>",
            defaultValue = "22",
            converter = [PortConverter::class],
            description = ["Port number of the SFTP server (default: \${DEFAULT-VALUE})"],
        )
        var port = 0

        @Option(
            names = ["--sftp-user"],
            paramLabel = "<user>",
            defaultValue = "\${env:ANQI_SFTP_USERNAME}",
            description = ["Username for SFTP authentication (env: ANQI_SFTP_USERNAME)"],
        )
        var user: String? = null

        @Option(
            names = ["--sftp-password"],
            paramLabel = "<password>",
            defaultValue = "\${env:ANQI_SFTP_PASSWORD}",
            description = ["Password for SFTP authentication (env: ANQI_SFTP_PASSWORD)"],
        )
        var password: String? = null

        @Option(
            names = ["--sftp-key"],
            paramLabel = "<path>",
            description = ["Path to private SSH key file for SFTP authentication"],
        )
        var key: Path? = null

        @Option(
            names = ["--sftp-skip-key-verification"],
            description = ["Skip SSH host key verification (insecure; accepts any server host key)"],
        )
        var skipHostKeyVerification = false
    }

    override fun call(): Int {
        Logger.debug = debug
        warnIfFileNamesAreNotUtf8()

        val archiveDescription = ArchiveDescription.create(archivePrefix)

        val archivePath = when (target) {
            Target.LOCAL -> Path(dst).resolve(archiveDescription.filename).toString()
            Target.SFTP -> PosixPath.join(dst, archiveDescription.filename)
        }
        println(Message.INFO_CREATING_ARCHIVE.get("path" to archivePath))

        val start = System.nanoTime()

        val archiveData = when (target) {
            Target.LOCAL -> LocalArchiver(src, dst, archiveDescription, keep).use { it.create() }
            Target.SFTP -> SftpArchiver(src, dst, archiveDescription, keep, sftpConfig()).use { it.create() }
        }

        val time = "%.2f".format(Locale.ROOT, (System.nanoTime() - start) / 1e9)
        println(Message.INFO_DONE_IN.get("time" to time))

        return if (archiveData.isComplete()) 0 else EXIT_INCOMPLETE
    }

    private fun sftpConfig(): SftpConfig {
        val host = sftp.host
        val user = sftp.user

        if (host == null || user == null) {
            throw AnqiException("Host and username need to be specified for an sftp connection!")
        }

        return SftpConfig(
            host, sftp.port, user, sftp.password, sftp.key,
            skipHostKeyVerification = sftp.skipHostKeyVerification,
        )
    }

    /** Parses an integer and fails with the given message if it is not a number within the range. */
    abstract class RangeConverter(
        private val range: IntRange,
        private val message: String,
    ) : ITypeConverter<Int> {
        override fun convert(value: String): Int =
            value.toIntOrNull()?.takeIf { it in range } ?: throw TypeConversionException(message)
    }

    class KeepConverter : RangeConverter(0..Int.MAX_VALUE, "Keep value must be a non-negative integer!")

    class PortConverter : RangeConverter(1..65535, "Port must be a valid port number (1-65535)!")

    class VersionProvider : IVersionProvider {
        override fun getVersion() = arrayOf(Anqi::class.java.`package`.implementationVersion ?: "unknown")
    }
}

// Java decodes file names with the charset of the locale, which cannot be changed once the JVM is running. Without a
// locale (e.g. in cron jobs) that is ASCII, which breaks non-ASCII file names. Windows is not affected, since Java uses
// its Unicode APIs there.
private fun warnIfFileNamesAreNotUtf8() {
    val encoding = System.getProperty("native.encoding")

    if (!PosixPath.IS_WINDOWS && !encoding.equals("UTF-8", ignoreCase = true)) {
        Logger.logWarning(Message.WARN_NO_UTF8_LOCALE.get("encoding" to encoding))
    }
}

fun main(args: Array<String>) {
    val commandLine = CommandLine(Anqi())
        .setCaseInsensitiveEnumValuesAllowed(true)
        .setExecutionExceptionHandler { e, _, _ ->
            Logger.logError(e.message ?: e.toString())
            Logger.logDebug(e.stackTraceToString())
            EXIT_ERROR
        }

    exitProcess(commandLine.execute(*args))
}
