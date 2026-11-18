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
async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/co2-lan-restart-'), runtimeDir = path.join(root, '.coop');
  const services = [], daemons = [], calls = [];
  let available = true, desktop = true, occupied = false;
  const dependencies = {
    lanInterfaces: () => available ? [{ name: 'synthetic', address }] : [],
    selectLanAddress: selected => {
      assert.ok(!selected || selected === address);
      if (!available) throw new Error('所选内网地址已不可用，请重新选择当前网络地址。');
      return address;
    },
    startTunnel: () => { throw new Error('LAN must never start a public tunnel'); },
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
          server.listen = function(port, host, callback) { assert.equal(host, address); return listen.call(this, port, '127.0.0.1', callback); };
          for (const event of ['request', 'upgrade']) server.prependListener(event, req => Object.defineProperties(req.socket, {
            localAddress: { configurable: true, value: address }, remoteAddress: { configurable: true, value: '192.168.44.12' },
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
  return { start, startForeground, manager, runtimeDir, calls, set available(value) { available = value; },
    set desktop(value) { desktop = value; }, set occupied(value) { occupied = value; } };
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
  assert.equal(second.recovery.status(original, origin).status, 'recoverable');
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

test('OFF revokes an unopened checkpoint while LAN is missing before same-process ON can load it', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.available = false;
  const second = await f.start();
  assert.equal(second.recovery.persistenceEnabled, false);
  const checkpoint = path.join(f.runtimeDir, 'lan-invite-recovery.json');
  assert.ok((await fs.stat(checkpoint)).size);
  await second.setBackgroundEnabled(false);
  await assert.rejects(fs.stat(checkpoint), { code: 'ENOENT' });
  await second.setBackgroundEnabled(true); f.available = true;
  await until(() => second.inviteOrigin === origin);
  assert.equal(second.recovery.status(original, origin).status, 'unavailable');
});

test('failed erasure of an unopened checkpoint blocks ON until a new disabled startup', async t => {
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
