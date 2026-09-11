import { createWriteStream, statSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { ArchiveDescription } from "./types.ts";
import { findOldArchives, writeArchive } from "./utils.ts";

export async function createLocalArchive(
    sources: string[],
    destination: string,
    archiveDescription: ArchiveDescription,
    compress: boolean,
    keep: number,
) {
    if (!statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            `Destination ${destination} is not a directory or does not exist!`,
        );
    }

    const archivePath = path.join(destination, archiveDescription.fullFilename);
    const hashPath = `${archivePath}.sha256`;

    try {
        const archiveData = await writeArchive(
            sources,
            createWriteStream(archivePath),
            compress,
        );
        await writeFile(
            hashPath,
            `${archiveData.hash.digest("hex")}  ${archiveDescription.fullFilename}\n`,
        );

        console.log(`Backup created at ${archivePath}`, archiveData.size);
    } catch (error) {
        await unlink(archivePath).catch(() => {});
        await unlink(hashPath).catch(() => {});
        throw error;
    }

    if (keep <= 0) return;

    const fileNames = (await readdir(destination, { withFileTypes: true }))
        ?.filter((x) => x.isFile())
        ?.map((x) => x.name);

    for (const name of findOldArchives(
        fileNames,
        archiveDescription.prefix,
        archiveDescription.extension,
        keep,
    )) {
        const filePath = path.join(destination, name);
        await unlink(filePath);

        if (fileNames.includes(`${name}.sha256`))
            await unlink(`${filePath}.sha256`);

        console.log(`Backup deleted at ${filePath}`);
    }
}

export async function createSftpArchive(
    sources: string[],
    destination: string,
    archiveDescription: ArchiveDescription,
    compress: boolean,
    keep: number,
    sftpConfig: SftpClient.ConnectOptions,
) {
    const archivePath = path.posix.join(
        destination,
        archiveDescription.fullFilename,
    );
    const hashPath = `${archivePath}.sha256`;

    const sftp = new SftpClient();

    try {
        await sftp.connect(sftpConfig);

        try {
            const archiveData = await writeArchive(
                sources,
                sftp.createWriteStream(archivePath),
                compress,
            );

            if ((await sftp.stat(archivePath))?.size !== archiveData.size) {
                throw new Error(
                    `File size mismatch after upload for ${archivePath}`,
                );
            }

            await sftp.put(
                Buffer.from(
                    `${archiveData.hash.digest("hex")}  ${archiveDescription.fullFilename}\n`,
                ),
                hashPath,
            );

            console.log(`Backup created at ${archivePath}`, archiveData.size);
        } catch (error) {
            await sftp.delete(archivePath).catch(() => {});
            await sftp.delete(hashPath).catch(() => {});

            await sftp.end();

            throw error;
        }

        if (keep <= 0) return;

        const fileNames = (await sftp.list(destination))
            ?.filter((x) => x.type === "-")
            ?.map((x) => x.name);

        for (const name of findOldArchives(
            fileNames,
            archiveDescription.prefix,
            archiveDescription.extension,
            keep,
        )) {
            const filePath = path.posix.join(destination, name);
            await sftp.delete(filePath);

            if (fileNames.includes(`${name}.sha256`)) {
                await sftp.delete(`${filePath}.sha256`);
            }
            console.log(`Backup deleted at ${filePath}`);
        }
    } finally {
        await sftp.end();
    }
}
