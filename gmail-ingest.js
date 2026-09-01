import { google } from "googleapis";
import dotenv from "dotenv";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

dotenv.config({
    path: "/opt/knowledge-agent/.env"
});

const GMAIL_ENABLED =
    String(
        process.env.GMAIL_ENABLED || "false"
    ).toLowerCase() === "true";

const STATE_DIR =
    process.env.GMAIL_STATE_DIR ||
    "/opt/knowledge-agent/gmail";

const CREDENTIALS_PATH =
    `${STATE_DIR}/credentials.json`;

const TOKEN_PATH =
    `${STATE_DIR}/token.json`;

const STATE_PATH =
    `${STATE_DIR}/state.json`;

const REPO =
    "/home/knowledge/repo";

const INGEST_WRAPPER =
    "/opt/knowledge-agent/run-gmail-ingest.sh";

const GMAIL_QUERY =
    process.env.GMAIL_QUERY ||
    "newer_than:14d -category:promotions -category:social";

const GMAIL_MAX_MESSAGES_PER_RUN =
    Number(
        process.env.GMAIL_MAX_MESSAGES_PER_RUN || 10
    );

const MAX_EMAIL_CHARS =
    Number(
        process.env.GMAIL_MAX_EMAIL_CHARS || 20000
    );

const MAX_PROCESSED_IDS =
    5000;

const FINANCIAL_SENDER_PATTERNS = [
    "bank",
    "chase",
    "capitalone",
    "capital one",
    "americanexpress",
    "american express",
    "amex",
    "citi",
    "citibank",
    "wellsfargo",
    "wells fargo",
    "bankofamerica",
    "bank of america",
    "bofa",
    "usbank",
    "u.s. bank",
    "discover",
    "synchrony",
    "barclays",
    "paypal",
    "venmo",
    "stripe",
    "square",
    "robinhood",
    "fidelity",
    "vanguard",
    "schwab",
    "etrade",
    "e-trade",
    "coinbase",
    "binance",
    "irs",
    "turbotax",
    "intuit"
];

function headerValue(message, name) {
    const headers =
        message.payload?.headers || [];

    const header =
        headers.find(
            item =>
                item.name.toLowerCase() ===
                name.toLowerCase()
        );

    return header?.value || "";
}

function decodeBase64Url(value) {
    const normalized =
        value
            .replace(/-/g, "+")
            .replace(/_/g, "/");

    return Buffer.from(
        normalized,
        "base64"
    ).toString("utf8");
}

function collectBodyParts(part, output = { plain: [], html: [] }) {
    if (!part) {
        return output;
    }

    if (
        part.mimeType === "text/plain" &&
        part.body?.data
    ) {
        output.plain.push(
            decodeBase64Url(
                part.body.data
            )
        );
    }

    if (
        part.mimeType === "text/html" &&
        part.body?.data
    ) {
        output.html.push(
            decodeBase64Url(
                part.body.data
            )
        );
    }

    for (const child of part.parts || []) {
        collectBodyParts(
            child,
            output
        );
    }

    return output;
}

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function extractBody(message) {
    const parts =
        collectBodyParts(
            message.payload
        );

    if (parts.plain.length) {
        return parts.plain.join("\n\n");
    }

    if (parts.html.length) {
        return parts.html
            .map(stripHtml)
            .filter(Boolean)
            .join("\n\n");
    }

    if (message.payload?.body?.data) {
        return decodeBase64Url(
            message.payload.body.data
        );
    }

    return message.snippet || "";
}

function isFinancialSender(from) {
    const lower =
        from.toLowerCase();

    return FINANCIAL_SENDER_PATTERNS.some(
        pattern => lower.includes(pattern)
    );
}

async function loadJson(file, fallback) {
    try {
        const raw =
            await fs.readFile(
                file,
                "utf8"
            );

        return JSON.parse(raw);

    } catch (err) {
        if (err.code === "ENOENT") {
            return fallback;
        }

        throw err;
    }
}

async function saveState(state) {
    await fs.mkdir(
        STATE_DIR,
        {
            recursive: true,
            mode: 0o700
        }
    );

    const processedIds =
        Array.from(
            new Set(
                state.processedIds || []
            )
        ).slice(
            -MAX_PROCESSED_IDS
        );

    const nextState = {
        ...state,
        processedIds,
        lastRun:
            new Date().toISOString()
    };

    await fs.writeFile(
        STATE_PATH,
        JSON.stringify(
            nextState,
            null,
            2
        ),
        {
            encoding: "utf8",
            mode: 0o600
        }
    );
}

async function createGmailClient() {
    const credentials =
        await loadJson(
            CREDENTIALS_PATH,
            null
        );

    const token =
        await loadJson(
            TOKEN_PATH,
            null
        );

    if (!credentials || !token) {
        throw new Error(
            "Gmail credentials or token missing. Run gmail-auth.js first."
        );
    }

    const clientInfo =
        credentials.installed ||
        credentials.web;

    const oauth2Client =
        new google.auth.OAuth2(
            clientInfo.client_id,
            clientInfo.client_secret,
            clientInfo.redirect_uris?.[0]
        );

    oauth2Client.setCredentials(token);

    oauth2Client.on(
        "tokens",
        async tokens => {
            const nextToken = {
                ...token,
                ...tokens
            };

            await fs.writeFile(
                TOKEN_PATH,
                JSON.stringify(
                    nextToken,
                    null,
                    2
                ),
                {
                    encoding: "utf8",
                    mode: 0o600
                }
            );
        }
    );

    return google.gmail({
        version: "v1",
        auth: oauth2Client
    });
}

async function listCandidateMessages(gmail) {
    const result =
        await gmail.users.messages.list({
            userId: "me",
            q: GMAIL_QUERY,
            maxResults: GMAIL_MAX_MESSAGES_PER_RUN
        });

    return result.data.messages || [];
}

async function fetchMessage(gmail, id) {
    const result =
        await gmail.users.messages.get({
            userId: "me",
            id,
            format: "full"
        });

    return result.data;
}

function emailToPromptBlock(message) {
    const from =
        headerValue(
            message,
            "From"
        );

    const to =
        headerValue(
            message,
            "To"
        );

    const date =
        headerValue(
            message,
            "Date"
        );

    const subject =
        headerValue(
            message,
            "Subject"
        );

    const body =
        extractBody(message).slice(
            0,
            MAX_EMAIL_CHARS
        );

    return `
--- EMAIL ${message.id} ---
From: ${from}
To: ${to}
Date: ${date}
Subject: ${subject}

${body}
--- END EMAIL ${message.id} ---
`;
}

async function runIngestCodex(prompt) {
    const tempDir =
        await fs.mkdtemp(
            path.join(
                os.tmpdir(),
                "knowledge-gmail-"
            )
        );

    const promptFile =
        path.join(
            tempDir,
            "prompt.txt"
        );

    try {
        await fs.writeFile(
            promptFile,
            prompt,
            "utf8"
        );

        await new Promise(
            (resolve, reject) => {
                const child =
                    spawn(
                        INGEST_WRAPPER,
                        [
                            promptFile
                        ],
                        {
                            cwd: REPO,
                            env: process.env,
                            stdio: [
                                "ignore",
                                "pipe",
                                "pipe"
                            ]
                        }
                    );

                child.stdout.on(
                    "data",
                    data => {
                        const text =
                            data.toString().trim();

                        if (text) {
                            console.log(text);
                        }
                    }
                );

                child.stderr.on(
                    "data",
                    data => {
                        const text =
                            data.toString().trim();

                        if (text) {
                            console.error(text);
                        }
                    }
                );

                child.on(
                    "error",
                    reject
                );

                child.on(
                    "close",
                    code => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(
                                new Error(
                                    `Gmail ingest wrapper exited with code ${code}`
                                )
                            );
                        }
                    }
                );
            }
        );

    } finally {
        await fs.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    }
}

function buildPrompt(emailBlocks) {
    return `
You are processing Gmail messages for a personal Markdown knowledge base.

Store durable knowledge, not raw email archives. Decide what should be
cataloged in the KB and what should be disregarded.

Capture useful durable facts such as deadlines, appointments, people,
organizations, contact updates, decisions, project updates, follow-ups,
policy/provider details, travel plans, warranties, and future-dated items.

If an email requires the user or another known person to respond, decide,
schedule, pay, renew, submit, review, call, email, bring something, prepare
something, or take another concrete action, add or update followups.md. Include
the email date, sender or organization, required action, owner when known, due
date if any, and status. If the follow-up has a future due date, also add or
update reminders.md.

Non-financial vendor invoices and receipts are KB-worthy when they document
services, subscriptions, infrastructure, warranties, business operations, or
renewals. For these, preserve a concise summary with vendor, invoice/receipt
number, invoice date, service period, service/product description, total
amount, support/contact context, and useful links. Examples include cloud
hosting, software subscriptions, utilities, medical/veterinary providers, home
services, travel providers, and equipment purchases.

Operational identifiers are allowed when useful. Preserve membership IDs,
registration numbers, confirmation numbers, appointment IDs, claim numbers,
policy numbers, provider names, and similar non-authentication identifiers.
USA Hockey or USAH registration numbers are allowed to store and return when
asked. Do not treat them as prohibited PII merely because they identify a
person's membership or registration.

If an email includes a future date, add or update a concise reminder in
reminders.md as appropriate.

Ignore marketing, newsletters, transient notifications, one-time codes,
password resets, authentication/security alerts, and messages that primarily
contain sensitive credentials or account-access information.

Do not store raw email text. Do not store prohibited personal information,
payment credentials, bank/card/account numbers, banking transaction details,
financial account balances, passwords, API tokens, recovery codes, or
government-issued identifiers. For allowed vendor invoices/receipts, the
invoice total, invoice number, vendor, and purchased service details are
permitted.

Search the repository before creating new files. Update existing files when
appropriate. If none of these emails contain durable KB-worthy information,
make no file changes.

Emails to evaluate:

${emailBlocks.join("\n\n")}
`;
}

async function main() {
    if (!GMAIL_ENABLED) {
        console.log(
            "Gmail ingestion disabled. Set GMAIL_ENABLED=true to enable."
        );

        return;
    }

    const gmail =
        await createGmailClient();

    const state =
        await loadJson(
            STATE_PATH,
            {
                processedIds: []
            }
        );

    const processed =
        new Set(
            state.processedIds || []
        );

    const candidates =
        await listCandidateMessages(gmail);

    const emailBlocks = [];
    const newlyProcessed = [];

    for (const candidate of candidates) {
        if (processed.has(candidate.id)) {
            continue;
        }

        const message =
            await fetchMessage(
                gmail,
                candidate.id
            );

        const from =
            headerValue(
                message,
                "From"
            );

        if (isFinancialSender(from)) {
            console.log(
                `Skipping likely financial sender: ${from}`
            );

            newlyProcessed.push(
                candidate.id
            );

            continue;
        }

        emailBlocks.push(
            emailToPromptBlock(message)
        );

        newlyProcessed.push(
            candidate.id
        );
    }

    if (!emailBlocks.length) {
        console.log(
            "No new Gmail messages to process."
        );

        await saveState({
            ...state,
            processedIds: [
                ...processed,
                ...newlyProcessed
            ]
        });

        return;
    }

    await runIngestCodex(
        buildPrompt(emailBlocks)
    );

    await saveState({
        ...state,
        processedIds: [
            ...processed,
            ...newlyProcessed
        ]
    });

    console.log(
        `Processed ${emailBlocks.length} Gmail message(s).`
    );
}

await main();
