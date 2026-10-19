import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../../ingest/state.js';

export async function createConnector(source) {
  const root = path.resolve(source.config.root || process.env.KNOWLEDGE_REPO || '/home/knowledge/repo');
  const selections = source.config.paths || ['.'];
  let items;
  function inside(file) {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  }
  async function load() {
    if (items) return items;
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Knowledge root cannot be a symlink');
    const found = new Set();
    async function visit(file) {
      if (!inside(file)) throw new Error('Invalid knowledge schedule path');
      if (path.relative(root, file).split(path.sep).some(p => p.startsWith('.') && p !== '')) return;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Knowledge schedule symlinks are not supported');
      // Resolve each selected path too, so symlinked ancestors cannot escape root.
      if (!inside(await fs.realpath(file))) throw new Error('Invalid knowledge schedule path');
      if (stat.isDirectory()) {
        for (const entry of (await fs.readdir(file)).sort()) await visit(path.join(file, entry));
      } else if (stat.isFile() && file.endsWith('.md') && path.basename(file) !== 'AGENTS.md') {
        if (stat.size > source.ingestion.maxItemChars) throw new Error('Knowledge schedule file exceeds item limit');
        found.add(file);
      }
    }
    for (const selected of selections) await visit(path.resolve(root, selected));
    items = [];
    for (const file of [...found].sort()) {
      const text = await fs.readFile(file, 'utf8');
      items.push({ externalId: path.relative(root, file).split(path.sep).join('/'), revision: hash(text),
        kind: 'document', title: path.basename(file), content: { text } });
    }
    return items;
  }
  return {
    check: async () => { await load(); },
    async fetchPage({ limit, has }) {
      const fresh = (await load()).filter(i => !has(i.externalId, i.revision));
      return { items: fresh.slice(0, limit), cursor: fresh.length > limit ? 'more' : null };
    }
  };
}
