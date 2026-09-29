package io.github.teranovell.anqi.archive

import java.nio.file.Path

data class SftpConfig(
    val host: String,
    val port: Int,
    val username: String,
    val password: String?,
    val privateKey: Path?,
    val skipHostKeyVerification: Boolean = false,
)
