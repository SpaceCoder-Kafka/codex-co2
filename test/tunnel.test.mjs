import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { startTunnel, validateTunnelOptions } from '../lib/tunnel.mjs';
import { checkHealth } from '../lib/network.mjs';

test('tunnel uses an explicit binary, reports its child and waits for shutdown without external access', async t => {
  const root = await fs.mkdtemp('/tmp/co2-tunnel-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'synthetic-cloudflared');
  await fs.writeFile(binary, '#!/bin/sh\necho "https://synthetic.trycloudflare.com Registered tunnel connection" >&2\nexec /bin/sleep 60\n', { mode: 0o700 });
  let spawned;
  const tunnel = await startTunnel('http://127.0.0.1:1', { binary, onSpawn: child => { spawned = child; } });
  assert.equal(tunnel.url, 'https://synthetic.trycloudflare.com');
  assert.equal(spawned.pid, tunnel.pid);
  await tunnel.close(); await tunnel.close();
  assert.ok(spawned.exitCode != null || spawned.signalCode != null);
  assert.throws(() => process.kill(spawned.pid, 0), { code: 'ESRCH' });
});

test('cancel during tunnel startup terminates the exact child and rejects readiness', async t => {
  const root = await fs.mkdtemp('/tmp/co2-tunnel-abort-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'synthetic-cloudflared');
  await fs.writeFile(binary, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 });
  const controller = new AbortController(); let child;
  await assert.rejects(startTunnel('http://127.0.0.1:1', { binary, signal: controller.signal,
    onSpawn: spawned => { child = spawned; controller.abort(); } }), /exited|aborted/);
  assert.ok(child); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('named tunnel uses a private token file and fixed HTTPS origin without reading a token into argv', async t => {
  const root = await fs.mkdtemp('/tmp/co2-named-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token'), binary = path.join(root, 'cloudflared');
  await fs.writeFile(tokenFile, 'synthetic-secret-not-in-argv', { mode: 0o600 });
  await fs.writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\necho "Registered tunnel connection" >&2\nexec /bin/sleep 60\n', { mode: 0o700 });
  const origin = 'https://co2.example.com';
  const tunnel = await startTunnel('http://127.0.0.1:8787', { binary, tokenFile, origin });
  t.after(() => tunnel.close()); assert.equal(tunnel.url, origin);
  assert.deepEqual((await fs.readFile(binary + '.args', 'utf8')).trim().split('\n'),
    ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token-file', tokenFile, '--url', 'http://127.0.0.1:8787']);
  await tunnel.close();
  await fs.chmod(tokenFile, 0o644);
  await assert.rejects(startTunnel('http://127.0.0.1:8787', { binary, tokenFile, origin }), /private same-user/);
  await fs.chmod(tokenFile, 0o600);
  const alias = path.join(root, 'alias'); await fs.symlink(tokenFile, alias);
  await assert.rejects(startTunnel('http://127.0.0.1:8787', { binary, tokenFile: alias, origin }), /private same-user/);
  for (const origin of [undefined, 'http://co2.example.com', 'https://co2.example.com/path', 'https://co2.example.com/']) {
    assert.throws(() => validateTunnelOptions({ tokenFile, origin }), /origin|HTTPS/);
  }
  assert.throws(() => validateTunnelOptions({ tokenFile: 'relative', origin }), /absolute/);
});

test('public health cancellation interrupts a server that never responds', async t => {
  const controller = new AbortController();
  let stall = false;
  const server = http.createServer((_req, res) => {
    if (stall) controller.abort();
    else res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await checkHealth(origin)).ok, true);
  stall = true;
  const result = await checkHealth(origin, { signal: controller.signal });
  assert.deepEqual(result, { ok: false, reason: 'ABORT_ERR' });
});
