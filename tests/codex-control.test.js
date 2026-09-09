import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledRun, settings, observeEvent, failureKind, retryAfterMs, userErrorMessage, callProfile, pinnedCodexArgs } from '../codex-control.js';

const ok = { code: 0, completed: true, error: '' };
const busy = { code: 1, error: 'Model is at capacity' };
function fixture(results, overrides = {}, initial = 0) {
  let clock = 100000, state = { nextAllowed: initial }, calls = 0;
  const waits = [], starts = [], logs = [];
  return {
    waits, starts, logs,
    get calls() { return calls; }, get state() { return state; },
    run: () => controlledRun({
      config: { ...settings({}), ...overrides },
      readState: async () => state, writeState: async next => { state = next; },
      now: () => clock, random: () => 0,
      wait: async ms => { waits.push(ms); clock += ms; },
      invoke: async () => { starts.push(clock); return results[calls++] || ok; },
      log: line => logs.push(line),
    }),
  };
}
test('success preserves pacing across separate calls', async () => {
  const f = fixture([ok, ok]);
  assert.equal(await f.run(), 0);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.waits, [1000]);
});
test('transient failures back off, then recover within three attempts', async () => {
  const f = fixture([busy, busy, ok]);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.waits, [30000, 60000]);
  assert.equal(f.calls, 3);
});
test('exhaustion leaves shared cooldown for next caller', async () => {
  const f = fixture([busy, busy, busy, ok]);
  assert.equal(await f.run(), 75);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.waits, [30000, 60000, 120000]);
});
test('server Retry-After is a minimum even beyond configured backoff cap', async () => {
  const f = fixture([{ ...busy, error: '429 rate limit. Retry-After: 180' }, ok]);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.waits, [180000]);
});
test('long server cooldown defers without retrying early', async () => {
  const f = fixture([{ ...busy, error: '503 Retry-After: 1200' }]);
  assert.equal(await f.run(), 75);
  assert.equal(f.calls, 1);
  assert.deepEqual(f.waits, []);
  assert.equal(f.state.nextAllowed, 1300000);
});
test('existing cooldown beyond budget makes no model call', async () => {
  const f = fixture([ok], { budget: 120000 }, 400000);
  assert.equal(await f.run(), 75);
  assert.equal(f.calls, 0);
});
test('quota, auth, context, and unknown errors do not retry', async () => {
  for (const error of ['429 insufficient_quota', '429 usage limit reached', '401 unauthorized', 'context length exceeded', 'bad CLI option']) {
    const f = fixture([{ code: 1, error }]);
    assert.equal(await f.run(), 1, error);
    assert.equal(f.calls, 1);
  }
});
test('tool execution, uncertain output, and signals prevent whole-turn replay', async () => {
  for (const extra of [{ tools: true }, { uncertain: true }, { signal: 'SIGTERM' }]) {
    const f = fixture([{ ...busy, ...extra }]);
    assert.equal(await f.run(), 75);
    assert.equal(f.calls, 1);
  }
});
test('a failed turn cannot be accepted on process exit zero', async () => {
  const f = fixture([{ ...ok, failed: true, error: 'bad configuration' }]);
  assert.equal(await f.run(), 1);
});
test('agent prose about rate limits is not treated as a CLI error', () => {
  const state = {};
  observeEvent(state, { type: 'item.completed', item: { type: 'agent_message', text: '429 at capacity' } });
  assert.equal(state.error, undefined);
  assert.equal(state.tools, undefined);
  observeEvent(state, { type: 'item.started', item: { type: 'mcp_tool_call' } });
  assert.equal(state.tools, true);
});
test('terminal error takes precedence over earlier reconnect warnings', () => {
  const state = {};
  observeEvent(state, { type: 'error', message: '503 overloaded' });
  observeEvent(state, { type: 'turn.failed', error: { message: 'insufficient_quota' } });
  assert.equal(failureKind(state.error), 'permanent');
});
test('Retry-After supports numeric and HTTP-date hints', () => {
  assert.equal(retryAfterMs('{"retry_after": 3.5}'), 3500);
  assert.equal(retryAfterMs('Retry-After: Tue, 08 Sep 2026 18:02:00 GMT', Date.parse('2026-09-08T18:00:00Z')), 120000);
});
test('invalid pacing configuration is rejected', () => {
  assert.throws(() => settings({ CODEX_MAX_ATTEMPTS: '-1' }), /Invalid/);
  assert.throws(() => settings({ CODEX_MIN_GAP_SECONDS: 'NaN' }), /Invalid/);
});
test('user messages distinguish transient failures and already committed updates', () => {
  assert.match(userErrorMessage({ exitCode: 75 }), /temporarily busy/);
  assert.match(userErrorMessage({ exitCode: 2 }), /saved locally/);
  assert.match(userErrorMessage({ exitCode: 73 }), /existing files were preserved/);
});
test('bulk invocations are pinned to GPT-5.6 Sol with medium reasoning', () => {
  assert.deepEqual(pinnedCodexArgs(['-C', '/tmp/work', 'exec', '--json', '-']), [
    '-C', '/tmp/work', '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort="medium"',
    '-c', 'features.multi_agent=false', 'exec', '--json', '-'
  ]);
  assert.throws(() => pinnedCodexArgs(['--model', 'other', 'exec']), /override rejected/);
  assert.throws(() => pinnedCodexArgs(['-c', 'model_reasoning_effort="high"', 'exec']), /override rejected/);
});
test('classifier invocations are explicitly pinned to GPT-5.6 Luna', () => {
  const selected = callProfile(['--knowledge-call-profile=classifier', 'exec', '--json', '-']);
  assert.equal(selected.profile, 'classifier');
  assert.deepEqual(selected.args, ['exec', '--json', '-']);
  assert.deepEqual(pinnedCodexArgs(selected.args, selected.profile), [
    '--model', 'gpt-5.6-luna',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'features.multi_agent=false', 'exec', '--json', '-'
  ]);
  assert.equal(callProfile(['exec']).profile, 'bulk');
  assert.throws(() => callProfile(['--knowledge-call-profile=other', 'exec']), /Invalid/);
  assert.throws(() => callProfile([
    '--knowledge-call-profile=classifier', '--knowledge-call-profile=bulk', 'exec'
  ]), /Duplicate/);
});
test('READ answer invocations use GPT-5.6 Luna with low reasoning', () => {
  const selected = callProfile(['--knowledge-call-profile=answer', 'exec', '--json', '-']);
  assert.deepEqual(pinnedCodexArgs(selected.args, selected.profile), [
    '--model', 'gpt-5.6-luna',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'features.multi_agent=false', 'exec', '--json', '-'
  ]);
});
