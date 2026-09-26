import { positive } from '../../ingest/config.js';
import {
  createGoogleCalendarClient,
  eventItem,
  writableCalendarIds
} from './google.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createConnector(source, { calendarClient } = {}) {
  const config = source.config || {};
  const calendarIds = config.calendarIds;
  if (!Array.isArray(calendarIds) || calendarIds.length === 0) {
    throw new Error('Google Calendar requires calendarIds');
  }
  if (calendarIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('Invalid Google Calendar calendarIds');
  }

  const lookbackDays = config.lookbackDays === 0
    ? 0
    : positive(config.lookbackDays, 30, 3650);
  const lookaheadDays = positive(config.lookaheadDays, 365, 3650);
  const writable = writableCalendarIds(source);
  for (const id of writable) {
    if (!calendarIds.includes(id)) {
      throw new Error('Writable calendars must also be ingested');
    }
  }

  let connection;
  async function client() {
    connection ||= await createGoogleCalendarClient(source, calendarClient);
    return connection.api;
  }

  return {
    async check() {
      const api = await client();
      for (const calendarId of calendarIds) {
        const { data } = await api.calendarList.get(
          { calendarId },
          { timeout: 30000 }
        );
        if (
          writable.has(calendarId) &&
          !['writer', 'owner'].includes(data.accessRole)
        ) {
          throw new Error('Configured writable calendar lacks write access');
        }
      }
      await connection.flush();
    },

    async close() {
      await connection?.flush();
    },

    async fetchPage({ cursor, limit, has }) {
      const api = await client();
      const now = Date.now();
      const state = cursor && typeof cursor === 'object'
        ? cursor
        : {
            calendarIndex: 0,
            pageToken: null,
            timeMin: new Date(now - lookbackDays * DAY_MS).toISOString(),
            timeMax: new Date(now + lookaheadDays * DAY_MS).toISOString()
          };
      let calendarIndex = Number(state.calendarIndex) || 0;
      let pageToken = state.pageToken || null;
      const items = [];

      while (calendarIndex < calendarIds.length && items.length < limit) {
        const calendarId = calendarIds[calendarIndex];
        const { data } = await api.events.list({
          calendarId,
          maxResults: Math.min(limit - items.length, 2500),
          pageToken: pageToken || undefined,
          showDeleted: true,
          singleEvents: false,
          timeMin: state.timeMin,
          timeMax: state.timeMax
        }, { timeout: 30000 });

        for (const event of data.items || []) {
          const item = eventItem(calendarId, event, {
            includeAttendees: config.includeAttendees !== false
          });
          if (!has(item.externalId, item.revision)) items.push(item);
        }

        if (data.nextPageToken) {
          pageToken = data.nextPageToken;
          await connection.flush();
          return {
            items,
            cursor: {
              calendarIndex,
              pageToken,
              timeMin: state.timeMin,
              timeMax: state.timeMax
            }
          };
        }

        calendarIndex++;
        pageToken = null;
      }

      await connection.flush();
      return {
        items,
        cursor: calendarIndex < calendarIds.length
          ? {
              calendarIndex,
              pageToken,
              timeMin: state.timeMin,
              timeMax: state.timeMax
            }
          : null
      };
    }
  };
}
