import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { ScopedThread } from '../lib/scoped-thread.mjs';
import { DesktopRpcClient } from '../lib/desktop-ipc.mjs';
import { SharedRoom, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';

// Synthetic protocol boundaries only. No default Codex profile, real index,
// account credentials, native conversation or external model is involved.
const THREAD = '11111111-1111-4111-8111-111111111111';
const command = (output = 'synthetic command output') => ({ id: 'command', type: 'commandExecution', command: 'synthetic-check',
  status: 'completed', exitCode: 0, durationMs: 12, aggregatedOutput: output,
  processId: 'private-process-handle', arguments: { token: 'private-arguments' } });
const seed = (items = [command(), { id: 'answer', type: 'agentMessage', text: 'Synthetic result' }]) => ({
  id: THREAD, name: 'Synthetic previews', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items }],
});
class Rpc extends EventEmitter {
  constructor(thread = seed()) { super(); this.thread = thread; this.calls = []; }
  async request(method, params) {
    this.calls.push({ method, params });
    assert.ok(['thread/read', 'thread/resume'].includes(method));
    assert.equal(params.threadId, THREAD);
    return { thread: structuredClone(this.thread) };
  }
  close() {}
}
async function scoped(t, rpc = new Rpc()) {
  const thread = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => thread.close()); await thread.start();
  return { rpc, thread };
}
const activity = thread => thread.snapshot.items.find(item => item.role === 'activity');
const detail = async (thread, id) => JSON.parse((await thread.readActivity(id)).bytes);
async function until(check, description = 'synthetic protocol event') {
  for (let n = 0; n < 300; n++) { const value = check(); if (value) return value; await delay(10); }
  throw new Error(`Timed out waiting for ${description}`);
}

test('activity references authorize only current content and this room; public snapshots never carry detail bodies', async t => {
  const { rpc, thread } = await scoped(t), first = activity(thread);
  assert.deepEqual(thread.snapshot.capabilities, ['file-original', 'activity-details']);
  assert.equal(Object.getOwnPropertySymbols(first).length, 0);
  assert.ok(!JSON.stringify(thread.snapshot).includes('synthetic command output'));
  assert.ok(!JSON.stringify(thread.snapshot).includes('private-'));
  assert.equal((await detail(thread, first.detailId)).text, 'synthetic command output');
  const other = (await scoped(t, rpc)).thread;
  assert.notEqual(activity(other).detailId, first.detailId);
  await assert.rejects(other.readActivity(first.detailId));
  await assert.rejects(thread.readActivity('f'.repeat(64)));
  const returned = await thread.readActivity(first.detailId); returned.bytes.fill(0);
  assert.equal((await detail(thread, first.detailId)).text, 'synthetic command output');

  rpc.thread.turns[0].items[0].aggregatedOutput = 'new synthetic output'; await thread.refresh();
  const second = activity(thread);
  assert.equal(second.id, first.id); assert.notEqual(second.detailId, first.detailId);
  assert.equal(thread.hasActivity(first.detailId), false); await assert.rejects(thread.readActivity(first.detailId));
  assert.equal((await detail(thread, second.detailId)).text, 'new synthetic output');

  rpc.thread.turns[0].items.shift(); await thread.refresh();
  assert.equal(activity(thread), undefined); await assert.rejects(thread.readActivity(second.detailId));
  assert.equal(thread.snapshot.items[0].text, 'Synthetic result');
});

test('chat text wins the bounded snapshot budget and omitted activities lose read scope', async t => {
  const { rpc, thread } = await scoped(t), first = activity(thread);
  const text = 'latest assistant text 😀 '.repeat(8000);
  rpc.thread.turns[0].items[1].text = text;
  for (let n = 0; n < 200; n++) rpc.thread.turns[0].items.push({ ...command(`log ${n}`), id: `command-${n}` });
  await thread.refresh();
  const snapshot = thread.snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 48 * 1024);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.items.some(item => item.role === 'activity'), false);
  assert.ok(snapshot.items[0].text.endsWith('latest assistant text 😀 '));
  assert.ok(!snapshot.items[0].text.includes('\ufffd'));
  assert.equal(thread.hasActivity(first.detailId), false); await assert.rejects(thread.readActivity(first.detailId));
  const withoutActivities = (await scoped(t, new Rpc(seed([{ id: 'answer', type: 'agentMessage', text }])))).thread;
  assert.equal(snapshot.items[0].text, withoutActivities.snapshot.items[0].text);
});

class NativeIpc extends EventEmitter {
  constructor(state) { super(); this.state = state; this.clientId = randomUUID(); this.owner = randomUUID(); this.timeoutMs = 1000; }
  async request(method) {
    assert.equal(method, 'thread-owner-discovery');
    return { handledByClientId: this.owner, result: { supportsUntrustedAppInput: true } };
  }
  follow(_threadId, _owner, following) {
    if (following) this.change({ type: 'snapshot', revision: 0, conversationState: structuredClone(this.state) });
  }
  change(change, extra = {}) {
    this.emit('broadcast', { method: 'thread-stream-state-changed', sourceClientId: this.owner,
      targetClientIds: [this.clientId], version: 11, params: { hostId: 'local', conversationId: THREAD, change }, ...extra });
  }
  close() { if (!this.closed) { this.closed = true; this.emit('closed'); } }
}

test('legacy/canonical native patch updates, rollback and disconnection revoke former detail capabilities', async t => {
  for (const canonical of [false, true]) {
    const turn = { turnId: 'turn', status: 'completed', items: [command(), { id: 'answer', type: 'agentMessage', text: 'Native synthetic result' }] };
    const state = { id: THREAD, hostId: 'local', title: 'Synthetic native fixture', turns: [turn], turnsPagination: { hasLoadedOldest: true },
      ...(canonical ? { turnHistory: { kind: 'canonical', history: { isComplete: true,
        islands: [{ entries: [{ value: 'turn-key' }] }], entitiesByKey: { 'turn-key': turn } } } } : {}) };
    const ipc = new NativeIpc(state), rpc = new DesktopRpcClient(ipc); t.after(() => rpc.close());
    const { thread } = await scoped(t, rpc), original = activity(thread);
    const basePath = canonical ? ['turnHistory', 'history', 'entitiesByKey', 'turn-key', 'items'] : ['turns', 0, 'items'];
    ipc.change({ type: 'patches', baseRevision: 0, revision: 1,
      patches: [{ op: 'replace', path: [...basePath, 0, 'aggregatedOutput'], value: 'patched synthetic output' }] });
    await thread.refresh();
    const updated = activity(thread);
    assert.notEqual(updated.detailId, original.detailId);
    assert.equal((await detail(thread, updated.detailId)).text, 'patched synthetic output');
    await assert.rejects(thread.readActivity(original.detailId));
    ipc.change({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'remove', path: [...basePath, 0] }] });
    await thread.refresh();
    assert.equal(activity(thread), undefined); await assert.rejects(thread.readActivity(updated.detailId));
    assert.equal(thread.snapshot.items[0].text, 'Native synthetic result');
    ipc.change({ type: 'snapshot', revision: 3, conversationState: structuredClone(state) }); await thread.refresh();
    const restored = activity(thread); assert.ok(restored);
    ipc.change({ type: 'patches', baseRevision: 2, revision: 5, patches: [] });
    assert.equal(thread.snapshot.status, 'offline'); await assert.rejects(thread.readActivity(restored.detailId));
    assert.equal(rpc.closed, true, 'revision gaps fail closed rather than preserving stale scope');
  }
});

async function relayFixture(t, source = seed()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-expanded-'));
  const registrationSecret = secret(), relay = await startRelay({ registrationSecret }), rooms = [], peers = [];
  t.after(async () => { for (const peer of peers) peer.ws.terminate(); for (const room of rooms) room.close();
    await relay.close(); await fs.rm(dir, { recursive: true, force: true }); });
  async function makeRoom(thread = source) {
    const rpc = new Rpc(thread), room = await new SharedRoom({ relayUrl: relay.url, registrationSecret,
      threadId: THREAD, rpcFactory: async () => rpc }).start();
    rooms.push(room); return { room, rpc };
  }
  async function join(room, admit = true) {
    const ws = new WebSocket(relay.url.replace('http:', 'ws:') + '/guest', { origin: relay.url }), messages = [];
    const peer = { ws, messages, send: payload => ws.send(JSON.stringify(payload)) }; peers.push(peer);
    ws.on('message', b => messages.push(JSON.parse(b))); ws.on('error', () => {}); await once(ws, 'open');
    peer.send({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name: 'Synthetic viewer' });
    const pending = await until(() => messages.find(m => m.type === 'pending')); peer.guestId = pending.guestId;
    if (admit) {
      await until(() => room.guests.has(peer.guestId)); room.admit(peer.guestId, true);
      await until(() => messages.find(m => m.type === 'admitted'));
      peer.snapshot = (await until(() => messages.find(m => m.payload?.type === 'snapshot'))).payload;
    }
    return peer;
  }
  return { dir, relay, makeRoom, join };
}

test('real admitted relay sends only current room activity details in bounded chunks and exact original file bytes', async t => {
  const h = await relayFixture(t), original = Buffer.concat([Buffer.from([255, 254]), Buffer.from('# 合成原件\r\n', 'utf16le')]);
  const file = path.join(h.dir, 'original.md'); await fs.writeFile(file, original);
  const { room } = await h.makeRoom(seed([command('synthetic large log\n'.repeat(12000)),
    { id: 'answer', type: 'agentMessage', text: `[原件](${file})` }]));
  const pending = await h.join(room, false);
  pending.send({ type: 'activity-request', activityId: 'a'.repeat(64) });
  await until(() => pending.messages.find(m => m.type === 'not-admitted'));
  const peer = await h.join(room), item = peer.snapshot.items.find(i => i.role === 'activity');
  assert.deepEqual(peer.snapshot.capabilities, ['file-original', 'activity-details']);
  peer.send({ type: 'activity-request', activityId: item.detailId });
  await until(() => peer.messages.find(m => m.payload?.type === 'activity-chunk' && m.payload.index + 1 === m.payload.total));
  const chunks = peer.messages.filter(m => m.payload?.type === 'activity-chunk').map(m => m.payload);
  assert.ok(chunks.length > 1); assert.ok(chunks.every(c => c.mime === 'application/json' && JSON.stringify(c).length < 48 * 1024));
  const received = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c.data, 'base64'))));
  assert.equal(received.text, 'synthetic large log\n'.repeat(12000));
  assert.ok(!JSON.stringify(received).includes('private-'));
  const fileId = peer.snapshot.items.find(i => i.role === 'assistant').files[0].id;
  peer.send({ type: 'file-request', fileId, representation: 'original' });
  await until(() => peer.messages.find(m => m.payload?.type === 'file-chunk' && m.payload.index + 1 === m.payload.total));
  const fileChunks = peer.messages.filter(m => m.payload?.type === 'file-chunk').map(m => m.payload);
  assert.ok(fileChunks.every(c => c.representation === 'original' && c.mime === 'application/octet-stream'));
  const downloaded = Buffer.concat(fileChunks.map(c => Buffer.from(c.data, 'base64')));
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), createHash('sha256').update(original).digest('hex'));
  const { room: otherRoom } = await h.makeRoom(), other = await h.join(otherRoom);
  other.send({ type: 'activity-request', activityId: item.detailId });
  await until(() => other.messages.find(m => m.payload?.type === 'activity-unavailable' && m.payload.activityId === item.detailId));
  assert.equal(other.messages.some(m => m.payload?.type === 'activity-chunk'), false);
  other.send({ type: 'file-request', fileId, representation: 'original' });
  await until(() => other.messages.find(m => m.payload?.type === 'file-unavailable' && m.payload.fileId === fileId));
  assert.equal(other.messages.some(m => m.payload?.type === 'file-chunk'), false);
});

test('relay rejects unknown activity/file capabilities, extra fields and unsupported representations before host dispatch', async t => {
  const h = await relayFixture(t), { room } = await h.makeRoom();
  for (const request of [
    { type: 'activity-request', activityId: 'a'.repeat(64), path: '/synthetic/private' },
    { type: 'activity-request', activityId: 'a'.repeat(64), method: 'command/exec' },
    { type: 'activity-request', activityId: 'a'.repeat(64), threadId: 'another-thread' },
    { type: 'activity-request', activityId: '../private' },
    { type: 'file-request', fileId: 'a'.repeat(64), representation: 'preview' },
    { type: 'file-request', fileId: 'a'.repeat(64), representation: null },
    { type: 'file-request', fileId: 'a'.repeat(64), representation: 'original', path: '/synthetic/private' },
  ]) {
    const peer = await h.join(room); peer.send(request);
    await until(() => peer.messages.find(m => m.type === 'invalid-message'));
    assert.equal(peer.messages.some(m => /^(?:file|activity)-(?:chunk|unavailable)$/.test(m.payload?.type ?? '')), false);
  }
});

test('revoking admission while an activity read completes suppresses all detail chunks', async t => {
  const h = await relayFixture(t), { room } = await h.makeRoom(), peer = await h.join(room);
  const id = peer.snapshot.items.find(i => i.role === 'activity').detailId, read = room.thread.readActivity.bind(room.thread);
  let readFinished = false;
  room.thread.readActivity = async activityId => {
    const result = await read(activityId); room.removeGuest(peer.guestId); readFinished = true; return result;
  };
  peer.send({ type: 'activity-request', activityId: id });
  await until(() => readFinished); await until(() => peer.messages.find(m => m.type === 'revoked'));
  assert.equal(peer.messages.some(m => m.payload?.type === 'activity-chunk'), false);
  assert.equal(room.imageTransfers.size, 0);
});
