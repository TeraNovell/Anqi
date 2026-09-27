import assert from "node:assert/strict";
import { test } from "node:test";
import { findOldArchives } from "./utils.ts";

test("findOldArchives returns the oldest archives beyond the retention count", () => {
    const names = ["archive-20250103-000000.zip", "archive-20250101-000000.zip", "archive-20250102-000000.zip"];
    assert.deepEqual(findOldArchives(names, "archive", ".zip", 1), [
        "archive-20250101-000000.zip",
        "archive-20250102-000000.zip",
    ]);
});

test("findOldArchives ignores files that do not match the configured prefix", () => {
    const names = [
        "archive-20250101-000000.zip",
        "archive-20250102-000000.zip",
        "other-20250102-000000.zip",
        "archive-20250101-000000.zip.sha256",
        "archive-test.zip",
    ];
    assert.deepEqual(findOldArchives(names, "archive", ".zip", 1), ["archive-20250101-000000.zip"]);
});

test("findOldArchives deletes stale partial archives without counting them towards retention", () => {
    const names = [
        "archive-20250103-000000.zip",
        "archive-20250101-000000.zip",
        "archive-20250101-000000.part",
        "archive-20250102-000000.part",
        "archive-20250102-000000.zip",
    ];
    assert.deepEqual(findOldArchives(names, "archive", ".zip", 2), [
        "archive-20250101-000000.zip",
        "archive-20250101-000000.part",
        "archive-20250102-000000.part",
    ]);
});