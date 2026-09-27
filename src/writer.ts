import { Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { constants as fsConstants, Stats } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatKnownError, logDebug, logWarning } from "./log/logger.ts";
import msg from "./log/messages.ts";
import { createHashingTransform, toPosixPath } from "./utils.ts";
import { walk, type WalkEntry } from "./walker.ts";

// ToDo: Evaluate Node.js's native ZIP api once it has matured and provides a sufficiently stable api for production
// use. If it meets the requirements, consider replacing the current ZIP implementation with the native API to reduce
// external dependencies. https://beta.docs.nodejs.org/zlib#class-zlibzipentry

export async function writeArchive(sources: string[], destination: Writable, exclude?: (entry: WalkEntry) => boolean) {
    const corruptedFiles: string[] = [];

    const { stream: hasher, getHash, getSize } = createHashingTransform();
    const stream = pipeline(hasher, destination);

    // The pipeline may fail at any time, e.g. when the destination breaks. Prevent an unhandled rejection until it is
    // awaited below.
    stream.catch(() => {});

    const zip = new ZipWriter(Writable.toWeb(hasher), { useWebWorkers: false });

    try {
        let entryCount = 0;
        let fileCount = 0;

        // Always perform a fresh lstat immediately before writing a zip entry instead of reusing the stats or
        // dirent collected during the crawl. This ensures that the header reflects the current filesystem state.
        // For regular files the stats come from the opened file handle.
        for await (const entry of walk(sources, exclude)) {
            try {
                const name = getName(entry.path);
                const kind = entry.dirent ?? entry.stats;

                if (kind?.isDirectory()) {
                    const stats = await lstat(entry.path);
                    await zip.add(`${name}/`, undefined, {
                        directory: true,
                        unixMode: stats.mode,
                        lastModDate: stats.mtime,
                    });

                    entryCount++;

                    logDebug(`Adding Directory: ${entry.path}`);
                } else if (kind?.isSymbolicLink()) {
                    const stats = await lstat(entry.path);
                    await zip.add(name, new Uint8ArrayReader(Buffer.from(await readlink(entry.path))), {
                        unixMode: stats.mode,
                        lastModDate: stats.mtime,
                    });

                    entryCount++;
                } else if (kind?.isFile()) {
                    const handle = await open(
                        entry.path,
                        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
                    );

                    try {
                        const stats = await handle.stat();

                        const reader = Readable.toWeb(
                            Readable.from(readContent(entry.path, handle, stats, corruptedFiles)),
                        ) as ReadableStream<Uint8Array>;
                        await zip.add(name, reader, {
                            unixMode: stats.mode,
                            lastModDate: stats.mtime,
                        });
                    } finally {
                        await handle.close();
                    }

                    entryCount++;
                    fileCount++;

                    logDebug(`Adding file: ${entry.path}`);
                } else {
                    logWarning(
                        msg.get("warn.unableToProcessUnknownType", {
                            path: entry.path,
                        }),
                    );
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

        if (entryCount <= 0) throw new Error(msg.get("err.nothingAdded"));

        await zip.close();
        console.log(
            msg.get("info.addedFiles", {
                count: fileCount,
            }),
        );
    } catch (error) {
        hasher.destroy(error instanceof Error ? error : new Error(String(error)));
        await stream.catch(() => {});
        throw error;
    }

    await stream;
    return {
        hash: getHash(),
        size: getSize(),
        corruptedFiles,
    };
}

// Convert all paths to relative paths. This prevents absolute paths inside the archive from overwriting system
// files. For example, a /etc/passwd entry in the archive could otherwise overwrite /etc/passwd on the target system
// during extraction.
function getName(entryPath: string) {
    return path.posix.relative("/", toPosixPath(entryPath));
}

// Reads the file up to the size it had when it was opened so that a file that keeps growing cannot make the entry
// endless. Since ZIP stores the size and checksum after the content, the archive stays valid even if the file changes
// while being read.
async function* readContent(filePath: string, handle: FileHandle, stats: Stats, corruptedFiles: string[]) {
    try {
        if (stats.size > 0) yield* handle.createReadStream({ end: stats.size - 1, autoClose: false });

        const after = await handle.stat();

        if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
            logWarning(
                msg.get("warn.fileChangedWhileArchiving", {
                    path: filePath,
                }),
            );
            corruptedFiles.push(filePath);
        }
    } catch {
        // Interrupted read (e.g. destination failure or cancelled entry). The error surfaces separately and the
        // archive is discarded.
    }
}