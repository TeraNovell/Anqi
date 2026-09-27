import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { Minimatch } from "minimatch";
import { createHash } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import constants from "./constants.ts";
import { logDebug } from "./log/logger.ts";

dayjs.extend(customParseFormat);

export function findOldArchives(fileNames: string[] | Set<string>, prefix: string, extension: string, keep: number) {
    if (keep <= 0) return [];

    const archives: string[] = [];
    const partials: string[] = [];

    for (const name of fileNames) {
        if (isArchiveFile(name, prefix, extension)) {
            archives.push(name);
            logDebug(`Found ${name}`);
        } else if (isArchiveFile(name, prefix, constants.fileExtension.partial)) {
            partials.push(name);
        }
    }

    archives.sort();

    const staleArchives = archives.length <= keep ? [] : archives.slice(0, archives.length - keep);

    // Partial archives are leftovers of interrupted runs. They are removed once they are older than
    // the most recent complete archive, but they never count towards `keep`, so they can never
    // evict a complete one.
    const newestArchive = archives.at(-1);
    const stalePartialArchives = newestArchive ? partials.filter((name) => name < newestArchive) : [];

    return [...staleArchives, ...stalePartialArchives];
}

export function createHashingTransform() {
    const hash = createHash("sha256");
    let size = 0;

    const stream = new Transform({
        transform(chunk, _, callback) {
            hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
        },
    });

    return {
        stream,
        getHash: () => hash.digest("hex"),
        getSize: () => size,
    };
}

export function toPosixPath(location: string) {
    return process.platform === "win32" ? location.replaceAll("\\", "/") : location;
}

export function splitGlob(pattern: string, matcher = new Minimatch(pattern)) {
    const parts = matcher.slashSplit(pattern);
    const firstMagic = parts.findIndex((part) => new Minimatch(part, matcher.options).hasMagic());
    const base = path.resolve(parts.slice(0, firstMagic === -1 ? parts.length : firstMagic).join(path.sep));

    return {
        parts,
        base,
    };
}

export function isArchiveFile(name: string, prefix: string, extension: string) {
    const expectedPrefix = `${prefix}-`;

    if (!name.startsWith(expectedPrefix) || !name.endsWith(extension)) return false;

    const timestamp = name.slice(expectedPrefix.length, name.length - extension.length);

    return dayjs(timestamp, "YYYYMMDD-HHmmss", true).isValid();
}
