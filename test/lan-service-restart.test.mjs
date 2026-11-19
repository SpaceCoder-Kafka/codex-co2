import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { SharingService } from '../lib/sharing-service.mjs';
import { BackgroundService, connectBackground } from '../lib/background-service.mjs';
import { startRelay } from '../lib/relay.mjs';
import { secret } from '../lib/host.mjs';
import { lanEntryHostname } from '../lib/lan-network.mjs';
import { openLanSettings } from '../lib/lan-settings.mjs';

const address = '192.168.44.11';
const resourceRoot = new URL('../', import.meta.url).pathname;
async function until(predicate) {
  for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await delay(10); }
  throw new Error('Synthetic LAN recovery timed out');
}
async function peer(t, origin, route, lan = false) {
  const url = new URL(route, origin);
  if (lan) url.hostname = '127.0.0.1';
  url.protocol = 'ws:';
  const ws = new WebSocket(url, { origin, ...(lan ? { headers: { Host: new URL(origin).host } } : {}) });
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes))); ws.on('error', () => {});
  t.after(() => ws.terminate()); await once(ws, 'open');
  return { ws, messages, send: value => ws.send(JSON.stringify(value)) };
}
async function fixture(t, { hostname = null } = {}) {
  const root = await fs.mkdtemp('/tmp/co2-lan-restart-'), runtimeDir = path.join(root, '.coop');
  const services = [], daemons = [], calls = [];
  let available = true, desktop = true, occupied = false, healthy = true, currentAddress = address;
  const dependencies = {
    publishLanBonjour: async selected => hostname && ({ hostname, entryHostname: lanEntryHostname(hostname, selected), isCurrent: async () => true, close: async () => {} }),
    lanInterfaces: () => available ? [{ name: 'synthetic', address: currentAddress }] : [],
    selectLanAddress: selected => {
      if (!available || (selected && selected !== currentAddress)) throw new Error('所选内网地址已不可用，请重新选择当前网络地址。');
      return currentAddress;
    },
    startTunnel: () => { throw new Error('LAN must never start a public tunnel'); },
    checkHealth: (origin, { direct, signal }) => {
      assert.equal(direct, true);
      const target = new URL(origin);
      if (!healthy) return Promise.resolve({ ok: false });
      return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: target.port, path: '/health', headers: { Host: target.host }, agent: false, signal }, response => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ ok: response.statusCode === 200 && body === '{"ok":true}' }));
          response.on('error', reject);
        }).on('error', reject);
      });
    },
    attachDesktop: async () => {
      calls.push('attach'); if (!desktop) throw new Error('Synthetic Desktop is not running');
      return {
        listThreads: async () => [{ id: 'synthetic-thread', name: 'Synthetic LAN thread' }],
        selectThread: async id => { assert.equal(id, 'synthetic-thread'); },
        rpcFactory: async () => {
          const rpc = new EventEmitter(); rpc.close = () => {};
          rpc.request = async (method, params) => {
            calls.push(method); assert.ok(['thread/read', 'thread/resume'].includes(method), 'restart must never replay Agent input');
            return { thread: { id: params.threadId, name: 'Synthetic LAN thread', status: { type: 'idle' }, turns: [] } };
          };
          return rpc;
        }, close() {},
      };
    },
    startRelay: async options => {
      if (occupied) throw Object.assign(new Error('Synthetic port occupied'), { code: 'EADDRINUSE' });
      let servers = 0;
      // Real HTTP/WS transports on loopback; only the test fixture supplies
      // synthetic local/peer addresses. This is not cross-device acceptance.
      return startRelay({ ...options, createHttpServer(handler) {
        const server = http.createServer(handler);
        if (servers++ === 1) {
          const listen = server.listen;
          server.listen = function(port, host, callback) { assert.equal(host, options.lanAddress); return listen.call(this, port, '127.0.0.1', callback); };
          for (const event of ['request', 'upgrade']) server.prependListener(event, req => Object.defineProperties(req.socket, {
            localAddress: { configurable: true, value: options.lanAddress }, remoteAddress: { configurable: true, value: '192.168.44.12' },
          }));
        }
        return server;
      } });
    },
  };
  const create = (options = {}) => {
    const service = new SharingService({ mode: 'host', attach: true, deferDesktop: true, persistentLan: true,
      resourceRoot, runtimeDir, lazyPublic: true, lanRetryIntervalMs: 20, lanCheckIntervalMs: 20, ...options }, dependencies);
    services.push(service); return service;
  };
  const start = async options => { const service = create(options); await service.start(); return service; };
  const startForeground = async () => {
    const daemon = new BackgroundService({ runtimeDir, foreground: true, firstClientMs: 4000,
      serviceFactory: options => create(options), command: async () => ({ ok: true }) });
    daemons.push(daemon); await daemon.start();
    const input = new PassThrough(), output = new PassThrough(); let received = '';
    output.on('data', chunk => { received += chunk.toString('utf8'); });
    const bridge = connectBackground({ runtimeDir, input, output });
    await until(() => received.includes('"type":"ready"'));
    return { service: daemon.service, async disconnect() {
      const closed = once(daemon, 'closed'); input.end(); await bridge; await closed;
    } };
  };
  const manager = async service => {
    const local = await peer(t, service.owner.baseUrl, '/owner');
    local.send({ type: 'auth', token: new URLSearchParams(new URL(service.owner.url).hash.slice(1)).get('owner') });
    await until(() => local.messages.some(message => message.type === 'state')); return local;
  };
  t.after(async () => { for (const daemon of daemons) await daemon.close(); for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { start, startForeground, manager, runtimeDir, calls, set available(value) { available = value; }, set healthy(value) { healthy = value; },
    set desktop(value) { desktop = value; }, set occupied(value) { occupied = value; }, set address(value) { currentAddress = value; } };
}
async function share(f, service, inviteLifetime = 'permanent') {
  await service.setNetwork({ intranetOnly: true, lanAddress: address });
  const local = await f.manager(service);
  local.send({ type: 'share', threadId: 'synthetic-thread', ownerName: 'Synthetic owner', inviteLifetime });
  const response = await until(() => local.messages.find(message => message.type === 'share-result'));
  return { local, room: service.owner.rooms.get(response.roomId) };
}

test('LAN service restores the same origin, receipt and explicit approval flow across repeated restarts without Desktop', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.desktop = false;
  const before = f.calls.length, second = await f.start();
  assert.equal(second.inviteOrigin, origin); assert.deepEqual(f.calls.slice(before), ['attach'], 'Desktop was unavailable; no conversation was read');
  const guest = await peer(t, origin, '/recovery', true);
  guest.send({ type: 'status', ...original });
  assert.equal((await until(() => guest.messages.find(m => m.type === 'recovery-status'))).status, 'recoverable');
  const input = { type: 'request', ...original, requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic guest' };
  guest.send(input);
  const pending = await until(() => guest.messages.find(m => m.status === 'pending'));
  const disk = await fs.readFile(path.join(f.runtimeDir, 'lan-invite-recovery.json'), 'utf8');
  for (const credential of [input.inviteToken, input.receiptToken, input.visitorToken]) assert.equal(disk.includes(credential), false);
  await second.close(); const third = await f.start();
  assert.equal(third.inviteOrigin, origin);
  const resumed = await peer(t, origin, '/recovery', true);
  resumed.send({ type: 'watch', requestId: input.requestId, receiptToken: input.receiptToken });
  const restored = await until(() => resumed.messages.find(m => m.status === 'pending'));
  assert.equal(restored.expiresAt, pending.expiresAt); assert.equal(third.recovery.list().length, 1);
  assert.deepEqual(f.calls.slice(before), ['attach', 'attach']);
  f.desktop = true; const local = await f.manager(third);
  local.send({ type: 'approve-recovery', requestId: input.requestId });
  const approved = await until(() => resumed.messages.find(m => m.status === 'approved'));
  const target = new URLSearchParams(new URL(approved.inviteUrl).hash.slice(1));
  const admitted = await peer(t, origin, '/guest', true);
  admitted.send({ type: 'join', roomId: target.get('room'), inviteToken: target.get('invite'), name: input.name, sessionId: input.visitorToken });
  await until(() => admitted.messages.some(m => m.type === 'admitted') && admitted.messages.some(m => m.payload?.type === 'snapshot'));
  local.send({ type: 'revoke', roomId: target.get('room') });
  await until(() => third.recovery.watch(input, origin).status === 'unavailable');
  await third.close(); const fourth = await f.start();
  assert.equal(fourth.recovery.status(original, origin).status, 'unavailable');
  assert.equal(fourth.recovery.watch(input, origin).status, 'unavailable');
});

for (const crash of [false, true]) test(`returning LAN members reopen the same invitation after ${crash ? 'a crash checkpoint' : 'clean shutdown'}`, async t => {
  const f = await fixture(t), first = await f.start(), { room, local } = await share(f, first, '1d');
  const origin = first.inviteOrigin, invitation = { roomId: room.roomId, inviteToken: room.inviteToken };
  const join = async (sessionId, invite = invitation) => {
    const client = await peer(t, origin, '/guest', true);
    client.send({ type: 'join', ...invite, sessionId, name: 'Synthetic visitor' });
    return client;
  };
  const admit = async token => {
    const client = await join(token);
    const { guestId } = await until(() => client.messages.find(m => m.type === 'pending'));
    await until(() => room.guests.has(guestId));
    local.send({ type: 'admit', roomId: room.roomId, guestId });
    await until(() => client.messages.some(m => m.payload?.type === 'visitor-recovery'));
    return guestId;
  };
  const firstMember = secret(), secondMember = secret(), removed = secret();
  const memberId = await admit(firstMember), participant = room.guests.get(memberId).participantId;
  await admit(secondMember);
  const removedId = await admit(removed);
  local.send({ type: 'remove-guest', roomId: room.roomId, guestId: removedId });
  await until(() => !room.guests.has(removedId));
  local.send({ type: 'set-message-policy', roomId: room.roomId, requireApproval: true });
  await until(() => room.requireApproval);

  const file = path.join(f.runtimeDir, 'lan-invite-recovery.json');
  const checkpoint = await fs.readFile(file, 'utf8');
  for (const raw of [firstMember, secondMember, removed, invitation.inviteToken]) assert.ok(!checkpoint.includes(raw));
  await first.close();
  if (crash) {
    // Simulate an installed older build which generated a random invitation.
    const old = JSON.parse(checkpoint);
    invitation.inviteToken = secret();
    old.rooms[0].inviteHash = createHash('sha256').update(invitation.inviteToken).digest('base64url');
    await fs.writeFile(file, JSON.stringify(old));
    await fs.unlink(path.join(f.runtimeDir, 'guest-permissions.json'));
  }
  f.desktop = false;
  const second = await f.start({ lanRestoreIntervalMs: 25 });
  for (const [token, invite] of [[removed, invitation], [secret(), invitation], [firstMember, { ...invitation, inviteToken: secret() }]]) {
    const stranger = await join(token, invite);
    await until(() => stranger.messages.some(m => m.type === 'join-rejected'));
  }
  assert.equal(second.owner.rooms.size, 0);

  const offline = await join(firstMember);
  await until(() => offline.messages.some(m => m.type === 'join-rejected'));
  assert.equal(second.owner.rooms.size, 0);
  const request = { ...invitation, requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Waiting visitor' };
  assert.equal(second.recovery.request(request, origin).status, 'pending');
  f.desktop = true;
  // The owner sees the original room online before either returning client connects.
  await until(() => second.recovery.status(invitation, origin).status === 'active');
  assert.equal(second.owner.rooms.get(room.roomId).guests.size, 0);
  const clients = await Promise.all([join(firstMember), join(secondMember)]);
  for (const client of clients) await until(() => client.messages.some(m => m.payload?.type === 'snapshot'));
  const target = second.owner.rooms.get(room.roomId);
  assert.equal(second.owner.rooms.size, 1);
  assert.equal(target.view().inviteUrl, room.view().inviteUrl);
  assert.equal(target.inviteExpiresAt, room.inviteExpiresAt);
  assert.equal(target.requireApproval, true);
  assert.ok([...target.guests.values()].some(g => g.participantId === participant));
  const outsider = await join(secret());
  const pending = await until(() => outsider.messages.find(m => m.type === 'pending'));
  await until(() => target.guests.has(pending.guestId));
  assert.equal(target.guests.get(pending.guestId).status, 'pending');
  assert.ok(!outsider.messages.some(m => m.type === 'data'));

  assert.equal(second.recovery.watch(request, origin).status, 'pending');
  const activeCheckpoint = await fs.readFile(file);
  await second.close();
  if (crash) await fs.writeFile(file, activeCheckpoint);
  const third = await f.start();
  await until(() => third.recovery.status(invitation, origin).status === 'active');
  const returning = await join(firstMember);
  assert.equal(third.recovery.watch(request, origin).status, 'pending');
  await until(() => returning.messages.some(m => m.payload?.type === 'snapshot'));
  const owner = await f.manager(third);
  owner.send({ type: 'revoke', roomId: room.roomId });
  await until(() => third.owner.rooms.get(room.roomId).closed);
  await third.close();
  const fourth = await f.start(), stopped = await join(firstMember);
  await until(() => stopped.messages.some(m => m.type === 'join-rejected'));
  assert.equal(fourth.owner.rooms.size, 0);
});

test('missing LAN address and occupied fixed port wait without changing origin, then recover automatically', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.available = false;
  const second = await f.start(); assert.equal(second.relay, null);
  f.available = true; f.occupied = true;
  await until(() => second.connection.message?.includes('端口被占用'));
  assert.equal(second.relay, null);
  f.occupied = false;
  await until(() => second.inviteOrigin === origin);
  await until(() => second.recovery.status(original, origin).status === 'active');
  assert.equal(second.owner.rooms.get(room.roomId).guests.size, 0);
  f.available = false;
  await until(() => second.relay === null);
  f.available = true;
  await until(() => second.inviteOrigin === origin);
  await until(() => second.recovery.status(original, origin).status === 'active');
});

test('invalid move keeps the working invitation; failed guest health pauses a move without issuing a new invitation', async t => {
  const f = await fixture(t), service = await f.start({ lanCheckIntervalMs: 60000 });
  const { room, local } = await share(f, service, '1d');
  const original = room.view().inviteUrl;
  local.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.215.0' });
  await until(() => local.messages.some(m => m.type === 'error' && m.operation === 'set-network-mode'));
  assert.equal(service.connection.state, 'local');
  assert.equal(service.inviteOrigin, new URL(original).origin);
  assert.equal(room.view().inviteUrl, original); assert.equal(room.state, 'online');

  const newAddress = '192.168.44.99'; f.address = newAddress; f.healthy = false;
  local.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: newAddress });
  await until(() => local.messages.some(m => m.type === 'error' && m.operation === 'set-network-mode' && /访客入口/.test(m.message)));
  assert.equal(room.closed, true);
  assert.equal(service.inviteOrigin, null);
  assert.equal(local.messages.some(m => m.type === 'network-result' && m.moved), false);
  await until(() => service.recovery.waitingLanRooms().length === 1);
  assert.equal([...service.owner.rooms.values()].some(r => !r.closed), false);

  f.healthy = true;
  const restored = await until(() => [...service.owner.rooms.values()].find(r => !r.closed && r.historyStarted));
  assert.equal(restored.admissionScope, room.admissionScope);
  assert.equal(restored.inviteExpiresAt, room.inviteExpiresAt);
  assert.equal(new URL(restored.view().inviteUrl).hostname, newAddress);
  assert.equal(new URL(restored.view().inviteUrl).port, new URL(original).port);
});

test('a delayed health response from the old LAN listener cannot pause its replacement', async t => {
  const f = await fixture(t), service = await f.start({ lanCheckIntervalMs: 60000 });
  const { room, local } = await share(f, service);
  const original = service.inviteOrigin, probe = service.dependencies.checkHealth;
  let resolveOld;
  service.dependencies.checkHealth = (origin, options) => origin === original
    ? new Promise(resolve => { resolveOld = resolve; }) : probe(origin, options);
  const oldCheck = service.checkLanAddress();
  assert.equal(service.checkLanAddress(), oldCheck);
  const next = '192.168.44.99'; f.address = next;
  local.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: next });
  await until(() => local.messages.some(m => m.type === 'network-result' && m.moved));
  resolveOld({ ok: false }); await oldCheck;
  assert.equal(service.connection.state, 'local');
  assert.equal(new URL(service.inviteOrigin).hostname, next);
  assert.ok([...service.owner.rooms.values()].some(r => !r.closed && r.admissionScope === room.admissionScope));
});

test('disabling background recovery erases persisted eligibility without stopping the current foreground share', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.setBackgroundEnabled(false);
  assert.equal(room.closed, false);
  await first.close(); const second = await f.start();
  assert.equal(second.recovery.status(original, origin).status, 'unavailable');
});

test('disabled foreground startup clears a pre-disable checkpoint before re-enabling can import it', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close();
  // Simulate a process killed after the OFF preference was saved but before
  // it erased the prior checkpoint. Startup receives the durable OFF policy.
  const second = await f.start({ persistentLan: false });
  assert.equal(second.relay, undefined);
  await second.setBackgroundEnabled(true); await second.ensureRelay();
  assert.equal(second.inviteOrigin, origin);
  assert.equal(second.recovery.status(original, origin).status, 'unavailable');
  await second.close(); const third = await f.start();
  assert.equal(third.recovery.status(original, origin).status, 'unavailable');
});

test('foreground manager disconnect preserves enabled recovery but never restores an approved grant', async t => {
  const f = await fixture(t), first = await f.startForeground(), { room } = await share(f, first.service);
  const origin = first.service.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.disconnect();
  assert.equal(first.service.closed, true);
  f.desktop = false;
  const before = f.calls.length, second = await f.startForeground();
  assert.equal(second.service.inviteOrigin, origin);
  assert.equal(second.service.recovery.status(original, origin).status, 'recoverable');
  assert.deepEqual(f.calls.slice(before), ['attach'], 'unavailable Desktop cannot supply a transcript');
  const input = { ...original, requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic foreground guest' };
  const guest = await peer(t, origin, '/recovery', true);
  guest.send({ type: 'request', ...input });
  await until(() => guest.messages.some(message => message.status === 'pending'));
  await second.disconnect();
  const third = await f.startForeground();
  assert.equal(third.service.recovery.watch(input, origin).status, 'pending');
  f.desktop = true;
  const local = await f.manager(third.service), resumed = await peer(t, origin, '/recovery', true);
  resumed.send({ type: 'watch', requestId: input.requestId, receiptToken: input.receiptToken });
  local.send({ type: 'approve-recovery', requestId: input.requestId });
  const approved = await until(() => resumed.messages.find(message => message.status === 'approved'));
  assert.ok(approved.inviteUrl);
  const disk = await fs.readFile(path.join(f.runtimeDir, 'lan-invite-recovery.json'), 'utf8');
  for (const credential of [input.inviteToken, input.receiptToken, input.visitorToken, approved.inviteUrl]) assert.equal(disk.includes(credential), false);
  await third.disconnect();
  const fourth = await f.startForeground();
  const result = fourth.service.recovery.watch(input, origin);
  assert.equal(result.status, 'unavailable'); assert.equal(result.inviteUrl, undefined);
  await fourth.disconnect();
});

test('OFF revokes a waiting checkpoint while LAN is missing before same-process ON can load it', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.available = false;
  const second = await f.start();
  assert.equal(second.recovery.persistenceEnabled, true);
  assert.equal(second.recovery.waitingLanRooms()[0].roomId, room.roomId);
  const checkpoint = path.join(f.runtimeDir, 'lan-invite-recovery.json');
  assert.ok((await fs.stat(checkpoint)).size);
  await second.setBackgroundEnabled(false);
  await assert.rejects(fs.stat(checkpoint), { code: 'ENOENT' });
  await second.setBackgroundEnabled(true); f.available = true;
  await until(() => second.inviteOrigin === origin);
  assert.equal(second.recovery.status(original, origin).status, 'unavailable');
});

test('failed erasure of a waiting checkpoint blocks ON until a new disabled startup', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.available = false;
  const second = await f.start(), checkpoint = path.join(f.runtimeDir, 'lan-invite-recovery.json');
  await fs.chmod(checkpoint, 0o644);
  await assert.rejects(second.setBackgroundEnabled(false), /恢复记录/);
  await fs.chmod(checkpoint, 0o600);
  await assert.rejects(second.setBackgroundEnabled(true), /恢复记录/);
  assert.equal(second.options.persistentLan, false);
  await second.close();
  const third = await f.start({ persistentLan: false });
  await third.setBackgroundEnabled(true); f.available = true;
  await until(() => third.inviteOrigin === origin);
  assert.equal(third.recovery.status(original, origin).status, 'unavailable');
});

for (const cold of [false, true]) test(`explicit DHCP address migration preserves scoped grants and the deadline (${cold ? 'cold start' : 'memory only'})`, async t => {
  const hostname = cold ? 'synthetic-host.local' : null;
  const f = await fixture(t, { hostname });
  const first = await f.start({ persistentLan: cold });
  const { room, local } = await share(f, first, '1h');
  const advertised = name => local.messages.filter(m => m.type === 'state').flatMap(m => m.rooms)
    .find(r => r.roomId === room.roomId && r.inviteUrl && new URL(r.inviteUrl).hostname === name);
  const before = await until(() => advertised(hostname ? lanEntryHostname(hostname, address) : address));
  const browserOrigin = first.relay.guestOrigin;
  if (hostname) assert.equal(before.ipInviteUrl, room.view().inviteUrl);
  const sessionId = secret(), guest = await peer(t, browserOrigin, '/guest', true);
  const original = { roomId: room.roomId, inviteToken: room.inviteToken };
  guest.send({ type: 'join', ...original, sessionId, name: 'Migrating visitor' });
  const { guestId } = await until(() => guest.messages.find(m => m.type === 'pending'));
  await until(() => room.guests.has(guestId));
  local.send({ type: 'admit', roomId: room.roomId, guestId });
  const proof = await until(() => guest.messages.find(m => m.payload?.type === 'visitor-recovery'));
  const participant = room.guests.get(guestId).participantId, originalOrigin = first.inviteOrigin;

  if (cold) await first.close();
  const movedAddress = '192.168.44.99'; f.address = movedAddress;
  const service = cold ? await f.start() : first;
  await until(() => service.connection.state === 'unavailable');
  const manager = cold ? await f.manager(service) : local;
  await until(() => manager.messages.some(m => m.waitingLanRooms?.some(saved => saved.roomId === room.roomId)));
  assert.equal(service.relay, null);
  manager.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: movedAddress });
  await until(() => manager.messages.some(m => m.type === 'network-result' && m.moved));
  const target = [...service.owner.rooms.values()].find(r => !r.closed);
  assert.ok(target);
  assert.equal(new URL(service.inviteOrigin).hostname, movedAddress);
  assert.equal(new URL(service.inviteOrigin).port, new URL(originalOrigin).port);
  assert.notEqual(target.roomId, room.roomId);
  assert.notEqual(target.inviteToken, room.inviteToken);
  assert.equal(target.admissionScope, proof.payload.scopeId);
  assert.equal(target.inviteExpiresAt, room.inviteExpiresAt);
  const offered = await until(() => manager.messages.filter(m => m.type === 'state').flatMap(m => m.rooms)
    .find(r => r.roomId === target.roomId && r.inviteUrl));
  const afterOrigin = service.relay.guestOrigin;
  if (hostname) {
    assert.equal(afterOrigin, browserOrigin);
    assert.equal(new URL(offered.inviteUrl).hostname, lanEntryHostname(hostname, movedAddress));
    assert.notEqual(new URL(offered.inviteUrl).origin, new URL(before.inviteUrl).origin);
    assert.equal(offered.ipInviteUrl, target.view().inviteUrl);
    assert.notEqual(offered.ipInviteUrl, before.ipInviteUrl);
  } else assert.equal(afterOrigin, service.inviteOrigin);
  const join = async (roomId, inviteToken, member) => {
    const client = await peer(t, afterOrigin, '/guest', true);
    client.send({ type: 'join', roomId, inviteToken, sessionId: member, name: 'New tab' });
    return client;
  };
  for (const id of [room.roomId, target.roomId]) {
    const old = await join(id, room.inviteToken, sessionId);
    await until(() => old.messages.some(m => m.type === 'join-rejected'));
    assert.equal(old.messages.some(m => m.type === 'data'), false);
  }
  const accepted = await join(target.roomId, target.inviteToken, sessionId);
  const restored = await until(() => accepted.messages.find(m => m.payload?.type === 'visitor-recovery'));
  assert.equal(restored.payload.expiresAt, proof.payload.expiresAt);
  assert.ok([...target.guests.values()].some(g => g.participantId === participant));
  const newcomer = await join(target.roomId, target.inviteToken, secret());
  const pending = await until(() => newcomer.messages.find(m => m.type === 'pending'));
  await until(() => target.guests.has(pending.guestId));
  assert.equal(target.guests.get(pending.guestId).status, 'pending');
  manager.send({ type: 'stop-waiting-lan-room', roomId: room.roomId });
  await until(() => manager.messages.some(m => m.type === 'error' && m.operation === 'stop-waiting-lan-room'));
  assert.equal(target.closed, false);
  f.available = false;
  await until(() => service.recovery.waitingLanRooms().some(r => r.roomId === target.roomId));
  manager.send({ type: 'stop-waiting-lan-room', roomId: target.roomId });
  await until(() => !service.recovery.waitingLanRooms().length);
  assert.equal(service.permissions.get(target.admissionScope, createHash('sha256').update(sessionId).digest('base64url')), undefined);
});

test('address migration resumes when interrupted before or after the checkpoint write', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first, '1d');
  const movedAddress = '10.17.0.2';
  await first.close(); f.address = movedAddress;
  const file = path.join(f.runtimeDir, 'lan-sharing.json');
  const settings = await openLanSettings(file);
  await settings.moveAddress(movedAddress);
  const intent = await fs.readFile(file);
  const second = await f.start();
  const moved = await until(() => [...second.owner.rooms.values()].find(candidate => candidate.historyStarted && !candidate.closed));
  assert.notEqual(moved.roomId, room.roomId);
  assert.equal(moved.admissionScope, room.admissionScope);
  assert.equal(moved.inviteExpiresAt, room.inviteExpiresAt);
  await second.close();
  await fs.writeFile(file, intent);
  const third = await f.start();
  const resumed = await until(() => [...third.owner.rooms.values()].find(candidate => candidate.historyStarted && !candidate.closed));
  assert.equal(resumed.view().inviteUrl, moved.view().inviteUrl);
  assert.equal((await openLanSettings(file)).previousAddress(), null);
});
