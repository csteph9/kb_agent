import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: process.env.KNOWLEDGE_ENV_FILE || path.join(appDir, '.env'), quiet: true });
export const sourceDir = process.env.INGEST_SOURCE_DIR || path.join(appDir, 'config/sources');
export const stateDir = process.env.INGEST_STATE_DIR || path.join(appDir, 'var/ingest');
export const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
export function positive(value, fallback, max = 10000) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Expected integer between 1 and ${max}`);
  return n;
}
export function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid source configuration');
  if (!validId(source.id) || !validId(source.connector)) throw new Error('Invalid source or connector ID');
  if (typeof source.enabled !== 'boolean') throw new Error(`${source.id}: enabled must be boolean`);
  source.config ??= {};
  source.ingestion ??= {};
  source.schedule ??= {};
  for (const key of ['config', 'ingestion', 'schedule']) {
    if (typeof source[key] !== 'object' || Array.isArray(source[key])) throw new Error('Invalid ' + key + ' configuration');
  }
  if (source.owner !== undefined && typeof source.owner !== 'string') throw new Error('Invalid owner');
  if (source.ingestion.purpose !== undefined && typeof source.ingestion.purpose !== 'string') throw new Error('Invalid ingestion purpose');
  source.schedule.everySeconds = positive(source.schedule.everySeconds, 600, 31536000);
  source.ingestion.maxItemsPerRun = positive(source.ingestion.maxItemsPerRun, 10, 1000);
  source.ingestion.maxPagesPerRun = positive(source.ingestion.maxPagesPerRun, 20, 1000);
  source.ingestion.maxItemChars = positive(source.ingestion.maxItemChars, 100000, 1000000);
  source.ingestion.profile ??= 'general';
  if (!['general', 'personal-correspondence', 'research', 'calendar'].includes(source.ingestion.profile)) {
    throw new Error(`${source.id}: unknown ingestion profile`);
  }
  for (const name of ['captureContacts', 'captureFollowups', 'captureReminders']) {
    if (source.ingestion[name] !== undefined && typeof source.ingestion[name] !== 'boolean') throw new Error(`${name} must be boolean`);
  }
  return source;
}
export async function sources() {
  await fs.mkdir(sourceDir, { recursive: true });
  const result = [];
  for (const name of (await fs.readdir(sourceDir)).sort()) {
    if (!name.endsWith('.json') || name.endsWith('.example.json')) continue;
    const source = validateSource(JSON.parse(await fs.readFile(path.join(sourceDir, name), 'utf8')));
    if (result.some(s => s.id === source.id)) throw new Error(`Duplicate source ID: ${source.id}`);
    result.push(source);
  }
  return result;
}
