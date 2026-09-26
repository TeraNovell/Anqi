import { Minimatch, type MinimatchOptions } from "minimatch";
import { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { formatKnownError, logDebug, logWarning } from "./log/logger.ts";
import { splitGlob, toPosixPath } from "./utils.ts";

const globOptions = {
    dot: true,
    nonegate: true,
    nocomment: true,
    magicalBraces: true,
} as MinimatchOptions;

export async function* walk(
    sources: readonly string[],
    exclude?: (entry: WalkEntry) => boolean,
): AsyncGenerator<WalkEntry> {
    const seenPaths = new Set<string>();

    for (const source of sources) {
        if (new Minimatch(toPosixPath(source), globOptions).hasMagic()) {
            yield* resolveGlob(source, seenPaths, exclude);
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
            yield* resolveDirectory(absPath, seenPaths, exclude);
        }
    }
}

// Node's built-in fs.glob does not provide the matching behavior needed here, so Minimatch is used
// to handle pattern matching independently of filesystem traversal. This allows the walker to retain
// full control over symlinks, including broken symlinks, without following symlinked directories and
// potentially archiving the same contents twice.

async function* resolveGlob(
    pattern: string,
    seenPaths: Set<string>,
    exclude?: (entry: WalkEntry) => boolean,
): AsyncGenerator<WalkEntry> {
    pattern = toPosixPath(path.resolve(pattern));

    // If the pattern matches a directory, everything inside it should be backed up too, just like `--src <dir>` would.
    // For example the pattern "docs/*" matches the directory "docs/sub", so "docs/sub/file.txt" is included as well.
    const contentPattern = `${pattern}/**`;

    // Does the path match the pattern itself? (e.g. "docs/sub" for "docs/*")
    const entryMatcher = new Minimatch(pattern, globOptions);

    // Is the path inside something that matched? (e.g. "docs/sub/file.txt" for "docs/*")
    const contentMatcher = new Minimatch(contentPattern, globOptions);

    // Should the walker look into this directory, i.e. how deep does it need to go? It uses "<pattern>/**" so it also
    // walks into subdirectories of a match, not only the match itself.
    const descendMatcher = new Minimatch(contentPattern, { ...globOptions, partial: true });

    // The walk starts at the fixed part of the pattern before the first wildcard, e.g. "docs" for "docs/*/*.txt".
    // Nothing outside of it can match, so there is no need to look there.
    const { base } = splitGlob(pattern, entryMatcher);

    yield* resolveDirectory(
        base,
        seenPaths,
        exclude,
        (entry) => entryMatcher.match(toPosixPath(entry.path)) || contentMatcher.match(toPosixPath(entry.path)),
        (entry) => descendMatcher.match(toPosixPath(entry.path)),
    );
}

async function* resolveDirectory(
    source: string,
    seenPaths: Set<string>,
    exclude?: (entry: WalkEntry) => boolean,
    filter?: (entry: WalkEntry) => boolean,
    descend?: (entry: WalkEntry) => boolean,
): AsyncGenerator<WalkEntry> {
    let directories = [source];

    while (directories.length > 0) {
        const directory = directories.pop();
        if (!directory) continue;

        logDebug(`Walking: ${directory}`);

        let contents: Dirent<string>[] = [];

        try {
            contents = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            let location: string | undefined;

            if (error instanceof Error && "path" in error && typeof error.path === "string") {
                location = error.path;
            }

            const message = formatKnownError(error, {
                path: location ?? directory,
            });

            if (message) {
                logWarning(message);
                continue;
            }

            throw error instanceof Error ? error : new Error(String(error));
        }

        for (const dirent of contents) {
            const absPath = path.resolve(dirent.parentPath, dirent.name);

            const entry: WalkEntry = {
                path: absPath,
                dirent,
            };

            if (exclude?.(entry)) {
                logDebug(`Excluding: ${absPath}`);
                continue;
            }

            if (dirent.isDirectory() && (!descend || descend(entry))) directories.push(absPath);

            if (filter && !filter(entry)) continue;

            if (seenPaths.has(absPath)) continue;
            seenPaths.add(absPath);

            yield entry;
        }
    }
}

export interface WalkEntry {
    path: string;
    stats?: Stats;
    dirent?: Dirent;
}
