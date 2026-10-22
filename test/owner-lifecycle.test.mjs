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

async function until(predicate) {
  for (let i = 0; i < 300; i++) { const result = predicate(); if (result) return result; await delay(10); }
  throw new Error('Synthetic owner lifecycle timed out');
}
class Rpc extends EventEmitter {
  async request(method, params) {
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'Lifecycle changes must not send Agent input');
    return { thread: { id: params.threadId, name: 'Synthetic lifecycle', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function manager(t, owner, authenticate = true) {
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes))); ws.on('error', () => {});
  t.after(() => ws.terminate()); await once(ws, 'open');
  const send = message => ws.send(JSON.stringify(message));
  if (authenticate) {
    send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
    await until(() => messages.some(m => m.type === 'state'));
  }
  const state = () => messages.findLast(m => m.type === 'state');
  const share = async (threadId, type = 'share') => {
    const offset = messages.length; send({ type, threadId });
    const result = await until(() => messages.slice(offset).find(m => m.type === 'share-result' || m.type === 'error'));
    assert.equal(result.type, 'share-result', result.message);
    return owner.rooms.get(result.roomId);
  };
  return { ws, messages, send, state, share };
}
async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/co2-owner-lifecycle-');
  const registrationSecret = secret(), relay = await startRelay({ registrationSecret });
  const history = await openShareHistory(path.join(dir, 'history.json'));
  const owner = await startOwner({ relayUrl: relay.url, registrationSecret, history, connection: { state: 'local' },
    rpcFactory: async () => new Rpc(), ownerDir: new URL('../owner', import.meta.url).pathname });
  t.after(async () => { await owner.close(); await relay.close(); await history.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  return { owner, history };
}

test('owner state sorts newest shares first, breaks equal times by reverse creation order, and keeps reconnects stable', async t => {
  const { owner } = await fixture(t), local = await manager(t, owner);
  const first = await local.share('first'), second = await local.share('second');
  first.startedAt = Date.now() - 2000; second.startedAt = first.startedAt + 1000;
  owner.setConnection({ state: 'local' });
  await until(() => local.state().rooms[0]?.startedAt === second.startedAt);
  assert.deepEqual(local.state().rooms.map(r => r.threadId), ['second', 'first']);
  second.startedAt = first.startedAt; owner.setConnection({ state: 'local' });
  await until(() => local.state().rooms.every(r => r.startedAt === first.startedAt));
  assert.deepEqual(local.state().rooms.map(r => r.threadId), ['second', 'first']);
  const invite = first.view().inviteUrl;
  first.ws.terminate(); await until(() => first.state === 'offline'); clearTimeout(first.reconnect);
  await first.connect(); await until(() => local.state().rooms.find(r => r.roomId === first.roomId)?.state === 'online');
  assert.equal(first.view().inviteUrl, invite);
  assert.deepEqual(local.state().rooms.map(r => r.threadId), ['second', 'first']);
  first.close({ reason: 'expired' });
  const replacement = await local.share('first', 'reshare');
  assert.notEqual(replacement.roomId, first.roomId);
  assert.equal(local.state().rooms[0].roomId, replacement.roomId);
});

test('acknowledging an expired share removes its card and attention across managers and refresh, retaining re-share history', async t => {
  const { owner, history } = await fixture(t), local = await manager(t, owner), other = await manager(t, owner);
  const room = await local.share('expired'); room.close({ reason: 'expired' });
  await until(() => other.state().attention.some(item => item.roomId === room.roomId));
  local.send({ type: 'dismiss-room', roomId: room.roomId });
  await until(() => !local.state().rooms.some(r => r.roomId === room.roomId) && !other.state().rooms.some(r => r.roomId === room.roomId));
  assert.equal(local.state().attention.some(item => item.roomId === room.roomId), false);
  assert.equal(other.state().attention.some(item => item.roomId === room.roomId), false);
  assert.equal(history.list().some(entry => entry.threadId === 'expired'), true);
  const refreshed = await manager(t, owner);
  assert.equal(refreshed.state().rooms.length, 0);
  assert.equal(refreshed.state().history.some(entry => entry.threadId === 'expired'), true);
  const offset = other.messages.length;
  other.send({ type: 'dismiss-room', roomId: room.roomId });
  await until(() => other.messages.slice(offset).some(m => m.type === 'state'));
  assert.equal(other.messages.slice(offset).some(m => m.type === 'error'), false);
  assert.equal((await refreshed.share('expired', 'reshare')).closed, false);
});

test('dismissal cannot stop online, connecting or offline rooms, and requires local-manager authentication', async t => {
  const { owner } = await fixture(t), local = await manager(t, owner), room = await local.share('active');
  for (const state of ['online', 'connecting', 'offline']) {
    room.state = state;
    const offset = local.messages.length;
    local.send({ type: 'dismiss-room', roomId: room.roomId });
    await until(() => local.messages.slice(offset).some(m => m.type === 'error' && m.operation === 'dismiss-room'));
    assert.equal(owner.rooms.has(room.roomId), true); assert.equal(room.closed, false);
  }
  room.state = 'online';
  const stranger = await manager(t, owner, false), closed = once(stranger.ws, 'close');
  stranger.send({ type: 'dismiss-room', roomId: room.roomId });
  assert.equal((await closed)[0], 1008);
  assert.equal(owner.rooms.has(room.roomId), true); assert.equal(room.closed, false);
});
