import { walkStream, type ErrorFilterFunction, type Entry as FsWalkEntry } from "@nodelib/fs.walk";
import fg, { type Options as GlobOptions } from "fast-glob";
import { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { formatKnownError, logWarning } from "./log/logger.ts";
import { toPosixPath } from "./utils.ts";

export async function* walk(sources: readonly string[]): AsyncGenerator<WalkEntry> {
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

// Node's own fs.glob has no option to match dotfiles, so an external library is needed. fast-glob is the only
// one that also handles symlinks correctly for a backup. With followSymbolicLinks set to false it keeps broken
// symlinks and doesn't silently drop them while also not following symlinked directories which would archive their
// contents twice, once under the symlink and once under its target.

const globOptions = {
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    objectMode: true,
    unique: true,
    suppressErrors: true,
} as GlobOptions;

async function* resolveGlob(pattern: string, seenPaths: Set<string>): AsyncGenerator<WalkEntry> {
    const stream = fg.stream(toPosixPath(pattern), globOptions) as AsyncIterable<fg.Entry>;

    let absPath = "";

    for await (const entry of stream) {
        absPath = path.resolve(entry.path);

        if (seenPaths.has(absPath)) continue;
        seenPaths.add(absPath);

        yield { path: absPath, dirent: entry.dirent };
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
        followSymbolicLinks: false,
        errorFilter,
    });

    for await (const entry of stream as AsyncIterable<FsWalkEntry>) {
        const absPath = path.resolve(entry.path);

        if (seen.has(absPath)) continue;
        seen.add(absPath);

        yield { path: absPath, dirent: entry.dirent };
    }
}

export interface WalkEntry {
    path: string;
    stats?: Stats;
    // Instead of importing fast-glob's or fs.walk's own Dirent type, this only specifies the methods actually used here.
    // fast-glob depends on an older fs.walk version, and the two Dirent types aren't assignable to each other.
    dirent?: {
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        isFile(): boolean;
    };
}
