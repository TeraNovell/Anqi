import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { pack } from "tar-stream";
import { countersStorage, formatKnownError, logDebug, logWarning } from "./log/logger.ts";
import msg from "./log/messages.ts";
import { Counters, type CompressionDescription } from "./types.ts";
import { createHashingTransform, toPosixPath } from "./utils.ts";
import { walk, type WalkEntry } from "./walker.ts";

export async function writeArchive(
    sources: string[],
    destination: Writable,
    compression?: CompressionDescription,
    exclude?: (entry: WalkEntry) => boolean,
) {
    const counters = new Counters();

    return countersStorage.run(counters, async () => {
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

            let entryCount = 0;
            let fileCount = 0;

            const directories: WalkEntry[] = [];

            // Always perform a fresh lstat immediately before writing a tar entry instead of reusing
            // the stats or dirent collected during the crawl. This ensures that the tar header reflects
            // the current filesystem state. For regular files the stats come from the opened file handle.

            for await (const entry of walk(sources, exclude)) {
                try {
                    const name = getName(entry.path);
                    const kind = entry.dirent ?? entry.stats;

                    if (kind?.isSymbolicLink()) {
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
                        const handle = await open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));

                        try {
                            const stats = await handle.stat({ bigint: true });

                            const size = Number(stats.size);
                            const mode = Number(stats.mode);

                            if (
                                stats.nlink > 1 &&
                                (process.platform !== "win32" || (stats.dev !== 0n && stats.ino !== 0n))
                            ) {
                                const inode = `${stats.dev}:${stats.ino}`;
                                const hardlinkTarget = seenHardlinks.get(inode);

                                if (hardlinkTarget) {
                                    tar.entry({
                                        name,
                                        type: "link",
                                        mode,
                                        mtime: stats.mtime,
                                        linkname: hardlinkTarget,
                                    });
                                    entryCount++;
                                    continue;
                                }

                                seenHardlinks.set(inode, name);
                            }

                            await pipeFile(
                                Readable.from(readFixedSize(handle, entry.path, size)),
                                tar.entry({
                                    name,
                                    type: "file",
                                    size,
                                    mode,
                                    mtime: stats.mtime,
                                }) as unknown as Writable,
                            );
                        } finally {
                            await handle.close();
                        }

                        entryCount++;
                        fileCount++;

                        logDebug(`Adding file: ${entry.path}`);
                    } else if (kind?.isDirectory()) {
                        directories.push(entry);
                        continue;
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
                    if (error instanceof Error && error.message.toLowerCase() === "size mismatch") {
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

            // Directories are written after their contents so that the directory entry's metadata
            // (such as mode, ownership, and timestamps) is applied after any files or subdirectories
            // beneath it have been created. Writing directories first could cause their metadata to
            // be modified again while extracting the contained entries.
            for (const entry of directories) {
                try {
                    const name = getName(entry.path);

                    const stats = await lstat(entry.path);
                    tar.entry({
                        name,
                        type: "directory",
                        mode: stats.mode,
                        mtime: stats.mtime,
                    });

                    entryCount++;

                    logDebug(`Adding directory: ${entry.path}`);
                } catch (error) {
                    // tar-stream reports this as a plain Error with no .code, so it can only be recognized by its message.
                    // Once one entry's declared size doesn't match what was actually streamed, the whole tar stream is
                    // corrupted from that point on, so this still has to abort the archive, just with a clearer message
                    // than tar-stream's own error.
                    if (error instanceof Error && error.message.toLowerCase() === "size mismatch") {
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
            tar.destroy(error instanceof Error ? error : new Error(String(error)));
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

// Convert all paths to relative paths. This prevents absolute paths inside the TAR archive from overwriting
// system files. For example, a /etc/passwd entry in the archive could otherwise overwrite /etc/passwd on the
// target system during extraction.
function getName(entryPath: string) {
    return path.posix.relative("/", toPosixPath(entryPath));
}

// The tar header declares the exact size of the file, so exactly that many bytes must follow.
// If the file grows while archiving, the additional data is ignored. If the file shrinks or
// cannot be read completely, the remaining bytes are padded with zeros to preserve the declared size.
async function* readFixedSize(handle: FileHandle, entryPath: string, size: number) {
    const chunkSize = 64 * 1024;

    let read = 0;

    try {
        if (size > 0) {
            for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
                read += chunk.length;
                yield chunk;
            }
        }
    } catch {
        // Handled below by padding the missing part.
    }

    if (read < size) {
        logWarning(msg.get("err.fileChangedWhileArchiving", { path: entryPath }));

        while (read < size) {
            const length = Math.min(chunkSize, size - read);
            yield Buffer.alloc(length);
            read += length;
        }
    }
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
