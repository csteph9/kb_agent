import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractDocument, stripHtml } from '../../ingest/documents.js';
import { positive, stateDir as runtimeDir, validId } from '../../ingest/config.js';
import { financialSenders } from './policy.js';

const decode = value => Buffer.from(value || '', 'base64url');
const header = (message, name) => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function parts(part, out = []) {
  if (part) { out.push(part); for (const child of part.parts || []) parts(child, out); }
  return out;
}
export async function createConnector(source, { gmailClient } = {}) {
  const config = source.config || {};
  if (source.credentialsRef && !validId(source.credentialsRef)) throw new Error('Invalid credentialsRef');
  const credentialsDir = config.stateDir || path.join(runtimeDir, 'credentials', source.credentialsRef || source.id);
  const maxChars = positive(config.maxEmailChars, 20000, 1000000);
  const maxAttachments = positive(config.maxAttachments, 5, 100);
  const maxAttachmentChars = positive(config.maxAttachmentChars, 50000, 1000000);
  if (config.query !== undefined && typeof config.query !== 'string') throw new Error('Gmail query must be text');
  let gmail = gmailClient;
  let tokenWrites = Promise.resolve();
  async function client() {
    if (gmail) return gmail;
    const credentials = JSON.parse(await fs.readFile(path.join(credentialsDir, 'credentials.json'), 'utf8'));
    let token = JSON.parse(await fs.readFile(path.join(credentialsDir, 'token.json'), 'utf8'));
    const info = credentials.installed || credentials.web;
    const auth = new google.auth.OAuth2(info.client_id, info.client_secret, info.redirect_uris?.[0]);
    auth.setCredentials(token);
    auth.on('tokens', next => {
      token = { ...token, ...next };
      const snapshot = JSON.stringify(token, null, 2);
      tokenWrites = tokenWrites.then(async () => {
        const file = path.join(credentialsDir, 'token.json');
        await fs.writeFile(file + '.tmp', snapshot, { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
      });
      tokenWrites.catch(() => {}); // Propagate via flush(), avoiding an unhandled event rejection.
    });
    gmail = google.gmail({ version: 'v1', auth });
    return gmail;
  }
  return {
    async check() { await (await client()).users.getProfile({ userId: 'me' }, { timeout: 30000 }); await tokenWrites; },
    async close() { await tokenWrites; },
    async fetchPage({ cursor, limit, has }) {
      const api = await client();
      let result;
      try {
        result = await api.users.messages.list({
          userId: 'me', q: config.query || 'newer_than:14d -category:promotions -category:social',
          maxResults: Math.min(limit, 100), pageToken: cursor || undefined
        }, { timeout: 30000 });
      } catch (error) {
        if (cursor && error.code === 400) return { items: [], cursor: null };
        throw error;
      }
      const items = [];
      for (const entry of result.data.messages || []) {
        // Gmail message content is immutable. Labels are intentionally not an ingestion revision.
        if (has(entry.id, entry.id)) continue;
        const { data: message } = await api.users.messages.get({ userId: 'me', id: entry.id, format: 'full' }, { timeout: 30000 });
        const from = header(message, 'From');
        if (financialSenders.some(pattern => from.toLowerCase().includes(pattern))) {
          items.push({ externalId: entry.id, revision: entry.id, kind: 'email', title: '', skipReason: 'financial-sender', content: { text: '' } });
          continue;
        }
        const all = parts(message.payload);
        const plain = all.filter(p => p.mimeType === 'text/plain' && !p.filename && p.body?.data);
        const html = all.filter(p => p.mimeType === 'text/html' && !p.filename && p.body?.data);
        const body = plain.length ? plain.map(p => decode(p.body.data).toString('utf8')).join('\n\n')
          : html.length ? html.map(p => stripHtml(decode(p.body.data).toString('utf8'))).join('\n\n') : message.snippet || '';
        const attachments = [];
        if (config.processAttachments !== false) {
          for (const part of all.filter(p => p.filename && (p.body?.attachmentId || p.body?.data)).slice(0, maxAttachments)) {
            if (part.body.size > 10 * 1024 * 1024) {
              attachments.push({ filename: part.filename, status: 'omitted-size-limit' }); continue;
            }
            const data = part.body.data || (await api.users.messages.attachments.get({
              userId: 'me', messageId: entry.id, id: part.body.attachmentId
            }, { timeout: 30000 })).data.data;
            // Extraction failures fail this page so the source can retry; never acknowledge incomplete extraction.
            const extracted = await extractDocument(decode(data), part.filename, part.mimeType || '', maxAttachmentChars);
            attachments.push({ filename: part.filename, mimeType: part.mimeType, ...(extracted || { status: 'unsupported' }) });
          }
        }
        items.push({
          externalId: entry.id, revision: entry.id, kind: 'email', title: header(message, 'Subject'),
          occurredAt: header(message, 'Date'),
          content: { text: body.slice(0, maxChars), truncated: body.length > maxChars },
          attachments,
          metadata: { from, to: header(message, 'To'), cc: header(message, 'Cc'), threadId: message.threadId }
        });
      }
      await tokenWrites;
      return { items, cursor: result.data.nextPageToken || null };
    }
  };
}