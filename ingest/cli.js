#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sources, stateDir, sourceDir, validateSource } from './config.js';
import { State } from './state.js';
import { loadConnector } from './registry.js';
import { syncKnowledge } from './knowledge-writer.js';
import { runSource } from './runner.js';

process.umask(0o077);
const [command = 'help', argument] = process.argv.slice(2);
const mutations = ['run', 'due', 'retry', 'refetch', 'migrate-gmail', 'check', 'sync'];
async function main() {
  if (command === 'help') {
    console.log('Usage: node ingest/cli.js sources | check <source> | run <source> | due | status | sync | retry <job-id> | refetch <source> | migrate-gmail [source-id]');
    return;
  }
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (mutations.includes(command) && process.env.KNOWLEDGE_INGEST_LOCKED !== '1') {
    if (process.platform === 'win32') throw new Error('Ingestion execution requires Linux flock; parser/state tests run on Windows.');
    const child = spawn('flock', ['-w', '5', path.join(stateDir, 'runner.lock'), process.execPath, ...process.argv.slice(1)], {
      stdio: 'inherit', env: { ...process.env, KNOWLEDGE_INGEST_LOCKED: '1' }
    });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { process.exitCode = code ?? 1; resolve(); }); });
    return;
  }
  const configured = await sources();
  const state = new State(stateDir);
  try {
    if (command === 'sources') { console.log(JSON.stringify(configured.map(s => ({id:s.id,connector:s.connector,enabled:s.enabled,everySeconds:s.schedule.everySeconds})), null, 2)); return; }
    if (command === 'status') { console.log(JSON.stringify(state.status(), null, 2)); return; }
    if (command === 'migrate-gmail') {
      const id = argument || 'personal-gmail';
      const dir = process.env.GMAIL_STATE_DIR || '/opt/knowledge-agent/gmail';
      const source = validateSource({
        id, connector: 'gmail', enabled: String(process.env.GMAIL_ENABLED || '').toLowerCase() === 'true',
        config: { stateDir: dir, query: process.env.GMAIL_QUERY || 'newer_than:14d -category:promotions -category:social',
          maxEmailChars: Number(process.env.GMAIL_MAX_EMAIL_CHARS || 20000),
          processAttachments: process.env.GMAIL_PROCESS_ATTACHMENTS !== 'false',
          maxAttachments: Number(process.env.GMAIL_MAX_ATTACHMENTS_PER_MESSAGE || 5),
          maxAttachmentChars: Number(process.env.GMAIL_MAX_ATTACHMENT_CHARS || 50000) },
        schedule: { everySeconds: 600 },
        ingestion: { profile: 'personal-correspondence', maxItemsPerRun: Number(process.env.GMAIL_MAX_MESSAGES_PER_RUN || 10), maxItemChars: 400000 }
      });
      let ids = [];
      try { ids = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).processedIds || []; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) throw new Error('Invalid legacy state');
      if (configured.some(s => s.id === id)) throw new Error('Source already exists; migration will not overwrite it');
      // Import first. If writing configuration fails, repeating the import is safe.
      state.importLegacy(id, ids);
      await fs.writeFile(path.join(sourceDir, id + '.json'), JSON.stringify(source, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log('Migrated Gmail configuration and ' + ids.length + ' processed IDs; OAuth files preserved.');
      return;
    }
    if (command === 'sync') {
      if (!(await syncKnowledge())) throw new Error('Source Git synchronization failed');
      state.db.prepare('UPDATE jobs SET sync_pending=0').run();
      console.log('Remote synchronization complete.');
      return;
    }
    if (command === 'due') {
      for (const source of configured.filter(s => s.enabled && Date.now() - state.source(s.id).last_run >= s.schedule.everySeconds * 1000)) {
        if (!(await runSource(source, state))) process.exitCode = 1;
      }
      if (state.status().syncPending) {
        if (await syncKnowledge()) state.db.prepare('UPDATE jobs SET sync_pending=0').run();
        else { console.error('Remote synchronization remains pending.'); process.exitCode = 1; }
      }
      return;
    }
    const id = command === 'retry' ? state.retry(argument) : argument;
    const source = configured.find(s => s.id === id);
    if (!source) throw new Error('Unknown source; use sources to list configured IDs');
    if (command === 'check') {
      const connector = await loadConnector(source);
      try { await connector.check(); console.log(source.id + ': connection and configuration OK'); }
      finally { await connector.close?.(); }
    } else if (['run', 'retry'].includes(command)) {
      if (!(await runSource(source, state))) process.exitCode = 1;
    } else if (command === 'refetch') {
      state.refetch(source.id);
      console.log('Reset scan cursor and expired jobs. Applied items remain deduplicated.');
    } else throw new Error('Unknown command');
  } finally { state.close(); }
}
main().catch(error => {
  // Provider exceptions may contain authenticated URLs, message content or tokens.
  const safe = ['Unknown', 'Invalid', 'Source', 'Expected', 'Ingestion', 'Job', 'Unsupported', 'Duplicate', 'Connector'];
  console.error(safe.some(prefix => error.message.startsWith(prefix)) ? error.message : 'Command failed. Check source configuration, credentials, dependencies and server logs.');
  process.exitCode = 1;
});