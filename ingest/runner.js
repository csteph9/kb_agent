import { loadConnector } from './registry.js';
import { hash } from './state.js';
import { writeKnowledge } from './knowledge-writer.js';

export function normalize(source, item) {
  if (!item || typeof item.externalId !== 'string' || !item.externalId || item.externalId.length > 8192) throw new Error('Connector item requires a stable externalId');
  if (typeof item.kind !== 'string' || typeof item.content?.text !== 'string') throw new Error('Connector item requires kind and content.text');
  if (item.revision !== undefined && (typeof item.revision !== 'string' || !item.revision)) throw new Error('Invalid revision');
  const revision = item.revision || hash(JSON.stringify(item));
  const normalized = { ...item, revision, sourceId: source.id, owner: source.owner || null, retrievedAt: new Date().toISOString() };
  if (JSON.stringify(normalized).length > source.ingestion.maxItemChars) throw new Error('Item exceeds maxItemChars; adjust source limits');
  return normalized;
}
export async function runSource(source, state, { load = loadConnector, write = writeKnowledge } = {}) {
  if (!source.enabled) throw new Error('Source is disabled: ' + source.id);
  let connector, failed = false, processed = 0, fetched = 0;
  const max = source.ingestion.maxItemsPerRun;
  async function drain() {
    for (const job of state.pending(source.id, max - processed)) {
      processed++;
      try {
        const result = await write(source, job);
        state.done(job.id, result.syncPending);
        if (result.synced) state.db.prepare('UPDATE jobs SET sync_pending=0 WHERE sync_pending=1').run();
        console.log(JSON.stringify({ source: source.id, job: job.id, status: result.syncPending ? 'applied-sync-pending' : 'applied' }));
      } catch (error) {
        state.fail(job);
        failed = true;
        console.error(JSON.stringify({ source: source.id, job: job.id, status: 'retry-or-failed', stage: error.message.startsWith('Knowledge transaction failed:') ? error.message : 'Knowledge writer failed' }));
      }
    }
  }
  try {
    state.prune();
    await drain();
    if (processed >= max) return !failed;
    connector = await load(source);
    let cursor = JSON.parse(state.source(source.id).cursor || 'null');
    for (let page = 0; page < source.ingestion.maxPagesPerRun && processed < max; page++) {
      const result = await connector.fetchPage({
        cursor, limit: max - processed,
        has: (id, revision) => state.has(source.id, id, revision)
      });
      if (!Array.isArray(result.items) || result.items.length > max - processed) throw new Error('Connector exceeded page limit');
      const items = result.items.map(item => normalize(source, item));
      cursor = result.cursor ?? null;
      // Enqueue and cursor advancement are one durable transaction.
      state.enqueuePage(source, items, cursor);
      fetched += items.length;
      await drain();
      if (cursor === null) break;
    }
  } catch {
    failed = true;
    console.error(JSON.stringify({ source: source.id, status: 'source-failed', hint: 'Run ingest check for connection/configuration validation' }));
  } finally {
    try { await connector?.close?.(); } catch { failed = true; }
    state.finish(source.id, failed ? 'Source or item processing failed; inspect status/check.' : null);
    console.log(JSON.stringify({ source: source.id, fetched, processed, failed }));
  }
  return !failed;
}