package io.github.teranovell.anqi.walk

import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

data class WalkEntry(val path: Path, val attributes: BasicFileAttributes)
