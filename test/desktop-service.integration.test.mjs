import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveCli, readJson, paths, ownsProcess, stop } from '../lib/runtime.mjs';
let binary;
if (process.env.CODEX_COOP_INTEGRATION === '1') { try { binary = resolveCli().cliPath; } catch {} }
const skip = !binary ? 'Run test:integration with exact Codex 0.163.0' : false;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(fn) { const end = Date.now() + 12000; while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(25); } throw new Error('Desktop service timeout'); }

test('private desktop helper starts without a public tunnel; EOF/quit cleans sharing, and relaunch reuses one backend', { skip, timeout: 60000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/co2-app-it-'));
  const runtimeDir = path.join(root, '.coop');
  await fs.mkdir(path.join(runtimeDir, 'home'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(runtimeDir, 'home/auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-only' }), { mode: 0o600 });
  const cloudflared = path.join(root, 'cloudflared');
  const marker = path.join(root, 'tunnel-was-started');
  await fs.writeFile(cloudflared, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'cloudflared version 2026.10.1 (synthetic)'; exit 0; fi\ntouch ${quote(marker)}\nexit 1\n`, { mode: 0o700 });
  const resourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const children = [];
  let p;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) {
        const exited = once(child, 'exit'); child.stdin.end();
        await Promise.race([exited, delay(3000)]);
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }
    }
    if (p) await stop(p);
    await fs.rm(root, { recursive: true, force: true });
  });
  const launch = () => {
    const child = spawn(process.execPath, [path.join(resourceRoot, 'bin/desktop-service.mjs'), '--runtime-dir', runtimeDir,
      '--resource-root', resourceRoot, '--cli', binary, '--cloudflared', cloudflared],
      { env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.messages = []; child.stderrText = '';
    let buffer = '';
    child.stdout.on('data', bytes => { buffer += bytes; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); child.messages.push(JSON.parse(line)); } });
    child.stderr.on('data', bytes => { child.stderrText += bytes; });
    children.push(child); return child;
  };
  let previous;
  for (let cycle = 0; cycle < 2; cycle++) {
    const child = launch();
    const ready = await until(() => { if (child.exitCode != null) throw new Error(child.stderrText); return child.messages.find(m => m.type === 'ready'); });
    assert.ok(ready.ownerUrl.startsWith('http://127.0.0.1:'));
    const state = await readJson(path.join(runtimeDir, 'server.json'));
    p = paths(root, { runtimeDir, shortSocket: true });
    assert.ok(ownsProcess(state, p));
    if (previous) assert.equal(state.pid, previous.pid);
    previous = state;
    assert.equal(await fs.stat(marker).then(() => true, () => false), false);
    if (cycle === 0) {
      const duplicate = launch(); const [code] = await once(duplicate, 'exit');
      assert.equal(code, 0); // Controlled failure emits a safe error and closes its private pipe.
      assert.ok(duplicate.messages.some(m => m.type === 'error'));
      assert.equal((await readJson(path.join(runtimeDir, 'sharing.lock'))).pid, child.pid);
    }
    const exited = once(child, 'exit');
    if (cycle === 0) child.stdin.end();
    else child.stdin.write('{"type":"shutdown"}\n');
    await exited;
    assert.ok(ownsProcess(state, p));
    assert.equal(await readJson(path.join(runtimeDir, 'host-service.json')), null);
    await assert.rejects(fs.stat(path.join(runtimeDir, 'sharing.lock')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(runtimeDir, 'Open-Test-Desktop.command')), { code: 'ENOENT' });
    assert.ok(!child.stderrText.includes('synthetic-only'));
  }
});
