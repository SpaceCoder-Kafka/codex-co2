import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundService, backgroundPaths, connectBackground } from '../lib/background-service.mjs';
import { readBackgroundSettings, writeBackgroundSettings } from '../lib/background-settings.mjs';
import { acquireServiceLease, processIdentity } from '../lib/runtime.mjs';
import { BackgroundChildren } from '../lib/background-children.mjs';
import { spawn } from 'node:child_process';

const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return predicate(); await delay(10); }
  throw new Error('Synthetic background operation timed out');
};
async function fixture(t, options = {}) {
  const { expectedCloseFailure = false, ...daemonOptions } = options;
  const root = await fs.mkdtemp('/tmp/co2-background-');
  const runtimeDir = path.join(root, '.coop'); await fs.mkdir(runtimeDir, { mode: 0o700 });
  const services = [], commands = [], settings = [];
  const daemon = new BackgroundService({ runtimeDir, firstClientMs: 1000, retryMs: 10,
    serviceFactory: args => {
      const service = new EventEmitter(); service.args = args; service.closed = false;
      service.start = async () => ({ ownerUrl: 'http://127.0.0.1:9876/#owner=synthetic-private-capability' });
      service.close = async () => { service.closed = true; };
      service.setBackgroundEnabled = async enabled => { settings.push(enabled); };
      services.push(service); return service;
    }, command: async (service, type) => { commands.push(type); return { ok: true }; }, ...daemonOptions });
  t.after(async () => {
    try { await daemon.close().catch(error => { if (!expectedCloseFailure) throw error; }); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return { root, runtimeDir, daemon, services, commands, settings };
}
async function client(f) {
  const credential = JSON.parse(await fs.readFile(backgroundPaths(f.runtimeDir).credential, 'utf8'));
  const socket = net.connect(backgroundPaths(f.runtimeDir).socket); socket.on('error', () => {});
  const messages = []; let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data; let i;
    while ((i = buffer.indexOf('\n')) !== -1) { messages.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
  });
  await once(socket, 'connect');
  socket.write(JSON.stringify({ type: 'authenticate', protocol: 1, token: credential.token }) + '\n');
  await until(() => messages.some(value => value.type === 'authenticated'));
  return { socket, messages, send: value => socket.write(JSON.stringify(value) + '\n'),
    close: async () => { const closed = once(socket, 'close'); socket.end(); await closed; } };
}

test('background manager reconnects to the same service and UI pipe EOF preserves default-on sharing', async t => {
  const f = await fixture(t); assert.equal(await f.daemon.start(), true);
  const first = await client(f); await until(() => first.messages.some(value => value.type === 'ready'));
  const ready = first.messages.find(value => value.type === 'ready');
  f.services[0].emit('status', { phase: 'ready', rooms: 2, pending: 1 });
  await first.close(); assert.equal(f.services[0].closed, false);
  const next = await client(f);
  assert.deepEqual(next.messages.find(value => value.type === 'ready'), ready);
  assert.equal(next.messages.find(value => value.type === 'status').rooms, 2);
  assert.equal(f.services.length, 1);
  next.send({ type: 'check-network', id: 7 });
  await until(() => next.messages.some(value => value.id === 7));
  assert.deepEqual(f.commands, ['check-network']); await next.close();
});

test('unauthenticated, wrong-secret and execution commands cannot control or stop sharing', async t => {
  const f = await fixture(t); await f.daemon.start();
  for (const request of [{ type: 'shutdown' }, { type: 'authenticate', protocol: 1, token: 'x'.repeat(43) }]) {
    const socket = net.connect(backgroundPaths(f.runtimeDir).socket); socket.on('error', () => {});
    await once(socket, 'connect'); const closed = once(socket, 'close');
    socket.write(JSON.stringify(request) + '\n'); await closed;
  }
  const invalid = await client(f); const closed = once(invalid.socket, 'close');
  invalid.send({ type: 'thread/resume', threadId: 'another-thread' }); await closed;
  assert.deepEqual(f.commands, []); assert.equal(f.services[0].closed, false);
  const held = net.connect(backgroundPaths(f.runtimeDir).socket); held.on('error', () => {}); await once(held, 'connect');
  await f.daemon.close(); assert.equal(f.services[0].closed, true); held.destroy();
});

test('disabling is durable, clears recovery first, and closes after the final manager disconnects', async t => {
  const f = await fixture(t); await f.daemon.start();
  const first = await client(f), second = await client(f);
  first.send({ type: 'set-background', enabled: false, id: 9 });
  await until(() => first.messages.some(value => value.id === 9));
  assert.deepEqual(await readBackgroundSettings(f.runtimeDir), { enabled: false });
  assert.deepEqual(f.settings, [false]);
  assert.equal(first.messages.find(value => value.id === 9).ok, true);
  assert.equal(f.services[0].closed, false); await first.close();
  assert.equal(f.services[0].closed, false);
  const ended = once(f.daemon, 'closed'); await second.close(); await ended;
  const next = new BackgroundService({ runtimeDir: f.runtimeDir, serviceFactory: () => { throw new Error('must not start'); } });
  assert.equal(await next.start(), false);
});

test('failed recovery erasure cannot persist a background-enabled preference', async t => {
  const f = await fixture(t); await f.daemon.start();
  const c = await client(f);
  f.services[0].setBackgroundEnabled = async () => { throw new Error('synthetic-disk-failure'); };
  c.send({ type: 'set-background', enabled: false, id: 1 });
  await until(() => c.messages.some(value => value.id === 1));
  assert.equal(c.messages.find(value => value.id === 1).type, 'error');
  assert.equal((await readBackgroundSettings(f.runtimeDir)).enabled, false);
  assert.equal(JSON.stringify(c.messages).includes('synthetic-disk-failure'), false);
  const closed = once(f.daemon, 'closed'); await c.close(); await closed;
});

test('forced foreground service never outlives its manager even with enabled preference', async t => {
  const f = await fixture(t, { foreground: true }); await f.daemon.start();
  const c = await client(f); assert.equal(f.services[0].args.persistentLan, true);
  assert.equal(c.messages.find(value => value.type === 'background-state').background, false);
  const closed = once(f.daemon, 'closed'); await c.close(); await closed;
  assert.equal(f.services[0].closed, true);
});

test('foreground startup without a manager still closes while a disabled preference forbids persistence', async t => {
  const f = await fixture(t, { foreground: true, firstClientMs: 40 });
  await writeBackgroundSettings(f.runtimeDir, false);
  const closed = once(f.daemon, 'closed');
  await f.daemon.start(); await closed;
  assert.equal(f.services[0].args.persistentLan, false);
  assert.equal(f.services[0].closed, true);
});

test('native pipe bridge hides authentication and EOF only closes that management connection', async t => {
  const f = await fixture(t); await f.daemon.start();
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', data => { text += data; });
  const bridge = connectBackground({ runtimeDir: f.runtimeDir, input, output });
  await until(() => text.includes('"ready"'));
  assert.equal(text.includes('authenticated'), false); assert.equal(text.includes('"token"'), false);
  input.end(); await bridge;
  assert.equal(f.services[0].closed, false);
});

test('background settings and endpoint discovery reject untrusted files', async t => {
  const f = await fixture(t);
  const settings = path.join(f.runtimeDir, 'background-settings.json');
  await fs.writeFile(settings, '{"version":1,"enabled":true,"unexpected":"secret"}', { mode: 0o600 });
  await assert.rejects(f.daemon.start(), /Invalid background service setting/);
  await fs.unlink(settings);
  await fs.symlink(path.join(f.root, 'external.json'), settings);
  await assert.rejects(writeBackgroundSettings(f.runtimeDir, false));
  await fs.unlink(settings);
  await f.daemon.start();
  await fs.chmod(backgroundPaths(f.runtimeDir).credential, 0o644);
  await assert.rejects(connectBackground({ runtimeDir: f.runtimeDir, input: new PassThrough(), output: new PassThrough() }), /private file/);
});

test('service lease recovers only confirmed stale private ownership and excludes concurrent starters', async t => {
  const f = await fixture(t); const p = { runtimeDir: f.runtimeDir };
  const file = path.join(f.runtimeDir, 'sharing.lock');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, ...processIdentity(process.pid) }), { mode: 0o600 });
  await assert.rejects(acquireServiceLease(p, 'sharing', { runtimeOnly: true, recoverStale: true }), /live|locked/);
  // A previous process with a reused PID has a different kernel-observed
  // command/start fingerprint. Recovery never sends a signal to that PID.
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, fingerprint: 'a'.repeat(64) }), { mode: 0o600 });
  const starts = await Promise.allSettled(Array.from({ length: 5 }, () => acquireServiceLease(p, 'sharing', { runtimeOnly: true, recoverStale: true })));
  assert.equal(starts.filter(value => value.status === 'fulfilled').length, 1);
  await starts.find(value => value.status === 'fulfilled').value();
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await assert.rejects(acquireServiceLease(p, 'sharing', { runtimeOnly: true, recoverStale: true }), /Unrecognized/);
  await fs.unlink(file);
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, fingerprint: 'a'.repeat(64) }), { mode: 0o644 });
  await assert.rejects(acquireServiceLease(p, 'sharing', { runtimeOnly: true, recoverStale: true }), /private file/);
});

test('daemon-owned tunnel cleanup verifies both process fingerprint and expected executable', async t => {
  const f = await fixture(t);
  const executable = path.join(f.root, 'synthetic-cloudflared');
  await fs.writeFile(executable, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o700 });
  const child = spawn(executable, ['tunnel', '--synthetic'], { stdio: 'ignore' });
  const exited = once(child, 'exit'); await once(child, 'spawn');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const journal = new BackgroundChildren(f.runtimeDir, executable);
  const identity = processIdentity(child.pid); assert.ok(identity);
  journal.record({ pid: child.pid, fingerprint: '0'.repeat(64) });
  await journal.retire(); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  journal.record({ pid: child.pid, fingerprint: identity.fingerprint });
  await journal.retire(); await exited;
  assert.ok(child.signalCode || child.exitCode !== null);
  await assert.rejects(fs.stat(path.join(f.runtimeDir, 'background-children.json')), { code: 'ENOENT' });
});

test('startup failure retries without dropping authenticated managers or emitting sensitive errors', async t => {
  let attempts = 0;
  const f = await fixture(t, { serviceFactory: () => {
    const service = new EventEmitter(); const attempt = ++attempts;
    service.start = async () => { if (attempt === 1) throw new Error('synthetic-private-error'); return { ownerUrl: 'http://127.0.0.1:1/#owner=synthetic' }; };
    service.close = async () => {}; return service;
  } });
  await f.daemon.start(); const c = await client(f);
  await until(() => c.messages.some(message => message.type === 'ready'));
  assert.equal(attempts, 2); assert.equal(JSON.stringify(c.messages).includes('synthetic-private-error'), false);
  await c.close();
});

test('failed service cleanup never acknowledges stopped and still closes manager transports', async t => {
  const failure = new Error('synthetic-private-cleanup-error');
  const f = await fixture(t, { expectedCloseFailure: true }); await f.daemon.start();
  const c = await client(f); await until(() => c.messages.some(message => message.type === 'ready'));
  f.services[0].close = async () => { throw failure; };
  const closed = once(c.socket, 'close');
  await assert.rejects(f.daemon.close(), error => error === failure); await closed;
  assert.equal(c.messages.some(message => message.type === 'stopped'), false);
  assert.equal(c.messages.some(message => message.type === 'error'), true);
  assert.equal(JSON.stringify(c.messages).includes(failure.message), false);
  await assert.rejects(fs.stat(backgroundPaths(f.runtimeDir).credential), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.runtimeDir, 'background.lock')), { code: 'ENOENT' });
});

test('failed startup cleanup stops the daemon without retrying or acknowledging clean shutdown', async t => {
  let failStart, attempts = 0;
  const startup = new Promise((resolve, reject) => { failStart = reject; });
  const cleanupFailure = new Error('synthetic-private-startup-cleanup-failure');
  const f = await fixture(t, { expectedCloseFailure: true, serviceFactory: () => {
    attempts++;
    const service = new EventEmitter();
    service.start = () => startup;
    service.close = async () => { throw cleanupFailure; };
    return service;
  } });
  await f.daemon.start(); const c = await client(f);
  const closed = once(f.daemon, 'closed'), disconnected = once(c.socket, 'close');
  failStart(new Error('synthetic-startup-failure'));
  assert.equal((await closed)[0], cleanupFailure); await disconnected;
  await delay(30);
  assert.equal(attempts, 1); assert.equal(f.daemon.closed, true);
  assert.equal(Boolean(f.daemon.retryTimer), false);
  assert.equal(c.messages.some(message => message.type === 'stopped' || message.type === 'ready'), false);
  assert.equal(c.messages.some(message => message.type === 'error'), true);
  assert.equal(JSON.stringify(c.messages).includes(cleanupFailure.message), false);
  await assert.rejects(fs.stat(backgroundPaths(f.runtimeDir).credential), { code: 'ENOENT' });
});

test('enabling waits until service initialization has applied the disabled-start revocation boundary', async t => {
  let finishStart, changes = [];
  const starting = new Promise(resolve => { finishStart = resolve; });
  const f = await fixture(t, { foreground: true, serviceFactory: () => {
    const service = new EventEmitter();
    service.start = () => starting;
    service.close = async () => {};
    service.setBackgroundEnabled = async enabled => { changes.push(enabled); };
    return service;
  } });
  await writeBackgroundSettings(f.runtimeDir, false);
  await f.daemon.start(); const c = await client(f);
  c.send({ type: 'set-background', enabled: true, id: 12 });
  await until(() => c.messages.some(message => message.id === 12));
  assert.equal(c.messages.find(message => message.id === 12).type, 'error');
  assert.equal((await readBackgroundSettings(f.runtimeDir)).enabled, false);
  assert.deepEqual(changes, []);
  finishStart({ ownerUrl: 'http://127.0.0.1:1/#owner=synthetic' });
  await until(() => c.messages.some(message => message.type === 'ready'));
  c.send({ type: 'set-background', enabled: true, id: 13 });
  await until(() => c.messages.some(message => message.id === 13));
  assert.equal(c.messages.find(message => message.id === 13).ok, true);
  assert.deepEqual(changes, [true]);
  const ended = once(f.daemon, 'closed'); await c.close(); await ended;
});
