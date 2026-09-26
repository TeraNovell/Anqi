import { constants as fsConstants, statSync } from "node:fs";
import { open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import constants from "./constants.ts";
import { formatBytes, formatKnownError, logSuccess, logWarning } from "./log/logger.ts";
import msg, { type MessageParams } from "./log/messages.ts";
import { ArchiveDescription } from "./types.ts";
import { findOldArchives, isArchiveFile } from "./utils.ts";
import { writeArchive } from "./writer.ts";

export async function createLocalArchive(
    sources: string[],
    destination: string,
    archive: ArchiveDescription,
    keep: number,
) {
    const partialPath = path.join(destination, archive.fullPartialFilename);
    const archivePath = path.join(destination, archive.fullFilename);
    const checksumPath = path.join(destination, archive.fullChecksumFilename);

    if (!statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            msg.get("err.noneExistDestination", {
                path: destination,
            }),
        );
    }

    for await (const location of [partialPath, archivePath, checksumPath]) {
        if (await stat(location).catch(() => null)) {
            throw new Error(
                msg.get("err.destinationExists", {
                    path: location,
                }),
            );
        }
    }

    const handle = await open(partialPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);

    try {
        const archiveData = await writeArchive(sources, handle.createWriteStream(), archive.compression, (entry) => {
            if (path.dirname(entry.path) !== path.resolve(destination)) return false;

            // Exclude the created archive files to prevent them from being included in backups,
            // which could otherwise cause duplicates or recursive backup loops.
            const name = path.basename(entry.path);
            return (
                isArchiveFile(name, archive.prefix, archive.extension) ||
                isArchiveFile(name, archive.prefix, archive.checksumExtension) ||
                isArchiveFile(name, archive.prefix, archive.partialExtension)
            );
        });

        if ((await stat(partialPath))?.size !== archiveData.size) {
            throw new Error(
                msg.get("err.sizeMismatch", {
                    path: partialPath,
                }),
            );
        }

        await writeFile(checksumPath, `${archiveData.hash}  ${archive.fullFilename}\n`, {
            flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        });
        await rename(partialPath, archivePath);

        logSuccess(
            msg.get("success.archiveCreated", {
                path: archivePath,
                size: formatBytes(archiveData.size),
            }),
        );

        if (archiveData.warnings > 0) process.exitCode = constants.exitCodes.incomplete;
    } catch (error) {
        await unlink(partialPath).catch(() => {
            logWarning(
                msg.get("warn.deleteFailed", {
                    path: partialPath,
                }),
            );
        });
        throw error;
    }

    if (keep <= 0) return;

    const fileNames = (await readdir(destination, { withFileTypes: true }))
        ?.filter((x) => x.isFile())
        ?.map((x) => x.name);

    for (const name of findOldArchives(fileNames, archive.prefix, archive.extension, keep)) {
        const filePath = path.join(destination, name);
        const checksumFilePath = filePath + archive.checksumExtension;

        let failed = false;

        if (fileNames.includes(name))
            await unlink(filePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: filePath,
                };
                logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
            });

        if (fileNames.includes(name + archive.checksumExtension))
            await unlink(checksumFilePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: checksumFilePath,
                };
                logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
            });

        if (failed) continue;

        logSuccess(
            msg.get("success.archiveDeleted", {
                path: filePath,
            }),
        );
    }
}

export async function createSftpArchive(
    sources: string[],
    destination: string,
    archive: ArchiveDescription,
    keep: number,
    sftpConfig: SftpClient.ConnectOptions,
) {
    const partialPath = path.posix.join(destination, archive.fullPartialFilename);
    const archivePath = path.posix.join(destination, archive.fullFilename);
    const checksumPath = path.posix.join(destination, archive.fullChecksumFilename);

    const sftp = new SftpClient();

    try {
        await sftp.connect(sftpConfig);

        if ((await sftp.exists(destination)) !== "d") {
            throw new Error(
                msg.get("err.noneExistDestination", {
                    path: destination,
                }),
            );
        }

        for await (const location of [partialPath, archivePath, checksumPath]) {
            if (await sftp.exists(location)) {
                throw new Error(
                    msg.get("err.destinationExists", {
                        path: location,
                    }),
                );
            }
        }

        try {
            const archiveData = await writeArchive(sources, sftp.createWriteStream(partialPath), archive.compression);

            if ((await sftp.stat(partialPath))?.size !== archiveData.size) {
                throw new Error(
                    msg.get("err.sizeMismatch", {
                        path: partialPath,
                    }),
                );
            }

            await sftp.put(Buffer.from(`${archiveData.hash}  ${archive.fullFilename}\n`), checksumPath);
            await sftp.rename(partialPath, archivePath);

            logSuccess(
                msg.get("success.archiveCreated", {
                    path: archivePath,
                    size: formatBytes(archiveData.size),
                }),
            );

            if (archiveData.warnings > 0) process.exitCode = constants.exitCodes.incomplete;
        } catch (error) {
            await sftp.delete(partialPath).catch(() => {
                logWarning(
                    msg.get("warn.deleteFailed", {
                        path: partialPath,
                    }),
                );
            });
            throw error;
        }

        if (keep <= 0) return;

        const fileNames = (await sftp.list(destination))?.filter((x) => x.type === "-")?.map((x) => x.name);

        for (const name of findOldArchives(fileNames, archive.prefix, archive.extension, keep)) {
            const filePath = path.posix.join(destination, name);
            const checksumFilePath = filePath + archive.checksumExtension;

            let failed = false;

            if (fileNames.includes(name))
                await sftp.delete(filePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: filePath,
                    };
                    logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
                });

            if (fileNames.includes(name + archive.checksumExtension))
                await sftp.delete(checksumFilePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: checksumFilePath,
                    };
                    logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
                });

            if (failed) continue;

            logSuccess(msg.get("success.archiveDeleted", { path: filePath }));
        }
    } finally {
        await sftp.end().catch(() => {});
    }
}
