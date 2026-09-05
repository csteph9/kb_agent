import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetchResource } from '../../ingest/http.js';
import { stripHtml } from '../../ingest/documents.js';
import { hash } from '../../ingest/state.js';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'object' && value !== null ? String(value['#text'] || '') : String(value || '');
export function parseFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML entity declarations are not supported');
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid feed XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false }).parse(xml);
  if (!parsed.rss?.channel && !parsed.feed) throw new Error('Expected RSS or Atom feed');
  return list(parsed.rss?.channel?.item || parsed.feed?.entry).map(entry => {
    const link = list(entry.link).find(l => typeof l === 'string' || !l['@_rel'] || l['@_rel'] === 'alternate');
    const url = typeof link === 'string' ? link : link?.['@_href'] || '';
    const externalId = text(entry.guid || entry.id) || url;
    if (!externalId) throw new Error('Feed entry lacks stable ID or link');
    const item = { externalId, kind: 'article', title: text(entry.title), sourceUrl: url,
      occurredAt: text(entry.pubDate || entry.published), updatedAt: text(entry.updated),
      content: { text: stripHtml(text(entry.encoded || entry.content || entry.description || entry.summary)) } };
    return { ...item, revision: hash(JSON.stringify(item)) };
  });
}
export async function createConnector(source) {
  if (typeof source.config.url !== 'string') throw new Error('RSS requires config.url');
  let items;
  async function load() { return items ||= parseFeed((await fetchResource(source.config.url)).body.toString('utf8')); }
  return {
    async check() { await load(); },
    async fetchPage({ limit, has }) {
      const fresh = (await load()).filter(i => !has(i.externalId, i.revision));
      // Each run reloads the snapshot and deduplicates; numeric offsets across changing feeds would skip items.
      return { items: fresh.slice(0, limit), cursor: fresh.length > limit ? 'more' : null };
    }
  };
}