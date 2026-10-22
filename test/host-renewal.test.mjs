import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { SharedRoom, secret } from '../lib/host.mjs';
import { GuestPermissions } from '../lib/guest-permissions.mjs';

const HOUR = 3600000, LEAD = 300000;
function unit(t, { canRenew = () => true } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1800000000000 });
  const permissions = new GuestPermissions(), sent = [];
  const room = new SharedRoom({ relayUrl: 'http://127.0.0.1:1', registrationSecret: secret(), threadId: 'synthetic', permissions, canRenew });
  room.state = 'online'; room.renewalSupported = true; room.lastHeartbeat = Date.now(); room.expiresAt = Date.now() + LEAD;
  room.thread = { snapshot: { title: 'Synthetic renewal', status: 'idle' }, close() {} };
  room.ws = { readyState: WebSocket.OPEN, send: value => sent.push(JSON.parse(value)),
    close() { this.readyState = WebSocket.CLOSED; }, terminate() { this.readyState = WebSocket.CLOSED; } };
  t.after(() => room.close());
  const renewals = () => sent.filter(m => m.type === 'renew');
  const ack = () => ({ type: 'renewed', roomId: room.roomId, requestId: room.pendingRenewal.requestId, expiresAt: room.pendingRenewal.expiresAt });
  return { room, permissions, sent, renewals, ack };
}

test('renewal commits only a matching confirmation, retaining the complete invitation, creation time and pending decisions', t => {
  const { room, renewals, ack } = unit(t);
  room.proposals.set('pending', { status: 'pending', text: 'Synthetic pending input' });
  room.proposals.set('uncertain', { status: 'unknown', text: '' });
  room.requireApproval = true;
  const before = { expiry: room.expiresAt, invite: room.view().inviteUrl, startedAt: room.startedAt, proposals: structuredClone([...room.proposals]) };
  room.maybeRenew();
  assert.equal(renewals().length, 1); assert.equal(room.expiresAt, before.expiry);
  assert.equal(room.pendingRenewal.previousExpiresAt, before.expiry);
  assert.equal(room.pendingRenewal.expiresAt, before.expiry + HOUR);
  const confirmation = ack();
  room.confirmRenewal({ ...confirmation, requestId: 'not-current' });
  assert.equal(room.expiresAt, before.expiry);
  room.confirmRenewal(confirmation);
  assert.equal(room.expiresAt, before.expiry + HOUR);
  assert.equal(room.view().inviteUrl, before.invite); assert.equal(room.view().startedAt, before.startedAt);
  assert.deepEqual([...room.proposals], before.proposals); assert.equal(room.requireApproval, true);
  room.confirmRenewal(confirmation); assert.equal(room.expiresAt, before.expiry + HOUR);
});

test('ACK timeout retries the same renewal without extending locally, and stop cancels further attempts', t => {
  const { room, renewals } = unit(t); room.maybeRenew();
  const request = structuredClone(renewals()[0]), expiry = room.expiresAt;
  t.mock.timers.tick(10000);
  assert.equal(room.expiresAt, expiry); assert.equal(room.pendingRenewal.requestId, request.requestId);
  t.mock.timers.tick(20000);
  assert.equal(renewals().length, 2); assert.deepEqual(renewals()[1], request);
  room.close(); const count = renewals().length;
  t.mock.timers.tick(HOUR * 2);
  assert.equal(renewals().length, count); assert.equal(room.closed, true);
});

test('scheduled renewal starts five minutes before expiry and a confirmation schedules the next full renewal', t => {
  const { room, renewals, ack } = unit(t);
  room.expiresAt = Date.now() + HOUR;
  const originalExpiry = room.expiresAt;
  // Simulate an otherwise healthy live relay while advancing the lease clock.
  const heartbeat = setInterval(() => { room.lastHeartbeat = Date.now(); }, 30000);
  t.after(() => clearInterval(heartbeat));
  room.scheduleExpiry();
  t.mock.timers.tick(HOUR - LEAD - 1);
  assert.equal(renewals().length, 0);
  t.mock.timers.tick(1);
  assert.equal(renewals().length, 1);
  assert.equal(Date.now(), originalExpiry - LEAD);
  assert.equal(room.expiresAt, originalExpiry);
  room.confirmRenewal(ack());
  assert.equal(room.expiresAt, originalExpiry + HOUR);
  t.mock.timers.tick(HOUR - 1);
  assert.equal(renewals().length, 1);
  t.mock.timers.tick(1);
  assert.equal(renewals().length, 2);
  assert.equal(renewals()[1].previousExpiresAt, originalExpiry + HOUR);
  assert.equal(renewals()[1].expiresAt, originalExpiry + HOUR * 2);
  assert.notEqual(renewals()[1].requestId, renewals()[0].requestId);
  room.confirmRenewal(ack());
  assert.equal(room.expiresAt, originalExpiry + HOUR * 2);
  assert.equal(room.closed, false);
});

test('a due renewal blocked by public health retries on its timer after connectivity recovers', t => {
  let healthy = false;
  const { room, renewals } = unit(t, { canRenew: () => healthy });
  room.expiresAt = Date.now() + HOUR;
  const originalExpiry = room.expiresAt;
  const heartbeat = setInterval(() => { room.lastHeartbeat = Date.now(); }, 30000);
  t.after(() => clearInterval(heartbeat));
  room.scheduleExpiry();
  t.mock.timers.tick(HOUR - LEAD - 1);
  assert.equal(renewals().length, 0);
  t.mock.timers.tick(1);
  assert.equal(renewals().length, 0); assert.equal(room.expiresAt, originalExpiry);
  healthy = true;
  t.mock.timers.tick(29999);
  assert.equal(renewals().length, 0);
  t.mock.timers.tick(1);
  assert.equal(renewals().length, 1);
  assert.equal(renewals()[0].previousExpiresAt, originalExpiry);
  assert.equal(renewals()[0].expiresAt, originalExpiry + HOUR);
});

test('health and native connection gate renewal; an unsupported relay retains its original deadline', t => {
  let healthy = false;
  const { room, renewals } = unit(t, { canRenew: () => healthy });
  room.maybeRenew(); assert.equal(renewals().length, 0);
  healthy = true; room.renewalSupported = false; room.maybeRenew();
  assert.equal(renewals().length, 0);
  room.renewalSupported = true; room.thread.snapshot.status = 'offline'; room.maybeRenew();
  assert.equal(renewals().length, 0);
  room.thread.snapshot.status = 'idle'; room.maybeRenew();
  assert.equal(renewals().length, 1);
});

test('late ACK and waking after expiry never resurrect the room', t => {
  const { room, renewals, ack } = unit(t); room.maybeRenew();
  const confirmation = ack(), expiry = room.expiresAt;
  t.mock.timers.setTime(expiry);
  room.confirmRenewal(confirmation); room.maybeRenew();
  assert.equal(room.closed, true); assert.equal(room.endReason, 'expired');
  assert.equal(room.expiresAt, expiry); assert.equal(renewals().length, 1);
});

test('renewed sharing survives its original deadline and still expires at the new deadline if renewal stops', t => {
  const { room, ack } = unit(t), originalExpiry = room.expiresAt;
  room.scheduleExpiry(); room.maybeRenew(); room.confirmRenewal(ack());
  room.renewalSupported = false;
  t.mock.timers.tick(LEAD);
  assert.equal(Date.now(), originalExpiry); assert.equal(room.closed, false);
  t.mock.timers.tick(HOUR);
  assert.equal(room.closed, true); assert.equal(room.endReason, 'expired');
});

test('a paused room ignores renewal confirmation and cancels retries while preserving its existing recovery scope', t => {
  const { room, permissions, renewals, ack } = unit(t);
  room.maybeRenew(); const confirmation = ack(), expiry = room.expiresAt, scope = room.admissionScope;
  room.close({ preserveAdmissions: true, reason: 'paused' }); room.confirmRenewal(confirmation);
  t.mock.timers.tick(HOUR);
  assert.equal(room.closed, true); assert.equal(room.endReason, 'paused'); assert.equal(room.expiresAt, expiry);
  assert.equal(permissions.scopes.some(item => item.id === scope), true); assert.equal(renewals().length, 1);
});

test('successful renewal refreshes only online admitted identities whose current authorization is still valid', t => {
  const { room, permissions, sent, ack } = unit(t), expiry = room.expiresAt;
  const identities = new Map();
  for (const name of ['online', 'offline', 'pending', 'removed', 'expired']) {
    const guest = { id: name, name, participantId: `participant-${name}`, resumeHash: secret(), status: name === 'pending' ? 'pending' : 'admitted' };
    identities.set(name, guest); permissions.allow(room.admissionScope, guest.resumeHash, guest, expiry);
    if (name !== 'offline') room.guests.set(name, guest);
  }
  permissions.forget(room.admissionScope, identities.get('removed').resumeHash);
  permissions.scopes.find(scope => scope.id === room.admissionScope).grants.find(grant => grant.hash === identities.get('expired').resumeHash).expiresAt = Date.now() - 1;
  room.maybeRenew(); room.confirmRenewal(ack());
  const online = identities.get('online'), grant = permissions.get(room.admissionScope, online.resumeHash);
  assert.equal(grant.expiresAt, expiry + HOUR); assert.equal(grant.participantId, online.participantId);
  assert.equal(permissions.get(room.admissionScope, identities.get('offline').resumeHash).expiresAt, expiry);
  assert.equal(permissions.get(room.admissionScope, identities.get('pending').resumeHash).expiresAt, expiry);
  assert.equal(permissions.get(room.admissionScope, identities.get('removed').resumeHash), undefined);
  assert.equal(permissions.get(room.admissionScope, identities.get('expired').resumeHash), undefined);
  const refreshes = sent.filter(m => m.payload?.type === 'visitor-recovery');
  assert.equal(refreshes.length, 1); assert.equal(refreshes[0].guestId, online.id);
  assert.equal(refreshes[0].payload.expiresAt, expiry + HOUR);
  assert.equal(refreshes[0].payload.scopeId, room.admissionScope);
});

async function until(predicate) {
  for (let i = 0; i < 300; i++) { const result = predicate(); if (result) return result; await delay(10); }
  throw new Error('Synthetic renewal transport timed out');
}
class Rpc extends EventEmitter {
  async request(method, params) {
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'Renewal must not submit Agent input');
    return { thread: { id: params.threadId, name: 'Synthetic transport renewal', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function syntheticRelay(t, { supported = true, dropAck = false } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let expiry, renewal;
  const frames = [], sockets = [];
  server.on('connection', ws => {
    sockets.push(ws);
    ws.on('message', bytes => {
      const m = JSON.parse(bytes); frames.push(m);
      if (m.type === 'register') {
        expiry ??= m.expiresAt;
        ws.send(JSON.stringify({ type: 'registered', roomId: m.roomId, expiresAt: expiry, ...(supported ? { renewalSupported: true } : {}) }));
      } else if (m.type === 'renew') {
        expiry = m.expiresAt; renewal = m;
        if (!dropAck) ws.send(JSON.stringify({ type: 'renewed', roomId: room.roomId, requestId: m.requestId, expiresAt: expiry }));
      }
    });
    ws.on('error', () => {});
  });
  const room = new SharedRoom({ relayUrl: `http://127.0.0.1:${server.address().port}`, registrationSecret: secret(), threadId: 'synthetic',
    permissions: new GuestPermissions(), rpcFactory: async () => new Rpc() });
  t.after(async () => { room.close(); for (const ws of sockets) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  await room.start();
  return { room, frames, sockets, renewal: () => renewal };
}

test('legacy relay registration disables auto renewal without changing the invitation lifetime', async t => {
  const { room, frames } = await syntheticRelay(t, { supported: false });
  const expiry = room.expiresAt; assert.equal(room.view().renewalSupported, false);
  room.maybeRenew(expiry - LEAD);
  await delay(20);
  assert.equal(frames.some(m => m.type === 'renew'), false); assert.equal(room.expiresAt, expiry);
});

test('a committed renewal with a lost ACK reconciles on authenticated reconnect without a second extension', async t => {
  const { room, sockets, renewal, frames } = await syntheticRelay(t, { dropAck: true });
  const oldExpiry = room.expiresAt, invite = room.view().inviteUrl, startedAt = room.startedAt;
  t.mock.timers.enable({ apis: ['Date'], now: oldExpiry - LEAD });
  room.lastHeartbeat = Date.now(); room.maybeRenew();
  await until(() => renewal());
  assert.equal(room.expiresAt, oldExpiry);
  sockets[0].terminate(); await until(() => room.state === 'offline'); clearTimeout(room.reconnect);
  await room.connect();
  assert.equal(room.expiresAt, renewal().expiresAt); assert.equal(room.expiresAt, oldExpiry + HOUR);
  assert.equal(room.view().inviteUrl, invite); assert.equal(room.startedAt, startedAt);
  assert.equal(frames.filter(m => m.type === 'renew').length, 1);
  assert.equal(frames.filter(m => m.type === 'register').at(-1).expiresAt, oldExpiry);
});

test('native disconnection cancels pending renewal and a late relay ACK cannot reauthorize the room', async t => {
  const { room, renewal } = await syntheticRelay(t, { dropAck: true });
  const originalExpiry = room.expiresAt;
  t.mock.timers.enable({ apis: ['Date'], now: originalExpiry - LEAD });
  room.lastHeartbeat = Date.now(); room.maybeRenew(); await until(() => renewal());
  const confirmation = { type: 'renewed', roomId: room.roomId, requestId: renewal().requestId, expiresAt: renewal().expiresAt };
  room.thread.emit('snapshot', { status: 'offline' }); room.confirmRenewal(confirmation);
  assert.equal(room.closed, true); assert.equal(room.expiresAt, originalExpiry);
  assert.equal(room.permissions.scopes.some(scope => scope.id === room.admissionScope), false);
  assert.equal(room.pendingRenewal, null);
});
