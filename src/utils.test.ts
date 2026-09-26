import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { findOldArchives, splitGlob } from "./utils.ts";

test("findOldArchives returns the oldest archives beyond the retention count", () => {
    const names = [
        "archive-20250103-000000.tar.gz",
        "archive-20250101-000000.tar.gz",
        "archive-20250102-000000.tar.gz",
    ];
    assert.deepEqual(findOldArchives(names, "archive", ".tar.gz", 1), [
        "archive-20250101-000000.tar.gz",
        "archive-20250102-000000.tar.gz",
    ]);
});

test("findOldArchives ignores files that do not match the configured prefix", () => {
    const names = [
        "archive-20250101-000000.tar.gz",
        "archive-20250102-000000.tar.gz",
        "other-20250102-000000.tar.gz",
        "archive-20250101-000000.zip",
        "archive-20250101-000000.tar.gz.sha256",
        "archive-test.tar.gz",
    ];
    assert.deepEqual(findOldArchives(names, "archive", ".tar.gz", 1), ["archive-20250101-000000.tar.gz"]);
});

const cases = [
    {
        pattern: "/home/foo/*.txt",
        base: "/home/foo",
    },
    {
        pattern: "/home/*/files/*.txt",
        base: "/home",
    },
    {
        pattern: "/home/foo/**/*.txt",
        base: "/home/foo",
    },
    {
        pattern: "*/foo/bar.txt",
        base: ".",
    },
    {
        pattern: "/home/foo/bar.txt",
        base: "/home/foo/bar.txt",
    },
];

await test("splitGlob", async (t) => {
    for (const testCase of cases) {
        await t.test(testCase.pattern, () => {
            assert.strictEqual(splitGlob(testCase.pattern).base, path.resolve(testCase.base));
        });
    }
});
