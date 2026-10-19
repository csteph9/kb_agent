import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../ingest/state.js';
import { validateSource } from '../ingest/config.js';
import { extractedItems, extractCalendars, extractSchedule } from '../ingest/calendar-extract.js';
import { createConnector } from '../connectors/knowledge-schedule/connector.js';

const source = validateSource({ id: 'schedule', enabled: true, connector: 'knowledge-schedule',
  calendarSync: { enabled: true, targetSourceId: 'gcal', calendarId: 'primary', timeZone: 'America/Los_Angeles' } });
const item = { externalId: 'sports/team.md', revision: 'v1', kind: 'document',
  content: { text: 'Team practice October 20, 2026 from 9 to 10 PM. Practice is cancelled.' } };
const event = { id: 'practice-occurrence-1', title: 'Team practice', description: '', location: '',
  start: { date: null, dateTime: '2026-10-20T21:00:00', timeZone: null },
  end: { date: null, dateTime: '2026-10-20T22:00:00', timeZone: null }, status: 'confirmed',
  evidence: 'Team practice October 20, 2026 from 9 to 10 PM.' };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-extract-'));
  const state = new State(dir);
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { state, dir };
}
test('unstructured schedule revisions enqueue extraction independently from KB jobs', async t => {
  const { state } = setup(t);
  state.enqueuePage(source, [item], null);
  state.done(state.pending(source.id, 1)[0].id);
  assert.equal(state.status().calendarExtractions[0].status, 'pending');
  assert.equal(await extractCalendars([source], state, { extract: async () => ({ events: [event], issues: [] }) }), true);
  assert.equal(state.status().calendarExtractions[0].status, 'applied');
  assert.equal(state.status().calendar[0].status, 'pending');
  state.enqueuePage(source, [{ ...item, revision: 'v2' }], null);
  let previous;
  await extractCalendars([source], state, { extract: async (_, __, hints) => { previous = hints; return { events: [{ ...event, title: 'Changed practice' }], issues: [] }; } });
  assert.equal(previous[0].id, event.id);
  assert.equal(state.status().calendar.length, 1);
});
test('evidence, dates, additional properties and unresolved issues are validated', () => {
  const output = { events: [event], issues: [] };
  assert.equal(extractedItems(output, item, source.calendarSync)[0].content.structured.googleEvent.start.timeZone, 'America/Los_Angeles');
  assert.throws(() => extractedItems({ ...output, issues: ['Unknown time'] }, item, source.calendarSync));
  assert.throws(() => extractedItems({ events: [{ ...event, evidence: 'invented evidence' }], issues: [] }, item, source.calendarSync));
  assert.throws(() => extractedItems({ events: [{ ...event, attendees: ['x'] }], issues: [] }, item, source.calendarSync));
  assert.throws(() => extractedItems({ events: [{ ...event, start: { ...event.start, dateTime: '2026-02-30T21:00:00' } }], issues: [] }, item, source.calendarSync));
  assert.throws(() => extractedItems({ events: [event, event], issues: [] }, item, source.calendarSync));
});
test('extraction problems retain input and never create delivery records', async t => {
  const { state } = setup(t); state.enqueuePage(source, [item], null);
  assert.equal(await extractCalendars([source], state, { extract: async () => ({ events: [], issues: ['Ambiguous date'] }) }), false);
  assert.equal(state.status().calendar.length, 0);
  assert.equal(state.status().calendarExtractions[0].status, 'retry');
  assert.ok(state.db.prepare('SELECT payload FROM calendar_extractions').get().payload);
});
test('omitting an extracted event never queues a cancellation', async t => {
  const { state } = setup(t); state.enqueuePage(source, [item], null);
  await extractCalendars([source], state, { extract: async () => ({ events: [event], issues: [] }) });
  state.enqueuePage(source, [{ ...item, revision: 'v2' }], null);
  await extractCalendars([source], state, { extract: async () => ({ events: [], issues: [] }) });
  const payload = JSON.parse(state.db.prepare('SELECT payload FROM calendar_deliveries').get().payload);
  assert.equal(payload.content.structured.cancelled, false);
});
test('KB watcher detects Markdown changes and rejects path escapes', async t => {
  const { dir } = setup(t), root = path.join(dir, 'kb'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'schedule.md'), item.content.text);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Policy');
  fs.mkdirSync(path.join(root, '.private')); fs.writeFileSync(path.join(root, '.private', 'x.md'), 'Hidden');
  const s = { ...source, config: { root, paths: ['.'] } };
  const c = await createConnector(s);
  const page = await c.fetchPage({ limit: 10, has: () => false });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].externalId, 'schedule.md');
  fs.writeFileSync(path.join(root, 'schedule.md'), 'Changed');
  const changed = await (await createConnector(s)).fetchPage({ limit: 10, has: () => false });
  assert.notEqual(changed.items[0].revision, page.items[0].revision);
  await assert.rejects(() => createConnector({ ...s, config: { root, paths: ['../'] } }).then(c => c.check()), /Invalid/);
});
test('extraction invokes the shared controller with JSON events and a schema in an isolated read-only workspace', async () => {
  let workspace;
  const result = await extractSchedule(source, item, [], { execute: async (command, args, options) => {
    assert.equal(command, 'bash');
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--skip-git-repo-check'), 'temporary extraction workspace is outside Git');
    assert.equal(options.env.CODEX_MAX_ATTEMPTS, '1');
    assert.equal(options.env.CODEX_QUEUE_TIMEOUT_SECONDS, '30');
    assert.ok(Number(options.env.CODEX_CALL_TIMEOUT_SECONDS) <= 3600);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.equal(schema.additionalProperties, false);
    assert.match(options.input, /untrusted source/);
    assert.match(options.input, /Never invent/);
    workspace = options.cwd;
    fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ events: [event], issues: [] }));
    return { code: 0 };
  } });
  assert.equal(result.events[0].id, event.id);
  assert.equal(fs.existsSync(workspace), false);
});
test('source cursor and extraction queue roll back together on persistence failure', t => {
  const { state } = setup(t);
  assert.throws(() => state.enqueuePage(source, [item, { ...item, externalId: undefined }], 'page2'));
  assert.equal(state.status().calendarExtractions.length, 0);
  assert.equal(state.source(source.id).cursor, null);
});
test('a correction from a different source document reuses the occurrence mapping', async t => {
  const { state } = setup(t); state.enqueuePage(source, [item], null);
  await extractCalendars([source], state, { extract: async () => ({ events: [event], issues: [] }) });
  state.enqueuePage(source, [{ ...item, externalId: 'daily/correction.md' }], null);
  let previous;
  await extractCalendars([source], state, { extract: async (_, __, hints) => {
    previous = hints;
    return { events: [{ ...event, status: 'cancelled', start: null, end: null, evidence: 'Practice is cancelled.' }], issues: [] };
  } });
  assert.equal(previous[0].id, event.id);
  assert.equal(state.status().calendar.length, 1);
  const payload = JSON.parse(state.db.prepare('SELECT payload FROM calendar_deliveries').get().payload);
  assert.equal(payload.content.structured.cancelled, true);
});
test('failed extractor processes expose a sanitized launch diagnostic and retain retry input', async t => {
  const { state } = setup(t); state.enqueuePage(source, [item], null);
  await extractCalendars([source], state, { extract: () => extractSchedule(source, item, [], {
    execute: async () => ({ code: 1, stderr: 'private source content and credentials' })
  }) });
  const row = state.status().calendarExtractions[0];
  assert.equal(row.status, 'retry');
  assert.match(row.error, /process failed \(exit 1, reason unknown\)/);
  assert.doesNotMatch(row.error, /private|credentials/);
  assert.equal(state.status().calendar.length, 0);
  assert.ok(state.db.prepare('SELECT payload FROM calendar_extractions').get().payload);
});
test('a systemic extractor failure stops the batch and leaves remaining jobs untouched', async t => {
  const { state } = setup(t);
  state.enqueuePage(source, [item, { ...item, externalId: 'another.md' }], null);
  let calls = 0;
  await extractCalendars([source], state, { extract: async () => {
    calls++;
    throw Object.assign(new Error('private raw provider output'), { code: 'CALENDAR_EXTRACT_LAUNCH', exitCode: 1, reason: 'output-schema' });
  } });
  assert.equal(calls, 1);
  const rows = state.status().calendarExtractions;
  assert.match(rows[0].error, /reason output-schema/);
  assert.equal(rows[1].status, 'pending');
  assert.equal(rows[1].attempts, 0);
});
test('disabled extraction queues cannot block eligible sources', async t => {
  const { state } = setup(t);
  const disabled = { ...source, id: 'disabled' };
  state.enqueuePage(disabled, [item], null);
  state.enqueuePage(source, [item], null);
  let calls = 0;
  await extractCalendars([{ ...disabled, enabled: false }, source], state, { limit: 1,
    extract: async () => { calls++; return { events: [], issues: [] }; } });
  assert.equal(calls, 1);
  assert.equal(state.status().calendarExtractions.find(r => r.source === source.id).status, 'applied');
});
