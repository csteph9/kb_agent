import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    cleanupResponses,
    responseTtlMs
} from "../http-puller-cleanup.js";

test("response TTL is configurable and validated", () => {
    assert.equal(responseTtlMs({}), 3600000);
    assert.equal(
        responseTtlMs({ HTTP_PULLER_RESPONSE_TTL_SECONDS: "120" }),
        120000
    );
    assert.throws(
        () => responseTtlMs({ HTTP_PULLER_RESPONSE_TTL_SECONDS: "10" }),
        /must be an integer/
    );
});

test("cleanup removes only stale response artifacts", async t => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "http-cleanup-test-")
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const now = Date.now();
    const old = new Date(now - 7200000);
    const stale = [
        "old.response",
        "old.json",
        "old.error",
        "old.response.tmp"
    ];

    for (const name of [...stale, "fresh.response", "keep.txt"]) {
        await fs.writeFile(path.join(directory, name), name);
    }

    for (const name of [...stale, "keep.txt"]) {
        await fs.utimes(path.join(directory, name), old, old);
    }

    assert.equal(
        await cleanupResponses(directory, {
            maxAgeMs: 3600000,
            now
        }),
        stale.length
    );
    assert.deepEqual(
        (await fs.readdir(directory)).sort(),
        ["fresh.response", "keep.txt"]
    );
});
