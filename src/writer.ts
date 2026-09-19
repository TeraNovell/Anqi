import { createReadStream, statSync } from "node:fs";
import { glob, lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { pack, type Pack } from "tar-stream";
import { logDebug, logWarning } from "./logger.ts";
import { CompressionDescription } from "./types.ts";
import { createHashingTransform, hasMagic } from "./utils.ts";

export async function writeArchive(
    sources: string[],
    destination: Writable,
    compression?: CompressionDescription,
) {
    const tar = pack();
    const { stream: hasher, getHash, getSize } = createHashingTransform();

    let compressor: zlib.Gzip | zlib.ZstdCompress | null = null;
    if (compression?.compressor === "zstd") {
        compressor = zlib.createZstdCompress({
            params: {
                [zlib.constants.ZSTD_c_compressionLevel]:
                    compression.level ?? 7,
            },
        });
    } else if (compression?.compressor === "gzip") {
        compressor = zlib.createGzip({ level: compression.level ?? 6 });
    }

    const stream = pipeline(
        tar,
        compressor ?? new PassThrough(),
        hasher,
        destination,
    );

    try {
        let added = 0;

        for (const source of sources) {
            if (hasMagic(source)) {
                for await (const path of glob(source)) {
                    added += await addTree(tar, path);
                }
                continue;
            }

            if (!statSync(source, { throwIfNoEntry: false })) {
                logWarning(`Source path ${source} does not exist!`);
                continue;
            }

            added += await addTree(tar, source);
        }

        if (added === 0) throw new Error("No files found to archive!");
        tar.finalize();
    } catch (error) {
        tar.destroy(error instanceof Error ? error : new Error(String(error)));
        await stream.catch(() => {});
        throw error;
    }

    await stream;
    return { hash: getHash(), size: getSize() };
}

async function addTree(tar: Pack, rootPath: string) {
    const queue = [rootPath];
    let head = 0;
    let added = 0;

    while (head < queue.length) {
        const current = queue[head++];
        const stat = await lstat(current).catch(() => null);

        if (!stat) {
            logWarning(`Skipping ${current}, it vanished before archiving`);
            continue;
        }

        let start = 0;
        while (current[start] === "/") start++;
        const name = current.slice(start);

        try {
            if (stat.isDirectory()) {
                tar.entry({
                    name,
                    type: "directory",
                    mode: stat.mode,
                    mtime: stat.mtime,
                });

                const contents = await readdir(current).catch(() => null);
                queue.push(
                    ...(contents?.map((x) => path.join(current, x)) ?? []),
                );
            } else if (stat.isSymbolicLink()) {
                tar.entry({
                    name,
                    type: "symlink",
                    mode: stat.mode,
                    mtime: stat.mtime,
                    linkname: await readlink(current),
                });
            } else if (stat.isFile()) {
                await pipeline(
                    createReadStream(current),
                    tar.entry({
                        name,
                        type: "file",
                        size: stat.size,
                        mode: stat.mode,
                        mtime: stat.mtime,
                    }),
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                logWarning(`Skipping ${current}, it vanished before archiving`);
                continue;
            }
            throw error;
        }

        logDebug(`Adding ${current}`);
        added++;
    }

    return added;
}
