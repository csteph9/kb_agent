import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../ingest/state.js';
import { validateSource } from '../ingest/config.js';
import { parseCalendar } from '../connectors/calendar/connector.js';
import { calendarEvent, reconcileCalendars, sameCalendarStart } from '../ingest/calendar-sync.js';

const rule = { enabled: true, targetSourceId: 'gcal', calendarId: 'primary', timeZone: 'America/Los_Angeles' };
const source = validateSource({ id: 'team-schedule', connector: 'calendar', enabled: true, calendarSync: rule });
const target = { id: 'gcal', connector: 'google-calendar', enabled: true, config: { writeEnabled: true, writableCalendarIds: ['primary'], allowDelete: true } };
function item(extra = '', hour = '21') {
  return parseCalendar(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:drylands-1\r\nSUMMARY:Drylands\r\nDTSTART:20261020T${hour}0000\r\nDTEND:20261020T${hour}4500\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-sync-'));
  const state = new State(dir);
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let event, inserts = 0, patches = 0, deletes = 0, loseResponse = false;
  const api = { events: {
    list: async () => ({ data: { items: [] } }),
    get: async () => { if (!event) throw Object.assign(new Error(), { code: 404 }); return { data: event }; },
    insert: async ({ requestBody }) => { inserts++; event = { ...requestBody, etag: 'v1' }; if (loseResponse) { loseResponse = false; throw new Error('lost response'); } return { data: event }; },
    patch: async ({ requestBody }, options) => { assert.equal(options.headers['If-Match'], event.etag); patches++; event = { ...event, ...requestBody, etag: 'v2' }; return { data: event }; },
    delete: async (_, options) => { assert.equal(options.headers['If-Match'], event.etag); deletes++; event = undefined; }
  } };
  return { state, api, connect: async () => ({ api, flush: async () => {} }),
    counts: () => ({ inserts, patches, deletes }), event: () => event, lose: () => { loseResponse = true; } };
}
test('creates, updates and cancels mapped events independently of KB completion', async t => {
  const f = setup(t);
  f.state.enqueuePage(source, [item()], null);
  const run = () => reconcileCalendars([source, target], f.state, f);
  assert.equal(await run(), true);
  assert.equal(f.event().start.timeZone, rule.timeZone);
  const id = f.event().id;
  f.state.done(f.state.pending(source.id, 1)[0].id);
  f.state.enqueuePage(source, [item('', '20')], null);
  assert.equal(await run(), true);
  assert.equal(f.event().id, id);
  assert.match(f.event().start.dateTime, /T20:/);
  f.state.enqueuePage(source, [item('STATUS:CANCELLED\r\n')], null);
  assert.equal(await run(), true);
  assert.deepEqual(f.counts(), { inserts: 1, patches: 1, deletes: 1 });
  assert.equal(f.state.status().calendar[0].status, 'synced');
});
test('lost create response retries using same provider identity', async t => {
  const f = setup(t); f.lose();
  f.state.enqueuePage(source, [item()], null);
  assert.equal(await reconcileCalendars([source, target], f.state, f), false);
  f.state.db.exec('UPDATE calendar_deliveries SET next_attempt=0');
  assert.equal(await reconcileCalendars([source, target], f.state, f), true);
  assert.equal(f.counts().inserts, 1);
});
test('enabling sync backfills already ingested source events', t => {
  const f = setup(t), old = { ...source, calendarSync: undefined };
  f.state.enqueuePage(old, [item()], null);
  f.state.done(f.state.pending(source.id, 1)[0].id);
  assert.equal(f.state.calendarHas(source, item().externalId, item().revision), false);
  f.state.enqueuePage(source, [item()], null);
  assert.equal(f.state.status().calendar.length, 1);
});
test('recurrence and unresolved floating times never become guessed events', () => {
  assert.throws(() => calendarEvent(item('RRULE:FREQ=WEEKLY\r\n'), rule), /Recurring/);
  assert.throws(() => calendarEvent(item(), {}), /Floating/);
});
test('disabled targets retain durable retry state without writes', async t => {
  const f = setup(t); f.state.enqueuePage(source, [item()], null);
  assert.equal(await reconcileCalendars([source, { ...target, enabled: false }], f.state, f), false);
  assert.equal(f.state.status().calendar[0].status, 'retry');
  assert.equal(f.counts().inserts, 0);
});
test('title filters are remembered and rule changes make events eligible again', t => {
  const f = setup(t), filtered = { ...source, calendarSync: { ...rule, titleIncludes: ['Game'] } };
  f.state.enqueuePage(filtered, [item()], null);
  assert.equal(f.state.status().calendar[0].status, 'ignored');
  assert.equal(f.state.calendarHas(filtered, item().externalId, item().revision), true);
  assert.equal(f.state.calendarHas(source, item().externalId, item().revision), false);
  f.state.enqueuePage(source, [item()], null);
  assert.equal(f.state.status().calendar[0].status, 'pending');
});
test('possible manual duplicates are held without creating or adopting', async t => {
  const f = setup(t);
  f.api.events.list = async () => ({ data: { items: [{ id: 'manual', summary: 'Drylands', start: { dateTime: '2026-10-20T21:00:00-07:00' } }] } });
  f.state.enqueuePage(source, [item()], null);
  assert.equal(await reconcileCalendars([source, target], f.state, f), false);
  assert.match(f.state.status().calendar[0].error, /duplicate/);
  assert.equal(f.counts().inserts, 0);
});
test('daily verification rechecks owned events without another source revision', async t => {
  const f = setup(t); f.state.enqueuePage(source, [item()], null);
  await reconcileCalendars([source, target], f.state, f);
  await reconcileCalendars([source, target], f.state, { ...f, now: () => Date.now() + 2 * 86400000 });
  assert.equal(f.counts().patches, 1);
});
test('ETag conflicts remain unsynced and do not report success', async t => {
  const f = setup(t); f.state.enqueuePage(source, [item()], null);
  await reconcileCalendars([source, target], f.state, f);
  f.state.enqueuePage(source, [item('', '20')], null);
  f.api.events.patch = async () => { throw Object.assign(new Error(), { code: 412 }); };
  assert.equal(await reconcileCalendars([source, target], f.state, f), false);
  assert.equal(f.state.status().calendar[0].status, 'retry');
});
test('missing events in a source page never delete destination entries', async t => {
  const f = setup(t); f.state.enqueuePage(source, [item()], null);
  await reconcileCalendars([source, target], f.state, f);
  f.state.enqueuePage(source, [], null);
  await reconcileCalendars([source, target], f.state, f);
  assert.equal(f.counts().deletes, 0);
});
test('duplicate matching respects timezone offsets and distinct occurrence times', () => {
  const desired = { dateTime: '2026-10-20T21:00:00', timeZone: 'America/Los_Angeles' };
  assert.equal(sameCalendarStart({ dateTime: '2026-10-21T04:00:00Z' }, desired), true);
  assert.equal(sameCalendarStart({ dateTime: '2026-10-20T09:00:00-07:00' }, desired), false);
  assert.equal(sameCalendarStart({ date: '2026-10-20' }, { date: '2026-10-20' }), true);
});
test('destination ownership marker prevents mutation of unrelated provider events', async t => {
  const f = setup(t); f.state.enqueuePage(source, [item()], null);
  await reconcileCalendars([source, target], f.state, f);
  delete f.event().extendedProperties.private.knowledgeSync;
  f.state.enqueuePage(source, [item('', '20')], null);
  assert.equal(await reconcileCalendars([source, target], f.state, f), false);
  assert.match(f.state.status().calendar[0].error, /ownership/);
  assert.equal(f.counts().patches, 0);
});
