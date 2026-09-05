#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fetchResource } from "./ingest/http.js";

const BASE = "/tmp/knowledge-http";
const REQUESTS = path.join(BASE, "requests");
const RESPONSES = path.join(BASE, "responses");

async function writeError(id, error) {
    const output =
        path.join(
            RESPONSES,
            `${id}.error`
        );

    await fs.writeFile(
        output,
        String(
            error?.stack ||
            error?.message ||
            error
        ),
        {
            mode: 0o600
        }
    );
}

async function processRequest(filename) {
    if (!filename.endsWith(".request")) {
        return;
    }

    const id =
        filename.slice(
            0,
            -".request".length
        );

    /*
     * Request IDs are deliberately restricted so a malicious filename
     * cannot escape our response directory.
     */
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return;
    }

    const requestFile =
        path.join(
            REQUESTS,
            filename
        );

    try {
        const raw =
            await fs.readFile(
                requestFile,
                "utf8"
            );

        const request =
            JSON.parse(raw);

        if (
            typeof request.url !== "string" ||
            !request.url.trim()
        ) {
            throw new Error(
                "Request must contain a URL"
            );
        }

        console.log(
            `${new Date().toISOString()} pulling ${request.url}`
        );

        const result =
            await fetchResource(
                request.url
            );

        const responseFile =
            path.join(
                RESPONSES,
                `${id}.response`
            );

        /*
         * Metadata is written separately from the actual response body.
         */
        const metadataFile =
            path.join(
                RESPONSES,
                `${id}.json`
            );

        await fs.writeFile(
            responseFile + ".tmp",
            result.body,
            {
                mode: 0o600
            }
        );

        await fs.writeFile(
            metadataFile,
            JSON.stringify(
                {
                    requestedUrl:
                        request.url,
                    finalUrl:
                        result.finalUrl,
                    contentType:
                        result.contentType,
                    bytes:
                        result.body.length,
                    retrievedAt:
                        new Date()
                            .toISOString()
                },
                null,
                2
            ),
            {
                mode: 0o600
            }
        );

        await fs.rename(responseFile + ".tmp", responseFile);

        console.log(
            `${new Date().toISOString()} retrieved ${result.body.length} bytes`
        );

    } catch (err) {

        console.error(
            `${new Date().toISOString()} retrieval failed:`,
            err
        );

        await writeError(
            id,
            err
        );

    } finally {

        await fs.rm(
            requestFile,
            {
                force: true
            }
        );
    }
}

async function main() {
    await fs.mkdir(
        REQUESTS,
        {
            recursive: true,
            mode: 0o700
        }
    );

    await fs.mkdir(
        RESPONSES,
        {
            recursive: true,
            mode: 0o700
        }
    );

    const files =
        await fs.readdir(
            REQUESTS
        );

    for (const filename of files) {
        await processRequest(
            filename
        );
    }
}

await main();
