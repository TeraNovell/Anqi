import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create } from "tar";
import { logDebug, logWarning } from "./logger.ts";
import { CompressionDescription } from "./types.ts";

dayjs.extend(customParseFormat);

export async function writeArchive(
    sources: string[],
    destination: Writable,
    compression?: CompressionDescription,
) {
    const paths = new Set<string>();

    for (const source of sources) {
        if (hasMagic(source)) {
            for await (const path of glob(source)) {
                logDebug(`Adding ${source}`);
                paths.add(path);
            }
            continue;
        }

        if (!statSync(source, { throwIfNoEntry: false })) {
            logWarning(`Source path ${source} does not exist!`);
            continue;
        }

        paths.add(source);
        logDebug(`Adding ${source}`);
    }

    if (paths.size === 0) {
        throw new Error("No files found to archive!");
    }

    const { stream, getHash, getSize } = createHashingTransform();

    await pipeline(
        create(
            {
                gzip:
                    compression?.compressor === "gzip"
                        ? { level: compression.level ?? 6 }
                        : false,
                zstd:
                    compression?.compressor === "zstd"
                        ? { level: compression.level ?? 7 }
                        : false,
                portable: true,
                strict: true,
            },
            Array.from(paths),
        ),
        stream,
        destination,
    );

    return { hash: getHash(), size: getSize() };
}

export function findOldArchives(
    names: string[],
    prefix: string,
    extension: string,
    keep: number,
) {
    if (keep <= 0) return [];

    const archives = names
        .filter((x) => isArchiveFile(x, prefix, extension))
        .sort();

    for (const name of archives) {
        logDebug(`Found ${name}`);
    }

    return archives.length <= keep
        ? []
        : archives.slice(0, archives.length - keep);
}

function createHashingTransform() {
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

function isArchiveFile(name: string, prefix: string, extension: string) {
    const expectedPrefix = `${prefix}-`;

    if (!name.startsWith(expectedPrefix) || !name.endsWith(extension))
        return false;

    const timestamp = name.slice(
        expectedPrefix.length,
        name.length - extension.length,
    );

    return dayjs(timestamp, "YYYYMMDD-HHmmss", true).isValid();
}

function hasMagic(path: string): boolean {
    return ["*", "?", "[", "]", "{", "}"].some((char) => path.includes(char));
}
