import { google } from "googleapis";
import fs from "fs/promises";
import readline from "readline/promises";
import process from "process";

const STATE_DIR =
    process.env.GMAIL_STATE_DIR ||
    "/opt/knowledge-agent/gmail";

const CREDENTIALS_PATH =
    `${STATE_DIR}/credentials.json`;

const TOKEN_PATH =
    `${STATE_DIR}/token.json`;

const SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly"
];

async function loadCredentials() {
    const raw =
        await fs.readFile(
            CREDENTIALS_PATH,
            "utf8"
        );

    const credentials =
        JSON.parse(raw);

    return (
        credentials.installed ||
        credentials.web
    );
}

async function main() {
    const credentials =
        await loadCredentials();

    const redirectUri =
        credentials.redirect_uris?.[0] ||
        "urn:ietf:wg:oauth:2.0:oob";

    const oauth2Client =
        new google.auth.OAuth2(
            credentials.client_id,
            credentials.client_secret,
            redirectUri
        );

    const authUrl =
        oauth2Client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES
        });

    console.log(
        "Authorize Gmail access by opening this URL:\n"
    );

    console.log(authUrl);

    const rl =
        readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

    const code =
        await rl.question(
            "\nPaste the authorization code here: "
        );

    rl.close();

    const result =
        await oauth2Client.getToken(
            code.trim()
        );

    await fs.mkdir(
        STATE_DIR,
        {
            recursive: true,
            mode: 0o700
        }
    );

    await fs.writeFile(
        TOKEN_PATH,
        JSON.stringify(
            result.tokens,
            null,
            2
        ),
        {
            encoding: "utf8",
            mode: 0o600
        }
    );

    console.log(
        `\nGmail token saved to ${TOKEN_PATH}`
    );
}

await main();
