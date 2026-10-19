import { spawn } from 'node:child_process';
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-200000); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}
