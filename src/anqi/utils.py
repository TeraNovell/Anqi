import glob
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path

from fabric import Connection


@dataclass
class SftpConfig:
    host: str
    user: str
    port: int
    password: str | None = None
    key: Path | None = None

    def connection(self) -> Connection:
        if self.password is not None and self.key is not None:
            print(
                "SFTP password and key cannot be used together",
                file=sys.stderr,
            )
            sys.exit(1)

        connect_kwargs = {}

        if self.password is not None:
            connect_kwargs["password"] = self.password
        elif self.key is not None:
            connect_kwargs["key_filename"] = str(self.key.expanduser())

        return Connection(
            self.host,
            self.user,
            port=self.port,
            connect_kwargs=connect_kwargs,
        )


def add_to_archive(
    archive_file: tarfile.TarFile,
    sources: list[str],
):
    for source in sources:
        if not glob.has_magic(source) and not Path(source).exists():
            print(f"Source path {source} does not exist", file=sys.stderr)
            continue

        for path in glob.iglob(source, recursive=True):
            print(f"Adding file: {path}")
            archive_file.add(path)


def find_old_archives(
    archives: list[str], prefix: str, extension: str, keep: int
) -> list[str]:
    if keep <= 0:
        return []

    files = sorted([x for x in archives if is_archive_file(x, prefix, extension)])

    if len(files) <= keep:
        return []

    return files[:-keep]


def is_archive_file(file_name: str, prefix: str, extension: str) -> bool:
    return file_name.startswith(f"{prefix}-") and file_name.endswith(extension)
