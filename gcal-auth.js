#!/usr/bin/env node
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import process from 'node:process';
import { google } from 'googleapis';
import { sources } from './ingest/config.js';
import { credentialsDirectory } from './connectors/google-calendar/google.js';

const sourceId = process.argv[2];
if (!sourceId) {
  throw new Error('Usage: node gcal-auth.js <google-calendar-source-id>');
}

const source = (await sources()).find(
  item => item.id === sourceId && item.connector === 'google-calendar'
);
if (!source) throw new Error('Unknown Google Calendar source');

const dir = credentialsDirectory(source);
const credentialsPath = `${dir}/credentials.json`;
const tokenPath = `${dir}/token.json`;
const credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
const info = credentials.installed || credentials.web;
if (!info?.client_id || !info?.client_secret) {
  throw new Error('Invalid Google OAuth credentials');
}

const redirectUri = info.redirect_uris?.[0];
if (!redirectUri) throw new Error('Google OAuth credentials lack a redirect URI');

const oauth = new google.auth.OAuth2(
  info.client_id,
  info.client_secret,
  redirectUri
);
const scopes = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
];
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: scopes
});

console.log('\nAuthorize Google Calendar access by opening this URL:\n');
console.log(authUrl);
console.log(
  '\nAfter approval, paste either the authorization code or the complete ' +
  'redirected URL. A localhost redirect page does not need to load.'
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nAuthorization code or redirected URL: ')).trim();
rl.close();

let code = answer;
try {
  const url = new URL(answer);
  code = url.searchParams.get('code') || '';
} catch {
  // A raw authorization code is also accepted.
}
if (!code) throw new Error('Authorization response did not contain a code');

const result = await oauth.getToken(code);
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
await fs.writeFile(
  tokenPath,
  JSON.stringify(result.tokens, null, 2),
  { encoding: 'utf8', mode: 0o600 }
);
console.log(`\nGoogle Calendar token saved to ${tokenPath}`);

oauth.setCredentials(result.tokens);
const calendar = google.calendar({ version: 'v3', auth: oauth });
const calendars = [];
let pageToken;
do {
  const { data } = await calendar.calendarList.list({
    maxResults: 250,
    pageToken
  }, { timeout: 30000 });
  calendars.push(...(data.items || []).map(item => ({
    summary: item.summary,
    id: item.id,
    primary: item.primary || false,
    accessRole: item.accessRole,
    timeZone: item.timeZone
  })));
  pageToken = data.nextPageToken;
} while (pageToken);

console.log('\nAvailable calendars:\n');
console.log(JSON.stringify(calendars, null, 2));
