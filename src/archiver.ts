import { createWriteStream, statSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import constants from "./constants.ts";
import {
    formatBytes,
    formatKnownError,
    logSuccess,
    logWarning,
} from "./log/logger.ts";
import msg, { type MessageParams } from "./log/messages.ts";
import { ArchiveDescription } from "./types.ts";
import { findOldArchives } from "./utils.ts";
import { writeArchive } from "./writer.ts";

export async function createLocalArchive(
    sources: string[],
    destination: string,
    archive: ArchiveDescription,
    keep: number,
) {
    if (!statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            msg.get("err.noneExistDestination", {
                path: destination,
            }),
        );
    }

    const archivePath = path.join(destination, archive.fullFilename);
    const hashPath = `${archivePath}.sha256`;

    try {
        const archiveData = await writeArchive(
            sources,
            createWriteStream(archivePath),
            archive.compression,
        );
        await writeFile(
            hashPath,
            `${archiveData.hash}  ${archive.fullFilename}\n`,
        );

        if ((await stat(archivePath))?.size !== archiveData.size) {
            throw new Error(
                msg.get("err.sizeMismatch", {
                    path: archivePath,
                }),
            );
        }

        logSuccess(
            msg.get("success.archiveCreated", {
                path: archivePath,
                size: formatBytes(archiveData.size),
            }),
        );

        if (archiveData.warnings > 0)
            process.exitCode = constants.exitCodes.incomplete;
    } catch (error) {
        await unlink(archivePath).catch(() => {
            logWarning(
                msg.get("warn.deleteFailed", {
                    path: archivePath,
                }),
            );
        });
        await unlink(hashPath).catch(() => {
            logWarning(
                msg.get("warn.deleteFailed", {
                    path: hashPath,
                }),
            );
        });
        throw error;
    }

    if (keep <= 0) return;

    const fileNames = (await readdir(destination, { withFileTypes: true }))
        ?.filter((x) => x.isFile())
        ?.map((x) => x.name);

    for (const name of findOldArchives(
        fileNames,
        archive.prefix,
        archive.extension,
        keep,
    )) {
        const filePath = path.join(destination, name);
        const hashFilePath = `${filePath}.sha256`;

        let failed = false;

        if (fileNames.includes(name))
            await unlink(filePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: filePath,
                };
                logWarning(
                    formatKnownError(error, params) ??
                        msg.get("warn.deleteFailed", params),
                );
            });

        if (fileNames.includes(`${name}.sha256`))
            await unlink(hashFilePath).catch((error) => {
                failed = true;

                const params: MessageParams = {
                    path: hashFilePath,
                };
                logWarning(
                    formatKnownError(error, params) ??
                        msg.get("warn.deleteFailed", params),
                );
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
    const archivePath = path.posix.join(destination, archive.fullFilename);
    const hashPath = `${archivePath}.sha256`;

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

        try {
            const archiveData = await writeArchive(
                sources,
                sftp.createWriteStream(archivePath),
                archive.compression,
            );

            if ((await sftp.stat(archivePath))?.size !== archiveData.size) {
                throw new Error(
                    msg.get("err.sizeMismatch", {
                        path: archivePath,
                    }),
                );
            }

            await sftp.put(
                Buffer.from(`${archiveData.hash}  ${archive.fullFilename}\n`),
                hashPath,
            );

            logSuccess(
                msg.get("success.archiveCreated", {
                    path: archivePath,
                    size: formatBytes(archiveData.size),
                }),
            );

            if (archiveData.warnings > 0)
                process.exitCode = constants.exitCodes.incomplete;
        } catch (error) {
            await sftp.delete(archivePath).catch(() => {});
            await sftp.delete(hashPath).catch(() => {});
            throw error;
        }

        if (keep <= 0) return;

        const fileNames = (await sftp.list(destination))
            ?.filter((x) => x.type === "-")
            ?.map((x) => x.name);

        for (const name of findOldArchives(
            fileNames,
            archive.prefix,
            archive.extension,
            keep,
        )) {
            const filePath = path.posix.join(destination, name);
            const hashFilePath = `${filePath}.sha256`;

            let failed = false;

            if (fileNames.includes(name))
                await sftp.delete(filePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: filePath,
                    };
                    logWarning(
                        formatKnownError(error, params) ??
                            msg.get("warn.deleteFailed", params),
                    );
                });

            if (fileNames.includes(`${name}.sha256`))
                await sftp.delete(hashFilePath).catch((error) => {
                    failed = true;

                    const params: MessageParams = {
                        path: hashFilePath,
                    };
                    logWarning(
                        formatKnownError(error, params) ??
                            msg.get("warn.deleteFailed", params),
                    );
                });

            if (failed) continue;

            logSuccess(msg.get("success.archiveDeleted", { path: filePath }));
        }
    } finally {
        await sftp.end().catch(() => {});
    }
}
