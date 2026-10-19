import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class State {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'ingest.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Unsupported ingestion database version'); }
    fs.chmodSync(path.join(dir, 'ingest.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      PRAGMA user_version=1;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, cursor TEXT, last_run INTEGER DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS legacy (source TEXT, external_id TEXT, PRIMARY KEY(source,external_id));
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, revision TEXT NOT NULL,
        payload TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER DEFAULT 0,
        next_attempt INTEGER DEFAULT 0, created INTEGER NOT NULL, error TEXT, sync_pending INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source,status,next_attempt);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_deliveries (
      source TEXT NOT NULL, external_id TEXT NOT NULL, target TEXT NOT NULL, calendar TEXT NOT NULL,
      revision TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      event_id TEXT, etag TEXT, error TEXT, verified_at INTEGER,
      PRIMARY KEY(source,external_id,target,calendar));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_extractions (
      source TEXT NOT NULL, external_id TEXT NOT NULL, signature TEXT NOT NULL, payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT,
      PRIMARY KEY(source,external_id));`);
  }
  close() { this.db.close(); }
  source(id) { return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) || { cursor: null, last_run: 0 }; }
  has(source, id, revision) {
    if (this.db.prepare('SELECT 1 FROM legacy WHERE source=? AND external_id=?').get(source, id)) return true;
    const latest = this.db.prepare('SELECT revision FROM jobs WHERE source=? AND external_id=? ORDER BY rowid DESC LIMIT 1').get(source, id);
    return !!latest && latest.revision === revision;
  }
  enqueuePage(source, items, cursor) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        if (this.has(source.id, item.externalId, item.revision)) {
          if (!this.calendarHas(source, item.externalId, item.revision)) this.queueCalendar(source, item);
          continue;
        }
        const previous = this.db.prepare('SELECT id FROM jobs WHERE source=? AND external_id=? ORDER BY rowid DESC LIMIT 1').get(source.id, item.externalId);
        const id = hash(JSON.stringify([source.id, item.externalId, item.revision, previous?.id || null]));
        this.db.prepare("UPDATE jobs SET status='superseded',payload=NULL WHERE source=? AND external_id=? AND status IN ('pending','retry','failed','expired')")
          .run(source.id, item.externalId);
        this.db.prepare('INSERT INTO jobs (id,source,external_id,revision,payload,created) VALUES (?,?,?,?,?,?)')
          .run(id, source.id, item.externalId, item.revision, JSON.stringify(item), Date.now());
        this.queueCalendar(source, item);
      }
      this.db.prepare(`INSERT INTO sources(id,cursor) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor`)
        .run(source.id, cursor == null ? null : JSON.stringify(cursor));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending(source, limit) {
    return this.db.prepare(`SELECT * FROM jobs WHERE source=? AND status IN ('pending','retry') AND next_attempt<=? ORDER BY created,rowid LIMIT ?`)
      .all(source, Date.now(), limit);
  }
  queueCalendar(source, item) {
    const rule = source.calendarSync;
    if (!rule?.enabled || item.skipReason) return;
    if (source.connector !== 'calendar' && !item._extractedCalendarEvent) {
      this.db.prepare(`INSERT INTO calendar_extractions(source,external_id,signature,payload) VALUES (?,?,?,?)
        ON CONFLICT(source,external_id) DO UPDATE SET signature=excluded.signature,payload=excluded.payload,status='pending',attempts=0,next_attempt=0,error=NULL`)
        .run(source.id, item.externalId, hash(JSON.stringify([item.revision, rule])), JSON.stringify(item));
      return;
    }
    if (item.kind !== 'event') return;
    // Keep revisions of already mapped events even if a title changes out of the filter.
    const existing = this.db.prepare('SELECT event_id FROM calendar_deliveries WHERE source=? AND external_id=? AND target=? AND calendar=?')
      .get(source.id, item.externalId, rule.targetSourceId, rule.calendarId);
    const ignored = !existing?.event_id && rule.titleIncludes?.length && !rule.titleIncludes.some(s => (item.title || '').toLowerCase().includes(s.toLowerCase()));
    this.db.prepare(`INSERT INTO calendar_deliveries(source,external_id,target,calendar,revision,payload)
      VALUES (?,?,?,?,?,?) ON CONFLICT(source,external_id,target,calendar) DO UPDATE SET
      revision=excluded.revision,payload=excluded.payload,status='pending',attempts=0,next_attempt=0,error=NULL`)
      .run(source.id, item.externalId, rule.targetSourceId, rule.calendarId, item.revision,
        JSON.stringify({ ...item, _calendarRuleHash: hash(JSON.stringify(rule)) }));
    if (ignored) this.db.prepare("UPDATE calendar_deliveries SET status='ignored' WHERE source=? AND external_id=? AND target=? AND calendar=?")
      .run(source.id, item.externalId, rule.targetSourceId, rule.calendarId);
  }
  calendarHas(source, id, revision) {
    const rule = source.calendarSync;
    if (!rule?.enabled) return true;
    if (source.connector !== 'calendar') return !!this.db.prepare('SELECT 1 FROM calendar_extractions WHERE source=? AND external_id=? AND signature=?')
      .get(source.id, id, hash(JSON.stringify([revision, rule])));
    return this.db.prepare("SELECT 1 FROM calendar_deliveries WHERE source=? AND external_id=? AND target=? AND calendar=? AND revision=? AND json_extract(payload,'$._calendarRuleHash')=?")
      .get(source.id, id, rule.targetSourceId, rule.calendarId, revision, hash(JSON.stringify(rule))) !== undefined;
  }
  done(id, syncPending = false) {
    this.db.prepare("UPDATE jobs SET status='applied',payload=NULL,error=NULL,sync_pending=? WHERE id=?").run(syncPending ? 1 : 0, id);
  }
  fail(job) {
    const attempts = job.attempts + 1;
    this.db.prepare('UPDATE jobs SET status=?,attempts=?,next_attempt=?,error=? WHERE id=?')
      .run(attempts >= 5 ? 'failed' : 'retry', attempts, Date.now() + Math.min(86400000, 60000 * 2 ** attempts), 'Ingestion failed; run check and inspect service diagnostics.', job.id);
  }
  finish(source, error = null) {
    this.db.prepare('INSERT INTO sources(id,last_run,error) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run,error=excluded.error')
      .run(source, Date.now(), error);
  }
  retry(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row || !row.payload || !['pending','retry','failed'].includes(row.status)) throw new Error('Job cannot be retried; expired input must be fetched again');
    this.db.prepare("UPDATE jobs SET status='pending',attempts=0,next_attempt=0,error=NULL WHERE id=?").run(id);
    return row.source;
  }
  prune() {
    this.db.prepare("UPDATE jobs SET payload=NULL,status='expired',error='Input retention expired; use refetch' WHERE payload IS NOT NULL AND created<?")
      .run(Date.now() - 7 * 86400000);
  }
  refetch(source) {
    this.db.prepare("DELETE FROM jobs WHERE source=? AND status='expired'").run(source);
    this.db.prepare('UPDATE sources SET cursor=NULL,last_run=0 WHERE id=?').run(source);
  }
  importLegacy(source, ids) {
    this.db.exec('BEGIN');
    try {
      for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO legacy VALUES (?,?)').run(source, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status() {
    return { calendarExtractions: this.db.prepare('SELECT source,external_id,status,attempts,error FROM calendar_extractions').all(),
      calendar: this.db.prepare('SELECT source,external_id,target,calendar,status,attempts,error,event_id,verified_at FROM calendar_deliveries').all(),
      sources: this.db.prepare('SELECT * FROM sources').all().map(({cursor, ...s}) => ({...s, hasCursor: cursor !== null})),
      counts: this.db.prepare('SELECT source,status,COUNT(*) AS count FROM jobs GROUP BY source,status').all(),
      failures: this.db.prepare("SELECT id,source,status,attempts,error FROM jobs WHERE status IN ('failed','retry','expired')").all(),
      syncPending: this.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE sync_pending=1').get().count };
  }
}
