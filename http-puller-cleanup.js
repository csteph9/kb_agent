#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESPONSES = "/tmp/knowledge-http/responses";
const RESPONSE_SUFFIXES = [".response", ".json", ".error", ".tmp"];

export function responseTtlMs(env = process.env) {
    const seconds = Number(
        env.HTTP_PULLER_RESPONSE_TTL_SECONDS || 3600
    );

    if (
        !Number.isInteger(seconds) ||
        seconds < 60 ||
        seconds > 604800
    ) {
        throw new Error(
            "HTTP_PULLER_RESPONSE_TTL_SECONDS must be an integer from 60 to 604800"
        );
    }

    return seconds * 1000;
}

export async function cleanupResponses(
    directory = RESPONSES,
    {
        maxAgeMs = responseTtlMs(),
        now = Date.now()
    } = {}
) {
    let entries;

    try {
        entries = await fs.readdir(
            directory,
            { withFileTypes: true }
        );
    } catch (err) {
        if (err.code === "ENOENT") {
            return 0;
        }

        throw err;
    }

    let removed = 0;

    for (const entry of entries) {
        if (
            !entry.isFile() ||
            !RESPONSE_SUFFIXES.some(
                suffix => entry.name.endsWith(suffix)
            )
        ) {
            continue;
        }

        const file = path.join(directory, entry.name);
        const stat = await fs.stat(file);

        if (now - stat.mtimeMs < maxAgeMs) {
            continue;
        }

        await fs.rm(file, { force: true });
        removed++;
    }

    return removed;
}

async function main() {
    const removed = await cleanupResponses();
    console.log(
        `${new Date().toISOString()} removed ${removed} stale HTTP response artifact(s)`
    );
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    await main();
}
