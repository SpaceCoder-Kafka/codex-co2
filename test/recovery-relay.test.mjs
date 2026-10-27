import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { InviteRecovery } from '../lib/invite-recovery.mjs';
import { startRelay } from '../lib/relay.mjs';

const secret = () => randomBytes(32).toString('base64url');
async function connect(url, options = {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'), options);
  const messages = [], waiters = new Set();
  ws.on('error', () => {});
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); for (const check of [...waiters]) check(); });
  await once(ws, 'open');
  return { ws, messages, send: message => ws.send(JSON.stringify(message)),
    next(type, predicate = () => true) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Missing ${type}`)); }, 2000);
        function check() {
          const index = messages.findIndex(message => message.type === type && predicate(message));
          if (index < 0) return;
          clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]);
        }
        waiters.add(check); check();
      });
    },
  };
}
async function fixture(t, { enabled = true, brokerOptions = {}, ...options } = {}) {
  const recovery = new InviteRecovery(brokerOptions);
  const registrationSecret = secret();
  const relay = await startRelay({ registrationSecret, recovery: enabled ? recovery : undefined, ...options });
  t.after(async () => { await relay.close(); recovery.close(); });
  const source = { roomId: randomUUID(), inviteToken: secret(), threadId: 'synthetic-thread', title: 'Synthetic private title',
    ownerName: 'Synthetic owner', origin: relay.inviteOrigin, state: 'online', expiresAt: Date.now() + 60000 };
  recovery.registerRoom(source);
  recovery.updateRoom(source.roomId, { state: 'revoked', endReason: 'expired' });
  const input = (patch = {}) => ({ type: 'request', roomId: source.roomId, inviteToken: source.inviteToken,
    requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic guest', ...patch });
  const endpoint = () => connect(relay.url + '/recovery', { origin: relay.url });
  return { relay, recovery, registrationSecret, source, input, endpoint };
}

test('recovery endpoint requires an injected broker and the exact browser origin', async t => {
  const disabled = await fixture(t, { enabled: false });
  await assert.rejects(disabled.endpoint(), /403/);
  const f = await fixture(t);
  for (const origin of [undefined, 'https://attacker.example']) {
    await assert.rejects(connect(f.relay.url + '/recovery', { origin }), /403/);
  }
  await assert.rejects(connect(f.relay.url + '/recovery?receipt=hidden', { origin: f.relay.url }), /403/);
  const client = await f.endpoint();
  client.send({ type: 'status', roomId: f.source.roomId, inviteToken: secret() });
  assert.deepEqual(await client.next('recovery-status'), { type: 'recovery-status', status: 'unavailable' });
  client.send({ type: 'status', roomId: f.source.roomId, inviteToken: f.source.inviteToken });
  const status = await client.next('recovery-status');
  assert.equal(status.status, 'recoverable');
  assert.equal(JSON.stringify(status).includes('Synthetic'), false);
});

test('full recovery bookkeeping does not prevent normal admission to a live invitation', async t => {
  const f = await fixture(t, { brokerOptions: { maxRooms: 1 } });
  const host = await connect(f.relay.url + '/host');
  const credentials = { type: 'register', registrationSecret: f.registrationSecret, roomId: randomUUID(),
    inviteToken: secret(), hostToken: secret(), expiresAt: Date.now() + 60000 };
  host.send(credentials); await host.next('registered');
  assert.equal(f.recovery.registerRoom({ ...f.source, ...credentials }), false, 'the ended source already fills recovery capacity');
  const client = await f.endpoint();
  client.send({ type: 'status', roomId: credentials.roomId, inviteToken: credentials.inviteToken });
  assert.deepEqual(await client.next('recovery-status'), { type: 'recovery-status', status: 'active' });
  client.send({ type: 'status', roomId: credentials.roomId, inviteToken: secret() });
  assert.deepEqual(await client.next('recovery-status'), { type: 'recovery-status', status: 'unavailable' });
  const guest = await connect(f.relay.url + '/guest', { origin: f.relay.url });
  guest.send({ type: 'join', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: 'Synthetic guest' });
  const { guestId } = await guest.next('pending'); await host.next('join-request');
  host.send({ type: 'admit', guestId }); await guest.next('admitted');
  const closed = once(host.ws, 'close'); host.ws.close(); await closed; await guest.next('offline');
  client.send({ type: 'status', roomId: credentials.roomId, inviteToken: credentials.inviteToken });
  assert.deepEqual(await client.next('recovery-status'), { type: 'recovery-status', status: 'temporarily-offline' });
  client.send({ ...f.input(), roomId: credentials.roomId, inviteToken: credentials.inviteToken });
  assert.equal((await client.next('recovery-request')).status, 'unavailable', 'normal admission fallback does not create recovery capability');
});

test('receipt streams deliver only their own approval and can be recovered without original invitation', async t => {
  const f = await fixture(t), first = await f.endpoint(), second = await f.endpoint();
  const one = f.input(), two = f.input();
  first.send(one); second.send(two);
  assert.equal((await first.next('recovery-request')).status, 'pending');
  assert.equal((await second.next('recovery-request')).status, 'pending');
  first.send(one);
  assert.equal((await first.next('recovery-request')).status, 'pending');
  assert.equal(f.recovery.list().length, 2);
  f.recovery.beginApproval(one.requestId);
  assert.equal((await first.next('recovery-request')).status, 'processing');
  const target = { ...f.source, roomId: randomUUID(), inviteToken: secret(), expiresAt: Date.now() + 60000 };
  f.recovery.registerRoom(target);
  const inviteUrl = `${target.origin}/#room=${target.roomId}&invite=${target.inviteToken}`;
  f.recovery.approve(one.requestId, { ...target, inviteUrl });
  assert.equal((await first.next('recovery-request')).inviteUrl, inviteUrl);
  first.ws.close();
  const restored = await f.endpoint();
  restored.send({ type: 'watch', requestId: one.requestId, receiptToken: one.receiptToken });
  assert.equal((await restored.next('recovery-request')).inviteUrl, inviteUrl);
  const wrong = await f.endpoint();
  wrong.send({ type: 'watch', requestId: one.requestId, receiptToken: two.receiptToken });
  assert.equal((await wrong.next('recovery-request')).status, 'unavailable');
  second.send({ type: 'watch', requestId: two.requestId, receiptToken: two.receiptToken });
  assert.equal((await second.next('recovery-request')).status, 'pending');
  assert.equal(second.messages.some(message => message.inviteUrl), false);
  restored.send({ type: 'ping' });
  await restored.next('pong');
  f.recovery.revokeThread(target.threadId);
  assert.equal((await restored.next('recovery-request')).status, 'unavailable');
});

test('recovery transport rejects execution, admission and extra-field injection without creating requests', async t => {
  const f = await fixture(t);
  for (const payload of [
    { type: 'join', roomId: f.source.roomId, inviteToken: f.source.inviteToken, name: 'Synthetic guest' },
    { type: 'proposal', requestId: randomUUID(), text: 'Never execute' },
    { type: 'admit', guestId: randomUUID() },
    { type: 'snapshot-request' },
    { type: 'request', ...f.input(), threadId: 'private-thread' },
    { type: 'status', roomId: f.source.roomId, inviteToken: f.source.inviteToken, role: 'owner' },
  ]) {
    const client = await f.endpoint();
    client.send(payload);
    await client.next('invalid-message');
  }
  assert.deepEqual(f.recovery.list(), []);
  const binary = await f.endpoint(); binary.ws.send(Buffer.from('{}'));
  await binary.next('invalid-message');
  const oversized = await f.endpoint(); oversized.send({ text: 'x'.repeat(4097) });
  await oversized.next('invalid-message');
});

test('recovery connection message limit applies before authorization and caps abusive requests', async t => {
  const f = await fixture(t), client = await f.endpoint();
  for (let i = 0; i < 61; i++) client.send({ type: 'status', roomId: randomUUID(), inviteToken: secret() });
  await client.next('rate-limited');
  assert.deepEqual(f.recovery.list(), []);
});

test('broker clearing invalidates open subscribers and leaves no stale result', async t => {
  const f = await fixture(t), client = await f.endpoint(), request = f.input();
  client.send(request); await client.next('recovery-request');
  f.recovery.clear();
  assert.equal((await client.next('recovery-request')).status, 'unavailable');
  client.send({ type: 'watch', requestId: request.requestId, receiptToken: request.receiptToken });
  assert.equal((await client.next('recovery-request')).status, 'unavailable');
});

test('only recovery-enabled hosts can communicate explicit system termination reasons', async t => {
  for (const enabled of [false, true]) {
    const f = await fixture(t, { enabled });
    const host = await connect(f.relay.url + '/host');
    const credentials = { type: 'register', registrationSecret: f.registrationSecret, roomId: randomUUID(),
      inviteToken: secret(), hostToken: secret(), expiresAt: Date.now() + 60000 };
    host.send(credentials); await host.next('registered');
    const guest = await connect(f.relay.url + '/guest', { origin: f.relay.url });
    guest.send({ type: 'join', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: 'Synthetic guest' });
    await guest.next('pending'); await host.next('join-request');
    host.send({ type: 'revoke', reason: 'interrupted' });
    if (enabled) await guest.next('interrupted');
    else await host.next('invalid-message');
  }
});

test('LAN recovery uses the private listener and real peer/Host/Origin checks without exposing /host', async t => {
  const lanAddress = '192.168.50.10';
  const network = { peer: '192.168.50.11', local: lanAddress };
  let count = 0;
  const f = await fixture(t, { lanAddress, createHttpServer(handler) {
    const server = http.createServer(handler);
    if (count++ === 1) {
      const listen = server.listen;
      server.listen = function (port, host, callback) {
        assert.equal(host, lanAddress); return listen.call(this, port, '127.0.0.1', callback);
      };
      server.prependListener('upgrade', req => Object.defineProperties(req.socket, {
        remoteAddress: { configurable: true, value: network.peer }, localAddress: { configurable: true, value: network.local },
      }));
    }
    return server;
  } });
  const url = `http://127.0.0.1:${f.relay.lanServer.address().port}`;
  const options = { headers: { Host: new URL(f.relay.inviteOrigin).host }, origin: f.relay.inviteOrigin };
  const client = await connect(url + '/recovery', options);
  client.send({ type: 'status', roomId: f.source.roomId, inviteToken: f.source.inviteToken });
  assert.equal((await client.next('recovery-status')).status, 'recoverable');
  await assert.rejects(connect(f.relay.url + '/recovery', { origin: f.relay.inviteOrigin }), /403/);
  await assert.rejects(connect(url + '/host', { headers: options.headers }), /403/);
  await assert.rejects(connect(url + '/recovery', { ...options, origin: 'https://attacker.example' }), /403/);
  await assert.rejects(connect(url + '/recovery', { ...options, headers: { Host: 'attacker.example' } }), /403/);
  await assert.rejects(connect(url + '/recovery', { ...options, headers: { ...options.headers, 'X-Forwarded-For': '192.168.50.11' } }), /403/);
  network.peer = '203.0.113.50';
  await assert.rejects(connect(url + '/recovery', options), /403/);
  network.peer = '192.168.50.11'; network.local = '192.168.50.12';
  await assert.rejects(connect(url + '/recovery', options), /403/);
});
