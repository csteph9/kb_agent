#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { sources } from './ingest/config.js';
import {
  assertWritableCalendar,
  compactEvent,
  createGoogleCalendarClient,
  idempotentEventId,
  writableCalendarIds
} from './connectors/google-calendar/google.js';

const server = new McpServer(
  { name: 'knowledge-google-calendar', version: '1.0.0' },
  {
    instructions:
      'Use list/get before update or delete. Writes are limited to configured calendars. ' +
      'Pass the current ETag for updates/deletes and a stable idempotency key for creates.'
  }
);

const sourceIdSchema = z.string().min(1).describe(
  'Configured google-calendar source ID from gcal_list_sources'
);
const dateTimeSchema = z.object({
  date: z.string().optional().describe('All-day date in YYYY-MM-DD form'),
  dateTime: z.string().optional().describe('RFC3339 date-time with offset'),
  timeZone: z.string().optional().describe('IANA time zone, especially for recurrence')
});
const eventFieldsSchema = z.object({
  summary: z.string().min(1).max(1000).optional(),
  description: z.string().max(20000).optional(),
  location: z.string().max(2000).optional(),
  start: dateTimeSchema.optional(),
  end: dateTimeSchema.optional(),
  recurrence: z.array(z.string().max(2000)).max(20).optional(),
  attendees: z.array(z.object({ email: z.email() })).max(100).optional(),
  reminders: z.object({
    useDefault: z.boolean(),
    overrides: z.array(z.object({
      method: z.enum(['email', 'popup']),
      minutes: z.number().int().min(0).max(40320)
    })).max(5).optional()
  }).optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
  transparency: z.enum(['opaque', 'transparent']).optional()
});

function text(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

async function calendarSource(sourceId) {
  const source = (await sources()).find(
    item => item.id === sourceId && item.connector === 'google-calendar'
  );
  if (!source) throw new Error('Unknown Google Calendar source');
  if (!source.enabled) throw new Error('Google Calendar source is disabled');
  return source;
}

function validateDateRange(start, end) {
  if (!start || !end) throw new Error('Event start and end are required');
  const allDay = Boolean(start.date || end.date);
  if (allDay) {
    if (!start.date || !end.date || start.dateTime || end.dateTime) {
      throw new Error('All-day events require start.date and end.date only');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start.date) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end.date) ||
        end.date <= start.date) {
      throw new Error('All-day end.date must be after start.date');
    }
    return;
  }
  if (!start.dateTime || !end.dateTime ||
      !Number.isFinite(Date.parse(start.dateTime)) ||
      !Number.isFinite(Date.parse(end.dateTime)) ||
      Date.parse(end.dateTime) <= Date.parse(start.dateTime)) {
    throw new Error('Timed events require a valid end after start');
  }
}

function safeError(error) {
  if (error?.code === 404) return 'Calendar or event not found';
  if (error?.code === 403) return 'Google Calendar denied this operation';
  if (error?.code === 412) return 'Event changed since it was read; fetch it again';
  const safePrefixes = [
    'Unknown Google Calendar',
    'Google Calendar source is disabled',
    'Calendar is not enabled',
    'Event start',
    'All-day',
    'Timed events',
    'idempotencyKey',
    'Event changed',
    'Calendar deletion'
  ];
  return safePrefixes.some(prefix => error?.message?.startsWith(prefix))
    ? error.message
    : 'Google Calendar operation failed';
}

function tool(handler) {
  return async args => {
    try {
      return text(await handler(args));
    } catch (error) {
      console.error(JSON.stringify({
        component: 'gcal-mcp',
        status: 'failed',
        code: error?.code || null
      }));
      return text({ error: safeError(error) }, true);
    }
  };
}

async function withCalendar(sourceId, operation) {
  const source = await calendarSource(sourceId);
  const connection = await createGoogleCalendarClient(source);
  try {
    return await operation(source, connection.api);
  } finally {
    await connection.flush();
  }
}

server.registerTool('gcal_list_sources', {
  description: 'List configured Google Calendar sources and their write boundaries.',
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, tool(async () => (await sources())
  .filter(source => source.connector === 'google-calendar')
  .map(source => ({
    id: source.id,
    enabled: source.enabled,
    owner: source.owner || null,
    calendarIds: source.config.calendarIds,
    writableCalendarIds: [...writableCalendarIds(source)],
    allowDelete: source.config.allowDelete === true,
    sendUpdates: source.config.sendUpdates || 'none'
  }))));

server.registerTool('gcal_list_calendars', {
  description: 'List configured calendars with live Google access roles.',
  inputSchema: { sourceId: sourceIdSchema },
  annotations: { readOnlyHint: true }
}, tool(async ({ sourceId }) => withCalendar(sourceId, async (source, api) => {
  const result = [];
  for (const calendarId of source.config.calendarIds) {
    const { data } = await api.calendarList.get(
      { calendarId },
      { timeout: 30000 }
    );
    result.push({
      id: data.id,
      summary: data.summary,
      primary: data.primary || false,
      timeZone: data.timeZone,
      accessRole: data.accessRole,
      writable: writableCalendarIds(source).has(calendarId)
    });
  }
  return result;
})));

server.registerTool('gcal_list_events', {
  description: 'Find live events in a bounded date range before creating or changing one.',
  inputSchema: {
    sourceId: sourceIdSchema,
    calendarId: z.string().min(1),
    timeMin: z.string().describe('Inclusive RFC3339 lower bound'),
    timeMax: z.string().describe('Exclusive RFC3339 upper bound'),
    query: z.string().max(500).optional(),
    maxResults: z.number().int().min(1).max(100).optional()
  },
  annotations: { readOnlyHint: true }
}, tool(async ({ sourceId, calendarId, timeMin, timeMax, query, maxResults }) =>
  withCalendar(sourceId, async (source, api) => {
    if (!source.config.calendarIds.includes(calendarId)) {
      throw new Error('Calendar is not configured for this source');
    }
    const { data } = await api.events.list({
      calendarId,
      timeMin,
      timeMax,
      q: query,
      maxResults: maxResults || 50,
      singleEvents: true,
      showDeleted: false,
      orderBy: 'startTime'
    }, { timeout: 30000 });
    return (data.items || []).map(event => compactEvent(event));
  })));

server.registerTool('gcal_get_event', {
  description: 'Get the current event and ETag before an update or delete.',
  inputSchema: {
    sourceId: sourceIdSchema,
    calendarId: z.string().min(1),
    eventId: z.string().min(1)
  },
  annotations: { readOnlyHint: true }
}, tool(async ({ sourceId, calendarId, eventId }) =>
  withCalendar(sourceId, async (source, api) => {
    if (!source.config.calendarIds.includes(calendarId)) {
      throw new Error('Calendar is not configured for this source');
    }
    const { data } = await api.events.get(
      { calendarId, eventId },
      { timeout: 30000 }
    );
    return compactEvent(data);
  })));

server.registerTool('gcal_create_event', {
  description:
    'Create an event on an explicitly writable calendar. Use a stable idempotency key tied to the user request.',
  inputSchema: {
    sourceId: sourceIdSchema,
    calendarId: z.string().min(1),
    idempotencyKey: z.string().min(8).max(500),
    event: eventFieldsSchema.extend({
      summary: z.string().min(1).max(1000),
      start: dateTimeSchema,
      end: dateTimeSchema
    })
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, tool(async ({ sourceId, calendarId, idempotencyKey, event }) =>
  withCalendar(sourceId, async (source, api) => {
    assertWritableCalendar(source, calendarId);
    validateDateRange(event.start, event.end);
    const eventId = idempotentEventId(source.id, calendarId, idempotencyKey);
    try {
      const { data } = await api.events.insert({
        calendarId,
        sendUpdates: source.config.sendUpdates || 'none',
        requestBody: { ...event, id: eventId }
      }, { timeout: 30000 });
      console.error(JSON.stringify({ component: 'gcal-mcp', action: 'create', source: source.id, calendarId, eventId }));
      return { created: true, event: compactEvent(data) };
    } catch (error) {
      if (error?.code !== 409) throw error;
      const { data } = await api.events.get({ calendarId, eventId }, { timeout: 30000 });
      return { created: false, alreadyExisted: true, event: compactEvent(data) };
    }
  })));

server.registerTool('gcal_update_event', {
  description:
    'Partially update an event on a writable calendar using the current ETag from get/list.',
  inputSchema: {
    sourceId: sourceIdSchema,
    calendarId: z.string().min(1),
    eventId: z.string().min(1),
    expectedEtag: z.string().min(1),
    changes: eventFieldsSchema
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
}, tool(async ({ sourceId, calendarId, eventId, expectedEtag, changes }) =>
  withCalendar(sourceId, async (source, api) => {
    assertWritableCalendar(source, calendarId);
    if (Object.keys(changes).length === 0) throw new Error('Event changes are required');
    const current = (await api.events.get(
      { calendarId, eventId },
      { timeout: 30000 }
    )).data;
    if (current.etag !== expectedEtag) {
      throw Object.assign(new Error('Event changed since it was read; fetch it again'), { code: 412 });
    }
    if (changes.start || changes.end) {
      validateDateRange(changes.start || current.start, changes.end || current.end);
    }
    const { data } = await api.events.patch({
      calendarId,
      eventId,
      sendUpdates: source.config.sendUpdates || 'none',
      requestBody: changes
    }, {
      timeout: 30000,
      headers: { 'If-Match': expectedEtag }
    });
    console.error(JSON.stringify({ component: 'gcal-mcp', action: 'update', source: source.id, calendarId, eventId }));
    return { updated: true, event: compactEvent(data) };
  })));

server.registerTool('gcal_delete_event', {
  description:
    'Delete an event only when deletion is enabled for the source. Requires its current ETag.',
  inputSchema: {
    sourceId: sourceIdSchema,
    calendarId: z.string().min(1),
    eventId: z.string().min(1),
    expectedEtag: z.string().min(1)
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
}, tool(async ({ sourceId, calendarId, eventId, expectedEtag }) =>
  withCalendar(sourceId, async (source, api) => {
    assertWritableCalendar(source, calendarId);
    if (source.config.allowDelete !== true) {
      throw new Error('Calendar deletion is disabled for this source');
    }
    const current = (await api.events.get(
      { calendarId, eventId },
      { timeout: 30000 }
    )).data;
    if (current.etag !== expectedEtag) {
      throw Object.assign(new Error('Event changed since it was read; fetch it again'), { code: 412 });
    }
    await api.events.delete({
      calendarId,
      eventId,
      sendUpdates: source.config.sendUpdates || 'none'
    }, {
      timeout: 30000,
      headers: { 'If-Match': expectedEtag }
    });
    console.error(JSON.stringify({ component: 'gcal-mcp', action: 'delete', source: source.id, calendarId, eventId }));
    return { deleted: true, calendarId, eventId };
  })));

await server.connect(new StdioServerTransport());
