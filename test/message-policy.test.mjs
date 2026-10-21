import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { SharedRoom, startOwner, secret } from '../lib/host.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';
import { startRelay } from '../lib/relay.mjs';

const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Synthetic message policy scenario timed out');
};
class Rpc extends EventEmitter {
  calls = [];
  async request(method, params) {
    if (method === 'turn/start') {
      this.calls.push(params);
      if (this.hold) await this.hold;
      if (this.fail) throw new Error('Synthetic uncertain response');
      return { turn: { id: randomUUID() } };
    }
    assert.ok(['thread/read', 'thread/resume'].includes(method));
    return { thread: { id: 'synthetic-thread', name: 'Synthetic thread', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function fixture(t) {
  const rpc = new Rpc(), room = new SharedRoom({ relayUrl: 'http://127.0.0.1:1', registrationSecret: secret(), threadId: 'synthetic-thread' });
  room.thread = new ScopedThread({ rpc, threadId: room.threadId }); await room.thread.start(); room.state = 'online';
  room.guests.set('guest', { id: 'guest', participantId: 'synthetic-author', name: 'B', status: 'admitted' });
  t.after(() => room.close());
  const send = (text, extra = {}) => {
    const requestId = randomUUID(), payload = { type: 'proposal', requestId, text, ...extra };
    room.receive({ type: 'guest-message', guestId: 'guest', payload });
    return { id: `guest:${requestId}`, payload };
  };
  return { rpc, room, send };
}

test('default direct input dispatches once to the shared thread and rejects guest capability fields', async t => {
  const { rpc, room, send } = await fixture(t);
  assert.equal(room.view().requireApproval, false);
  send('invalid', { requireApproval: false }); send('invalid', { threadId: 'other' });
  room.receive({ type: 'guest-message', guestId: 'guest', payload: { type: 'set-message-policy', requireApproval: false } });
  assert.equal(room.proposals.size, 0);
  const input = send('Exact synthetic input');
  await until(() => room.proposals.get(input.id)?.status === 'accepted');
  room.receive({ type: 'guest-message', guestId: 'guest', payload: input.payload });
  assert.deepEqual(rpc.calls, [{ threadId: 'synthetic-thread', input: [{ type: 'text', text: 'Exact synthetic input' }] }]);
  room.guests.get('guest').status = 'pending'; send('not admitted'); assert.equal(room.proposals.size, 1);
});

test('local policy controls new input; switching off never drains existing pending decisions', async t => {
  const { rpc, room, send } = await fixture(t);
  for (const invalid of ['false', null, 0, undefined]) assert.throws(() => room.setRequireApproval(invalid), /布尔/);
  room.setRequireApproval(true);
  const pending = send('Manual approval'), rejected = send('Manual rejection');
  assert.equal(rpc.calls.length, 0);
  room.setRequireApproval(false);
  assert.equal(room.proposals.get(pending.id).status, 'pending');
  const direct = send('Direct input'); await until(() => room.proposals.get(direct.id)?.status === 'accepted');
  await room.decide(pending.id, true); await room.decide(rejected.id, false);
  assert.equal(room.proposals.get(rejected.id).status, 'rejected');
  assert.deepEqual(rpc.calls.map(c => c.input[0].text), ['Direct input', 'Manual approval']);
  await assert.rejects(room.decide(pending.id, true), /已处理/);
});

test('direct inputs check admission again before queued dispatch and never retry uncertain results', async t => {
  const { rpc, room, send } = await fixture(t);
  let release; rpc.hold = new Promise(resolve => { release = resolve; });
  const first = send('Already dispatched'); await until(() => rpc.calls.length === 1);
  const queued = send('Revoke before dispatch'); room.removeGuest('guest'); release();
  await until(() => room.proposals.get(queued.id)?.status === 'rejected');
  assert.equal(rpc.calls.length, 1);
  await until(() => room.proposals.get(first.id)?.status === 'accepted');
  room.guests.set('guest', { id: 'guest', name: 'B', status: 'admitted' }); rpc.fail = true;
  const uncertain = send('Uncertain input'); await until(() => room.proposals.get(uncertain.id)?.status === 'unknown');
  room.receive({ type: 'guest-message', guestId: 'guest', payload: uncertain.payload });
  assert.equal(rpc.calls.length, 2);
  room.close(); send('After close'); assert.equal(room.proposals.size, 3);
  assert.throws(() => room.setRequireApproval(false), /不可用/);
});

test('authenticated owner configures room policy through WebSocket; admitted guests receive current updates', async t => {
  const registrationSecret = secret(), rpc = new Rpc();
  const relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  const owner = await startOwner({ relayUrl: relay.url, registrationSecret, rpcFactory: async () => rpc,
    ownerDir: new URL('../owner', import.meta.url).pathname }); t.after(() => owner.close());
  const messages = [], local = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => local.terminate()); local.on('message', b => messages.push(JSON.parse(b))); await once(local, 'open');
  const send = m => local.send(JSON.stringify(m));
  send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => messages.some(m => m.type === 'state'));
  send({ type: 'share', threadId: 'synthetic-thread', requireApproval: 'false' });
  await until(() => messages.some(m => m.type === 'error')); assert.equal(owner.rooms.size, 0);
  send({ type: 'share', threadId: 'synthetic-thread' });
  await until(() => messages.some(m => m.type === 'share-result'));
  const room = [...owner.rooms.values()][0]; assert.equal(room.requireApproval, false);
  const guestMessages = [], guest = new WebSocket(relay.url.replace('http:', 'ws:') + '/guest', { origin: relay.url });
  t.after(() => guest.terminate()); guest.on('message', b => guestMessages.push(JSON.parse(b))); await once(guest, 'open');
  guest.send(JSON.stringify({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name: 'Synthetic B' }));
  await until(() => room.guests.size === 1);
  assert.equal(guestMessages.some(m => m.type === 'data'), false);
  send({ type: 'admit', roomId: room.roomId, guestId: [...room.guests.keys()][0] });
  await until(() => guestMessages.some(m => m.payload?.type === 'message-policy' && m.payload.requireApproval === false));
  const directId = randomUUID(); guest.send(JSON.stringify({ type: 'proposal', requestId: directId, text: 'Default direct' }));
  await until(() => guestMessages.some(m => m.payload?.requestId === directId && m.payload.status === 'accepted'));
  send({ type: 'set-message-policy', roomId: room.roomId, requireApproval: true });
  await until(() => guestMessages.some(m => m.payload?.requireApproval === true));
  const pendingId = randomUUID(); guest.send(JSON.stringify({ type: 'proposal', requestId: pendingId, text: 'Requires decision' }));
  await until(() => [...room.proposals.values()].some(p => p.requestId === pendingId));
  assert.equal(rpc.calls.length, 1); assert.equal(room.view().requireApproval, true);
  send({ type: 'approve', roomId: room.roomId, proposalId: `${[...room.guests.keys()][0]}:${pendingId}` });
  await until(() => guestMessages.some(m => m.payload?.requestId === pendingId && m.payload.status === 'accepted'));
  assert.equal(rpc.calls.length, 2);
});
