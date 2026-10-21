import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { openShareHistory } from '../lib/share-history.mjs';
import { GuestPermissions } from '../lib/guest-permissions.mjs';

const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Synthetic recovery scenario timed out');
};
class Rpc extends EventEmitter {
  calls = [];
  async request(method, params) {
    this.calls.push(method);
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'recovery must never send Agent input');
    return { thread: { id: params.threadId, name: 'Synthetic title', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function manager(t, owner) {
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes))); ws.on('error', () => {});
  t.after(() => ws.terminate()); await once(ws, 'open');
  const send = message => ws.send(JSON.stringify(message));
  send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => messages.some(m => m.type === 'state'));
  return { ws, messages, send };
}

test('half-open host transport reconnects to the same invitation without restoring guest admission or sending inputs', async t => {
  const registrationSecret = secret(), relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  const rpc = new Rpc(), owner = await startOwner({ relayUrl: relay.url, registrationSecret, rpcFactory: async () => rpc,
    ownerDir: new URL('../owner', import.meta.url).pathname }); t.after(() => owner.close());
  const local = await manager(t, owner); local.send({ type: 'share', threadId: 'synthetic' });
  await until(() => local.messages.some(m => m.type === 'share-result'));
  const room = [...owner.rooms.values()][0], invite = room.view().inviteUrl;
  room.guests.set('old-guest', { id: 'old-guest', name: 'B', status: 'admitted' });
  room.proposals.set('old', { status: 'processing', text: 'Never replay' });
  const before = rpc.calls.length;
  room.lastHeartbeat = Date.now() - 80000; owner.checkConnections();
  await until(() => room.state === 'offline'); clearTimeout(room.reconnect);
  await room.connect(); assert.equal(room.state, 'online'); assert.equal(room.view().inviteUrl, invite);
  assert.equal(room.guests.size, 0); assert.equal(room.proposals.get('old').status, 'unknown');
  assert.equal(rpc.calls.length, before);
});

test('restart exposes only history metadata; explicit re-sharing checks catalog and creates new credentials', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-owner-history-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json'), registrationSecret = secret();
  const relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  let factories = 0;
  const options = { relayUrl: relay.url, registrationSecret, ownerDir: new URL('../owner', import.meta.url).pathname,
    rpcFactory: async () => { factories++; return new Rpc(); }, listThreads: async () => [{ id: 'synthetic' }] };
  const history = await openShareHistory(file), owner = await startOwner({ ...options, history });
  let firstClosed = false; t.after(() => firstClosed ? undefined : owner.close());
  const first = await manager(t, owner); first.send({ type: 'share', threadId: 'synthetic', ownerName: 'A', requireApproval: true });
  await until(() => first.messages.some(m => m.type === 'share-result'));
  const old = [...owner.rooms.values()][0], oldInvite = old.view().inviteUrl;
  await owner.close(); firstClosed = true; await history.flush();
  const saved = await openShareHistory(file), second = await startOwner({ ...options, history: saved }); t.after(() => second.close());
  const count = factories, local = await manager(t, second);
  assert.equal(factories, count); assert.equal(second.rooms.size, 0);
  const initial = local.messages.find(m => m.type === 'state'); assert.equal(initial.history.length, 1);
  assert.ok(!JSON.stringify(initial.history).includes('invite'));
  local.send({ type: 'reshare', threadId: 'other' }); await until(() => local.messages.some(m => m.type === 'error'));
  assert.equal(second.rooms.size, 0); assert.equal(factories, count);
  local.send({ type: 'reshare', threadId: 'synthetic' }); await until(() => local.messages.some(m => m.type === 'share-result'));
  const fresh = [...second.rooms.values()][0]; assert.notEqual(fresh.view().inviteUrl, oldInvite);
  assert.equal(fresh.requireApproval, true); assert.equal(fresh.guests.size, 0); assert.equal(fresh.proposals.size, 0);
});

test('personal credential resumes admission across reconnect and replaced invitations, but never crosses stop, removal or thread scope', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-admission-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registrationSecret = secret(), relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  const permissions = new GuestPermissions(), history = await openShareHistory(path.join(dir, 'history.json'));
  const owner = await startOwner({ relayUrl: relay.url, registrationSecret, permissions, history, rpcFactory: async () => new Rpc(),
    listThreads: async () => [{ id: 'one' }, { id: 'two' }], ownerDir: new URL('../owner', import.meta.url).pathname });
  t.after(() => owner.close()); const local = await manager(t, owner);
  async function share(threadId, type = 'share') {
    const before = local.messages.filter(m => m.type === 'share-result').length;
    local.send({ type, threadId });
    await until(() => local.messages.filter(m => m.type === 'share-result').length > before);
    return [...owner.rooms.values()].find(r => !r.closed && r.threadId === threadId);
  }
  async function join(room, token) {
    const ws = new WebSocket(relay.url.replace('http:', 'ws:') + '/guest', { origin: relay.url }), messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes))); t.after(() => ws.terminate());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name: 'Same display name', sessionId: token }));
    await until(() => messages.some(m => m.type === 'pending'));
    const id = messages.find(m => m.type === 'pending').guestId;
    await until(() => room.guests.has(id)); return { ws, messages, id };
  }
  const room = await share('one'), credential = secret(), first = await join(room, credential);
  assert.equal(room.guests.get(first.id).status, 'pending');
  assert.equal(first.messages.some(m => m.type === 'data'), false);
  local.send({ type: 'admit', roomId: room.roomId, guestId: first.id });
  await until(() => first.messages.some(m => m.payload?.type === 'visitor-recovery'));
  const scope = new URLSearchParams(new URL(room.view().inviteUrl).hash.slice(1)).get('scope');
  assert.equal(scope, room.admissionScope);
  assert.equal(first.messages.find(m => m.payload?.type === 'visitor-recovery').payload.scopeId, scope);
  assert.ok(!room.view().inviteUrl.includes(credential), 'the shared invitation never contains a personal credential');
  const participant = room.guests.get(first.id).participantId;
  first.ws.close(); await until(() => !room.guests.has(first.id));
  const again = await join(room, credential); await until(() => again.messages.some(m => m.type === 'admitted'));
  assert.equal(room.guests.get(again.id).participantId, participant);
  // A's click may refer to the card just removed by a network disconnect.
  local.send({ type: 'remove-guest', roomId: room.roomId, guestId: first.id });
  await until(() => !room.guests.has(again.id));
  const revokedByStaleCard = await join(room, credential);
  assert.equal(room.guests.get(revokedByStaleCard.id).status, 'pending');
  local.send({ type: 'admit', roomId: room.roomId, guestId: revokedByStaleCard.id });
  await until(() => revokedByStaleCard.messages.some(m => m.type === 'admitted'));
  const stranger = await join(room, secret()); assert.equal(room.guests.get(stranger.id).status, 'pending');
  assert.equal(stranger.messages.some(m => m.type === 'data'), false);
  owner.pauseAll(); const replaced = await share('one', 'reshare');
  assert.notEqual(replaced.roomId, room.roomId);
  assert.equal(new URLSearchParams(new URL(replaced.view().inviteUrl).hash.slice(1)).get('scope'), scope);
  const restored = await join(replaced, credential); await until(() => restored.messages.some(m => m.type === 'admitted'));
  await until(() => restored.messages.some(m => m.payload?.type === 'visitor-recovery'));
  assert.equal(restored.messages.find(m => m.payload?.type === 'visitor-recovery').payload.expiresAt, room.expiresAt);
  const other = await share('two'), crossThread = await join(other, credential);
  assert.equal(other.guests.get(crossThread.id).status, 'pending');
  assert.equal(crossThread.messages.some(m => m.type === 'data'), false);
  local.send({ type: 'remove-guest', roomId: replaced.roomId, guestId: restored.id });
  await until(() => !replaced.guests.has(restored.id));
  const removed = await join(replaced, credential); assert.equal(replaced.guests.get(removed.id).status, 'pending');
  local.send({ type: 'admit', roomId: replaced.roomId, guestId: removed.id });
  await until(() => removed.messages.some(m => m.type === 'admitted'));
  local.send({ type: 'revoke', roomId: replaced.roomId }); await until(() => replaced.closed);
  const stopped = await share('one', 'reshare'), returning = await join(stopped, credential);
  assert.notEqual(new URLSearchParams(new URL(stopped.view().inviteUrl).hash.slice(1)).get('scope'), scope);
  assert.equal(stopped.guests.get(returning.id).status, 'pending');
  assert.equal(returning.messages.some(m => m.type === 'data'), false);
});
