import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCli } from '../lib/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fail before running tests when the exact backend is absent. A skipped run
// must never satisfy CI or the release acceptance check.
const { cliPath, version } = resolveCli();
const handle = await fs.open(cliPath, 'r');
try {
  const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0);
  if (header.toString() === '#!') throw new Error('CODEX_COOP_CLI must point to the native Codex executable, not an npm or shell launcher; isolated tests do not inherit the development PATH');
} finally { await handle.close(); }
console.log(`Required isolated backend: ${version}`);
const tests = (await fs.readdir(path.join(root, 'test'))).filter(name => name.endsWith('.integration.test.mjs')).sort();
if (tests.length !== 4) throw new Error('Review integration inventory before changing the required suite count');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map(name => path.join(root, 'test', name))], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, CODEX_COOP_INTEGRATION: '1', CODEX_COOP_CLI: cliPath },
});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0 || !/^# tests \d+$/m.test(result.stdout) || !/^# skipped 0$/m.test(result.stdout) || /# SKIP\b/i.test(result.stdout)) {
  throw new Error('Required isolated integration run failed or skipped tests');
}
