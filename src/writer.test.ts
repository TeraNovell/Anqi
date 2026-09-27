import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { BlobReader, TextWriter, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import { writeArchive } from "./writer.ts";

async function makeFixtureDir(t: TestContext): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "anqi-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

// Writes the archive to a buffer and reads the entries back from it, so tests assert on what
// writeArchive actually produced instead of just that it did not throw.
async function archiveEntries(sources: string[]): Promise<Map<string, Entry>> {
    const chunks: Buffer[] = [];
    const destination = new PassThrough();
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));

    await writeArchive(sources, destination);

    const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(Buffer.concat(chunks))])));
    const entries = await reader.getEntries();
    await reader.close();

    return new Map(entries.map((entry) => [entry.filename, entry]));
}

test("writeArchive creates an archive with the expected files and directories", async (t) => {
    const root = await makeFixtureDir(t);
    await writeFile(path.join(root, "a.txt"), "hello");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "b.txt"), "world");

    const entries = await archiveEntries([root]);
    const prefix = root.replace(/^\//, "");

    const file = entries.get(`${prefix}/a.txt`) as FileEntry | undefined;
    assert.ok(file, "a.txt should be in the archive");
    assert.equal(await file.getData(new TextWriter()), "hello");

    assert.ok(entries.get(`${prefix}/sub/`)?.directory, "sub should be stored as a directory entry");

    const nested = entries.get(`${prefix}/sub/b.txt`) as FileEntry | undefined;
    assert.ok(nested, "b.txt should be in the archive");
    assert.equal(await nested.getData(new TextWriter()), "world");
});

test("writeArchive keeps a broken symlink instead of dropping it", async (t) => {
    const root = await makeFixtureDir(t);
    const target = path.join(root, "does-not-exist");
    await symlink(target, path.join(root, "broken-link"));

    const entries = await archiveEntries([root]);
    const link = entries.get(`${root.replace(/^\//, "")}/broken-link`) as FileEntry | undefined;

    assert.ok(link, "the broken symlink should be present");
    assert.ok(link.symlink, "the entry should be marked as a symlink");
    assert.equal(await link.getData(new TextWriter()), target);
});

test("writeArchive rejects with the real error when the destination fails", async (t) => {
    const root = await makeFixtureDir(t);
    await writeFile(path.join(root, "a.txt"), "hello");

    let received = 0;
    const failing = new Writable({
        write(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            cb(received > 100 ? new Error("SIMULATED DEST FAILURE") : undefined);
        },
    });

    await assert.rejects(
        Promise.race([
            writeArchive([root], failing),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("writeArchive hung")), 5000).unref()),
        ]),
        /SIMULATED DEST FAILURE/,
    );
});