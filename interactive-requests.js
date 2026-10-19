import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function keyedQueue() {
  const pending = new Map();
  return (key, task) => {
    const result = (pending.get(key) || Promise.resolve()).then(task, task);
    const tail = result.catch(() => {});
    pending.set(key, tail);
    tail.finally(() => { if (pending.get(key) === tail) pending.delete(key); });
    return result;
  };
}

// Release the long-poll transport while requests run. Authorization precedes
// this middleware; application queues and the two model lanes bound execution.
export function concurrentUpdates({ limit = 32, spoolDir, onError = console.error } = {}) {
  const active = new Set();
  const ids = new Set();
  const middleware = async (ctx, next) => {
    const id = ctx.update?.update_id;
    let file;
    if (spoolDir) {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid Telegram update ID');
      if (ids.has(id)) return;
      ids.add(id);
      try {
        await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
        file = path.join(spoolDir, `${id}.json`);
        await fs.writeFile(file + '.tmp', JSON.stringify(ctx.update), { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
      } catch (error) { ids.delete(id); throw error; }
    }
    if (active.size >= limit) await Promise.race(active);
    const task = Promise.resolve().then(next).then(async () => {
      if (file) await fs.unlink(file);
    }).catch(error => { try { onError(error); } catch { /* Keep polling alive. */ } });
    active.add(task);
    task.finally(() => { active.delete(task); ids.delete(id); });
  };
  middleware.pending = async () => {
    if (!spoolDir) return [];
    let files;
    try { files = await fs.readdir(spoolDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const updates = [];
    for (const name of files.filter(f => /^\d+\.json$/.test(f)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]))) {
      let update;
      try { update = JSON.parse(await fs.readFile(path.join(spoolDir, name), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!Number.isSafeInteger(update.update_id) || String(update.update_id) !== name.slice(0, -5)) throw new Error('Invalid persisted Telegram update');
      updates.push(update);
    }
    return updates;
  };
  return middleware;
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ReadMemory {
  constructor({ now = Date.now, ttl = 30000, maxAnswers = 100 } = {}) {
    this.now = now; this.ttl = ttl; this.maxAnswers = maxAnswers;
    this.histories = new Map(); this.answers = new Map(); this.generations = new Map();
  }
  generation(user) { return this.generations.get(user) || 0; }
  context(user) { if (!this.histories.has(user)) this.histories.set(user, []); return this.histories.get(user); }
  record(user, prompt, answer, generation) {
    if (this.generation(user) !== generation) return;
    this.histories.set(user, [...this.context(user), { user: prompt.slice(0, 3000), assistant: answer.slice(0, 5000) }].slice(-4));
  }
  key(user, revision, prompt, identity, context = this.context(user)) {
    return digest([user, this.generation(user), revision, prompt, identity, context, Math.floor(this.now() / 60000)]);
  }
  get(key) { const row = this.answers.get(key); return row && this.now() - row.time < this.ttl ? row.answer : null; }
  put(key, answer) {
    this.answers.set(key, { answer, time: this.now() });
    while (this.answers.size > this.maxAnswers) this.answers.delete(this.answers.keys().next().value);
  }
  clear(user) { this.generations.set(user, this.generation(user) + 1); this.histories.delete(user); }
}
