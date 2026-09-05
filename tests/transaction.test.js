import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
test('Git transaction recovery, protected files, receipts and failed push', {
  skip: process.platform === 'win32' && !fs.existsSync(bash),
  timeout: 120000
}, () => {
  const result = spawnSync(bash, ['tests/transaction.sh'], { encoding:'utf8', timeout:110000 });
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});