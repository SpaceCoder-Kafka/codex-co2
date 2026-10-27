import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SharingService } from '../lib/sharing-service.mjs';
import { lanInterfaces, selectLanAddress } from '../lib/lan-network.mjs';
import { openLanSettings } from '../lib/lan-settings.mjs';

const privateInterface = address => ({ address, family: 'IPv4', internal: false });
async function fixture(t, { saved, interfaces = { en0: [privateInterface('192.168.40.2')] }, options = {}, dependencies = {} } = {}) {
  const root = await fs.mkdtemp('/tmp/co2-lan-service-'), runtimeDir = path.join(root, '.coop');
  await fs.mkdir(runtimeDir, { mode: 0o700 });
  if (saved) await fs.writeFile(path.join(runtimeDir, 'lan-sharing.json'), JSON.stringify({ version: 1, ...saved }), { mode: 0o600 });
  const calls = [], relays = [], counts = { tunnel: 0, health: 0 };
  let ownerOptions;
  const owner = { url: 'http://127.0.0.1:1/#owner=synthetic',
    setConnection() {}, revokeAll: () => calls.push('revoke'), close: async () => calls.push('owner-close') };
  const service = new SharingService({ mode: 'host', attach: true, resourceRoot: root, runtimeDir, lazyPublic: true, lanCheckIntervalMs: 100000, ...options }, {
    attachDesktop: async () => ({ rpcFactory: async () => {}, listThreads: async () => [], selectThread: async () => {}, close: () => calls.push('detach') }),
    start: async () => { throw new Error('LAN tests must not start a backend'); },
    startOwner: async value => { ownerOptions = value; return owner; },
    lanInterfaces: () => lanInterfaces(interfaces), selectLanAddress: address => selectLanAddress(address, interfaces),
    startRelay: async value => {
      const relay = { options: value, url: 'http://127.0.0.1:35000', inviteOrigin: value.lanAddress ? `http://${value.lanAddress}:35001` : 'http://127.0.0.1:35000',
        setAllowedOrigins: origins => { relay.origins = origins; }, close: async () => { relay.closed = true; calls.push('relay-close'); } };
      relays.push(relay); calls.push('relay'); return relay;
    },
    startTunnel: async () => { counts.tunnel++; calls.push('tunnel'); return { url: 'https://synthetic.example', close: async () => calls.push('tunnel-close') }; },
    checkHealth: async () => { counts.health++; return { ok: true }; }, ...dependencies,
  });
  const services = [service];
  t.after(async () => { for (const instance of services) await instance.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, runtimeDir, service, services, calls, counts, relays, interfaces, get ownerOptions() { return ownerOptions; } };
}

test('persisted LAN mode survives restart without public access, and host transport stays loopback', async t => {
  const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' }, options: { lazyPublic: false } });
  await f.service.start();
  assert.equal(f.counts.tunnel, 0); assert.equal(f.relays.length, 0);
  assert.equal(f.ownerOptions.getNetwork().intranetOnly, true);
  assert.equal(await f.ownerOptions.ensureRelay(), 'http://127.0.0.1:35000');
  assert.equal(f.ownerOptions.getInviteOrigin(), 'http://192.168.40.2:35001');
  assert.equal(f.relays[0].options.host, '127.0.0.1'); assert.equal(f.relays[0].options.port, 0);
  assert.equal(f.relays[0].options.lanAddress, '192.168.40.2');
  assert.deepEqual(f.relays[0].origins, ['http://192.168.40.2:35001']);
  assert.equal(f.counts.health, 0); assert.equal(f.counts.tunnel, 0);
});

test('missing or changed LAN addresses keep management available and fail closed without a tunnel', async t => {
  for (const interfaces of [{}, { en0: [privateInterface('192.168.50.2')] }]) {
    const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' }, interfaces });
    await f.service.start();
    await assert.rejects(f.ownerOptions.ensureRelay(), /未找到|已不可用/);
    assert.equal(f.ownerOptions.getNetwork().intranetOnly, true);
    assert.equal(f.service.connection.state, 'unavailable');
    assert.equal(f.relays.length, 0); assert.equal(f.counts.tunnel, 0); assert.equal(f.counts.health, 0);
  }
});

test('enabling LAN closes the old public transport, selects a current address and persists privately', async t => {
  const f = await fixture(t); await f.service.start(); await f.ownerOptions.ensureRelay();
  assert.equal(f.counts.tunnel, 1);
  await f.ownerOptions.setNetwork({ intranetOnly: true, lanAddress: null });
  assert.equal(f.relays[0].closed, true); assert.ok(f.calls.includes('tunnel-close'));
  assert.equal(f.service.monitor, null); assert.equal(f.service.tunnel, null);
  assert.equal(f.service.getNetwork().lanAddress, '192.168.40.2');
  const file = path.join(f.runtimeDir, 'lan-sharing.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, intranetOnly: true, lanAddress: '192.168.40.2' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.runtimeDir)).mode & 0o777, 0o700);
  await f.ownerOptions.ensureRelay();
  assert.equal(f.counts.tunnel, 1); assert.equal(f.relays[1].options.lanAddress, '192.168.40.2');
  await f.service.close();
  const restarted = new SharingService(f.service.options, f.service.dependencies); f.services.push(restarted);
  await restarted.start(); await restarted.ensureRelay();
  assert.equal(restarted.getNetwork().intranetOnly, true); assert.equal(f.counts.tunnel, 1);
});

test('unusable or ambiguous selection records restrictive intent but never reports a successful switch', async t => {
  for (const interfaces of [{}, { en0: [privateInterface('192.168.40.2')], utun0: [privateInterface('10.20.0.2')] }]) {
    const f = await fixture(t, { interfaces }); await f.service.start(); await f.service.ensureRelay();
    await assert.rejects(f.service.setNetwork({ intranetOnly: true, lanAddress: null }), /未找到|多个/);
    assert.equal(f.service.getNetwork().intranetOnly, true); assert.equal(f.service.connection.state, 'unavailable');
    assert.equal(f.service.tunnel, null); assert.equal(f.relays[0].closed, true);
    assert.equal((await openLanSettings(path.join(f.runtimeDir, 'lan-sharing.json'))).get().intranetOnly, true);
    await assert.rejects(f.service.ensureRelay(), /未找到|多个/);
    assert.equal(f.counts.tunnel, 1);
  }
});

test('resource-close failure still closes relay and leaves restart in persisted LAN mode', async t => {
  const f = await fixture(t, { dependencies: { startTunnel: async () => ({ url: 'https://synthetic.example', close: async () => { throw new Error('Synthetic close failure'); } }) } });
  await f.service.start(); await f.service.ensureRelay();
  await assert.rejects(f.service.setNetwork({ intranetOnly: true, lanAddress: '192.168.40.2' }), /close failure/);
  assert.equal(f.relays[0].closed, true); assert.equal(f.service.getNetwork().intranetOnly, true);
  assert.equal((await openLanSettings(path.join(f.runtimeDir, 'lan-sharing.json'))).get().intranetOnly, true);
});

test('LAN disappearance revokes authorization and closes listeners without changing mode or falling back', async t => {
  const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' } });
  await f.service.start(); await f.service.ensureRelay();
  f.interfaces.en0 = [];
  await assert.rejects(f.ownerOptions.checkConnection(), /未找到/);
  assert.ok(f.calls.includes('revoke')); assert.equal(f.relays[0].closed, true);
  assert.equal(f.service.relay, null); assert.equal(f.service.lanTimer, null);
  assert.equal(f.service.getNetwork().intranetOnly, true); assert.equal(f.service.connection.state, 'unavailable');
  await assert.rejects(f.service.ensureRelay(), /未找到/); assert.equal(f.counts.tunnel, 0);
});

test('LAN rebuilding stays private and disabling it needs an explicit saved switch before public access', async t => {
  const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' } });
  await f.service.start(); await f.service.ensureRelay(); await f.ownerOptions.rebuildRelay();
  assert.equal(f.relays.length, 2); assert.equal(f.relays[0].closed, true); assert.equal(f.counts.tunnel, 0);
  await f.ownerOptions.setNetwork({ intranetOnly: false, lanAddress: null });
  assert.equal(f.relays[1].closed, true); assert.equal(f.counts.tunnel, 0);
  await f.service.ensureRelay(); assert.equal(f.counts.tunnel, 1);
});

test('explicit public deployment configuration cannot be silently replaced by the manager', async t => {
  const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' }, options: { relayUrl: 'https://synthetic-relay.example' } });
  await f.service.start(); assert.equal(f.service.getNetwork().configurable, false);
  assert.equal(f.service.getNetwork().intranetOnly, false);
  await assert.rejects(f.ownerOptions.setNetwork({ intranetOnly: true, lanAddress: '192.168.40.2' }), /启动参数/);
  assert.equal(f.counts.tunnel, 0); assert.equal(f.relays.length, 0);
});

test('CLI LAN conflicts fail before any runtime, attachment or outbound resource is created', async t => {
  for (const options of [{ publicMode: true }, { relayUrl: 'https://synthetic.example' }, { origin: 'https://synthetic.example', tunnelTokenFile: '/synthetic/token' },
    { bind: '0.0.0.0' }, { mode: 'relay', attach: false }, { mode: 'demo', attach: false }]) {
    const f = await fixture(t, { options: { intranetOnly: true, ...options } });
    await assert.rejects(f.service.start(), /cannot be combined|requires host/);
    assert.equal(f.calls.length, 0); assert.equal(f.counts.health, 0);
  }
  const f = await fixture(t, { options: { lanAddress: '192.168.40.2' } });
  await assert.rejects(f.service.start(), /requires --intranet-only/);
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/share.mjs', '--help'], { cwd: new URL('..', import.meta.url) });
  assert.match(stdout, /--intranet-only/); assert.match(stdout, /--lan-address/);
});

test('explicit LAN startup requires the existing Desktop before creating any runtime directory or resources', async t => {
  const root = await fs.mkdtemp('/tmp/co2-lan-attach-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.coop'), calls = [];
  const service = new SharingService({ mode: 'host', intranetOnly: true, resourceRoot: root, runtimeDir }, {
    attachDesktop: async () => { calls.push('attach'); }, start: async () => { calls.push('backend'); },
    startDesktopBridge: async () => { calls.push('bridge'); }, startOwner: async () => { calls.push('owner'); },
    startRelay: async () => { calls.push('relay'); }, startTunnel: async () => { calls.push('tunnel'); },
  });
  t.after(() => service.close());
  await assert.rejects(service.start(), /requires host --attach/);
  assert.deepEqual(calls, []);
  await assert.rejects(fs.stat(runtimeDir), { code: 'ENOENT' });
});

test('persisted LAN restriction rejects an isolated start without preparing its home or profile', async t => {
  const f = await fixture(t, { saved: { intranetOnly: true, lanAddress: '192.168.40.2' }, options: { attach: false } });
  await assert.rejects(f.service.start(), /requires host --attach/);
  assert.deepEqual(f.calls, []); assert.equal(f.counts.tunnel, 0); assert.equal(f.counts.health, 0);
  assert.equal(f.service.getNetwork().configurable, false);
  assert.deepEqual(await fs.readdir(f.runtimeDir), ['lan-sharing.json']);
  for (const name of ['home', 'desktop-profile', 'workspace']) {
    await assert.rejects(fs.stat(path.join(f.runtimeDir, name)), { code: 'ENOENT' });
  }
});

test('an existing synthetic isolated host cannot enable LAN sharing through management', async t => {
  const calls = [];
  const f = await fixture(t, { options: { attach: false }, dependencies: {
    start: async () => { calls.push('backend'); },
    startDesktopBridge: async () => { calls.push('bridge'); return { launcher: 'synthetic', close: async () => {} }; },
  } });
  const binary = path.join(f.root, 'synthetic-codex');
  await fs.writeFile(binary, '#!/bin/sh\necho "codex-cli 0.163.0"\n', { mode: 0o700 });
  f.service.options.cliPath = binary;
  await f.service.start();
  assert.deepEqual(calls, ['backend', 'bridge']);
  assert.equal(f.ownerOptions.getNetwork().configurable, false);
  await assert.rejects(f.ownerOptions.setNetwork({ intranetOnly: true, lanAddress: '192.168.40.2' }), /启动参数/);
  assert.equal(f.service.getNetwork().intranetOnly, false); assert.equal(f.counts.tunnel, 0);
});

