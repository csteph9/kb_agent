#!/usr/bin/env node

import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

const BASE = "/tmp/knowledge-http";
const REQUESTS = path.join(BASE, "requests");
const RESPONSES = path.join(BASE, "responses");

const WAIT_MS = 35000;
const POLL_MS = 100;

const rawUrl = process.argv[2];

if (!rawUrl) {
    console.error(
        "Usage: http-puller.js <URL>"
    );

    process.exit(1);
}

let parsedUrl;

try {
    parsedUrl =
        new URL(rawUrl);
} catch {
    console.error(
        "Invalid URL"
    );

    process.exit(1);
}

if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:"
) {
    console.error(
        "Only HTTP and HTTPS URLs are supported"
    );

    process.exit(1);
}

const id =
    crypto.randomBytes(16)
        .toString("hex");

const requestFile =
    path.join(
        REQUESTS,
        `${id}.request`
    );

const responseFile =
    path.join(
        RESPONSES,
        `${id}.response`
    );

const metadataFile =
    path.join(
        RESPONSES,
        `${id}.json`
    );

const errorFile =
    path.join(
        RESPONSES,
        `${id}.error`
    );

await fs.mkdir(
    REQUESTS,
    {
        recursive: true
    }
);

await fs.mkdir(
    RESPONSES,
    {
        recursive: true
    }
);

await fs.writeFile(
    requestFile,
    JSON.stringify({
        url: rawUrl
    }),
    {
        mode: 0o600
    }
);

const started =
    Date.now();

while (
    Date.now() - started <
    WAIT_MS
) {
    try {
        const error =
            await fs.readFile(
                errorFile,
                "utf8"
            );

        console.error(
            error
        );

        await fs.rm(
            errorFile,
            {
                force: true
            }
        );

        process.exit(2);

    } catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }

    try {
        const body =
            await fs.readFile(
                responseFile
            );

        /*
         * Metadata is useful diagnostically but does not need to be
         * emitted into Codex's document stream.
         */
        try {
            const metadata =
                JSON.parse(
                    await fs.readFile(
                        metadataFile,
                        "utf8"
                    )
                );

            console.error(
                `Retrieved ${metadata.bytes} bytes from ${metadata.finalUrl}`
            );

            console.error(
                `Content-Type: ${metadata.contentType}`
            );

        } catch {
            // Metadata is optional.
        }

        process.stdout.write(
            body
        );

        await fs.rm(
            responseFile,
            {
                force: true
            }
        );

        await fs.rm(
            metadataFile,
            {
                force: true
            }
        );

        process.exit(0);

    } catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                POLL_MS
            )
    );
}

console.error(
    "Timed out waiting for HTTP puller service"
);

process.exit(3);
