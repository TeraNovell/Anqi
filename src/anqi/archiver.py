import posixpath
import sys
import tarfile
from pathlib import Path

from paramiko import SFTPClient

from .types import ArchiveDescription, HashingWriter
from .utils import (
    SftpConfig,
    add_to_archive,
    find_old_archives,
)


def create_local_archive(
    sources: list[str],
    destination: Path,
    archive_description: ArchiveDescription,
    keep: int,
):
    archive_path = destination / archive_description.full_filename

    if not archive_path.parent.is_dir():
        print(
            f"Destination {archive_path.parent} is not a directory or does not exist!",
            file=sys.stderr,
        )
        sys.exit(1)

    with archive_path.open("wb") as file, HashingWriter(file) as writer:
        with tarfile.open(fileobj=writer, mode="w:gz") as archive_file:
            add_to_archive(archive_file, sources)

        hash_path = Path(f"{archive_path}.sha256")

        with hash_path.open("w") as hash_file:
            hash_file.write(
                f"{writer.hexdigest()}  {archive_description.full_filename}\n"
            )

        print(f"Backup created at {archive_path}")

    if keep <= 0:
        return

    old_archives = find_old_archives(
        [x.name for x in destination.iterdir() if x.is_file()],
        archive_description.prefix,
        archive_description.extension,
        keep,
    )

    for file_name in old_archives:
        file_path = destination / file_name
        file_path.unlink()

        hash_path = file_path.with_name(f"{file_name}.sha256")
        if hash_path.exists():
            hash_path.unlink()

        print(f"Backup deleted at {file_path}")


def create_sftp_archive(
    sources: list[str],
    destination: str,
    archive_description: ArchiveDescription,
    keep: int,
    sftp_config: SftpConfig,
):
    remote_archive_path = posixpath.join(destination, archive_description.full_filename)

    with (
        sftp_config.connection() as conn,
        conn.sftp() as sftp,
    ):
        sftp: SFTPClient

        with (
            sftp.file(remote_archive_path, "wb") as file,
            HashingWriter(file) as writer,
        ):
            with tarfile.open(fileobj=writer, mode="w|gz") as archive_file:
                add_to_archive(archive_file, sources)

            remote_size = sftp.stat(remote_archive_path).st_size

            if remote_size != writer.size:
                print(
                    f"File size mismatch after upload for {remote_archive_path}",
                    file=sys.stderr,
                )
                sys.exit(1)

            with sftp.file(remote_archive_path + ".sha256", "w") as hash_file:
                hash_file.write(
                    f"{writer.hexdigest()}  {archive_description.full_filename}\n"
                )

            print(f"Backup created at {remote_archive_path}")

        if keep <= 0:
            return

        # files = set(sftp.listdir(destination))
        files = sftp.listdir(destination)
        old_archives = find_old_archives(
            files,
            archive_description.prefix,
            archive_description.extension,
            keep,
        )

        for file_name in old_archives:
            file_path = posixpath.join(destination, file_name)
            sftp.remove(file_path)

            hash_path = f"{file_path}.sha256"
            if f"{file_name}.sha256" in files:
                sftp.remove(hash_path)

            print(f"Backup deleted at {file_path}")
