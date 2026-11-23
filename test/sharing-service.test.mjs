import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SharingService, runtimePaths } from '../lib/sharing-service.mjs';
import { paths, prepare, writeJson } from '../lib/runtime.mjs';
import { randomUUID } from 'node:crypto';
import { secret } from '../lib/host.mjs';

async function fixture(t, failures = 0) {
  const root = await fs.mkdtemp('/tmp/co2-service-');
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
  const services = [service];
  t.after(async () => { for (const instance of services) await instance.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, service, services, calls, counts, get ownerOptions() { return ownerOptions; } };
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

test('shutdown attempts all cleanup but never reports stopped when a resource cannot close', async () => {
  const service = new SharingService({ mode: 'host' });
  const calls = [], phases = [];
  service.on('status', status => phases.push(status.phase));
  service.cleanup.push(() => calls.push('lease-released'));
  service.cleanup.push(() => { calls.push('tunnel-close-failed'); throw new Error('Synthetic tunnel close failure'); });
  service.cleanup.push(() => calls.push('manager-closed'));
  await assert.rejects(service.close(), /Synthetic tunnel close failure/);
  assert.deepEqual(calls, ['manager-closed', 'tunnel-close-failed', 'lease-released']);
  assert.equal(phases.includes('stopped'), false);
});

test('host reloads its persisted sharing limit after service restart without starting public access', async t => {
  const f = await fixture(t); await f.service.start();
  assert.deepEqual(f.ownerOptions.managerSettings.get(), { shareLimit: 10 });
  await f.ownerOptions.managerSettings.setShareLimit(null); await f.service.close();
  let settings;
  const restarted = new SharingService(f.service.options, { ...f.service.dependencies,
    startOwner: async options => { settings = options.managerSettings.get(); return { url: 'http://127.0.0.1:1', revokeAll() {}, close: async () => {} }; } });
  f.services.push(restarted); await restarted.start();
  assert.deepEqual(settings, { shareLimit: null }); assert.equal(f.counts.tunnel, 0);
});

test('host wires private author evidence through service restart without opening a conversation or public relay', async t => {
  const f = await fixture(t); await f.service.start();
  const evidence = { sequence: 0, entries: [], submissions: [] };
  f.ownerOptions.authorHistory.remember('selected-synthetic-thread', evidence); await f.service.close();
  let recovered;
  const restarted = new SharingService(f.service.options, { ...f.service.dependencies,
    startOwner: async options => { recovered = options.authorHistory.get('selected-synthetic-thread'); return { url: 'http://127.0.0.1:1', revokeAll() {}, close: async () => {} }; } });
  f.services.push(restarted); await restarted.start();
  assert.deepEqual(recovered, evidence); assert.equal(f.counts.tunnel, 0);
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

test('reopening a manager verifies a cached attachment and replaces an uninstalled bridge once', async t => {
  const f = await fixture(t);
  Object.assign(f.service.options, { attach: true, deferDesktop: true });
  let installed = true, opens = 0, verifies = 0, closes = 0;
  f.service.dependencies.attachDesktop = async () => {
    const id = ++opens;
    return { isCurrent: async () => { verifies++; return installed; },
      listThreads: async () => [id], close: async () => { closes++; } };
  };
  await f.service.start();
  const list = f.ownerOptions.listThreads;
  assert.deepEqual(await list({}, true), [1]);
  assert.deepEqual(await list({}, true), [1]);
  assert.deepEqual(await list({ search: 'a' }), [1]);
  assert.deepEqual([verifies, opens, closes], [1, 1, 0]);
  installed = false;
  const results = await Promise.all([list({}, true), list({}, true), list({ search: 'b' })]);
  assert.deepEqual(results, [[2], [2], [2]]);
  assert.deepEqual([verifies, opens, closes], [2, 2, 1]);
  await f.service.close();
});

test('deferred first connection failure keeps retry metadata and successful retry does not reconnect twice', async t => {
  const f = await fixture(t); Object.assign(f.service.options, { attach: true, deferDesktop: true });
  let attempts = 0, reconnects = 0;
  const desktopInfo = { transport: 'desktop-app-tools', connected: true, capabilities: { uploads: false } };
  f.service.dependencies.attachDesktop = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('desktop_bridge_connect_timeout'), { code: 'desktop_bridge_connect_timeout' });
    return { desktopInfo, listThreads: async () => [], rpcFactory: async () => {}, selectThread: async () => {},
      reconnect: async () => { reconnects++; }, close: async () => {} };
  };
  await f.service.start();
  assert.equal(attempts, 0);
  assert.deepEqual(f.ownerOptions.getDesktopConnection(), { transport: null, connected: false, canReconnect: true });
  await assert.rejects(f.ownerOptions.listThreads(), { code: 'desktop_bridge_connect_timeout' });
  assert.deepEqual(f.ownerOptions.getDesktopConnection(), { transport: null, connected: false, canReconnect: true });
  await f.ownerOptions.reconnectDesktop();
  assert.equal(attempts, 2); assert.equal(reconnects, 0, 'first successful attach is already a complete reconnect');
  assert.deepEqual(f.ownerOptions.getDesktopConnection(), desktopInfo);
  await f.ownerOptions.reconnectDesktop();
  assert.equal(attempts, 2); assert.equal(reconnects, 1);
  assert.deepEqual(await f.ownerOptions.listThreads(), []);
  assert.deepEqual(f.calls, ['owner'], 'retry never creates a backend or public relay');
});

test('deferred retry shares an in-flight first handshake without restarting its successful result', async t => {
  const f = await fixture(t); Object.assign(f.service.options, { attach: true, deferDesktop: true });
  let finish, attempts = 0, reconnects = 0;
  f.service.dependencies.attachDesktop = async () => {
    attempts++;
    await new Promise(resolve => { finish = resolve; });
    return { listThreads: async () => [], rpcFactory: async () => {}, selectThread: async () => {},
      reconnect: async () => { reconnects++; }, close: async () => {} };
  };
  await f.service.start();
  const list = f.ownerOptions.listThreads(), retry = f.ownerOptions.reconnectDesktop();
  assert.equal(attempts, 1); finish();
  await Promise.all([list, retry]);
  assert.equal(reconnects, 0);
  assert.equal(f.ownerOptions.getDesktopConnection(), null, 'a legacy attachment retains its existing metadata contract');
});

test('Desktop lifecycle events notify every manager without resuming rooms or sending input', async t => {
  for (const deferred of [true, false]) {
    const f = await fixture(t); Object.assign(f.service.options, { attach: true, deferDesktop: deferred });
    const attachment = new EventEmitter(), notifications = []; let connected = true, reads = 0;
    Object.defineProperty(attachment, 'desktopInfo', { get: () => ({ transport: 'desktop-app-tools', connected }) });
    Object.assign(attachment, { listThreads: async () => { reads++; return []; }, close: async () => {},
      reconnect: async () => { connected = true; attachment.emit('connected'); } });
    f.service.dependencies.attachDesktop = async () => attachment;
    const startOwner = f.service.dependencies.startOwner;
    f.service.dependencies.startOwner = async options => {
      const owner = await startOwner(options);
      owner.notifyDesktopChanged = () => notifications.push(options.getDesktopConnection());
      owner.restoreLanRooms = () => assert.fail('connection notification must not restore rooms');
      return owner;
    };
    await f.service.start();
    if (deferred) {
      await f.ownerOptions.listThreads();
      assert.equal(notifications.at(-1).connected, true, 'first lazy handshake notifies an already-open manager');
    }
    connected = false; attachment.emit('disconnected');
    assert.equal(notifications.at(-1).connected, false);
    await f.service.reconnectDesktop();
    assert.equal(notifications.at(-1).connected, true, 'native reconnect uses the same manager notification');
    connected = false; attachment.emit('closed');
    assert.equal(notifications.at(-1).connected, false);
    assert.equal(reads, deferred ? 1 : 0);
    assert.deepEqual(f.calls, ['owner']);
    await f.service.close();
    for (const event of ['connected', 'disconnected', 'closed']) assert.equal(attachment.listenerCount(event), 0);
    const count = notifications.length; attachment.emit('connected'); assert.equal(notifications.length, count);
  }
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

test('recovery exists only with the running built-in relay and entry rebuild or exit cancels its requests', async t => {
  const f = await fixture(t);
  let relayRecovery;
  const startRelay = f.service.dependencies.startRelay;
  f.service.dependencies.startRelay = async options => { relayRecovery = options.recovery; return startRelay(options); };
  await f.service.start(); await f.ownerOptions.ensureRelay();
  const recovery = f.ownerOptions.recovery;
  assert.equal(relayRecovery, recovery);
  const create = () => {
    const origin = 'https://synthetic.example', roomId = randomUUID(), inviteToken = secret();
    recovery.registerRoom({ roomId, inviteToken, threadId: 'synthetic', origin, expiresAt: Date.now() + 3600000 });
    recovery.updateRoom(roomId, { state: 'revoked', endReason: 'expired' });
    const input = { roomId, inviteToken, requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic' };
    assert.equal(recovery.request(input, origin).status, 'pending');
    return () => recovery.watch(input, origin).status;
  };
  const beforeRebuild = create();
  await f.ownerOptions.rebuildRelay();
  assert.equal(beforeRebuild(), 'unavailable');
  const beforeExit = create();
  await f.service.close();
  assert.equal(beforeExit(), 'unavailable');
  const external = new SharingService({ mode: 'host', relayUrl: 'https://synthetic.example' });
  const standalone = new SharingService({ mode: 'relay' });
  assert.equal(external.recovery, undefined); assert.equal(standalone.recovery, undefined);
  await external.close(); await standalone.close();
});
