import { constants as fsConstants, statSync } from "node:fs";
import { open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import constants from "./constants.ts";
import { formatBytes, formatKnownError, logDebug, logSuccess, logWarning } from "./log/logger.ts";
import msg, { type MessageParams } from "./log/messages.ts";
import { ArchiveDescription, type ArchiveManifest } from "./types.ts";
import { findOldArchives, isArchiveFile } from "./utils.ts";
import { writeArchive } from "./writer.ts";

export async function createLocalArchive(
    sources: string[],
    destination: string,
    archive: ArchiveDescription,
    keep: number,
) {
    const partialPath = path.join(destination, archive.partialFilename);

    const archivePath = path.join(destination, archive.filename);
    const checksumPath = archivePath + constants.fileExtension.checksum;
    const manifestPath = archivePath + constants.fileExtension.manifest;

    if (!statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            msg.get("err.noneExistDestination", {
                path: destination,
            }),
        );
    }

    for await (const location of [archivePath, partialPath, checksumPath, manifestPath]) {
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
        const archiveData = await writeArchive(sources, handle.createWriteStream(), (entry) => {
            if (path.dirname(entry.path) !== path.resolve(destination)) return false;

            // Exclude the created archive files to prevent them from being included in backups,
            // which could otherwise cause duplicates or recursive backup loops.
            const name = path.basename(entry.path);
            return (
                isArchiveFile(name, archive.prefix, constants.fileExtension.complete) ||
                isArchiveFile(name, archive.prefix, constants.fileExtension.partial) ||
                isArchiveFile(
                    name,
                    archive.prefix,
                    constants.fileExtension.complete + constants.fileExtension.checksum,
                ) ||
                isArchiveFile(name, archive.prefix, constants.fileExtension.complete + constants.fileExtension.manifest)
            );
        });

        if ((await stat(partialPath))?.size !== archiveData.size) {
            throw new Error(
                msg.get("err.sizeMismatch", {
                    path: partialPath,
                }),
            );
        }

        await writeFile(checksumPath, `${archiveData.hash}  ${archive.filename}\n`, {
            flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        });

        const manifest: ArchiveManifest = {
            timestamp: archive.timestamp,
            hash: archiveData.hash,
            corruptedFiles: archiveData.corruptedFiles,
        };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), {
            flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        });

        await rename(partialPath, archivePath);

        if (archiveData.corruptedFiles.length > 0) process.exitCode = constants.exitCodes.incomplete;

        logSuccess(
            msg.get("success.archiveCreated", {
                path: archivePath,
                size: formatBytes(archiveData.size),
            }),
        );
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

    const fileNames = new Set(
        (await readdir(destination, { withFileTypes: true })).filter((x) => x.isFile()).map((x) => x.name),
    );

    for (const name of findOldArchives(fileNames, archive.prefix, constants.fileExtension.complete, keep)) {
        const filePath = path.join(destination, name);
        const checksumFilePath = filePath + constants.fileExtension.checksum;
        const manifestFilePath = filePath + constants.fileExtension.manifest;

        let failed = false;

        if (fileNames.has(name)) {
            logDebug(`Deleting: ${filePath}`);
            await unlink(filePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: filePath,
                };
                logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
            });
        }

        if (fileNames.has(name + constants.fileExtension.checksum)) {
            logDebug(`Deleting: ${checksumFilePath}`);
            await unlink(checksumFilePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: checksumFilePath,
                };
                logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
            });
        }

        if (fileNames.has(name + constants.fileExtension.manifest)) {
            logDebug(`Deleting: ${manifestFilePath}`);
            await unlink(manifestFilePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: manifestFilePath,
                };
                logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
            });
        }

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
    const partialPath = path.posix.join(destination, archive.partialFilename);

    const archivePath = path.posix.join(destination, archive.filename);
    const checksumPath = archivePath + constants.fileExtension.checksum;
    const manifestPath = archivePath + constants.fileExtension.manifest;

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

        for await (const location of [archivePath, partialPath, checksumPath, manifestPath]) {
            if (await sftp.exists(location)) {
                throw new Error(
                    msg.get("err.destinationExists", {
                        path: location,
                    }),
                );
            }
        }

        try {
            const archiveData = await writeArchive(sources, sftp.createWriteStream(partialPath));

            if ((await sftp.stat(partialPath))?.size !== archiveData.size) {
                throw new Error(
                    msg.get("err.sizeMismatch", {
                        path: partialPath,
                    }),
                );
            }

            await sftp.put(Buffer.from(`${archiveData.hash}  ${archive.filename}\n`), checksumPath, {
                writeStreamOptions: { flags: "wx" as any },
            });

            const manifest: ArchiveManifest = {
                timestamp: archive.timestamp,
                hash: archiveData.hash,
                corruptedFiles: archiveData.corruptedFiles,
            };
            await sftp.put(Buffer.from(JSON.stringify(manifest, null, 2)), manifestPath, {
                writeStreamOptions: { flags: "wx" as any },
            });

            await sftp.rename(partialPath, archivePath);

            if (archiveData.corruptedFiles.length > 0) process.exitCode = constants.exitCodes.incomplete;

            logSuccess(
                msg.get("success.archiveCreated", {
                    path: archivePath,
                    size: formatBytes(archiveData.size),
                }),
            );
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

        const fileNames = new Set((await sftp.list(destination)).filter((x) => x.type === "-")?.map((x) => x.name));

        for (const name of findOldArchives(fileNames, archive.prefix, constants.fileExtension.complete, keep)) {
            const filePath = path.posix.join(destination, name);
            const checksumFilePath = filePath + constants.fileExtension.checksum;
            const manifestFilePath = filePath + constants.fileExtension.manifest;

            let failed = false;

            if (fileNames.has(name)) {
                logDebug(`Deleting: ${filePath}`);
                await sftp.delete(filePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: filePath,
                    };
                    logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
                });
            }

            if (fileNames.has(name + constants.fileExtension.checksum)) {
                logDebug(`Deleting: ${checksumFilePath}`);
                await sftp.delete(checksumFilePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: checksumFilePath,
                    };
                    logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
                });
            }

            if (fileNames.has(name + constants.fileExtension.manifest)) {
                logDebug(`Deleting: ${manifestFilePath}`);
                await sftp.delete(manifestFilePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: manifestFilePath,
                    };
                    logWarning(formatKnownError(error, params) ?? msg.get("warn.deleteFailed", params));
                });
            }

            if (failed) continue;

            logSuccess(msg.get("success.archiveDeleted", { path: filePath }));
        }
    } finally {
        await sftp.end().catch(() => {});
    }
}
