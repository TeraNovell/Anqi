import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { Minimatch } from "minimatch";
import { createHash } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { logDebug } from "./log/logger.ts";

dayjs.extend(customParseFormat);

export function findOldArchives(fileNames: string[] | Set<string>, prefix: string, extension: string, keep: number) {
    if (keep <= 0) return [];

    const archives: string[] = [];

    for (const name of fileNames) {
        if (isArchiveFile(name, prefix, extension)) {
            archives.push(name);
            logDebug(`Found ${name}`);
        }
    }

    archives.sort();

    return archives.length <= keep ? [] : archives.slice(0, archives.length - keep);
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
