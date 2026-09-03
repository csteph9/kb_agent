import { Bot } from "grammy";
import dotenv from "dotenv";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

dotenv.config({
    path: "/opt/knowledge-agent/.env"
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const ALLOWED_USER_IDS = new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
        .split(",")
        .map(id => Number(id.trim()))
        .filter(Number.isFinite)
);

const TELEGRAM_USER_NAMES = new Map(
    (process.env.TELEGRAM_USER_NAMES || "")
        .split(",")
        .filter(Boolean)
        .map(entry => {
            const separator = entry.indexOf(":");

            if (separator === -1) {
                return [
                    Number(entry.trim()),
                    "User"
                ];
            }

            const id = Number(
                entry.slice(0, separator).trim()
            );

            const name = entry
                .slice(separator + 1)
                .trim();

            return [
                id,
                name || "User"
            ];
        })
        .filter(([id]) => Number.isFinite(id))
);

const REPO = "/home/knowledge/repo";

const SESSION_DIR =
    "/opt/knowledge-agent/sessions";

const SESSION_TIMEOUT_MS =
    6 * 60 * 60 * 1000;

const MAX_TEXT_CHARS = 250000;

const REMINDER_TIME =
    process.env.REMINDER_TIME || "08:00";

const REMINDER_FILE =
    process.env.REMINDER_FILE || "reminders.md";

const REMINDER_WEATHER_LOCATION =
    process.env.REMINDER_WEATHER_LOCATION || "";

const REMINDER_NEWS_FEEDS =
    (
        process.env.REMINDER_NEWS_FEEDS ||
        [
            "https://feeds.bbci.co.uk/news/rss.xml",
            "https://feeds.npr.org/1001/rss.xml",
            "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"
        ].join(",")
    )
        .split(",")
        .map(feed => feed.trim())
        .filter(Boolean);

const REMINDER_DISABLED_VALUES =
    new Set([
        "0",
        "false",
        "no",
        "off",
        "disabled"
    ]);

const REMINDER_CHECK_INTERVAL_MS =
    60 * 1000;

const TELEGRAM_MESSAGE_CHUNK_SIZE =
    3900;

if (!BOT_TOKEN) {
    throw new Error(
        "TELEGRAM_BOT_TOKEN is not configured"
    );
}

if (ALLOWED_USER_IDS.size === 0) {
    throw new Error(
        "TELEGRAM_ALLOWED_USER_IDS is not configured"
    );
}

const bot = new Bot(BOT_TOKEN);


// ---------------------------------------------------------------------------
// User identity
// ---------------------------------------------------------------------------

function sessionFileFor(userId) {
    return path.join(
        SESSION_DIR,
        `${userId}.json`
    );
}

function userNameFor(userId) {
    return (
        TELEGRAM_USER_NAMES.get(userId) ||
        `Telegram user ${userId}`
    );
}

function allowedUserIds() {
    return Array.from(
        ALLOWED_USER_IDS
    ).sort(
        (a, b) => a - b
    );
}


// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

let queue = Promise.resolve();

function enqueue(fn) {
    const next = queue.then(fn, fn);

    queue = next.catch(() => {});

    return next;
}


// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
    if (!ctx.from) {
        return;
    }

    const userId = ctx.from.id;

    if (!ALLOWED_USER_IDS.has(userId)) {
        console.warn(
            `${new Date().toISOString()} ` +
            `unauthorized Telegram user ${userId}`
        );

        const text =
            ctx.message?.text || "";

        if (
            text === "/start" ||
            text.startsWith("/start@")
        ) {
            await ctx.reply(
                `This knowledge agent is private.\n\n` +
                `Your Telegram user ID is:\n` +
                `${userId}\n\n` +
                `Send this ID to the administrator ` +
                `to request access.`
            );
        }

        return;
    }

    await next();
});


// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function ensureSessionDirectory() {
    await fs.mkdir(
        SESSION_DIR,
        {
            recursive: true,
            mode: 0o700
        }
    );
}


async function loadSession(userId) {
    try {
        const raw = await fs.readFile(
            sessionFileFor(userId),
            "utf8"
        );

        const session = JSON.parse(raw);

        if (
            !session.threadId ||
            !session.lastUsed
        ) {
            return null;
        }

        const age =
            Date.now() -
            new Date(
                session.lastUsed
            ).getTime();

        if (
            !Number.isFinite(age) ||
            age >= SESSION_TIMEOUT_MS
        ) {
            console.log(
                `${new Date().toISOString()} ` +
                `Codex session expired for Telegram user ${userId}`
            );

            await clearSession(userId);

            return null;
        }

        return session;

    } catch (err) {
        if (err.code !== "ENOENT") {
            console.error(
                `Could not read session state for ${userId}:`,
                err
            );
        }

        return null;
    }
}


async function saveSession(
    userId,
    threadId
) {
    await ensureSessionDirectory();

    const state = {
        threadId,
        lastUsed:
            new Date().toISOString()
    };

    const sessionFile =
        sessionFileFor(userId);

    const tempFile =
        `${sessionFile}.tmp`;

    await fs.writeFile(
        tempFile,
        JSON.stringify(
            state,
            null,
            2
        ),
        {
            encoding: "utf8",
            mode: 0o600
        }
    );

    await fs.rename(
        tempFile,
        sessionFile
    );
}


async function clearSession(userId) {
    try {
        await fs.unlink(
            sessionFileFor(userId)
        );

        console.log(
            `${new Date().toISOString()} ` +
            `Cleared Codex session for Telegram user ${userId}`
        );

    } catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
}


// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

async function runProcess(
    command,
    args,
    options = {}
) {
    return new Promise(
        (resolve, reject) => {

            const child = spawn(
                command,
                args,
                {
                    ...options,
                    stdio: [
                        options.stdinData
                            ? "pipe"
                            : "ignore",
                        "pipe",
                        "pipe"
                    ]
                }
            );

            let stdout = "";
            let stderr = "";

            child.stdout.on(
                "data",
                data => {
                    stdout +=
                        data.toString();
                }
            );

            child.stderr.on(
                "data",
                data => {
                    stderr +=
                        data.toString();
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
                        resolve({
                            stdout,
                            stderr
                        });
                    } else {
                        reject(
                            new Error(
                                `${command} exited with code ${code}\n${stderr}`
                            )
                        );
                    }
                }
            );

            if (options.stdinData) {
                child.stdin.write(
                    options.stdinData
                );

                child.stdin.end();
            }
        }
    );
}


// ---------------------------------------------------------------------------
// Intent classifier
// ---------------------------------------------------------------------------

async function classifyIntent(
    userText,
    hasAttachment = false
) {
    const classifierPrompt = `
Classify the user's request as exactly READ or WRITE.

WRITE means fulfilling the request requires changing, adding, deleting,
organizing, processing into, correcting, or otherwise modifying the
persistent Markdown knowledge base.

READ means the request can be fulfilled by answering conversationally
without changing the persistent knowledge base.

Important rules:

- Questions about existing knowledge are READ.
- Summaries, lookups, comparisons, explanations, and conversational
  follow-ups are READ unless the user asks to save/update something.
- Casual statements are READ unless the user is asking for the
  information to be remembered, recorded, saved, added, updated, or
  otherwise incorporated into the knowledge base.
- "Remember...", "record...", "save...", "add...", "update...",
  "change...", "delete...", "remove...", "process my inbox", and
  equivalent instructions are WRITE.
- A correction intended to update stored knowledge is WRITE.
- Do not classify something WRITE merely because it contains new facts.
- An attachment is NOT automatically WRITE. Determine intent from the
  user's instruction.
- If an attachment is supplied with no meaningful instruction, default
  to WRITE because the normal behavior is to extract useful knowledge
  from it into the knowledge base.

Attachment supplied: ${hasAttachment ? "YES" : "NO"}

User request:

${userText || "[No caption or text was supplied]"}

Respond with exactly one word:

READ

or

WRITE
`;

    try {
        const result =
            await runProcess(
                "codex",
                [
                    "exec",
                    "--ephemeral",
                    "--sandbox",
                    "read-only",
                    "-C",
                    REPO,
                    "-"
                ],
                {
                    cwd: REPO,
                    env: process.env,
                    stdinData:
                        classifierPrompt
                }
            );

        const answer =
            result.stdout
                .trim()
                .toUpperCase();

        if (
            answer === "READ" ||
            answer === "WRITE"
        ) {
            return answer;
        }

        console.warn(
            `Unexpected intent classification: ${answer}`
        );

    } catch (err) {
        console.error(
            "Intent classification failed:",
            err
        );
    }

    return hasAttachment
        ? "WRITE"
        : "READ";
}


// ---------------------------------------------------------------------------
// Extract Codex thread ID
// ---------------------------------------------------------------------------

async function extractThreadId(jsonFile) {
    const raw =
        await fs.readFile(
            jsonFile,
            "utf8"
        );

    const lines =
        raw.split(/\r?\n/);

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            const event =
                JSON.parse(line);

            if (
                event.type ===
                    "thread.started" &&
                event.thread_id
            ) {
                return event.thread_id;
            }

        } catch {
            // Ignore malformed/non-JSON lines.
        }
    }

    throw new Error(
        "Codex did not return a thread_id"
    );
}


// ---------------------------------------------------------------------------
// Main conversational Codex invocation
// ---------------------------------------------------------------------------

async function runCodex(
    userId,
    prompt,
    imageFile = null,
    mode = "READ"
) {
    const tempDir =
        await fs.mkdtemp(
            path.join(
                os.tmpdir(),
                "knowledge-agent-"
            )
        );

    const outputFile =
        path.join(
            tempDir,
            "response.txt"
        );

    const jsonFile =
        path.join(
            tempDir,
            "events.jsonl"
        );

    try {
        const session =
            await loadSession(userId);

        const sessionId =
            session?.threadId || "";

        const currentUserName =
            userNameFor(userId);

        const modeInstruction =
            mode === "WRITE"
                ? `
SYSTEM FOR THIS TURN:

This request has been classified as WRITE.

You may modify the Markdown knowledge base as necessary to fulfill the
user's request. Search existing knowledge before creating duplicates.
`
                : `
SYSTEM FOR THIS TURN:

This request has been classified as READ.

Answer the user's request using the existing knowledge base and the
current conversation context.

DO NOT create, edit, delete, rename, or otherwise modify any files in
the knowledge base during this turn. This is a conversational/read-only
request.
`;

        const identityInstruction = `
CURRENT USER:

Name: ${currentUserName}
Telegram user ID: ${userId}

The request below was sent by ${currentUserName}.

Interpret first-person references such as "I", "me", "my", and "mine"
as referring to ${currentUserName}.

Do not assume that information belonging to another person in the
shared knowledge base belongs to ${currentUserName}. When storing
personal information, preserve who the information belongs to.
`;

        const finalPrompt =
            `${modeInstruction}\n` +
            `${identityInstruction}\n\n` +
            `USER REQUEST:\n\n${prompt}`;

        const args = [
            outputFile,
            sessionId,
            imageFile || "",
            jsonFile,
            mode
        ];

        await new Promise(
            (resolve, reject) => {

                const child = spawn(
                    "/opt/knowledge-agent/run-codex.sh",
                    args,
                    {
                        cwd: REPO,
                        env: process.env,
                        stdio: [
                            "pipe",
                            "pipe",
                            "pipe"
                        ]
                    }
                );

                let stderr = "";

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
                        stderr +=
                            data.toString();
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
                                    `Codex wrapper exited with code ${code}\n${stderr}`
                                )
                            );
                        }
                    }
                );

                child.stdin.write(
                    finalPrompt
                );

                child.stdin.end();
            }
        );

        if (sessionId) {
            await saveSession(
                userId,
                sessionId
            );

        } else {
            const newThreadId =
                await extractThreadId(
                    jsonFile
                );

            console.log(
                `${new Date().toISOString()} ` +
                `New Codex session ${newThreadId} ` +
                `for Telegram user ${userId}`
            );

            await saveSession(
                userId,
                newThreadId
            );
        }

        return (
            await fs.readFile(
                outputFile,
                "utf8"
            )
        ).trim();

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


// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function parseReminderTime(value) {
    const trimmed =
        String(value || "").trim();

    if (
        REMINDER_DISABLED_VALUES.has(
            trimmed.toLowerCase()
        )
    ) {
        return null;
    }

    const match =
        trimmed.match(
            /^([01]?\d|2[0-3]):([0-5]\d)$/
        );

    if (!match) {
        throw new Error(
            "REMINDER_TIME must be HH:MM in 24-hour local server time, or off"
        );
    }

    return {
        hour: Number(match[1]),
        minute: Number(match[2])
    };
}

function localDateKey(date) {
    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(
            2,
            "0"
        );

    const day =
        String(
            date.getDate()
        ).padStart(
            2,
            "0"
        );

    return `${year}-${month}-${day}`;
}

function shouldRunReminders(
    now,
    schedule,
    lastRunDate
) {
    if (!schedule) {
        return false;
    }

    const currentMinutes =
        now.getHours() * 60 +
        now.getMinutes();

    const scheduledMinutes =
        schedule.hour * 60 +
        schedule.minute;

    if (currentMinutes < scheduledMinutes) {
        return false;
    }

    return localDateKey(now) !== lastRunDate;
}

async function runReminderCodex(userId) {
    const tempDir =
        await fs.mkdtemp(
            path.join(
                os.tmpdir(),
                "knowledge-reminder-"
            )
        );

    const outputFile =
        path.join(
            tempDir,
            "response.txt"
        );

    const jsonFile =
        path.join(
            tempDir,
            "events.jsonl"
        );

    const currentUserName =
        userNameFor(userId);

    const today =
        localDateKey(
            new Date()
        );

    const weatherLocation =
        REMINDER_WEATHER_LOCATION.trim();

    const newsFeeds =
        REMINDER_NEWS_FEEDS.length
            ? REMINDER_NEWS_FEEDS
                  .map(feed => `- ${feed}`)
                  .join("\n")
            : "- No configured news feeds";

    const prompt = `
SYSTEM FOR THIS TURN:

This is the scheduled daily reminder check for the personal knowledge
base. This is a READ-only request. It should produce the daily morning
Telegram ping for the recipient.

Today is ${today}. Use the server's local date as authoritative for
date-based agenda items and reminders.

Current recipient:

Name: ${currentUserName}
Telegram user ID: ${userId}

Daily weather:

Include a short weather line for the recipient when a location is
available. The configured weather location is:

${weatherLocation || "[not configured]"}

If the configured weather location is blank, search the knowledge base
for a city/state location for this recipient. Use only city/state level
location. Do not use or expose street addresses, precise coordinates, or
other sensitive location details.

If you have a location, retrieve today's weather using the local HTTP
retrieval bridge:

/opt/knowledge-agent/http-puller.js "https://wttr.in/<URL-ENCODED-LOCATION>?format=j1"

Use the retrieved weather data to summarize today's conditions briefly.
If weather retrieval fails or no location is available, omit the weather
line rather than inventing weather.

Top news:

Retrieve current headlines from these configured public RSS feeds using
the local HTTP retrieval bridge:

${newsFeeds}

Parse the actual feed entries and include the top 10 news items total,
deduplicated across feeds. Prefer broadly important/top headlines. Each
item should include the source name and a short title. Include links
only if they fit cleanly in the Telegram message. If news retrieval
fails, say briefly that news could not be refreshed today; do not invent
headlines.

Today's agenda:

Search the knowledge base for items dated today for the recipient or
their household/family context. Include appointments, practices, games,
meetings, travel, reservations, deadlines, school items, medical or
veterinary items, errands with a today date, and other time-specific
events. Search beyond the reminder file; schedules may live in daily,
people, projects, travel, inbox, or other relevant files.

If today's agenda items exist, include a concise "Today" section with
times, names, places, and useful preparation context when known. If no
today agenda items are found, omit the section entirely. Do not invent
events.

Read the reminder source in the knowledge base. The expected reminder
file is:

${REMINDER_FILE}

If that exact file is not present, search for a clearly named reminders
file such as reminders.md, reminder.md, Reminders.md, or a reminders
file in a relevant notes directory.

Send a reminder only when the reminder file indicates something should
be delivered today or continually/daily. Date-specific reminders should
only be delivered on their specified date unless the file says they
should continue. Recurring or continual reminders should be delivered
whenever they are currently active.

Always write the exact Telegram message to send. Keep it concise and
practical.

Start with one short, friendly wake-up line addressed to the recipient
by name, and make it clear the knowledge agent is active. Make this
line feel fresh each day: light chit-chat, a small observation, or a
practical nudge based on reminders is good. You may mention weather,
travel, deadlines, or preparation only when that information is present
in the knowledge base or the reminder text. Do not invent real-world
conditions, plans, or facts. Avoid being overly cute or verbose.

After the wake-up line, present today's agenda when available. Then
present a reminder list only when at least one reminder should be
included.

Include reminders when:

- A date-specific reminder is exactly 7 days away.
- A date-specific reminder is exactly 2 days away.
- A date-specific reminder is today.
- A recurring or continual reminder is currently active.

If no reminders match those rules, do not add a reminder section, do
not say "no reminders", and do not mention the reminder file. Send only
the short wake-up/check-in line plus any available weather, today's
agenda, and news.

Do not mention Markdown file paths unless the reminder text itself
requires it.

Do not create, edit, delete, rename, or otherwise modify any files.
`;

    try {
        await new Promise(
            (resolve, reject) => {
                const child = spawn(
                    "/opt/knowledge-agent/run-codex.sh",
                    [
                        outputFile,
                        "",
                        "",
                        jsonFile,
                        "READ"
                    ],
                    {
                        cwd: REPO,
                        env: process.env,
                        stdio: [
                            "pipe",
                            "pipe",
                            "pipe"
                        ]
                    }
                );

                let stderr = "";

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
                        stderr +=
                            data.toString();
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
                                    `Reminder Codex wrapper exited with code ${code}\n${stderr}`
                                )
                            );
                        }
                    }
                );

                child.stdin.write(prompt);
                child.stdin.end();
            }
        );

        return (
            await fs.readFile(
                outputFile,
                "utf8"
            )
        ).trim();

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

async function sendDailyReminders() {
    console.log(
        `${new Date().toISOString()} scheduled reminder check starting`
    );

    for (const userId of allowedUserIds()) {
        try {
            const message =
                await runReminderCodex(userId);

            if (!message.trim()) {
                console.log(
                    `${new Date().toISOString()} ` +
                    `empty reminder message for Telegram user ${userId}`
                );

                continue;
            }

            await sendTelegramMessage(
                userId,
                message.trim()
            );

            console.log(
                `${new Date().toISOString()} ` +
                `sent reminder to Telegram user ${userId}`
            );

        } catch (err) {
            console.error(
                `Reminder check failed for Telegram user ${userId}:`,
                err
            );
        }
    }

    console.log(
        `${new Date().toISOString()} scheduled reminder check complete`
    );
}

async function sendTelegramMessage(chatId, message) {
    for (
        let start = 0;
        start < message.length;
        start += TELEGRAM_MESSAGE_CHUNK_SIZE
    ) {
        await bot.api.sendMessage(
            chatId,
            message.slice(
                start,
                start + TELEGRAM_MESSAGE_CHUNK_SIZE
            )
        );
    }
}

function startReminderScheduler() {
    const schedule =
        parseReminderTime(
            REMINDER_TIME
        );

    if (!schedule) {
        console.log(
            "Scheduled reminders are disabled."
        );

        return;
    }

    let lastRunDate = null;

    console.log(
        `Scheduled reminders enabled for ${REMINDER_TIME} local server time.`
    );

    const tick = () => {
        const now =
            new Date();

        if (
            !shouldRunReminders(
                now,
                schedule,
                lastRunDate
            )
        ) {
            return;
        }

        lastRunDate =
            localDateKey(now);

        enqueue(
            sendDailyReminders
        ).catch(
            err => {
                console.error(
                    "Scheduled reminder run failed:",
                    err
                );
            }
        );
    };

    tick();

    setInterval(
        tick,
        REMINDER_CHECK_INTERVAL_MS
    );
}


// ---------------------------------------------------------------------------
// Telegram file download
// ---------------------------------------------------------------------------

async function downloadTelegramFile(
    ctx,
    fileId,
    destination
) {
    const file =
        await ctx.api.getFile(
            fileId
        );

    if (!file.file_path) {
        throw new Error(
            "Telegram did not return a file path"
        );
    }

    const url =
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Telegram download failed: ${response.status}`
        );
    }

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    await fs.writeFile(
        destination,
        buffer
    );
}


// ---------------------------------------------------------------------------
// Text document detection
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
    ".txt",
    ".md",
    ".markdown",
    ".xml",
    ".json",
    ".jsonl",
    ".csv",
    ".tsv",
    ".html",
    ".htm",
    ".yaml",
    ".yml",
    ".log",
    ".ics",
    ".vcf",
    ".ini",
    ".conf",
    ".config",
    ".properties",
    ".env",
    ".sql",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".py",
    ".rb",
    ".php",
    ".java",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".go",
    ".rs",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".eml"
]);

const TEXT_MIME_TYPES = new Set([
    "application/json",
    "application/xml",
    "application/rss+xml",
    "application/atom+xml",
    "application/javascript",
    "application/sql",
    "application/x-yaml",
    "application/yaml",
    "application/x-ndjson"
]);

function isTextDocument(doc) {
    const filename =
        doc.file_name || "";

    const extension =
        path.extname(
            filename
        ).toLowerCase();

    const mimeType =
        (
            doc.mime_type || ""
        ).toLowerCase();

    if (
        mimeType.startsWith(
            "text/"
        )
    ) {
        return true;
    }

    if (
        TEXT_EXTENSIONS.has(
            extension
        )
    ) {
        return true;
    }

    if (
        TEXT_MIME_TYPES.has(
            mimeType
        )
    ) {
        return true;
    }

    return false;
}


// ---------------------------------------------------------------------------
// Safely read uploaded text
// ---------------------------------------------------------------------------

async function readTextDocument(file) {
    const buffer =
        await fs.readFile(file);

    // NUL bytes strongly suggest a binary file.
    if (buffer.includes(0)) {
        throw new Error(
            "Uploaded file appears to be binary rather than text"
        );
    }

    let text =
        buffer.toString("utf8");

    if (
        text.length >
        MAX_TEXT_CHARS
    ) {
        text =
            text.slice(
                0,
                MAX_TEXT_CHARS
            ) +
            "\n\n[Document truncated by knowledge agent]";
    }

    return text;
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command(
    "help",
    async ctx => {
        await ctx.reply(
`Available commands:

/start — Check that the knowledge agent is online
/status — Show your conversation session status
/new — Start a new conversation session
/sync — Force an immediate GitHub sync/rebase
/help — Show this help`
        );
    }
);


bot.command(
    "sync",
    async ctx => {
        await ctx.api.sendChatAction(
            ctx.chat.id,
            "typing"
        );

        try {
            await enqueue(
                async () => {
                    console.log(
                        `${new Date().toISOString()} ` +
                        `manual GitHub sync requested by ${ctx.from.id}`
                    );

                    return await runProcess(
                        "flock",
                        [
                            "-w",
                            "300",
                            "/tmp/knowledge-repo.lock",
                            "/opt/knowledge-agent/sync-repo.sh"
                        ],
                        {
                            cwd: REPO,
                            env: process.env
                        }
                    );
                }
            );

            console.log(
                `${new Date().toISOString()} manual GitHub sync complete`
            );

            await ctx.reply(
                "GitHub sync complete. Local knowledge base is up to date."
            );

        } catch (err) {
            console.error(
                "Manual GitHub sync failed:",
                err
            );

            await ctx.reply(
                "GitHub sync failed. Check the knowledge-agent service log for details."
            );
        }
    }
);


bot.command(
    "start",
    async ctx => {
        const name =
            userNameFor(
                ctx.from.id
            );

        await ctx.reply(
            `Knowledge agent is online. Welcome, ${name}.`
        );
    }
);


bot.command(
    "status",
    async ctx => {
        const session =
            await loadSession(
                ctx.from.id
            );

        if (!session) {
            await ctx.reply(
                "Knowledge agent is online. You have no active conversation session."
            );

            return;
        }

        const minutes =
            Math.floor(
                (
                    Date.now() -
                    new Date(
                        session.lastUsed
                    ).getTime()
                ) /
                60000
            );

        await ctx.reply(
            `Knowledge agent is online. ` +
            `Your conversation session is active; ` +
            `last used ${minutes} minute(s) ago.`
        );
    }
);


bot.command(
    "new",
    async ctx => {
        await enqueue(
            async () => {
                await clearSession(
                    ctx.from.id
                );
            }
        );

        await ctx.reply(
            "Started a new conversation. Your knowledge base is unchanged."
        );
    }
);


// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

bot.on(
    "message:photo",
    async ctx => {
        const caption =
            ctx.message.caption
                ?.trim() || "";

        const userId =
            ctx.from.id;

        console.log(
            `${new Date().toISOString()} image request from ${userId}`
        );

        await ctx.api.sendChatAction(
            ctx.chat.id,
            "typing"
        );

        try {
            const response =
                await enqueue(
                    async () => {
                        const mode =
                            await classifyIntent(
                                caption,
                                true
                            );

                        console.log(
                            `${new Date().toISOString()} ` +
                            `image classified ${mode}`
                        );

                        const tempDir =
                            await fs.mkdtemp(
                                path.join(
                                    os.tmpdir(),
                                    "knowledge-image-"
                                )
                            );

                        try {
                            const photo =
                                ctx.message.photo[
                                    ctx.message.photo.length - 1
                                ];

                            const imageFile =
                                path.join(
                                    tempDir,
                                    "image.jpg"
                                );

                            await downloadTelegramFile(
                                ctx,
                                photo.file_id,
                                imageFile
                            );

                            const prompt =
                                caption
                                    ? `
The user sent an image with this instruction:

${caption}

Read and understand the attached image and follow the user's instruction.

Do not store the source image itself in the knowledge repository.
`
                                    : `
Read and understand the attached image.

Extract useful information from it and incorporate that information into
the knowledge base.

Do not store the source image itself in the knowledge repository.
`;

                            return await runCodex(
                                userId,
                                prompt,
                                imageFile,
                                mode
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
                );

            await ctx.reply(
                response ||
                "Image processed."
            );

        } catch (err) {
            console.error(
                "Image processing failed:",
                err
            );

            await ctx.reply(
                "I couldn't process that image."
            );
        }
    }
);


// ---------------------------------------------------------------------------
// Documents
//
// PDF:
//     pdftotext -> Codex
//
// Text-based documents:
//     read directly -> Codex
//
// Original source files always remain temporary.
// ---------------------------------------------------------------------------

bot.on(
    "message:document",
    async ctx => {
        const doc =
            ctx.message.document;

        const caption =
            ctx.message.caption
                ?.trim() || "";

        const userId =
            ctx.from.id;

        const filename =
            doc.file_name ||
            "uploaded-document";

        const isPdf =
            doc.mime_type ===
                "application/pdf" ||
            filename
                .toLowerCase()
                .endsWith(".pdf");

        const isText =
            isTextDocument(doc);

        if (!isPdf && !isText) {
            await ctx.reply(
                "I currently support PDFs, images, and text-based documents such as TXT, Markdown, XML, JSON, CSV, HTML, YAML, ICS, logs, and source/config files."
            );

            return;
        }

        console.log(
            `${new Date().toISOString()} ` +
            `document request from ${userId}: ${filename}`
        );

        await ctx.api.sendChatAction(
            ctx.chat.id,
            "typing"
        );

        try {
            const response =
                await enqueue(
                    async () => {
                        const mode =
                            await classifyIntent(
                                caption,
                                true
                            );

                        console.log(
                            `${new Date().toISOString()} ` +
                            `document classified ${mode}`
                        );

                        const tempDir =
                            await fs.mkdtemp(
                                path.join(
                                    os.tmpdir(),
                                    "knowledge-document-"
                                )
                            );

                        try {
                            const extension =
                                path.extname(
                                    filename
                                );

                            const sourceFile =
                                path.join(
                                    tempDir,
                                    `document${extension}`
                                );

                            await downloadTelegramFile(
                                ctx,
                                doc.file_id,
                                sourceFile
                            );

                            let documentText;

                            if (isPdf) {
                                const textFile =
                                    path.join(
                                        tempDir,
                                        "document.txt"
                                    );

                                await runProcess(
                                    "pdftotext",
                                    [
                                        "-layout",
                                        sourceFile,
                                        textFile
                                    ],
                                    {
                                        cwd: tempDir
                                    }
                                );

                                documentText =
                                    await fs.readFile(
                                        textFile,
                                        "utf8"
                                    );

                                if (
                                    documentText.length >
                                    MAX_TEXT_CHARS
                                ) {
                                    documentText =
                                        documentText.slice(
                                            0,
                                            MAX_TEXT_CHARS
                                        ) +
                                        "\n\n[Document truncated by knowledge agent]";
                                }

                            } else {
                                documentText =
                                    await readTextDocument(
                                        sourceFile
                                    );
                            }

                            const instruction =
                                caption ||
                                `
Extract useful information from this document and incorporate it into
the knowledge base.
`;

                            const prompt =
                                `
The user supplied a document.

Filename:
${filename}

MIME type:
${doc.mime_type || "unknown"}

User instruction:

${instruction}

The uploaded source document is temporary and MUST NOT be copied into
the knowledge repository.

Interpret the document according to its format. Preserve relevant
structure and semantics when understanding XML, RSS, Atom, JSON, CSV,
calendar data, notes, source files, or other structured text.

--- BEGIN DOCUMENT CONTENT ---

${documentText}

--- END DOCUMENT CONTENT ---
`;

                            return await runCodex(
                                userId,
                                prompt,
                                null,
                                mode
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
                );

            await ctx.reply(
                response ||
                "Document processed."
            );

        } catch (err) {
            console.error(
                "Document processing failed:",
                err
            );

            await ctx.reply(
                "I couldn't process that document."
            );
        }
    }
);


// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

bot.on(
    "message:text",
    async ctx => {
        const prompt =
            ctx.message.text.trim();

        if (!prompt) {
            return;
        }

        const userId =
            ctx.from.id;

        console.log(
            `${new Date().toISOString()} text request from ${userId}`
        );

        await ctx.api.sendChatAction(
            ctx.chat.id,
            "typing"
        );

        try {
            const response =
                await enqueue(
                    async () => {
                        const mode =
                            await classifyIntent(
                                prompt,
                                false
                            );

                        console.log(
                            `${new Date().toISOString()} ` +
                            `text classified ${mode}`
                        );

                        return await runCodex(
                            userId,
                            prompt,
                            null,
                            mode
                        );
                    }
                );

            await ctx.reply(
                response ||
                "Done."
            );

        } catch (err) {
            console.error(
                "Codex processing failed:",
                err
            );

            await ctx.reply(
                "Codex encountered an error processing that request."
            );
        }
    }
);


// ---------------------------------------------------------------------------
// Global errors
// ---------------------------------------------------------------------------

bot.catch(err => {
    console.error(
        "Telegram bot error:",
        err.error
    );
});


// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await ensureSessionDirectory();

await bot.api.setMyCommands([
    {
        command: "start",
        description: "Check that the knowledge agent is online"
    },
    {
        command: "status",
        description: "Show your conversation session status"
    },
    {
        command: "new",
        description: "Start a new conversation"
    },
    {
        command: "sync",
        description: "Force GitHub synchronization"
    },
    {
        command: "help",
        description: "Show available commands"
    }
]);

console.log(
    "Knowledge Telegram bot starting..."
);

startReminderScheduler();

bot.start();
