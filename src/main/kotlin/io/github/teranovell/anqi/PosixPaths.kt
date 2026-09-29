package io.github.teranovell.anqi

/** Helpers for paths with "/" as separator, as used in globs, ZIP entries and on SFTP servers. */
object PosixPaths {
    val IS_WINDOWS = System.getProperty("os.name").lowercase().startsWith("windows")

    fun toPosixPath(location: String) = if (IS_WINDOWS) location.replace('\\', '/') else location

    fun join(directory: String, name: String) = when {
        directory.isEmpty() -> name
        directory.endsWith("/") -> directory + name
        else -> "$directory/$name"
    }
}
