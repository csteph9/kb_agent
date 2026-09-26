import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnector } from '../connectors/google-calendar/connector.js';
import {
  eventItem,
  idempotentEventId
} from '../connectors/google-calendar/google.js';
import { validateSource } from '../ingest/config.js';

function source(config = {}) {
  return validateSource({
    id: 'gcal',
    connector: 'google-calendar',
    enabled: true,
    config: {
      calendarIds: ['primary', 'family@example.test'],
      writeEnabled: true,
      writableCalendarIds: ['primary'],
      ...config
    }
  });
}

test('Google Calendar connector scans configured calendars and preserves event structure', async () => {
  const calls = [];
  const api = {
    calendarList: { get: async () => ({ data: { accessRole: 'owner' } }) },
    events: {
      list: async args => {
        calls.push(args);
        return {
          data: {
            items: [{
              id: args.calendarId === 'primary' ? 'known' : 'new',
              etag: `etag-${args.calendarId}`,
              status: args.calendarId === 'primary' ? 'confirmed' : 'cancelled',
              summary: 'Practice',
              description: 'Bring water',
              start: { dateTime: '2026-09-26T17:00:00-07:00' },
              end: { dateTime: '2026-09-26T18:00:00-07:00' },
              recurrence: ['RRULE:FREQ=WEEKLY'],
              updated: '2026-09-25T10:00:00Z'
            }]
          }
        };
      }
    }
  };
  const connector = await createConnector(source(), { calendarClient: api });
  const result = await connector.fetchPage({
    cursor: null,
    limit: 10,
    has: id => id === 'primary:known'
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].singleEvents, false);
  assert.equal(calls[0].showDeleted, true);
  assert.equal(result.cursor, null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].externalId, 'family@example.test:new');
  assert.equal(result.items[0].content.structured.event.status, 'cancelled');
  assert.deepEqual(
    result.items[0].content.structured.event.recurrence,
    ['RRULE:FREQ=WEEKLY']
  );
});

test('Google Calendar write checks require provider write access', async () => {
  const connector = await createConnector(source(), {
    calendarClient: {
      calendarList: {
        get: async ({ calendarId }) => ({
          data: { accessRole: calendarId === 'primary' ? 'reader' : 'owner' }
        })
      }
    }
  });
  await assert.rejects(
    () => connector.check(),
    /lacks write access/
  );
});

test('Google event revisions and idempotent create IDs are stable', () => {
  const event = {
    id: 'event-1',
    etag: 'etag-1',
    summary: 'Dinner',
    start: { dateTime: '2026-09-26T18:00:00-07:00' },
    end: { dateTime: '2026-09-26T19:00:00-07:00' }
  };
  assert.equal(
    eventItem('primary', event).revision,
    eventItem('primary', event).revision
  );
  const first = idempotentEventId('gcal', 'primary', 'request-12345');
  assert.equal(first, idempotentEventId('gcal', 'primary', 'request-12345'));
  assert.notEqual(first, idempotentEventId('gcal', 'primary', 'request-67890'));
  assert.match(first, /^kb[0-9a-f]+$/);
});
