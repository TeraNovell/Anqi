import argparse
import sys
import time
from enum import Enum
from pathlib import Path

from .archiver import create_local_archive, create_sftp_archive
from .types import ArchiveDescription
from .utils import SftpConfig


class BackupTarget(Enum):
    LOCAL = "local"
    SFTP = "sftp"


def main():
    parser = argparse.ArgumentParser(description="Anqi - A really simple backup tool")

    # General backup options
    parser.add_argument(
        "-s",
        "--src",
        type=str,
        action="append",
        required=True,
        metavar="PATH",
        help="Path or glob pattern of a file or directory to back up (can be specified multiple times)",
    )
    parser.add_argument(
        "-d",
        "--dst",
        type=str,
        required=True,
        metavar="PATH",
        help="Destination directory path where the backup archive will be stored",
    )
    parser.add_argument(
        "-t",
        "--target",
        type=str,
        choices=[x.value for x in BackupTarget],
        default=BackupTarget.LOCAL.value,
        help="Backup destination type (default: %(default)s)",
    )
    parser.add_argument(
        "-k",
        "--keep",
        type=int,
        default=None,
        metavar="N",
        help="Number of most recent backups to retain in destination (older archives are deleted)",
    )
    parser.add_argument("-c", "--compress", action="store_true")
    parser.add_argument(
        "--archive-prefix",
        type=str,
        default="archive",
        metavar="PREFIX",
        help="Prefix for the generated archive filename (default: %(default)s)",
    )

    # SFTP target options
    sftp_group = parser.add_argument_group("SFTP target options")
    sftp_group.add_argument(
        "--sftp-host",
        type=str,
        default=None,
        metavar="HOST",
        help="Hostname or IP address of the SFTP server (required for SFTP target)",
    )
    sftp_group.add_argument(
        "--sftp-user",
        type=str,
        default=None,
        metavar="USER",
        help="Username for SFTP authentication (required for SFTP target)",
    )
    sftp_group.add_argument(
        "--sftp-port",
        type=int,
        default=22,
        metavar="PORT",
        help="Port number of the SFTP server (default: %(default)s)",
    )
    sftp_group.add_argument(
        "--sftp-password",
        type=str,
        default=None,
        metavar="PASSWORD",
        help="Password for SFTP authentication",
    )
    sftp_group.add_argument(
        "--sftp-key",
        type=Path,
        default=None,
        metavar="KEY_FILE",
        help="Path to private SSH key file for SFTP authentication",
    )

    args = parser.parse_args()

    sources: list[str] = args.src
    destination: str = args.dst
    mode = BackupTarget(args.target)

    keep = int(args.keep or 0)
    if keep < 0:
        print("Keep value must be a non-negative integer", file=sys.stderr)
        sys.exit(1)

    compress: bool = args.compress

    if mode != BackupTarget.LOCAL:
        if args.sftp_host is None or args.sftp_user is None:
            print(
                "--sftp-host and --sftp-user are required for SFTP target",
                file=sys.stderr,
            )
            sys.exit(1)

    sftp = SftpConfig(
        host=args.sftp_host,
        user=args.sftp_user,
        port=args.sftp_port,
        password=args.sftp_password,
        key=args.sftp_key,
    )

    archive_description = ArchiveDescription(
        args.archive_prefix or "", ".tar.gz" if compress else ".tar"
    )

    start = time.perf_counter()

    match mode:
        case BackupTarget.LOCAL:
            create_local_archive(
                sources,
                Path(destination),
                archive_description,
                keep,
            )
        case BackupTarget.SFTP:
            create_sftp_archive(sources, destination, archive_description, keep, sftp)
        case _:
            print(f"Unknown backup target {args.target}", file=sys.stderr)
            sys.exit(1)

    print(f"Took {time.perf_counter() - start:.6f} s")


if __name__ == "__main__":
    main()
