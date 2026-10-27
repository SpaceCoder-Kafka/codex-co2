import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { SharingService } from '../lib/sharing-service.mjs';
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
  const services = [], calls = [];
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
  const start = async (options = {}) => {
    const service = new SharingService({ mode: 'host', attach: true, deferDesktop: true, persistentLan: true,
      resourceRoot, runtimeDir, lazyPublic: true, lanRetryIntervalMs: 20, lanCheckIntervalMs: 20, ...options }, dependencies);
    services.push(service); await service.start(); return service;
  };
  const manager = async service => {
    const local = await peer(t, service.owner.baseUrl, '/owner');
    local.send({ type: 'auth', token: new URLSearchParams(new URL(service.owner.url).hash.slice(1)).get('owner') });
    await until(() => local.messages.some(message => message.type === 'state')); return local;
  };
  t.after(async () => { for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { start, manager, runtimeDir, calls, set available(value) { available = value; },
    set desktop(value) { desktop = value; }, set occupied(value) { occupied = value; } };
}
async function share(f, service) {
  await service.setNetwork({ intranetOnly: true, lanAddress: address });
  const local = await f.manager(service);
  local.send({ type: 'share', threadId: 'synthetic-thread', ownerName: 'Synthetic owner', inviteLifetime: 'permanent' });
  const response = await until(() => local.messages.find(message => message.type === 'share-result'));
  return { local, room: service.owner.rooms.get(response.roomId) };
}

test('LAN service restores the same origin, receipt and explicit approval flow across repeated restarts without Desktop', async t => {
  const f = await fixture(t), first = await f.start(), { room } = await share(f, first);
  const origin = first.inviteOrigin, original = { roomId: room.roomId, inviteToken: room.inviteToken };
  await first.close(); f.desktop = false;
  const before = f.calls.length, second = await f.start();
  assert.equal(second.inviteOrigin, origin); assert.equal(f.calls.length, before, 'serving the recovery entry must not read Desktop');
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
  assert.equal(f.calls.length, before);
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
  assert.equal(second.recovery.status(original, origin).status, 'recoverable');
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
