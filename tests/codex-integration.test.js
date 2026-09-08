import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const script of ['telegram-transaction.sh', 'codex-gate.sh']) {
  test(script, { skip: process.platform !== 'linux', timeout: 120000 }, () => {
    const r = spawnSync('bash', [`tests/${script}`], { encoding: 'utf8', timeout: 110000 });
    assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  });
}
