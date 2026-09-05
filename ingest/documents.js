import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './process.js';

export function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li|\/tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").trim();
}
export async function extractDocument(buffer, filename, mimeType, maxChars = 50000) {
  if (buffer.length > 10 * 1024 * 1024) throw new Error('Attachment exceeds 10 MB');
  let text;
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(filename)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-document-'));
    try {
      const input = path.join(dir, 'input.pdf');
      await fs.writeFile(input, buffer, { mode: 0o600 });
      const result = await run('pdftotext', ['-layout', input, path.join(dir, 'output.txt')], { timeout: 60000 });
      if (result.code !== 0) throw new Error('PDF extraction failed');
      text = await fs.readFile(path.join(dir, 'output.txt'), 'utf8');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  } else if (mimeType.startsWith('text/') || /\.(txt|md|markdown|xml|json|jsonl|csv|tsv|html?|ya?ml|log|ics|vcf|ini|conf|config|properties|sql|js|mjs|cjs|ts|tsx|jsx|css|scss|py|rb|php|java|c|h|cpp|hpp|cs|go|rs|sh|bash|zsh|ps1|eml)$/i.test(filename)
      || ['application/json', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/javascript', 'application/sql', 'application/x-yaml', 'application/yaml', 'application/x-ndjson'].includes(mimeType)) {
    if (buffer.includes(0)) throw new Error('Binary attachment cannot be read as text');
    text = buffer.toString('utf8');
    if (mimeType === 'text/html') text = stripHtml(text);
  } else return null;
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}