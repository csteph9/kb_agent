import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { stateDir as runtimeDir, validId } from '../../ingest/config.js';

export function credentialsDirectory(source) {
  if (source.credentialsRef && !validId(source.credentialsRef)) {
    throw new Error('Invalid credentialsRef');
  }
  return source.config?.stateDir || path.join(
    runtimeDir,
    'credentials',
    source.credentialsRef || source.id
  );
}

export async function createGoogleCalendarClient(source, injectedClient) {
  if (injectedClient) {
    return { api: injectedClient, flush: async () => {} };
  }

  const dir = credentialsDirectory(source);
  const credentials = JSON.parse(
    await fs.readFile(path.join(dir, 'credentials.json'), 'utf8')
  );
  let token = JSON.parse(
    await fs.readFile(path.join(dir, 'token.json'), 'utf8')
  );
  const info = credentials.installed || credentials.web;
  if (!info?.client_id || !info?.client_secret) {
    throw new Error('Invalid Google OAuth credentials');
  }

  const auth = new google.auth.OAuth2(
    info.client_id,
    info.client_secret,
    info.redirect_uris?.[0]
  );
  auth.setCredentials(token);

  let tokenWrites = Promise.resolve();
  auth.on('tokens', next => {
    token = { ...token, ...next };
    const snapshot = JSON.stringify(token, null, 2);
    tokenWrites = tokenWrites.then(async () => {
      const file = path.join(dir, 'token.json');
      await fs.writeFile(file + '.tmp', snapshot, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    });
    tokenWrites.catch(() => {});
  });

  return {
    api: google.calendar({ version: 'v3', auth }),
    flush: async () => await tokenWrites
  };
}

function cleanParty(party) {
  if (!party) return undefined;
  return {
    email: party.email,
    displayName: party.displayName,
    self: party.self,
    responseStatus: party.responseStatus
  };
}

export function compactEvent(event, { includeAttendees = true } = {}) {
  const compact = {
    id: event.id,
    iCalUID: event.iCalUID,
    etag: event.etag,
    status: event.status,
    summary: event.summary || '',
    description: event.description || '',
    location: event.location || '',
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
    updated: event.updated,
    created: event.created,
    organizer: cleanParty(event.organizer),
    creator: cleanParty(event.creator),
    attendees: includeAttendees
      ? (event.attendees || []).map(cleanParty)
      : undefined,
    reminders: event.reminders,
    visibility: event.visibility,
    transparency: event.transparency,
    htmlLink: event.htmlLink,
    eventType: event.eventType
  };

  return Object.fromEntries(
    Object.entries(compact).filter(([, value]) => value !== undefined)
  );
}

export function eventItem(calendarId, event, options = {}) {
  const structured = compactEvent(event, options);
  const item = {
    externalId: `${calendarId}:${event.id}`,
    kind: 'event',
    title: event.summary || '',
    occurredAt:
      event.start?.dateTime ||
      event.start?.date ||
      event.originalStartTime?.dateTime ||
      event.originalStartTime?.date ||
      event.updated || '',
    updatedAt: event.updated || '',
    content: {
      text: event.description || '',
      structured: {
        calendarId,
        event: structured
      }
    },
    metadata: {
      calendarId,
      status: event.status || '',
      htmlLink: event.htmlLink || ''
    }
  };

  return {
    ...item,
    revision: createHash('sha256')
      .update(JSON.stringify(item))
      .digest('hex')
  };
}

export function writableCalendarIds(source) {
  if (source.config?.writeEnabled !== true) return new Set();
  return new Set(source.config.writableCalendarIds || []);
}

export function assertWritableCalendar(source, calendarId) {
  if (!writableCalendarIds(source).has(calendarId)) {
    throw new Error('Calendar is not enabled for agent writes');
  }
}

export function idempotentEventId(sourceId, calendarId, key) {
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 500) {
    throw new Error('idempotencyKey must contain 8 to 500 characters');
  }
  return 'kb' + createHash('sha256')
    .update(`${sourceId}\0${calendarId}\0${key.trim()}`)
    .digest('hex')
    .slice(0, 50);
}
