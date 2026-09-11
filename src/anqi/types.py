import datetime
import io
from hashlib import sha256
from typing import BinaryIO

from paramiko import SFTPFile


class ArchiveDescription:
    def __init__(self, prefix: str, extension: str):
        self._prefix = prefix
        self._extension = extension
        self._filename = f"{prefix}-{datetime.datetime.now(datetime.UTC):%Y%m%d-%H%M%S}"

    @property
    def prefix(self) -> str:
        return self._prefix

    @property
    def extension(self) -> str:
        return self._extension

    @property
    def filename(self) -> str:
        return self._filename

    @property
    def full_filename(self) -> str:
        return self._filename + self._extension


class HashingWriter(io.BufferedIOBase):
    def __init__(self, file: BinaryIO | SFTPFile):
        super().__init__()
        self.file = file
        self.hash = sha256()
        self.size = 0

    def writable(self) -> bool:
        return True

    def write(self, data: bytes) -> int:
        self.hash.update(data)
        self.size += len(data)
        self.file.write(data)
        return len(data)

    def tell(self) -> int:
        return self.file.tell()

    def seek(self, offset: int, whence: int = 0) -> int:
        self.file.seek(offset, whence)
        return self.tell()

    def close(self) -> None:
        if not self.closed:
            self.file.close()
        super().close()

    def hexdigest(self) -> str:
        return self.hash.hexdigest()
