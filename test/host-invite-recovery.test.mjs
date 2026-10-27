import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { InviteRecovery } from '../lib/invite-recovery.mjs';
import { createManagerSettings } from '../lib/manager-settings.mjs';

const until = async predicate => {
  for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error('Synthetic invitation recovery timed out');
};
class Rpc extends EventEmitter {
  async request(method, params) {
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'recovery cannot send Agent input');
    return { thread: { id: params.threadId, name: 'Synthetic invitation recovery', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function peer(t, origin, route) {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + route, { origin });
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return { ws, messages, send: value => ws.send(JSON.stringify(value)) };
}
async function fixture(t, options = {}) {
  const recovery = new InviteRecovery(), registrationSecret = secret();
  const relay = await startRelay({ registrationSecret, recovery });
  let factories = 0;
  const owner = await startOwner({ relayUrl: relay.url, registrationSecret, recovery,
    ownerDir: new URL('../owner', import.meta.url).pathname, connection: { state: 'local' },
    rpcFactory: async () => { factories++; return new Rpc(); }, ...options });
  t.after(async () => { await owner.close(); await relay.close(); recovery.close(); });
  const local = await peer(t, owner.baseUrl, '/owner');
  local.send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => local.messages.some(m => m.type === 'state'));
  const share = async threadId => {
    const offset = local.messages.length;
    local.send({ type: 'share', threadId, ownerName: 'Synthetic owner', requireApproval: true });
    const response = await until(() => local.messages.slice(offset).find(m => m.type === 'share-result'));
    return owner.rooms.get(response.roomId);
  };
  const request = async room => {
    const client = await peer(t, relay.url, '/recovery');
    const input = { type: 'request', roomId: room.roomId, inviteToken: room.inviteToken,
      requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Same unverified name' };
    client.send(input);
    await until(() => client.messages.some(m => m.type === 'recovery-request' && m.status === 'pending'));
    return { client, input, watch: () => recovery.watch(input, relay.url) };
  };
  const approve = async request => {
    local.send({ type: 'approve-recovery', requestId: request.input.requestId });
    return until(() => request.watch().status === 'approved' && request.watch());
  };
  const join = async (inviteUrl, sessionId = secret()) => {
    const fragment = new URLSearchParams(new URL(inviteUrl).hash.slice(1));
    const guest = await peer(t, relay.url, '/guest');
    guest.send({ type: 'join', roomId: fragment.get('room'), inviteToken: fragment.get('invite'), name: 'Same unverified name', sessionId });
    const pending = await until(() => guest.messages.find(m => m.type === 'pending'));
    return { ...guest, id: pending.guestId, room: owner.rooms.get(fragment.get('room')) };
  };
  return { recovery, relay, owner, local, share, request, approve, join, get factories() { return factories; } };
}

test('expired invitation remains recoverable after card dismissal and approval admits only its requester', async t => {
  const f = await fixture(t), original = await f.share('one');
  original.close({ reason: 'expired' });
  f.local.send({ type: 'dismiss-room', roomId: original.roomId });
  await until(() => !f.owner.rooms.has(original.roomId));
  const first = await f.request(original), second = await f.request(original);
  assert.equal(f.factories, 1, 'request creation never reads Desktop');
  const state = f.local.messages.filter(m => m.type === 'state').at(-1);
  assert.equal(JSON.stringify(state.recoveryRequests).includes(first.input.receiptToken), false);
  const approved = await f.approve(first);
  assert.equal(f.factories, 2);
  assert.equal(second.watch().status, 'pending');
  const guest = await f.join(approved.inviteUrl, first.input.visitorToken);
  await until(() => guest.messages.some(m => m.payload?.type === 'snapshot'));
  assert.equal(guest.room.guests.get(guest.id).status, 'admitted');
  const other = await f.join(approved.inviteUrl, second.input.visitorToken);
  assert.equal(other.room.guests.get(other.id).status, 'pending');
  assert.equal(other.messages.some(m => m.type === 'data'), false);
  f.local.send({ type: 'approve-recovery', requestId: first.input.requestId });
  await delay(20);
  assert.equal(f.factories, 2, 'duplicate approval never creates a room');
  assert.equal(first.watch().inviteUrl, approved.inviteUrl);
});

test('two explicit approvals reuse an already active invitation without changing its policy or connections', async t => {
  const f = await fixture(t), original = await f.share('one');
  original.close({ reason: 'interrupted' });
  const first = await f.request(original), second = await f.request(original);
  const active = await f.share('one'), url = active.view().inviteUrl;
  active.setRequireApproval(false);
  f.local.send({ type: 'approve-recovery', requestId: first.input.requestId });
  f.local.send({ type: 'approve-recovery', requestId: second.input.requestId });
  await until(() => first.watch().status === 'approved' && second.watch().status === 'approved');
  assert.equal(first.watch().inviteUrl, url); assert.equal(second.watch().inviteUrl, url);
  assert.equal(f.factories, 2); assert.equal(active.requireApproval, false);
  const a = await f.join(url, first.input.visitorToken), b = await f.join(url, second.input.visitorToken);
  await until(() => a.messages.some(m => m.type === 'admitted') && b.messages.some(m => m.type === 'admitted'));
  assert.equal(active.guests.size, 2);
});

test('removal invalidates an approved receipt and cannot reinstall admission by querying or approving again', async t => {
  const f = await fixture(t), original = await f.share('one'); original.close({ reason: 'expired' });
  const request = await f.request(original), result = await f.approve(request);
  const guest = await f.join(result.inviteUrl, request.input.visitorToken);
  await until(() => guest.messages.some(m => m.type === 'admitted'));
  f.local.send({ type: 'remove-guest', roomId: guest.room.roomId, guestId: guest.id });
  await until(() => request.watch().status === 'unavailable');
  f.local.send({ type: 'approve-recovery', requestId: request.input.requestId });
  const rejoined = await f.join(result.inviteUrl, request.input.visitorToken);
  await delay(20);
  assert.equal(rejoined.room.guests.get(rejoined.id).status, 'pending');
  assert.equal(rejoined.messages.some(m => m.type === 'data'), false);
  f.local.send({ type: 'revoke', roomId: guest.room.roomId });
  await until(() => guest.room.closed);
  assert.equal(f.recovery.status(request.input, f.relay.url).status, 'unavailable');
});

test('stopping all shares while approval waits for Desktop prevents a late room or grant', async t => {
  let block = false, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { selectThread: async () => {
    if (block) { entered(); await new Promise(resolve => { release = resolve; }); }
  } });
  const original = await f.share('one'); original.close({ reason: 'expired' });
  const request = await f.request(original); block = true;
  f.local.send({ type: 'approve-recovery', requestId: request.input.requestId });
  await waiting; f.owner.revokeAll(); release();
  await until(() => f.local.messages.some(m => m.type === 'error' && m.operation === 'approve-recovery'));
  assert.equal(request.watch().status, 'unavailable');
  assert.equal([...f.owner.rooms.values()].some(room => !room.closed), false);
  assert.equal(f.factories, 1);
});

test('a failed approval does not retry through reads; only another local decision creates the room', async t => {
  const f = await fixture(t, { managerSettings: createManagerSettings({ shareLimit: 1 }) });
  const original = await f.share('one'); original.close({ reason: 'expired' });
  const request = await f.request(original), blocker = await f.share('two');
  f.local.send({ type: 'approve-recovery', requestId: request.input.requestId });
  await until(() => request.watch().status === 'failed');
  for (let i = 0; i < 3; i++) request.client.send({ type: 'watch', requestId: request.input.requestId, receiptToken: request.input.receiptToken });
  assert.equal(f.factories, 2);
  f.local.send({ type: 'revoke', roomId: blocker.roomId }); await until(() => blocker.closed);
  const approved = await f.approve(request);
  assert.equal(approved.status, 'approved'); assert.equal(f.factories, 3);
});

test('Desktop interruption is recoverable while ordinary transport disconnection retains its old room', async t => {
  const f = await fixture(t), room = await f.share('one');
  room.disconnected(); clearTimeout(room.reconnect);
  assert.equal(f.recovery.status({ roomId: room.roomId, inviteToken: room.inviteToken }, f.relay.url).status, 'temporarily-offline');
  room.thread.emit('fault', new Error('synthetic only'));
  const status = f.recovery.status({ roomId: room.roomId, inviteToken: room.inviteToken }, f.relay.url);
  assert.equal(status.status, 'recoverable'); assert.equal(status.reason, 'interrupted');
});

test('a stale stop for an ended room cannot disable its active replacement recovery', async t => {
  const f = await fixture(t), original = await f.share('one'); original.close({ reason: 'expired' });
  const request = await f.request(original), approved = await f.approve(request);
  const target = [...f.owner.rooms.values()].find(room => !room.closed);
  f.local.send({ type: 'revoke', roomId: original.roomId });
  await delay(20);
  assert.equal(target.closed, false); assert.equal(request.watch().status, 'approved');
  assert.equal(request.watch().inviteUrl, approved.inviteUrl);
  target.close({ reason: 'expired' });
  assert.equal(f.recovery.status({ roomId: target.roomId, inviteToken: target.inviteToken }, f.relay.url).status, 'recoverable');
});

test('a failed durable grant consumption closes sharing without admission or an uncaught relay callback', async t => {
  const f = await fixture(t), original = await f.share('one'); original.close({ reason: 'expired' });
  const request = await f.request(original), result = await f.approve(request);
  const target = [...f.owner.rooms.values()].find(room => !room.closed);
  const consume = f.recovery.consumeGrant.bind(f.recovery);
  f.recovery.consumeGrant = () => { throw new Error('synthetic-private-store-path'); };
  const guest = await f.join(result.inviteUrl, request.input.visitorToken);
  await until(() => target.closed);
  assert.equal(guest.messages.some(message => message.type === 'admitted' || message.type === 'data'), false);
  assert.equal(target.guests.size, 0);
  assert.match(target.lastError, /恢复授权无法安全保存/);
  assert.equal(JSON.stringify(f.local.messages).includes('synthetic-private-store-path'), false);
  f.recovery.consumeGrant = consume;
  assert.equal((await f.share('other')).closed, false, 'local manager and service survived the failed join');
});

test('failed recovery revocation cannot leave a denied or removed visitor authorized', async t => {
  const f = await fixture(t);
  const revoke = f.recovery.revokeVisitor.bind(f.recovery);
  for (const operation of ['deny', 'remove-guest']) {
    const room = await f.share(operation);
    const guest = await f.join(room.view().inviteUrl);
    await until(() => room.guests.has(guest.id));
    if (operation === 'remove-guest') {
      f.local.send({ type: 'admit', roomId: room.roomId, guestId: guest.id });
      await until(() => guest.messages.some(message => message.type === 'admitted'));
    }
    f.recovery.revokeVisitor = () => { throw new Error('synthetic-private-store-path'); };
    const offset = f.local.messages.length;
    f.local.send({ type: operation, roomId: room.roomId, guestId: guest.id });
    await until(() => f.local.messages.slice(offset).some(message => message.type === 'error' && message.operation === operation));
    assert.equal(room.closed, true); assert.equal(room.guests.size, 0);
    assert.equal(JSON.stringify(f.local.messages.slice(offset)).includes('synthetic-private-store-path'), false);
    f.recovery.revokeVisitor = revoke;
  }
});
