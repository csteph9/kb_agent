#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import dns from "dns/promises";
import net from "net";

const BASE = "/tmp/knowledge-http";
const REQUESTS = path.join(BASE, "requests");
const RESPONSES = path.join(BASE, "responses");

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30000;

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36";

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const parts = ip.split(".").map(Number);

        return (
            parts[0] === 10 ||
            parts[0] === 127 ||
            parts[0] === 0 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168)
        );
    }

    if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();

        return (
            lower === "::1" ||
            lower === "::" ||
            lower.startsWith("fc") ||
            lower.startsWith("fd") ||
            lower.startsWith("fe80:")
        );
    }

    return true;
}

async function validatePublicUrl(rawUrl) {
    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("Invalid URL");
    }

    if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
    ) {
        throw new Error(
            "Only HTTP and HTTPS URLs are supported"
        );
    }

    if (url.username || url.password) {
        throw new Error(
            "URLs containing credentials are not supported"
        );
    }

    if (
        url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost")
    ) {
        throw new Error(
            "Localhost URLs are not allowed"
        );
    }

    const addresses =
        await dns.lookup(
            url.hostname,
            { all: true }
        );

    if (!addresses.length) {
        throw new Error(
            "Hostname did not resolve"
        );
    }

    for (const result of addresses) {
        if (isPrivateIp(result.address)) {
            throw new Error(
                `Private/local address is not allowed: ${result.address}`
            );
        }
    }

    return url;
}

async function fetchResource(rawUrl) {
    const url =
        await validatePublicUrl(rawUrl);

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            TIMEOUT_MS
        );

    let response;

    try {
        response =
            await fetch(
                url,
                {
                    method: "GET",
                    redirect: "follow",
                    signal:
                        controller.signal,
                    headers: {
                        "User-Agent":
                            USER_AGENT,

                        "Accept":
                            "text/html,application/xhtml+xml," +
                            "application/xml;q=0.9," +
                            "application/rss+xml," +
                            "application/atom+xml," +
                            "application/json;q=0.9," +
                            "text/plain;q=0.8,*/*;q=0.5",

                        "Accept-Language":
                            "en-US,en;q=0.9",

                        "Cache-Control":
                            "no-cache",

                        "Pragma":
                            "no-cache"
                    }
                }
            );

    } finally {
        clearTimeout(timeout);
    }

    /*
     * fetch() follows redirects automatically. Validate the final
     * destination as well so a public URL cannot redirect us into
     * localhost/private infrastructure.
     */
    await validatePublicUrl(
        response.url
    );

    const contentType =
        response.headers.get(
            "content-type"
        ) || "unknown";

    if (!response.ok) {
        let body = "";

        try {
            body =
                (await response.text())
                    .slice(0, 4000);
        } catch {
            // Ignore.
        }

        throw new Error(
            `HTTP ${response.status} ${response.statusText}` +
            (body
                ? `\n\n${body}`
                : "")
        );
    }

    const reader =
        response.body.getReader();

    const chunks = [];
    let total = 0;

    while (true) {
        const {
            done,
            value
        } = await reader.read();

        if (done) {
            break;
        }

        total += value.length;

        if (total > MAX_BYTES) {
            await reader.cancel();

            throw new Error(
                `Response exceeded ${MAX_BYTES} bytes`
            );
        }

        chunks.push(value);
    }

    return {
        finalUrl: response.url,
        contentType,
        body: Buffer.concat(chunks)
    };
}

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
            responseFile,
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
