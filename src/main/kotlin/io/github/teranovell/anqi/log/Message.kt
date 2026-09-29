package io.github.teranovell.anqi.log

enum class Message(private val template: String) {
    // Info
    INFO_CREATING_ARCHIVE("Creating archive {{path}} ..."),
    INFO_DONE_IN("Done in {{time}} s"),
    INFO_ADDED_FILES("Added {{count}} files to archive"),

    // Success
    SUCCESS_ARCHIVE_CREATED("Archive created at {{path}} with {{size}}"),
    SUCCESS_ARCHIVE_DELETED("Archive deleted at {{path}}"),

    // Warning
    WARN_HOST_KEY_VERIFICATION_DISABLED(
        "SSH host key verification is disabled for {{host}}:{{port}}. The server identity is not verified!",
    ),
    WARN_DELETE_FAILED("Unable to delete {{path}}. Skipping it."),
    WARN_UNABLE_TO_ACCESS_NONE_EXIST_PATH("Unable to access {{path}}: it no longer exists. Skipping it."),
    WARN_UNABLE_TO_ACCESS_PATH("Unable to access {{path}}: it cannot be accessed. Skipping it."),
    WARN_UNABLE_TO_PROCESS_UNKNOWN_TYPE("Unable to process {{path}}: unsupported content type. Skipping it."),
    WARN_FILE_CHANGED_WHILE_ARCHIVING("The file {{path}} changed while being streamed!"),
    WARN_FILE_READ_FAILED("The file {{path}} could not be read completely!"),
    WARN_NO_UTF8_LOCALE(
        "The locale uses {{encoding}} instead of UTF-8, so file names with special characters may be archived " +
            "incorrectly. Run it with a UTF-8 locale, e.g. \"LC_ALL=C.UTF-8 java -jar ...\"!",
    ),

    // Error
    ERR_SIZE_MISMATCH("Archive creation failed: File size mismatch after creating {{path}}"),
    ERR_NONE_EXIST_DESTINATION("Destination {{path}} is not a directory or does not exist!"),
    ERR_DESTINATION_EXISTS("Archive creation failed: The destination {{path}} already exists!"),
    ERR_NOTHING_ADDED("Archive creation failed: Nothing could be added to the archive!"),
    ERR_KNOWN_HOSTS(
        "Unable to load ~/.ssh/known_hosts to verify the SFTP server. Add its host key, e.g. with " +
            "\"ssh-keyscan -p {{port}} {{host}} >> ~/.ssh/known_hosts\"!",
    ),
    ;

    fun get(vararg params: Pair<String, Any?>): String =
        params.fold(template) { result, (name, value) -> result.replace("{{$name}}", value.toString()) }
}
