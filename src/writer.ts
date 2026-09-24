import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { pack } from "tar-stream";
import {
    countersStorage,
    formatKnownError,
    logDebug,
    logWarning,
} from "./log/logger.ts";
import msg from "./log/messages.ts";
import { Counters, type CompressionDescription } from "./types.ts";
import { createHashingTransform, toPosixPath } from "./utils.ts";
import { walk } from "./walker.ts";

export async function writeArchive(
    sources: string[],
    destination: Writable,
    compression?: CompressionDescription,
) {
    const counters = new Counters();

    return countersStorage.run(counters, async () => {
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
            const seenHardlinks = new Map<string, string>();

            let entryCount = 0;
            let fileCount = 0;

            for await (const entry of walk(sources)) {
                try {
                    // Convert all paths to relative paths. This prevents absolute paths inside the TAR archive from overwriting
                    // system files. For example, a /etc/passwd entry in the archive could otherwise overwrite /etc/passwd on the
                    // target system during extraction.
                    let start = path.win32.parse(entry.path).root.length;
                    const name = toPosixPath(entry.path.slice(start));
                    const kind = entry.dirent ?? entry.stats;

                    // Each branch below fetches a fresh stat right before writing the tar header, instead of reusing entry.stats or
                    // entry.dirent from the crawl. This narrows the window between discovering a file and reading it. A stale size here
                    // would make the actual bytes streamed not match the declared header size, which tar-stream treats as a fatal error
                    // that aborts the whole archive stream.
                    if (kind?.isDirectory()) {
                        const stats = await lstat(entry.path);
                        tar.entry({
                            name,
                            type: "directory",
                            mode: stats.mode,
                            mtime: stats.mtime,
                        });

                        entryCount++;
                    } else if (kind?.isSymbolicLink()) {
                        const stats = await lstat(entry.path);
                        tar.entry({
                            name,
                            type: "symlink",
                            mode: stats.mode,
                            mtime: stats.mtime,
                            linkname: await readlink(entry.path),
                        });

                        entryCount++;
                    } else if (kind?.isFile()) {
                        const stats = await lstat(entry.path);

                        if (
                            stats.nlink > 1 &&
                            (process.platform !== "win32" ||
                                (stats.dev !== 0 && stats.ino !== -1))
                        ) {
                            const inode = `${stats.dev}:${stats.ino}`;
                            const hardlinkTarget = seenHardlinks.get(inode);

                            if (hardlinkTarget) {
                                tar.entry({
                                    name,
                                    type: "link",
                                    mode: stats.mode,
                                    mtime: stats.mtime,
                                    linkname: hardlinkTarget,
                                });
                                entryCount++;
                                continue;
                            }

                            seenHardlinks.set(inode, name);
                        }

                        await pipeFile(
                            createReadStream(entry.path),
                            tar.entry({
                                name,
                                type: "file",
                                size: stats.size,
                                mode: stats.mode,
                                mtime: stats.mtime,
                            }) as unknown as Writable,
                        );

                        entryCount++;
                        fileCount++;

                        logDebug(`Adding ${entry.path}`);
                    } else {
                        logWarning(
                            msg.get("warn.unableToProcessUnknownType", {
                                path: entry.path,
                            }),
                        );
                    }
                } catch (error) {
                    // tar-stream reports this as a plain Error with no .code, so it can only be recognized by its message.
                    // Once one entry's declared size doesn't match what was actually streamed, the whole tar stream is
                    // corrupted from that point on, so this still has to abort the archive, just with a clearer message
                    // than tar-stream's own error.
                    if (
                        error instanceof Error &&
                        error.message.toLowerCase() === "size mismatch"
                    ) {
                        throw new Error(
                            msg.get("err.fileChangedWhileArchiving", {
                                path: entry.path,
                            }),
                        );
                    }

                    const message = formatKnownError(error, {
                        path: entry.path,
                    });

                    if (message) {
                        logWarning(message);
                        continue;
                    }

                    throw error;
                }
            }

            if (entryCount <= 0) throw new Error(msg.get("err.nothingAdded"));

            tar.finalize();
            console.log(
                msg.get("info.addedFiles", {
                    count: fileCount,
                }),
            );
        } catch (error) {
            tar.destroy(
                error instanceof Error ? error : new Error(String(error)),
            );
            await stream.catch(() => {});
            throw error;
        }

        await stream;
        return {
            hash: getHash(),
            size: getSize(),
            warnings: counters.warnings,
        };
    });
}

// Using pipe is faster than invoking a pipeline for every individual file added to the stream, because pipeline
// attaches additional event listeners and cleanup handlers for each file.
function pipeFile(src: Readable, dst: Writable) {
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            src.destroy();
            dst.destroy();
            reject(error);
        };

        src.on("error", onError);
        dst.on("error", onError);
        dst.on("finish", resolve);
        src.pipe(dst);
    });
}
