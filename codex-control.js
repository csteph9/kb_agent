import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

// Only inspect CLI error events/stderr, never agent prose or tool output.
export function failureKind(message) {
  if (/insufficient[_ ]quota|quota.{0,30}(exceed|exhaust)|usage[_ ]limit|usage limit|credit.balance|spend[_ ]limit|billing|authentication|unauthori[sz]ed|invalid.api.key|context.{0,20}(length|window)|token.limit|\b401\b|\b403\b/i.test(message)) return 'permanent';
  if (/at capacity|overloaded|server_is_overloaded|rate[_ -]limit|too many requests|\b429\b|\b503\b|service.unavailable/i.test(message)) return 'transient';
  return 'unknown';
}

export function retryAfterMs(message, now = Date.now()) {
  const seconds = message.match(/retry[-_ ]after["'\s:=]+(\d+(?:\.\d+)?)/i);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  const date = message.match(/retry[-_ ]after["'\s:=]+([A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT)/i);
  return date ? Math.max(0, Date.parse(date[1]) - now) : 0;
}

export function retryDelayMs(attempt, hint, config, random = Math.random) {
  return Math.max(hint, Math.min(config.maxBackoff, config.backoff * 2 ** (attempt - 1)))
    + Math.floor(random() * config.jitter);
}

export function userErrorMessage(error) {
  const code = error.exitCode;
  if (code === 75) return 'Codex is temporarily busy or rate-limited. Please try again in a few minutes.';
  if (code === 124 || code === 137) return 'This request reached its time limit. Please try a smaller task. Any unfinished KB edits were not applied.';
  if (code === 73) return 'The KB has uncommitted changes that need attention before I can continue. Your existing files were preserved.';
  if (code === 2) return 'Your KB update was saved locally, but synchronization with GitHub is pending. You do not need to repeat the update.';
  return 'Codex could not finish this request. Please check the service logs; unfinished KB edits were not applied.';
}

export function relayCodexProgress(stream, log = console.log) {
  const lines = createInterface({ input: stream });
  lines.on('line', line => {
    if (/^(Codex: (waiting for shared execution slot|execution queue busy; try again later|cooldown exceeds this request budget; deferred|pacing wait \d+s|starting attempt \d+\/\d+|completed|(?:transient|permanent|unknown) failure(?: after tool activity; automatic replay disabled)?)|Telegram: (running (?:READ|WRITE) request in temporary worktree|request failed; unfinished worktree edits discarded|(?:READ|WRITE) transaction complete))$/.test(line)) log(line);
  });
}

function numberSetting(env, key, fallback, min, max) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  return n;
}

export function settings(env = process.env) {
  return {
    gap: numberSetting(env, 'CODEX_MIN_GAP_SECONDS', 10, 0, 3600) * 1000,
    attempts: numberSetting(env, 'CODEX_MAX_ATTEMPTS', 3, 1, 5),
    backoff: numberSetting(env, 'CODEX_RETRY_BASE_SECONDS', 30, 1, 3600) * 1000,
    maxBackoff: numberSetting(env, 'CODEX_RETRY_MAX_SECONDS', 120, 1, 3600) * 1000,
    jitter: numberSetting(env, 'CODEX_RETRY_JITTER_SECONDS', 5, 0, 60) * 1000,
    cooldown: numberSetting(env, 'CODEX_FAILURE_COOLDOWN_SECONDS', 120, 1, 86400) * 1000,
    budget: numberSetting(env, 'CODEX_CALL_TIMEOUT_SECONDS', 900, 1, 86400) * 1000,
  };
}

export function observeEvent(state, event) {
  if (event.type === 'turn.completed') state.completed = true;
  if (event.type === 'turn.failed') {
    state.failed = true;
    state.error = JSON.stringify(event.error || event.message || '');
  } else if (event.type === 'error' && !state.failed) {
    state.error = JSON.stringify(event.error || event.message || event);
  }
  // Never replay a whole turn after tools may have run (including external
  // effects). Unknown item types are conservatively treated as tool activity.
  if (event.type?.startsWith('item.') && !['reasoning', 'agent_message', 'plan'].includes(event.item?.type)) state.tools = true;
}

export function pinnedCodexArgs(args) {
  const execIndex = args.indexOf('exec');
  if (execIndex < 0) throw new Error('Codex exec subcommand required');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') throw new Error('Codex model override rejected');
    if ((args[i] === '--config' || args[i] === '-c') &&
        /^(?:model|model_reasoning_effort)=/.test(args[i + 1] || '')) {
      throw new Error('Codex model override rejected');
    }
  }
  return [
    ...args.slice(0, execIndex),
    '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort="medium"',
    '-c', 'features.multi_agent=false',
    ...args.slice(execIndex),
  ];
}

async function attempt(args, prompt, output) {
  const state = { completed: false, failed: false, tools: false, error: '', uncertain: false };
  const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { observeEvent(state, JSON.parse(line)); }
    catch { state.uncertain = true; }
  });
  const copy = pipeline(child.stdout, createWriteStream(output, { mode: 0o600 }));
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  const [result] = await Promise.all([exit, copy]);
  return { ...state, ...result, error: state.error || stderr };
}

// Caller MUST hold call.lock. The shell adapter owns the lock and deadline.
export async function controlledRun({ config, readState, writeState, invoke, log,
  now = Date.now, wait = sleep, random = Math.random }) {
  const deadline = now() + config.budget;
  let state = await readState();
  if (!Number.isFinite(state.nextAllowed) || state.nextAllowed < 0) throw new Error('Invalid Codex pacing state');
  for (let count = 1; count <= config.attempts; count++) {
    const delay = Math.max(0, state.nextAllowed - now());
    if (now() + delay >= deadline) {
      log('Codex: cooldown exceeds this request budget; deferred');
      return 75;
    }
    if (delay) { log(`Codex: pacing wait ${Math.ceil(delay / 1000)}s`); await wait(delay); }
    log(`Codex: starting attempt ${count}/${config.attempts}`);
    const result = await invoke(count);
    const success = result.code === 0 && result.completed && !result.failed;
    const kind = success ? 'none' : failureKind(result.error);
    const hint = success ? 0 : retryAfterMs(result.error, now());
    const backoff = kind === 'transient' ? retryDelayMs(count, hint, config, random) : 0;
    state = { nextAllowed: now() + Math.max(config.gap, backoff,
      kind === 'transient' && (count === config.attempts || result.tools || result.uncertain) ? config.cooldown : 0) };
    await writeState(state);
    if (success) { log('Codex: completed'); return 0; }
    log(`Codex: ${kind} failure${result.tools ? ' after tool activity; automatic replay disabled' : ''}`);
    if (kind !== 'transient') return 1;
    if (result.tools || result.uncertain || result.signal || count === config.attempts) return 75;
  }
  return 75;
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (!args.includes('--json')) throw new Error('Codex calls require --json');
  const dir = process.env.CODEX_CONTROL_DIR;
  if (!dir) throw new Error('Use run-codex-call.sh to acquire the execution lock');
  const stateFile = path.join(dir, 'pacing.json');
  const config = settings();
  const temp = await fs.mkdtemp(path.join(process.env.CODEX_CALL_TEMP_DIR || os.tmpdir(), 'knowledge-codex-'));
  const output = path.join(temp, 'events.jsonl');
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks);
    const code = await controlledRun({ config,
      readState: async () => {
        try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return { nextAllowed: 0 }; throw error; }
      },
      writeState: async state => {
        await fs.writeFile(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
        await fs.rename(stateFile + '.tmp', stateFile);
      },
      // Pin every application-owned call, including resumed sessions.
      invoke: () => attempt(pinnedCodexArgs(args), prompt, output),
      log: message => console.error(message),
    });
    // Earlier thread.started events must not become the saved session ID.
    if (code === 0) await pipeline(createReadStream(output), process.stdout);
    process.exitCode = code;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message.startsWith('Invalid ') ? error.message : 'Codex controller failed; check configuration and installed CLI.');
    process.exitCode = 1;
  });
}
