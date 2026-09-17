import assert from "node:assert/strict";
import { test } from "node:test";
import { findOldArchives } from "./utils.ts";

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
    assert.deepEqual(findOldArchives(names, "archive", ".tar.gz", 1), [
        "archive-20250101-000000.tar.gz",
    ]);
});
