package io.github.teranovell.anqi.log

import picocli.CommandLine.Help.Ansi
import java.io.UncheckedIOException
import java.math.BigDecimal
import java.math.RoundingMode
import java.nio.file.*
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow

object Logger {
    private val SIZE_UNITS = listOf("B", "KB", "MB", "GB", "TB")

    var debug = false

    fun logSuccess(message: String) = println("${prefix("green", "✔", "SUCCESS")} $message")

    fun logWarning(message: String) = System.err.println("${prefix("yellow", "⚠", "WARNING")} $message")

    fun logError(message: String) = System.err.println("${prefix("red", "✖", "ERROR")} $message")

    fun logDebug(message: String) {
        if (debug) println(message)
    }

    fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val i = floor(ln(bytes.toDouble()) / ln(1024.0)).toInt().coerceAtMost(SIZE_UNITS.lastIndex)
        val value = BigDecimal.valueOf(bytes / 1024.0.pow(i)).setScale(2, RoundingMode.HALF_UP)
        return "${value.stripTrailingZeros().toPlainString()} ${SIZE_UNITS[i]}"
    }

    /**
     * Returns a user facing message for errors caused by the filesystem changing or being inaccessible, which are
     * skipped instead of aborting the backup. Any other error yields null.
     */
    fun formatKnownError(e: Throwable, path: Any): String? =
        when (val cause = if (e is UncheckedIOException) e.cause else e) {
            is NoSuchFileException -> Message.WARN_UNABLE_TO_ACCESS_NONE_EXIST_PATH.get("path" to path)
            is AccessDeniedException, is NotDirectoryException, is FileSystemLoopException ->
                Message.WARN_UNABLE_TO_ACCESS_PATH.get("path" to path)
            // Errors like EBUSY or ELOOP have no dedicated subclass.
            is FileSystemException if cause::class == FileSystemException::class ->
                Message.WARN_UNABLE_TO_ACCESS_PATH.get("path" to path)

            else -> null
        }

    fun warnOrThrow(e: Throwable, path: Any) {
        logWarning(formatKnownError(e, path) ?: throw e)
    }

    // Colors are used when the console is a terminal and can be disabled with -Dpicocli.ansi=false.
    private fun prefix(color: String, symbol: String, label: String) =
        if (Ansi.AUTO.enabled()) Ansi.AUTO.string("@|$color $symbol $label|@") else label
}
