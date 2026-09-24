import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { extract, type Header } from "tar-stream";
import { writeArchive } from "./writer.ts";

async function makeFixtureDir(t: TestContext): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "anqi-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

// Reads every entry back out of a tar buffer, so tests can assert on what writeArchive actually produced instead of
// just that it did not throw.
function readEntries(tarBuffer: Buffer): Promise<Header[]> {
    return new Promise((resolve, reject) => {
        const entries: Header[] = [];
        const ex = extract();

        ex.on("entry", (header, stream, next) => {
            entries.push(header);
            stream.on("end", next);
            stream.resume();
        });
        ex.on("finish", () => resolve(entries));
        ex.on("error", reject);

        ex.end(tarBuffer);
    });
}

async function archive(sources: string[]): Promise<Header[]> {
    const chunks: Buffer[] = [];
    const destination = new PassThrough();
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));

    await writeArchive(sources, destination);

    return readEntries(Buffer.concat(chunks));
}

test("writeArchive keeps a broken symlink instead of silently dropping it", async (t) => {
    const root = await makeFixtureDir(t);
    const brokenLink = path.join(root, "broken-link");
    await symlink(path.join(root, "does-not-exist"), brokenLink);

    const entries = await archive([root]);

    const entry = entries.find((e) => e.name.endsWith("broken-link"));
    assert.ok(entry, "broken-link should be present in the archive");
    assert.equal(entry.type, "symlink");
    assert.equal(entry.linkname, path.join(root, "does-not-exist"));
});

test("writeArchive lists a symlinked directory but doesn't traverse into it a second time", async (t) => {
    const root = await makeFixtureDir(t);
    const real = path.join(root, "real");
    await mkdir(real);
    await writeFile(path.join(real, "file.txt"), "content");
    await symlink(real, path.join(root, "link-to-real"));

    const entries = await archive([root]);

    const linkEntry = entries.find((e) => path.basename(e.name) === "link-to-real");
    assert.ok(linkEntry, "the symlink itself should be listed");
    assert.equal(linkEntry.type, "symlink");

    const fileEntries = entries.filter((e) => path.basename(e.name) === "file.txt");
    assert.equal(
        fileEntries.length,
        1,
        "file.txt must only appear once, via the real directory, not a second time through the symlink",
    );
});

test("writeArchive stores a hardlinked file's content once and links the rest", async (t) => {
    const root = await makeFixtureDir(t);
    const original = path.join(root, "original.txt");
    await writeFile(original, "shared content");
    await link(original, path.join(root, "hardlink.txt"));

    const entries = await archive([root]);

    // Whichever of the two names the crawler happens to visit first becomes the "file" entry with real content. The
    // other becomes a link entry pointing back to it. Which name ends up in which role depends on readdir order, not
    // creation order, so this only asserts the shape: exactly one real file, exactly one link back to it.
    const named = (name: string) => entries.find((e) => path.basename(e.name) === name);
    const originalEntry = named("original.txt");
    const hardlinkEntry = named("hardlink.txt");

    assert.ok(originalEntry);
    assert.ok(hardlinkEntry);

    const [fileEntry, linkEntry] =
        originalEntry.type === "file" ? [originalEntry, hardlinkEntry] : [hardlinkEntry, originalEntry];

    assert.equal(fileEntry.type, "file");
    assert.equal(linkEntry.type, "link");
    assert.equal(linkEntry.linkname, fileEntry.name);
});

test(
    "writeArchive skips a named pipe with a warning instead of hanging on it",
    { skip: process.platform === "win32" },
    async (t) => {
        const root = await makeFixtureDir(t);
        execFileSync("mkfifo", [path.join(root, "pipe")]);
        await writeFile(path.join(root, "file.txt"), "content");

        const entries = await Promise.race([
            archive([root]),
            new Promise<never>((_, reject) => {
                setTimeout(
                    () => reject(new Error("writeArchive did not return, likely hung reading the named pipe")),
                    5000,
                ).unref();
            }),
        ]);

        assert.ok(!entries.some((e) => path.basename(e.name) === "pipe"));
        assert.ok(entries.some((e) => path.basename(e.name) === "file.txt"));
    },
);

test("writeArchive skips a source that doesn't exist and still archives the other sources", async (t) => {
    const root = await makeFixtureDir(t);
    await writeFile(path.join(root, "file.txt"), "content");

    const entries = await archive([path.join(root, "does-not-exist"), root]);

    assert.ok(entries.some((e) => path.basename(e.name) === "file.txt"));
});
