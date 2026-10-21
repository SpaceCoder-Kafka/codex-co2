import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t, { ipc = false, attach = true } = {}) {
  const root = await fs.mkdtemp('/tmp/co2-helper-');
  const runtimeDir = path.join(root, '.coop');
  const resourceRoot = process.env.CO2_TEST_RESOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
  const cloudflared = path.join(root, 'cloudflared');
  await fs.writeFile(cloudflared, '#!/bin/sh\nif [ "$1" = --version ]; then echo "cloudflared version 2026.10.1 (synthetic)"; exit 0; fi\nexit 99\n', { mode: 0o700 });
  const requests = [], sockets = new Set();
  let server;
  if (ipc) {
    const directory = path.join(root, '.codex/ipc');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = Buffer.alloc(0);
      socket.on('data', bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE();
          if (buffer.length < size + 4) return;
          const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
          requests.push(request.method);
          const response = Buffer.from(JSON.stringify({ type: 'response', resultType: 'success', method: request.method,
            requestId: request.requestId, result: { clientId: randomUUID() } }));
          const header = Buffer.alloc(4); header.writeUInt32LE(response.length);
          socket.write(Buffer.concat([header, response]));
        }
      });
    });
    server.listen(path.join(directory, 'ipc.sock')); await once(server, 'listening');
    await fs.chmod(path.join(directory, 'ipc.sock'), 0o600);
  }
  const child = spawn(process.execPath, [path.join(resourceRoot, 'bin/desktop-service.mjs'), '--runtime-dir', runtimeDir,
    '--resource-root', resourceRoot, '--cloudflared', cloudflared, ...(attach ? ['--attach'] : [])], {
    env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', CODEX_COOP_CLI: '/missing/codex' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = []; let buffer = '', stderr = '';
  const exited = once(child, 'exit');
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await exited; }
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const waitFor = async predicate => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode != null || child.signalCode != null) throw new Error(`Helper exited: ${stderr}`);
      await delay(10);
    }
    throw new Error('Helper response timeout');
  };
  return { root, runtimeDir, child, exited, requests, messages, waitFor, get stderr() { return stderr; } };
}

test('packaged helper attaches without a CLI and never creates an isolated backend or home', { timeout: 10000 }, async t => {
  const f = await fixture(t, { ipc: true });
  const ready = await f.waitFor(m => m.type === 'ready');
  assert.ok(ready.ownerUrl.startsWith('http://127.0.0.1:'));
  f.child.stdin.write('{"type":"account","id":1}\n{"type":"connect-current","id":2}\n');
  assert.equal((await f.waitFor(m => m.id === 1)).attached, true);
  assert.equal((await f.waitFor(m => m.id === 2)).ok, true);
  assert.deepEqual(f.requests, ['initialize', 'initialize']);
  for (const name of ['home', 'server.json', 'Open-Test-Desktop.command']) {
    await assert.rejects(fs.stat(path.join(f.runtimeDir, name)), { code: 'ENOENT' });
  }
  f.child.stdin.write('{"type":"shutdown"}\n');
  assert.equal((await f.exited)[0], 0);
  await assert.rejects(fs.stat(path.join(f.runtimeDir, 'sharing.lock')), { code: 'ENOENT' });
});

test('packaged helper with unavailable Desktop fails closed without resolving a backend', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.exited)[0], 0);
  assert.ok(f.messages.some(m => m.type === 'error'));
  assert.ok(!f.messages.some(m => m.type === 'ready'));
  for (const name of ['home', 'server.json', 'sharing.lock']) {
    await assert.rejects(fs.stat(path.join(f.runtimeDir, name)), { code: 'ENOENT' });
  }
});

test('isolated helper still requires an explicit CLI instead of using a global fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t, { attach: false });
  assert.notEqual((await f.exited)[0], 0);
  assert.match(f.stderr, /requires an absolute CLI path/);
  await assert.rejects(fs.stat(f.runtimeDir), { code: 'ENOENT' });
});
