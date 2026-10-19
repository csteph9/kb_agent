import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retrieveContext } from '../read-context.js';

test('retrieval finds relevant passages with paths and lines and leaves full-search fallback possible', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sports'));
  await fs.writeFile(path.join(root, 'sports/team.md'), 'General notes\n'.repeat(50) + 'Drylands are Tuesday at 9 PM.\nCoach: Alex.');
  await fs.writeFile(path.join(root, 'unrelated.md'), 'A recipe for soup.');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Drylands: policy must not become retrieved knowledge.');
  const result = await retrieveContext(root, 'test', 'When are dryland sessions?', { maxChars: 1000 });
  assert.equal(result[0].path, 'sports/team.md');
  assert.match(result[0].text, /Tuesday at 9 PM/);
  assert.ok(result[0].line > 1);
  assert.ok(result.every(r => r.path !== 'AGENTS.md'));
  assert.deepEqual(await retrieveContext(root, 'test', 'unmatchedword'), []);
});
test('index cache follows the immutable revision and rebuilds after commits or corruption', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-index-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'kb'), cacheDir = path.join(directory, 'index');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'team.md'), 'Coach: Alex.');
  const v1 = 'a'.repeat(40), v2 = 'b'.repeat(40);
  await retrieveContext(root, v1, 'coach', { cacheDir });
  await fs.writeFile(path.join(root, 'team.md'), 'Coach: Sam.');
  assert.match((await retrieveContext(root, v1, 'coach', { cacheDir }))[0].text, /Alex/);
  assert.match((await retrieveContext(root, v2, 'coach', { cacheDir }))[0].text, /Sam/);
  await fs.writeFile(path.join(cacheDir, v2 + '.json'), 'broken');
  assert.match((await retrieveContext(root, v2, 'coach', { cacheDir }))[0].text, /Sam/);
});
