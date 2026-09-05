import { fetchResource } from '../../ingest/http.js';
import { stripHtml } from '../../ingest/documents.js';
import { hash } from '../../ingest/state.js';
export async function createConnector(source) {
  if (typeof source.config.url !== 'string') throw new Error('Website requires config.url');
  let result;
  async function load() { return result ||= await fetchResource(source.config.url); }
  return {
    async check() { await load(); },
    async fetchPage() {
      const r = await load();
      if (!/text\/|json|xml/i.test(r.contentType)) throw new Error('Website connector supports HTML, text, XML and JSON; use a document connector for binary input');
      const raw = r.body.toString('utf8');
      const text = /html/i.test(r.contentType) ? stripHtml(raw) : raw;
      return { items: [{ externalId: source.config.url, revision: hash(text), kind: 'document',
        sourceUrl: r.finalUrl, title: source.config.title || 'Internet resource', content: { text } }], cursor: null };
    }
  };
}