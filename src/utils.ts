import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create } from "tar";

export async function writeArchive(
    sources: string[],
    destination: Writable,
    compress: boolean,
) {
    const paths = new Set<string>();

    for (const source of sources) {
        if (hasMagic(source)) {
            for await (const path of glob(source)) {
                console.log(`Adding file: ${path}`);
                paths.add(path);
            }
            continue;
        }

        if (!statSync(source, { throwIfNoEntry: false })) {
            console.warn(`Source path ${source} does not exist!`);
            continue;
        }

        paths.add(source);
        console.log(`Adding file: ${source}`);
    }

    const { stream, hash, getSize } = createHashingTransform();
    await pipeline(
        create(
            {
                gzip: compress,
                portable: true,
                strict: true,
            },
            Array.from(paths),
        ),
        stream,
        destination,
    );

    return { hash, size: getSize() };
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
    return archives.length <= keep
        ? []
        : archives.slice(0, archives.length - keep);
}

export type HelpOption = {
    short?: string;
    description?: string;
};

export function generateHelp(
    options: Record<string, HelpOption>,
    description?: string,
) {
    const entries = Object.entries(options).map(([name, option]) => {
        const parts = [];

        if (option.short) parts.push(`-${option.short}`);

        parts.push(`--${name}`);

        return [parts.join(", "), option.description] as const;
    });

    const maxLength = Math.max(...entries.map(([name]) => name.length));

    const lines = [];

    if (description) lines.push(description, "");

    lines.push("Options:");

    for (const [name, description] of entries) {
        lines.push(`${name.padEnd(maxLength + 3)}${description ?? ""}`);
    }

    return lines.join("\n");
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
        hash,
        getSize: () => size,
    };
}

function isArchiveFile(
    name: string,
    prefix: string,
    extension: string,
): boolean {
    return name.startsWith(`${prefix}-`) && name.endsWith(extension);
}

function hasMagic(path: string): boolean {
    return ["*", "?", "[", "]", "{", "}"].some((char) => path.includes(char));
}
