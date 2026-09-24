import { walkStream, type ErrorFilterFunction, type Entry as FsWalkEntry } from "@nodelib/fs.walk";
import fg, { type Options as GlobOptions } from "fast-glob";
import { createReadStream, Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { pack } from "tar-stream";
import { formatKnownError, logDebug, logWarning } from "./log/logger.ts";
import msg from "./log/messages.ts";
import { type CompressionDescription } from "./types.ts";
import { createHashingTransform } from "./utils.ts";

const globOptions = {
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    stats: true,
    unique: true,
    suppressErrors: true,
} as GlobOptions;

export async function writeArchive(sources: string[], destination: Writable, compression?: CompressionDescription) {
    const tar = pack();
    const { stream: hasher, getHash, getSize } = createHashingTransform();

    let compressor: zlib.Gzip | zlib.ZstdCompress | null = null;
    if (compression?.compressor === "zstd") {
        compressor = zlib.createZstdCompress({
            params: {
                [zlib.constants.ZSTD_c_compressionLevel]: compression.level ?? 7,
            },
        });
    } else if (compression?.compressor === "gzip") {
        compressor = zlib.createGzip({ level: compression.level ?? 6 });
    }

    const stream = pipeline(tar, compressor ?? new PassThrough(), hasher, destination);

    try {
        const seenHardlinks = new Map<string, string>();

        let fileCount = 0;

        for await (const entry of walk(sources)) {
            try {
                // Convert all paths to relative paths. This prevents absolute paths inside the TAR archive from overwriting
                // system files. For example, a /etc/passwd entry in the archive could otherwise overwrite /etc/passwd on the
                // target system during extraction.
                let start = 0;
                while (entry.path[start] === "/") start++;
                const name = entry.path.slice(start);

                if (entry.stats?.isDirectory()) {
                    tar.entry({
                        name,
                        type: "directory",
                        mode: entry.stats.mode,
                        mtime: entry.stats.mtime,
                    });
                } else if (entry.stats?.isSymbolicLink()) {
                    tar.entry({
                        name,
                        type: "symlink",
                        mode: entry.stats.mode,
                        mtime: entry.stats.mtime,
                        linkname: await readlink(entry.path),
                    });
                } else if (entry.stats?.isFile()) {
                    if (entry.stats?.nlink > 1) {
                        const inode = `${entry.stats.dev}:${entry.stats.ino}`;
                        const hardlinkTarget = seenHardlinks.get(inode);

                        if (hardlinkTarget) {
                            tar.entry({
                                name,
                                type: "link",
                                mode: entry.stats.mode,
                                mtime: entry.stats.mtime,
                                linkname: hardlinkTarget,
                            });
                            continue;
                        }

                        seenHardlinks.set(inode, name);
                    }

                    await pipeFile(
                        createReadStream(entry.path),
                        tar.entry({
                            name,
                            type: "file",
                            size: entry.stats.size,
                            mode: entry.stats.mode,
                            mtime: entry.stats.mtime,
                        }) as unknown as Writable,
                    );

                    fileCount++;

                    logDebug(`Adding ${entry.path}`);
                }
            } catch (error) {
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

        tar.finalize();
        console.log(
            msg.get("info.addedFiles", {
                count: fileCount,
            }),
        );
    } catch (error) {
        tar.destroy(error instanceof Error ? error : new Error(String(error)));
        await stream.catch(() => {});
        throw error;
    }

    await stream;
    return { hash: getHash(), size: getSize() };
}

async function* walk(sources: readonly string[]): AsyncGenerator<WalkEntry> {
    const seenPaths = new Set<string>();

    for (const source of sources) {
        if (fg.isDynamicPattern(source)) {
            yield* resolveGlob(source, seenPaths);
            continue;
        }

        const absPath = path.resolve(source);

        let stats: Stats;

        try {
            stats = await lstat(absPath);
        } catch (error) {
            const message = formatKnownError(error, {
                path: absPath,
            });

            if (message) {
                logWarning(message);
                continue;
            }

            throw error;
        }

        if (seenPaths.has(absPath)) continue;
        seenPaths.add(absPath);

        yield {
            path: absPath,
            stats,
        };

        if (stats.isDirectory()) {
            yield* resolveDirectory(absPath, seenPaths);
        }
    }
}

async function* resolveGlob(pattern: string, seenPaths: Set<string>): AsyncGenerator<WalkEntry> {
    const stream = fg.stream(pattern, globOptions) as AsyncIterable<fg.Entry>;

    let absPath = "";

    for await (const entry of stream) {
        absPath = path.resolve(entry.path);

        if (seenPaths.has(absPath)) continue;
        seenPaths.add(absPath);

        yield { path: absPath, stats: entry.stats };
    }
}

async function* resolveDirectory(dirPath: string, seen: Set<string>): AsyncGenerator<WalkEntry> {
    const errorFilter: ErrorFilterFunction = (error) => {
        const message = formatKnownError(error, {
            path: dirPath,
        });

        if (message) {
            logWarning(message);
            return true;
        }

        throw error instanceof Error ? error : new Error(String(error));
    };

    const stream = walkStream(dirPath, {
        stats: true,
        followSymbolicLinks: false,
        throwErrorOnBrokenSymbolicLink: false,
        errorFilter,
    });

    for await (const entry of stream as AsyncIterable<FsWalkEntry>) {
        const absPath = path.resolve(entry.path);

        if (!entry.stats) {
            logWarning(
                msg.get("warn.unableToAccessNoneExistPath", {
                    path: absPath,
                }),
            );
            continue;
        }

        if (seen.has(absPath)) continue;
        seen.add(absPath);

        yield { path: absPath, stats: entry.stats };
    }
}

interface WalkEntry {
    path: string;
    stats?: Stats;
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
