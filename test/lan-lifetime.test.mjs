import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { SharedRoom, startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { GuestPermissions, recoveryHash } from '../lib/guest-permissions.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, LEAD = 300000, lanAddress = '192.168.40.20';
const lanOptions = () => ({ relayUrl: 'http://127.0.0.1:35000', inviteOrigin: `http://${lanAddress}:35001`, intranetOnly: true,
  registrationSecret: secret(), threadId: 'synthetic-lifetime' });
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); } throw new Error('Synthetic lifetime timeout'); };
function unit(t, inviteLifetime = '1h') {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1800000000000 });
  const sent = [], permissions = new GuestPermissions();
  const room = new SharedRoom({ ...lanOptions(), inviteLifetime, permissions });
  room.state = 'online'; room.renewalSupported = true; room.lastHeartbeat = Date.now();
  room.thread = { snapshot: { title: 'Synthetic LAN lifetime', status: 'idle' }, close() {} };
  room.ws = { readyState: WebSocket.OPEN, send: data => sent.push(JSON.parse(data)),
    close() { this.readyState = WebSocket.CLOSED; }, terminate() { this.readyState = WebSocket.CLOSED; } };
  t.after(() => room.close());
  const renewals = () => sent.filter(message => message.type === 'renew');
  const ack = () => ({ type: 'renewed', roomId: room.roomId, requestId: room.pendingRenewal.requestId, expiresAt: room.pendingRenewal.expiresAt });
  return { room, permissions, sent, renewals, ack };
}
async function fixture(t) {
  let serverCount = 0;
  const registrationSecret = secret();
  const relay = await startRelay({ lanAddress, registrationSecret, createHttpServer(handler) {
    const server = http.createServer(handler);
    if (serverCount++ === 1) {
      const listen = server.listen;
      server.listen = function(port, host, callback) { assert.equal(host, lanAddress); return listen.call(this, port, '127.0.0.1', callback); };
      server.prependListener('upgrade', req => Object.defineProperties(req.socket, {
        localAddress: { configurable: true, value: lanAddress }, remoteAddress: { configurable: true, value: '192.168.40.21' },
      }));
    }
    return server;
  } });
  t.after(() => relay.close());
  return { relay, registrationSecret, guestURL: `http://127.0.0.1:${relay.lanServer.address().port}/guest`,
    guestOptions: { headers: { Host: new URL(relay.inviteOrigin).host }, origin: relay.inviteOrigin } };
}
async function connection(t, url, options) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'), options), messages = [], waiting = new Set();
  ws.on('error', () => {}); t.after(() => ws.terminate());
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); for (const check of [...waiting]) check(); });
  await once(ws, 'open');
  return { ws, messages, send: value => ws.send(JSON.stringify(value)), next(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`Missing ${type}`)); }, 2500);
      function check() { const index = messages.findIndex(message => message.type === type); if (index < 0) return;
        clearTimeout(timer); waiting.delete(check); resolve(messages.splice(index, 1)[0]); }
      waiting.add(check); check();
    });
  } };
}
const credentials = (f, overrides = {}) => ({ type: 'register', registrationSecret: f.registrationSecret, roomId: randomUUID(),
  hostToken: secret(), inviteToken: secret(), expiresAt: Date.now() + HOUR, inviteExpiresAt: Date.now() + DAY, ...overrides });
async function joined(t, f, host, registration) {
  const guest = await connection(t, f.guestURL, f.guestOptions);
  guest.send({ type: 'join', roomId: registration.roomId, inviteToken: registration.inviteToken, name: 'Synthetic guest' });
  const { guestId } = await guest.next('pending'); await host.next('join-request');
  host.send({ type: 'admit', guestId }); await guest.next('admitted'); return guest;
}

test('LAN lifetimes have immutable exact deadlines while transport and recovery keep short leases', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  for (const [inviteLifetime, duration] of [['1h', HOUR], ['1d', DAY], ['7d', 7 * DAY], ['permanent', null]]) {
    const room = new SharedRoom({ ...lanOptions(), inviteLifetime, permissions: new GuestPermissions() });
    assert.equal(room.inviteExpiresAt, duration === null ? null : Date.now() + duration);
    assert.equal(room.expiresAt, Date.now() + HOUR);
    assert.equal(room.view().inviteLifetime, inviteLifetime); assert.equal(room.view().intranetOnly, true);
    assert.throws(() => { room.inviteExpiresAt = Date.now() + 90 * DAY; }, TypeError);
    assert.throws(() => { room.inviteLifetime = 'permanent'; }, TypeError);
    room.close();
  }
  assert.equal(new SharedRoom(lanOptions()).inviteLifetime, '1h');
  for (const inviteLifetime of [null, '', '2h', 3600000, ['1h'], {}, '__proto__']) {
    assert.throws(() => new SharedRoom({ ...lanOptions(), inviteLifetime }), /时效/);
  }
  assert.throws(() => new SharedRoom({ relayUrl: 'https://synthetic.example', registrationSecret: secret(), threadId: 'synthetic', inviteLifetime: 'permanent' }), /时效/);
  const publicRoom = new SharedRoom({ relayUrl: 'https://synthetic.example', registrationSecret: secret(), threadId: 'synthetic' });
  assert.equal(Object.hasOwn(publicRoom.view(), 'inviteExpiresAt'), false);
});

test('one-hour LAN invitation never auto-renews and expiry revokes admission and pending work', t => {
  const { room, permissions, renewals } = unit(t);
  room.proposals.set('pending', { status: 'pending', text: 'Synthetic pending input' });
  room.scheduleExpiry();
  t.mock.timers.tick(HOUR - LEAD); room.lastHeartbeat = Date.now(); room.maybeRenew();
  assert.equal(renewals().length, 0);
  t.mock.timers.tick(LEAD);
  assert.equal(room.closed, true); assert.equal(room.endReason, 'expired');
  assert.equal(room.proposals.get('pending').status, 'rejected');
  assert.equal(permissions.scopes.some(scope => scope.id === room.admissionScope), false);
});

test('LAN renewal clips the final lease to the fixed deadline and does not schedule another extension', t => {
  const { room, renewals, ack } = unit(t, '1d'), deadline = room.inviteExpiresAt;
  room.expiresAt = deadline - HOUR / 2;
  t.mock.timers.setTime(room.expiresAt - LEAD); room.lastHeartbeat = Date.now(); room.maybeRenew();
  assert.equal(renewals()[0].expiresAt, deadline);
  room.confirmRenewal(ack()); assert.equal(room.expiresAt, deadline); assert.equal(room.inviteExpiresAt, deadline);
  t.mock.timers.setTime(deadline - LEAD); room.lastHeartbeat = Date.now(); room.maybeRenew();
  assert.equal(renewals().length, 1); assert.equal(room.canExtendLease(), false);
  t.mock.timers.tick(LEAD); assert.equal(room.closed, true);
});

test('permanent LAN invitation retains its link across multiple days of leases without permanent recovery credentials', t => {
  const { room, permissions, ack } = unit(t, 'permanent'), invite = room.view().inviteUrl;
  const hash = secret(); assert.equal(recoveryHash(hash), true);
  const guest = { id: 'synthetic-guest', participantId: randomUUID(), name: 'Synthetic guest', status: 'admitted', resumeHash: hash };
  room.guests.set(guest.id, guest); permissions.allow(room.admissionScope, hash, guest, room.expiresAt);
  for (let i = 0; i < 50; i++) {
    t.mock.timers.setTime(room.expiresAt - LEAD); room.lastHeartbeat = Date.now(); room.maybeRenew();
    assert.ok(room.pendingRenewal); room.confirmRenewal(ack());
    const grant = permissions.get(room.admissionScope, hash);
    assert.ok(grant.expiresAt <= Date.now() + DAY); assert.equal(grant.expiresAt, room.expiresAt);
    assert.equal(room.inviteExpiresAt, null); assert.equal(room.view().inviteUrl, invite); assert.equal(room.closed, false);
  }
  room.close(); room.maybeRenew(); assert.equal(room.closed, true); assert.equal(room.pendingRenewal, null);
  assert.equal(permissions.get(room.admissionScope, hash), undefined);
});

test('host enforces deadline before queued execution, admission and attachment reads, even before timers run', async t => {
  const { room, sent } = unit(t, '1h'); let dispatched = 0, reads = 0;
  const guest = { id: 'synthetic-guest', participantId: randomUUID(), name: 'Synthetic guest', status: 'admitted' };
  room.guests.set(guest.id, guest);
  room.proposals.set('pending', { status: 'pending', guestId: guest.id, text: 'Synthetic queued request' });
  room.thread.submitApproved = async () => { dispatched++; }; room.thread.hasFile = () => true; room.thread.readFile = async () => { reads++; };
  t.mock.timers.setTime(room.inviteExpiresAt);
  await assert.rejects(room.decide('pending', true), /到期/);
  await room.sendPreview(guest, 'a'.repeat(64), 'file');
  assert.equal(dispatched, 0); assert.equal(reads, 0); assert.equal(room.closed, true);
  assert.equal(sent.some(message => message.type === 'deliver'), false);
  assert.throws(() => room.admit(guest.id, true), /到期/);
});

test('LAN relay requires and echoes a bounded immutable deadline while public relay rejects its extension', async t => {
  const f = await fixture(t);
  for (const value of [undefined, 'permanent', 0, Date.now() + 8 * DAY, Date.now() + HOUR / 2]) {
    const host = await connection(t, f.relay.url + '/host'); const input = credentials(f);
    if (value === undefined) delete input.inviteExpiresAt; else input.inviteExpiresAt = value;
    host.send(input); await host.next('registration-rejected');
  }
  for (const deadline of [null, Date.now() + 7 * DAY]) {
    const host = await connection(t, f.relay.url + '/host'); host.send(credentials(f, { inviteExpiresAt: deadline }));
    assert.equal((await host.next('registered')).inviteExpiresAt, deadline);
  }
  const publicRelay = await startRelay({ registrationSecret: f.registrationSecret }); t.after(() => publicRelay.close());
  const publicHost = await connection(t, publicRelay.url + '/host'); publicHost.send(credentials(f, { inviteExpiresAt: null }));
  await publicHost.next('registration-rejected');
});

test('LAN relay clips authorization to the deadline and lost-ACK reconnect cannot change or reset it', async t => {
  const f = await fixture(t), original = credentials(f, { inviteExpiresAt: Date.now() + HOUR + LEAD });
  const host = await connection(t, f.relay.url + '/host'); host.send(original); await host.next('registered');
  host.send({ type: 'renew', requestId: randomUUID(), previousExpiresAt: original.expiresAt, expiresAt: original.inviteExpiresAt });
  assert.equal((await host.next('renewed')).expiresAt, original.inviteExpiresAt);
  const closed = once(host.ws, 'close'); host.ws.close(); await closed;
  const changed = await connection(t, f.relay.url + '/host'); changed.send({ ...original, inviteExpiresAt: null });
  await changed.next('registration-rejected');
  const reconnect = await connection(t, f.relay.url + '/host'); reconnect.send(original);
  const registered = await reconnect.next('registered');
  assert.equal(registered.expiresAt, original.inviteExpiresAt); assert.equal(registered.inviteExpiresAt, original.inviteExpiresAt);
  reconnect.send({ type: 'renew', requestId: randomUUID(), previousExpiresAt: registered.expiresAt, expiresAt: registered.expiresAt + 1 });
  await reconnect.next('invalid-message');
});

test('deadline rejects new joins and blocks existing guest file requests before forwarding to the host', async t => {
  const f = await fixture(t), original = credentials(f, { expiresAt: Date.now() + 60000, inviteExpiresAt: Date.now() + 60000 });
  const host = await connection(t, f.relay.url + '/host'); host.send(original); await host.next('registered');
  const guest = await joined(t, f, host, original);
  t.mock.timers.enable({ apis: ['Date'], now: original.inviteExpiresAt });
  guest.send({ type: 'file-request', fileId: 'a'.repeat(64) });
  await guest.next('expired'); await host.next('expired');
  assert.equal(host.messages.some(message => message.type === 'guest-message'), false);
  const newcomer = await connection(t, f.guestURL, f.guestOptions);
  newcomer.send({ type: 'join', roomId: original.roomId, inviteToken: original.inviteToken, name: 'Synthetic late guest' });
  await newcomer.next('join-rejected');
});

test('relay maintenance closes host and admitted guests at the fixed deadline without incoming traffic', async t => {
  const f = await fixture(t), original = credentials(f, { expiresAt: Date.now() + 60000, inviteExpiresAt: Date.now() + 60000 });
  const host = await connection(t, f.relay.url + '/host'); host.send(original); await host.next('registered');
  const guest = await joined(t, f, host, original);
  t.mock.timers.enable({ apis: ['Date'], now: original.inviteExpiresAt });
  await Promise.all([host.next('expired'), guest.next('expired')]);
});

test('permanent LAN relay supports multi-day bounded renewals and explicit revocation still invalidates the invitation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const f = await fixture(t), original = credentials(f, { inviteExpiresAt: null });
  const host = await connection(t, f.relay.url + '/host'); host.send(original); await host.next('registered');
  let expiry = original.expiresAt;
  for (let i = 0; i < 50; i++) {
    t.mock.timers.setTime(expiry - LEAD);
    host.send({ type: 'renew', requestId: randomUUID(), previousExpiresAt: expiry, expiresAt: expiry + HOUR });
    expiry = (await host.next('renewed')).expiresAt; assert.ok(expiry <= Date.now() + DAY);
  }
  const guest = await joined(t, f, host, original);
  host.send({ type: 'revoke' }); await guest.next('revoked'); await host.next('revoked');
  const newcomer = await connection(t, f.guestURL, f.guestOptions);
  newcomer.send({ type: 'join', roomId: original.roomId, inviteToken: original.inviteToken, name: 'Synthetic revoked guest' });
  await newcomer.next('join-rejected');
});

test('LAN host fails closed when a relay does not confirm its fixed or permanent policy', async t => {
  for (const inviteLifetime of ['1d', 'permanent']) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    server.on('connection', ws => ws.on('message', bytes => {
      const message = JSON.parse(bytes);
      if (message.type === 'register') ws.send(JSON.stringify({ type: 'registered', roomId: message.roomId, expiresAt: message.expiresAt, renewalSupported: true }));
    }));
    const room = new SharedRoom({ ...lanOptions(), inviteLifetime, relayUrl: `http://127.0.0.1:${server.address().port}` });
    t.after(() => room.close()); await assert.rejects(room.connect(), /unexpected expiry/); assert.equal(room.closed, true);
  }
});

test('authenticated owner applies all four LAN lifetimes to new and history shares and rejects public or malformed policy before activation', async t => {
  const f = await fixture(t), entries = new Map();
  class Rpc extends EventEmitter { async request(_method, params) { return { thread: { id: params.threadId, name: 'Synthetic lifetime', status: { type: 'idle' }, turns: [] } }; } close() {} }
  let intranetOnly = true, activations = 0;
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: f.registrationSecret,
    relayUrl: f.relay.url, getInviteOrigin: () => f.relay.inviteOrigin, rpcFactory: async () => new Rpc(),
    getNetwork: () => ({ intranetOnly }), selectThread: async () => { activations++; }, connection: { state: 'local' },
    history: { list: () => [...entries.values()], remember: entry => entries.set(entry.threadId, entry), flush: async () => {} } });
  t.after(() => owner.close());
  const manager = await connection(t, owner.baseUrl + '/owner', { origin: owner.baseUrl });
  manager.send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') }); await manager.next('state');
  for (const inviteLifetime of [null, '2h', ['1h'], 3600000]) {
    manager.send({ type: 'share', threadId: 'synthetic', inviteLifetime }); await manager.next('error');
  }
  assert.equal(activations, 0);
  for (const inviteLifetime of ['1h', '1d', '7d', 'permanent']) {
    manager.send({ type: 'share', threadId: 'synthetic', inviteLifetime }); await manager.next('share-result');
    const room = [...owner.rooms.values()].find(room => !room.closed);
    assert.equal(room.inviteLifetime, inviteLifetime); assert.equal(room.view().inviteExpiresAt, room.inviteExpiresAt);
    owner.revokeAll();
  }
  manager.send({ type: 'reshare', threadId: 'synthetic', inviteLifetime: '7d' }); await manager.next('share-result');
  assert.equal([...owner.rooms.values()].find(room => !room.closed).inviteLifetime, '7d'); owner.revokeAll();
  intranetOnly = false; const prior = activations;
  manager.send({ type: 'share', threadId: 'synthetic', inviteLifetime: 'permanent' }); await manager.next('error');
  assert.equal(activations, prior);
});
