import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startRelay } from '../lib/relay.mjs';

const secret = () => randomBytes(32).toString('base64url');
async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coop-relay-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><p>Guest</p>');
  await fs.writeFile(path.join(dir, 'guest.js'), '// guest');
  await fs.writeFile(path.join(dir, 'notifications.js'), '// notifications');
  await fs.writeFile(path.join(dir, 'notification-worker.js'), '// notification worker');
  await fs.writeFile(path.join(dir, 'style.css'), 'body {}');
  await fs.writeFile(path.join(dir, 'private.txt'), 'must not be served');
  const registrationSecret = secret();
  const relay = await startRelay({ registrationSecret, publicDir: dir, ...overrides });
  t.after(async () => { await relay.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...relay, registrationSecret };
}

async function connect(relay, endpoint, origin = endpoint === '/guest' ? relay.url : undefined) {
  const ws = new WebSocket(relay.url.replace(/^http/, 'ws') + endpoint, origin ? { origin } : {});
  const messages = [];
  const waiters = new Set();
  ws.on('error', () => {});
  ws.on('message', bytes => {
    messages.push(JSON.parse(bytes.toString()));
    for (const wake of [...waiters]) wake();
  });
  await once(ws, 'open');
  return {
    ws, messages,
    send: message => ws.send(JSON.stringify(message)),
    next(type) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Missing ${type}: ${JSON.stringify(messages)}`)); }, 1500);
        function check() {
          const index = messages.findIndex(message => message.type === type);
          if (index < 0) return;
          clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]);
        }
        waiters.add(check); check();
      });
    },
  };
}

async function register(relay, existing = {}) {
  const credentials = { type: 'register', registrationSecret: relay.registrationSecret, roomId: randomUUID(), hostToken: secret(), inviteToken: secret(), expiresAt: Date.now() + 60_000, ...existing };
  const host = await connect(relay, '/host');
  host.send(credentials);
  const registered = await host.next('registered');
  return { host, credentials, registered };
}

async function join(relay, credentials, name = 'Bob', extra = {}) {
  const guest = await connect(relay, '/guest');
  guest.send({ type: 'join', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name, ...extra });
  return guest;
}

async function admit(relay, host, credentials) {
  const guest = await join(relay, credentials);
  const { guestId } = await guest.next('pending');
  assert.equal((await host.next('join-request')).guestId, guestId);
  host.send({ type: 'admit', guestId });
  await guest.next('admitted');
  return { guest, guestId };
}

test('relay serves only fixed public assets and never emits CORS permissions', async t => {
  const relay = await fixture(t);
  const page = await fetch(relay.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.match(page.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.equal(await (await fetch(relay.url + '/notifications.js')).text(), '// notifications');
  const worker = await fetch(relay.url + '/notification-worker.js');
  assert.match(worker.headers.get('content-type'), /text\/javascript/);
  assert.equal(worker.headers.get('cache-control'), 'no-store');
  assert.equal(await worker.text(), '// notification worker');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await page.text(), '<!doctype html><p>Guest</p>');
  assert.deepEqual(await (await fetch(relay.url + '/health')).json(), { ok: true });
  for (const suffix of ['/private.txt', '/%2e%2e/private.txt', '/guest.js?token=hidden', '/host']) {
    assert.equal((await fetch(relay.url + suffix)).status, 404);
  }
  assert.equal((await fetch(relay.url, { method: 'POST' })).status, 405);
});

test('operator authentication and same-origin browser admission are required', async t => {
  const relay = await fixture(t);
  await assert.rejects(connect(relay, '/guest', 'https://attacker.example'), /403/);
  await assert.rejects(connect(relay, '/guest', ''), /403/);
  await assert.rejects(connect(relay, '/host', relay.url), /403/);
  const bad = await connect(relay, '/host');
  bad.send({ type: 'register', registrationSecret: secret(), roomId: randomUUID(), hostToken: secret(), inviteToken: secret(), expiresAt: Date.now() + 60_000 });
  await bad.next('registration-rejected');
  const { host, credentials } = await register(relay);
  const wrongInvite = await join(relay, { ...credentials, inviteToken: secret() });
  await wrongInvite.next('join-rejected');
  const privilegeInjection = await join(relay, credentials, 'Bob', { role: 'owner', threadId: 'another-thread' });
  await privilegeInjection.next('join-rejected');
  assert.equal(host.messages.some(message => message.type === 'join-request'), false);
});

test('invite possession does not expose content; proposals require admission and cannot address threads', async t => {
  const relay = await fixture(t);
  const { host, credentials } = await register(relay);
  const guest = await join(relay, credentials, 'Bob', { sessionId: 'pretend-existing-session' });
  const { guestId } = await guest.next('pending');
  assert.notEqual(guestId, 'pretend-existing-session');
  assert.equal((await host.next('join-request')).name, 'Bob');
  host.send({ type: 'deliver', payload: { type: 'snapshot', text: 'not for pending users' } });
  host.send({ type: 'admit', guestId });
  await guest.next('admitted');
  assert.equal(guest.messages.some(message => message.type === 'data'), false);
  host.send({ type: 'deliver', guestId, payload: { type: 'snapshot', text: 'selected thread' } });
  assert.deepEqual(await guest.next('data'), { type: 'data', payload: { type: 'snapshot', text: 'selected thread' } });
  const proposal = { type: 'proposal', requestId: randomUUID(), text: 'Please explain this function' };
  guest.send(proposal);
  assert.deepEqual(await host.next('guest-message'), { type: 'guest-message', guestId, payload: proposal });
  guest.send(proposal);
  assert.equal((await guest.next('duplicate')).requestId, proposal.requestId);
  guest.send({ type: 'snapshot-request' });
  assert.equal((await host.next('guest-message')).payload.type, 'snapshot-request');
  assert.equal(host.messages.some(message => message.type === 'guest-message'), false);
  guest.send({ ...proposal, requestId: randomUUID(), threadId: 'private-thread' });
  await guest.next('invalid-message');
});

test('room identity and targeted delivery isolate guests and hosts', async t => {
  const relay = await fixture(t);
  const a = await register(relay);
  const b = await register(relay);
  const first = await admit(relay, a.host, a.credentials);
  const second = await admit(relay, a.host, a.credentials);
  const third = await admit(relay, b.host, b.credentials);
  a.host.send({ type: 'deliver', guestId: first.guestId, payload: { type: 'notice', text: 'only first' } });
  await first.guest.next('data');
  a.host.send({ type: 'deliver', guestId: third.guestId, payload: { type: 'notice', text: 'not in room' } });
  b.host.send({ type: 'deliver', payload: { type: 'notice', text: 'room B' } });
  assert.equal((await third.guest.next('data')).payload.text, 'room B');
  assert.equal(second.guest.messages.some(message => message.type === 'data'), false);
  assert.equal(third.guest.messages.some(message => message.type === 'data'), false);
  const stolen = await join(relay, { ...b.credentials, inviteToken: a.credentials.inviteToken });
  await stolen.next('join-rejected');
});

test('image requests require admission and accept only an opaque reference, without filesystem or RPC fields', async t => {
  const relay = await fixture(t), { host, credentials } = await register(relay);
  const pending = await join(relay, credentials); await pending.next('pending'); await host.next('join-request');
  pending.send({ type: 'image-request', imageId: 'a'.repeat(64) }); await pending.next('not-admitted');
  const { guest, guestId } = await admit(relay, host, credentials);
  const payload = { type: 'image-request', imageId: 'b'.repeat(64) }; guest.send(payload);
  assert.deepEqual(await host.next('guest-message'), { type: 'guest-message', guestId, payload });
  guest.send({ ...payload, path: '/synthetic/private.png' }); await guest.next('invalid-message');
});

test('disconnect requires host authentication and fresh guest admission, without replay', async t => {
  const relay = await fixture(t);
  const { host, credentials } = await register(relay);
  const { guest, guestId } = await admit(relay, host, credentials);
  const closed = once(host.ws, 'close');
  host.ws.close();
  await guest.next('offline');
  await closed;
  const attacker = await connect(relay, '/host');
  attacker.send({ ...credentials, hostToken: secret() });
  await attacker.next('registration-rejected');
  const reconnect = await register(relay, credentials);
  const again = await join(relay, credentials, 'Bob', { sessionId: guestId });
  const pending = await again.next('pending');
  assert.notEqual(pending.guestId, guestId);
  assert.equal((await reconnect.host.next('join-request')).guestId, pending.guestId);
  again.send({ type: 'proposal', requestId: randomUUID(), text: 'Not admitted yet' });
  await again.next('not-admitted');
  assert.equal(reconnect.host.messages.some(message => message.type === 'guest-message'), false);
});

test('revocation closes recipients and cannot resurrect an old invitation', async t => {
  const relay = await fixture(t);
  const { host, credentials } = await register(relay);
  const first = await admit(relay, host, credentials);
  const second = await admit(relay, host, credentials);
  host.send({ type: 'revoke', guestId: first.guestId });
  await first.guest.next('revoked');
  host.send({ type: 'deliver', payload: { type: 'notice', text: 'second remains' } });
  await second.guest.next('data');
  host.send({ type: 'revoke' });
  await second.guest.next('revoked');
  await host.next('revoked');
  const resurrection = await connect(relay, '/host');
  resurrection.send(credentials);
  await resurrection.next('registration-rejected');
  const formerGuest = await join(relay, credentials);
  await formerGuest.next('join-rejected');
});

test('expiry, payload and proposal limits bound relay resources', async t => {
  const relay = await fixture(t);
  const short = await register(relay, { expiresAt: Date.now() + 150 });
  await delay(160);
  const expired = await join(relay, short.credentials);
  await expired.next('join-rejected');
  const { host, credentials } = await register(relay);
  const { guest } = await admit(relay, host, credentials);
  for (let i = 0; i < 20; i++) {
    guest.send({ type: 'proposal', requestId: randomUUID(), text: 'bounded input' });
    await host.next('guest-message');
  }
  guest.send({ type: 'proposal', requestId: randomUUID(), text: 'one too many' });
  await guest.next('rate-limited');
  const large = await connect(relay, '/guest');
  const closed = once(large.ws, 'close');
  large.ws.send('x'.repeat(65 * 1024));
  assert.equal((await closed)[0], 1009);
});

test('explicit public origin works while loopback and unrelated origins are denied', async t => {
  const relay = await fixture(t, { allowedOrigins: ['https://collaboration.example'] });
  await assert.rejects(connect(relay, '/guest'), /403/);
  const guest = await connect(relay, '/guest', 'https://collaboration.example');
  guest.ws.close();
  relay.setAllowedOrigins([relay.url, 'https://fresh-tunnel.example']);
  const local = await connect(relay, '/guest');
  local.ws.close();
  await assert.rejects(connect(relay, '/guest', 'https://collaboration.example'), /403/);
  const page = await fetch(relay.url);
  assert.match(page.headers.get('content-security-policy'), /wss:\/\/fresh-tunnel\.example/);
  assert.throws(() => relay.setAllowedOrigins(['https://attacker.example/path']), /Invalid/);
  await assert.rejects(startRelay({ registrationSecret: 'weak' }), /32-byte/);
});

test('names use 40 Unicode characters; only exact fixed Markdown asset routes are public', async t => {
  const relay = await fixture(t);
  const { host, credentials } = await register(relay);
  const guest = await join(relay, credentials, '😀'.repeat(40));
  await guest.next('pending');
  assert.equal((await host.next('join-request')).name, '😀'.repeat(40));
  for (const name of ['x'.repeat(41), '\n坏名字', '坏\u0085名字']) {
    const bad = await join(relay, credentials, name); await bad.next('join-rejected');
  }
  const asset = await fetch(relay.url + '/vendor/markdown-it.min.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.ok((await asset.text()).length > 1000);
  for (const suffix of ['/vendor/package.json', '/vendor/markdown-it.min.js?x=1', '/node_modules/markdown-it/package.json']) assert.equal((await fetch(relay.url + suffix)).status, 404);
});

test('host renewal is idempotent, keeps the invitation and admissions, and still expires at the new deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const relay = await fixture(t), { host, credentials, registered } = await register(relay);
  assert.equal(registered.renewalSupported, true);
  const { guest, guestId } = await admit(relay, host, credentials);
  const proposal = { type: 'proposal', requestId: randomUUID(), text: 'Do not replay across renewal' };
  guest.send(proposal); await host.next('guest-message');
  const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: credentials.expiresAt,
    expiresAt: credentials.expiresAt + 3600000 };
  host.send(request);
  const expected = { type: 'renewed', roomId: credentials.roomId, requestId: request.requestId, expiresAt: request.expiresAt };
  assert.deepEqual(await host.next('renewed'), expected);
  host.send(request); assert.deepEqual(await host.next('renewed'), expected);
  guest.send(proposal); assert.equal((await guest.next('duplicate')).requestId, proposal.requestId);
  t.mock.timers.tick(60001);
  const arriving = await join(relay, credentials); await arriving.next('pending'); await host.next('join-request');
  host.send({ type: 'deliver', guestId, payload: { type: 'notice', text: 'Original admission still works' } });
  assert.equal((await guest.next('data')).payload.text, 'Original admission still works');
  t.mock.timers.tick(3600000);
  host.send(request);
  await host.next('expired'); await guest.next('expired'); await arriving.next('expired');
});

test('only the current authenticated host may renew; guests and competing host connections cannot', async t => {
  const relay = await fixture(t), { host, credentials } = await register(relay);
  const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: credentials.expiresAt,
    expiresAt: credentials.expiresAt + 3600000 };
  const unauthenticated = await connect(relay, '/host');
  unauthenticated.send(request); await unauthenticated.next('registration-rejected');
  const competing = await connect(relay, '/host');
  competing.send(credentials); await competing.next('registration-rejected');
  const pending = await join(relay, credentials); await pending.next('pending'); await host.next('join-request');
  pending.send(request); await pending.next('not-admitted');
  const { guest } = await admit(relay, host, credentials);
  guest.send(request); await guest.next('invalid-message');
  host.send(request); assert.equal((await host.next('renewed')).expiresAt, request.expiresAt);
});

test('renewal rejects malformed, stale, non-increasing, excessive and conflicting requests', async t => {
  const relay = await fixture(t);
  const invalid = [
    request => ({ ...request, requestId: 'not-a-uuid' }),
    request => ({ ...request, previousExpiresAt: String(request.previousExpiresAt) }),
    request => ({ ...request, expiresAt: 'later' }),
    request => ({ ...request, expiresAt: request.expiresAt + 0.5 }),
    request => ({ ...request, previousExpiresAt: request.previousExpiresAt - 1 }),
    request => ({ ...request, expiresAt: request.previousExpiresAt }),
    request => ({ ...request, expiresAt: request.previousExpiresAt - 1 }),
    request => ({ ...request, expiresAt: Date.now() + 86400000 + 60000 }),
    request => ({ ...request, threadId: 'another-thread' }),
    request => { const { previousExpiresAt, ...rest } = request; return rest; },
  ];
  for (const change of invalid) {
    const { host, credentials } = await register(relay);
    const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: credentials.expiresAt,
      expiresAt: credentials.expiresAt + 3600000 };
    host.send(change(request)); await host.next('invalid-message');
    assert.equal(host.messages.some(message => message.type === 'renewed'), false);
  }
  for (const field of ['expiresAt', 'previousExpiresAt']) {
    const { host, credentials } = await register(relay);
    const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: credentials.expiresAt,
      expiresAt: credentials.expiresAt + 3600000 };
    host.send(request); await host.next('renewed');
    host.send({ ...request, [field]: request[field] + 1 }); await host.next('invalid-message');
  }
});

test('lost renewal acknowledgements reconcile only the last committed lease on authenticated reconnect', async t => {
  const relay = await fixture(t), { host, credentials } = await register(relay);
  const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: credentials.expiresAt,
    expiresAt: credentials.expiresAt + 3600000 };
  host.send(request); await host.next('renewed');
  const closed = once(host.ws, 'close'); host.ws.close(); await closed;
  for (const overrides of [{ expiresAt: credentials.expiresAt + 1 }, { expiresAt: request.expiresAt + 1 },
    { hostToken: secret() }, { inviteToken: secret() }]) {
    const rejected = await connect(relay, '/host'); rejected.send({ ...credentials, ...overrides });
    await rejected.next('registration-rejected');
  }
  const reconnect = await register(relay, credentials);
  assert.equal(reconnect.registered.expiresAt, request.expiresAt);
  reconnect.host.send(request); assert.equal((await reconnect.host.next('renewed')).expiresAt, request.expiresAt);
  const second = { type: 'renew', requestId: randomUUID(), previousExpiresAt: request.expiresAt,
    expiresAt: request.expiresAt + 3600000 };
  reconnect.host.send(second); await reconnect.host.next('renewed');
  const secondClosed = once(reconnect.host.ws, 'close'); reconnect.host.ws.close(); await secondClosed;
  const tooOld = await connect(relay, '/host'); tooOld.send(credentials); await tooOld.next('registration-rejected');
  const final = await register(relay, { ...credentials, expiresAt: request.expiresAt });
  assert.equal(final.registered.expiresAt, second.expiresAt);
});

test('registration cannot revive an expired relay lease by supplying a future deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const relay = await fixture(t), { host, credentials } = await register(relay);
  const closed = once(host.ws, 'close'); host.ws.close(); await closed;
  t.mock.timers.tick(60001);
  const revived = await connect(relay, '/host'); revived.send({ ...credentials, expiresAt: Date.now() + 60000 });
  await revived.next('registration-rejected');
});

test('rolling leases may outlive 24 hours in total but explicit revocation remains final', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const relay = await fixture(t), { host, credentials } = await register(relay);
  let expiresAt = credentials.expiresAt;
  for (let i = 0; i < 26; i++) {
    const request = { type: 'renew', requestId: randomUUID(), previousExpiresAt: expiresAt, expiresAt: expiresAt + 3600000 };
    host.send(request); assert.equal((await host.next('renewed')).expiresAt, request.expiresAt);
    expiresAt = request.expiresAt;
    t.mock.timers.tick(3600000);
  }
  assert.ok(expiresAt - credentials.expiresAt > 86400000);
  host.send({ type: 'revoke' }); await host.next('revoked');
  const revival = await connect(relay, '/host'); revival.send({ ...credentials, expiresAt });
  await revival.next('registration-rejected');
});
