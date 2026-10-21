import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SharingService, runtimePaths } from '../lib/sharing-service.mjs';
import { paths, prepare, writeJson } from '../lib/runtime.mjs';

async function fixture(t, failures = 0) {
  const root = await fs.mkdtemp('/tmp/co2-service-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'fake-codex');
  await fs.writeFile(binary, '#!/bin/sh\necho "codex-cli 0.163.0"\n', { mode: 0o700 });
  const calls = [], counts = { tunnel: 0 }, owner = { url: 'http://127.0.0.1:1/#owner=synthetic',
    close: async () => { calls.push('owner-close'); }, revokeAll: () => { calls.push('revoke'); } };
  let ownerOptions;
  const service = new SharingService({ mode: 'host', resourceRoot: root, runtimeDir: path.join(root, '.coop'), cliPath: binary, lazyPublic: true }, {
    start: async () => { calls.push('backend'); },
    startOwner: async options => { ownerOptions = options; calls.push('owner'); return owner; },
    startDesktopBridge: async () => ({ launcher: 'synthetic', close: async () => { calls.push('bridge-close'); } }),
    startRelay: async () => { calls.push('relay'); return { url: 'http://127.0.0.1:1', setAllowedOrigins() {}, close: async () => calls.push('relay-close') }; },
    startTunnel: async () => { counts.tunnel++; if (counts.tunnel <= failures) throw new Error('offline'); return { url: 'https://synthetic.example', close: async () => calls.push('tunnel-close') }; },
    checkHealth: async () => ({ ok: true }),
  });
  t.after(() => service.close());
  return { root, service, calls, counts, get ownerOptions() { return ownerOptions; } };
}

test('desktop starts locally, creates one lazy public connection, and exit preserves the backend', async t => {
  const f = await fixture(t); await f.service.start();
  assert.deepEqual(f.calls, ['backend', 'owner']);
  assert.equal(f.counts.tunnel, 0);
  const results = await Promise.all([f.ownerOptions.ensureRelay(), f.ownerOptions.ensureRelay()]);
  assert.deepEqual(results, ['https://synthetic.example', 'https://synthetic.example']); assert.equal(f.counts.tunnel, 1);
  await f.service.close();
  assert.ok(f.calls.indexOf('revoke') < f.calls.indexOf('tunnel-close'));
  assert.ok(!f.calls.includes('backend-stop'));
  await assert.rejects(fs.stat(path.join(f.root, '.coop/sharing.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, '.coop/host-service.json')), { code: 'ENOENT' });
});

test('host reloads its persisted sharing limit after service restart without starting public access', async t => {
  const f = await fixture(t); await f.service.start();
  assert.deepEqual(f.ownerOptions.managerSettings.get(), { shareLimit: 10 });
  await f.ownerOptions.managerSettings.setShareLimit(null); await f.service.close();
  let settings;
  const restarted = new SharingService(f.service.options, { ...f.service.dependencies,
    startOwner: async options => { settings = options.managerSettings.get(); return { url: 'http://127.0.0.1:1', revokeAll() {}, close: async () => {} }; } });
  t.after(() => restarted.close()); await restarted.start();
  assert.deepEqual(settings, { shareLimit: null }); assert.equal(f.counts.tunnel, 0);
});

test('failed public startup is retryable and does not prevent the local management service', async t => {
  const f = await fixture(t, 1); await f.service.start();
  await assert.rejects(f.ownerOptions.ensureRelay(), /offline/);
  assert.equal(f.service.status.phase, 'ready');
  assert.equal(await f.ownerOptions.ensureRelay(), 'https://synthetic.example'); assert.equal(f.counts.tunnel, 2);
});

test('an explicitly selected existing home preserves its socket; default app homes use a short socket', async t => {
  const root = await fs.mkdtemp('/tmp/co2-paths-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = paths(root); await prepare(p); await writeJson(p.stateFile, { codexHome: p.codexHome, socketPath: p.socketPath });
  assert.equal((await runtimePaths(root, p.runtimeDir)).socketPath, p.socketPath);
  await fs.unlink(p.stateFile);
  assert.equal((await runtimePaths(root, p.runtimeDir)).socketPath, path.join(await fs.realpath(p.runtimeDir), 'rpc.sock'));
  await assert.rejects(runtimePaths(root, path.join(root, '.codex')), /absolute .coop/);
});

test('selected runtimes cannot redirect authentication or history into another home', async t => {
  const root = await fs.mkdtemp('/tmp/co2-alias-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.coop'); await fs.mkdir(runtimeDir);
  const other = path.join(root, 'unrelated-home'); await fs.mkdir(other);
  await fs.symlink(other, path.join(runtimeDir, 'home'));
  await assert.rejects(runtimePaths(root, runtimeDir), /must not be symlinked/);
  assert.deepEqual(await fs.readdir(other), []);
});

test('attach startup bypasses CLI resolution, backend creation, isolated home and Desktop launcher', async t => {
  const f = await fixture(t); f.service.options.attach = true;
  f.service.options.cliPath = '/does-not-exist/never-execute';
  f.service.dependencies.attachDesktop = async () => ({ rpcFactory: async () => {}, listThreads: async () => [], selectThread: async () => {}, close: () => f.calls.push('detach') });
  const info = await f.service.start();
  assert.equal(info.attached, true); assert.equal(info.desktopLauncher, null);
  assert.deepEqual(f.calls, ['owner']); assert.equal(f.ownerOptions.attached, true);
  await assert.rejects(fs.stat(path.join(f.root, '.coop/home')), { code: 'ENOENT' });
  await f.service.close(); assert.ok(f.calls.includes('detach')); assert.ok(!f.calls.includes('backend'));
});

test('attach failure starts no backend, owner, bridge or public relay and releases the lease', async t => {
  const f = await fixture(t); f.service.options.attach = true; f.service.options.lazyPublic = false;
  f.service.dependencies.attachDesktop = async () => { throw new Error('No supported running Desktop'); };
  await assert.rejects(f.service.start(), /No supported/); assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(path.join(f.root, '.coop/sharing.lock')), { code: 'ENOENT' });
});

test('named tunnel validates before starting resources and forwards only explicit fixed-origin options', async t => {
  const f = await fixture(t);
  f.service.options.tunnelTokenFile = '/synthetic/token';
  await assert.rejects(f.service.start(), /requires --origin/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(path.join(f.root, '.coop')), { code: 'ENOENT' });
  const g = await fixture(t);
  Object.assign(g.service.options, { tunnelTokenFile: '/synthetic/token', origin: 'https://synthetic.example' });
  let tunnelOptions;
  const startTunnel = g.service.dependencies.startTunnel;
  g.service.dependencies.startTunnel = async (url, options) => { tunnelOptions = options; return startTunnel(url, options); };
  await g.service.start(); await g.ownerOptions.ensureRelay();
  assert.equal(tunnelOptions.tokenFile, '/synthetic/token'); assert.equal(tunnelOptions.origin, 'https://synthetic.example');
  assert.equal(g.service.relayUrl, 'https://synthetic.example');
});

test('closing during stalled public health checks aborts readiness and cleans the tunnel and lease', async t => {
  const f = await fixture(t); await f.service.start();
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  f.service.dependencies.checkHealth = async (_origin, { signal }) => {
    entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false };
  };
  const connecting = f.ownerOptions.ensureRelay();
  const rejected = assert.rejects(connecting, /abort|closed/i);
  await checking; await f.service.close(); await rejected;
  assert.ok(f.calls.includes('tunnel-close')); assert.ok(f.calls.includes('relay-close'));
  await assert.rejects(fs.stat(path.join(f.root, '.coop/sharing.lock')), { code: 'ENOENT' });
});

test('ongoing failure and manual checks preserve the tunnel and recover status; rebuilding is explicit and serialized', async t => {
  const f = await fixture(t); await f.service.start(); await f.ownerOptions.ensureRelay();
  let healthy = false;
  f.service.monitor.checkHealth = async () => ({ ok: healthy });
  for (let i = 0; i < 3; i++) await f.ownerOptions.checkConnection();
  assert.equal(f.service.connection.state, 'unavailable');
  assert.equal(f.counts.tunnel, 1); assert.ok(!f.calls.includes('revoke'));
  healthy = true; await f.ownerOptions.checkConnection();
  assert.equal(f.service.connection.state, 'online'); assert.equal(f.counts.tunnel, 1);
  await Promise.all([f.ownerOptions.rebuildRelay(), f.ownerOptions.rebuildRelay()]);
  assert.equal(f.counts.tunnel, 2); assert.equal(f.calls.filter(v => v === 'revoke').length, 1);
  assert.ok(f.calls.indexOf('revoke') < f.calls.indexOf('tunnel-close'));
});

test('a retired tunnel exit cannot revoke replacement rooms; an unexpected current exit requires re-sharing', async t => {
  const f = await fixture(t), children = [];
  f.service.dependencies.startTunnel = async () => {
    const child = new EventEmitter(); children.push(child); f.counts.tunnel++;
    return { child, url: 'https://synthetic.example', close: async () => child.emit('exit') };
  };
  await f.service.start(); await f.ownerOptions.ensureRelay(); await f.ownerOptions.rebuildRelay();
  assert.equal(f.service.connection.state, 'online');
  const revokes = f.calls.filter(v => v === 'revoke').length;
  children[0].emit('exit'); assert.equal(f.calls.filter(v => v === 'revoke').length, revokes);
  children[1].emit('exit'); assert.equal(f.calls.filter(v => v === 'revoke').length, revokes + 1);
  assert.equal(f.service.connection.state, 'stopped'); assert.equal(f.service.status.public, false);
  assert.equal(f.counts.tunnel, 2, 'a failed tunnel is not automatically replaced');
});

test('shutdown during a rebuild cannot create a replacement tunnel after cleanup', async t => {
  const f = await fixture(t); await f.service.start(); await f.ownerOptions.ensureRelay();
  let entered;
  const probing = new Promise(resolve => { entered = resolve; });
  f.service.monitor.checkHealth = (_url, { signal }) => new Promise(resolve => {
    entered(); signal.addEventListener('abort', () => resolve({ ok: false }), { once: true });
  });
  const check = f.ownerOptions.checkConnection(); await probing;
  const rebuild = f.ownerOptions.rebuildRelay(); const rejected = assert.rejects(rebuild, /closed/i);
  await f.service.close(); await check; await rejected;
  assert.equal(f.counts.tunnel, 1); assert.equal(f.service.status.phase, 'stopped');
});
