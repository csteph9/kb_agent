import test from 'node:test';
import assert from 'node:assert/strict';
import { keyedQueue, concurrentUpdates, ReadMemory } from '../interactive-requests.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('read queues preserve per-user ordering while other users proceed', async () => {
  const enqueue = keyedQueue(), gate = deferred(), starts = [];
  const first = enqueue('a', async () => { starts.push('a1'); await gate.promise; });
  const second = enqueue('a', async () => { starts.push('a2'); });
  const other = enqueue('b', async () => { starts.push('b'); });
  await other;
  assert.deepEqual(starts, ['a1', 'b']);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(starts, ['a1', 'b', 'a2']);
  await assert.rejects(enqueue('a', async () => { throw new Error('failed'); }));
  await enqueue('a', async () => { starts.push('recovered'); });
  assert.equal(starts.at(-1), 'recovered');
});
test('Telegram transport accepts later updates before an earlier handler finishes', async () => {
  const first = deferred(), finished = deferred(), starts = [];
  const middleware = concurrentUpdates();
  await middleware({}, async () => { starts.push(1); await first.promise; });
  await middleware({}, async () => { starts.push(2); finished.resolve(); });
  await finished.promise;
  assert.deepEqual(starts, [1, 2]);
  first.resolve();
});
test('detached handlers are bounded and recover after errors', async () => {
  const gate = deferred(), finished = deferred(); let errors = 0, started = false;
  const middleware = concurrentUpdates({ limit: 1, onError: () => { errors++; } });
  await middleware({}, async () => { await gate.promise; throw new Error('failed'); });
  const later = middleware({}, async () => { started = true; finished.resolve(); });
  await Promise.resolve(); assert.equal(started, false);
  gate.resolve(); await later; await finished.promise;
  assert.equal(errors, 1);
});
test('answer cache separates users, revisions, identity, context and expiry', () => {
  let clock = 1000; const memory = new ReadMemory({ now: () => clock, ttl: 1000 });
  const key = memory.key('a', 'v1', 'Who is the coach?', 'Alice');
  memory.put(key, 'Answer');
  assert.equal(memory.get(memory.key('a', 'v1', 'Who is the coach?', 'Alice')), 'Answer');
  for (const changed of [memory.key('b', 'v1', 'Who is the coach?', 'Alice'), memory.key('a', 'v2', 'Who is the coach?', 'Alice'), memory.key('a', 'v1', 'Who is the coach?', 'Bob')]) assert.equal(memory.get(changed), null);
  memory.record('a', 'Another question', 'Another answer', 0);
  assert.equal(memory.get(memory.key('a', 'v1', 'Who is the coach?', 'Alice')), null);
  clock += 1001; assert.equal(memory.get(key), null);
});
test('reset invalidates cache and prevents in-flight answers restoring old context', () => {
  const memory = new ReadMemory();
  const before = memory.key(1, 'v1', 'Question', 'Alice'); memory.put(before, 'Old answer');
  const generation = memory.generation(1); memory.clear(1);
  memory.record(1, 'Old question', 'Old answer', generation);
  assert.deepEqual(memory.context(1), []);
  assert.equal(memory.get(memory.key(1, 'v1', 'Question', 'Alice')), null);
});
test('captured context cannot change underneath an in-flight read', () => {
  const memory = new ReadMemory(), context = memory.context('a');
  const before = memory.key('a', 'v1', 'Question', 'Alice', context);
  memory.record('a', 'A concurrent write', 'Saved', 0);
  assert.equal(memory.key('a', 'v1', 'Question', 'Alice', context), before);
  assert.notEqual(memory.key('a', 'v1', 'Question', 'Alice'), before);
});
test('accepted updates survive restart until their handlers complete', async t => {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-inflight-'));
  t.after(() => fs.rm(spoolDir, { recursive: true, force: true }));
  const gate = deferred();
  const update = { update_id: 17, message: { text: 'Question', from: { id: 1 } } };
  const middleware = concurrentUpdates({ spoolDir });
  await middleware({ update }, async () => { await gate.promise; });
  const restarted = concurrentUpdates({ spoolDir });
  assert.deepEqual(await restarted.pending(), [update]);
  let duplicate = false;
  await middleware({ update }, async () => { duplicate = true; });
  assert.equal(duplicate, false);
  gate.resolve();
  for (let i = 0; i < 100; i++) {
    if (!(await restarted.pending()).length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await restarted.pending(), []);
});
test('failed detached handlers retain their replayable update', async t => {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-retry-'));
  t.after(() => fs.rm(spoolDir, { recursive: true, force: true }));
  const failed = deferred(), update = { update_id: 19 };
  const middleware = concurrentUpdates({ spoolDir, onError: () => failed.resolve() });
  await middleware({ update }, async () => { throw new Error('handler failed'); });
  await failed.promise;
  assert.deepEqual(await middleware.pending(), [update]);
});
