import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { createManagerSettings, openManagerSettings } from '../lib/manager-settings.mjs';

const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Synthetic sharing capacity scenario timed out');
};
const ownerDir = new URL('../owner', import.meta.url).pathname;
class Rpc extends EventEmitter {
  async request(method, params) {
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'Capacity tests must never submit Agent input');
    return { thread: { id: params.threadId, name: 'Synthetic thread', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function manager(t, owner) {
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => ws.terminate()); const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes))); await once(ws, 'open');
  const send = m => ws.send(JSON.stringify(m));
  send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => messages.some(m => m.type === 'state'));
  const request = async m => {
    const offset = messages.length; send(m);
    await until(() => messages.slice(offset).some(r => r.type === 'error' || r.type === 'settings-result' || r.type === 'share-result'));
    return messages.slice(offset).find(r => r.type === 'error' || r.type === 'settings-result' || r.type === 'share-result');
  };
  return { ws, send, messages, request };
}

test('manager settings persist custom and unlimited limits and reject invalid or unsafe files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-settings-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manager-settings.json'), settings = await openManagerSettings(file);
  assert.deepEqual(settings.get(), { shareLimit: 10 });
  for (const invalid of [0, -1, 1.5, '10', undefined, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(settings.setShareLimit(invalid), /正整数/);
  }
  assert.deepEqual(settings.get(), { shareLimit: 10 });
  await Promise.all([settings.setShareLimit(25), settings.setShareLimit(null)]);
  assert.deepEqual((await openManagerSettings(file)).get(), { shareLimit: null });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await settings.setShareLimit(1);
  assert.deepEqual((await openManagerSettings(file)).get(), { shareLimit: 1 });
  const link = path.join(dir, 'link.json'); await fs.symlink(file, link);
  await assert.rejects(openManagerSettings(link));
  await fs.chmod(file, 0o644); await assert.rejects(openManagerSettings(file), /私有/);
  await fs.chmod(file, 0o600); await fs.writeFile(file, '{"version":1,"shareLimit":0}');
  await assert.rejects(openManagerSettings(file), /不兼容/);
  let fail = true;
  const failing = createManagerSettings({ persist: async () => { if (fail) throw new Error('Synthetic disk failure'); } });
  await assert.rejects(failing.setShareLimit(null), /disk failure/);
  assert.deepEqual(failing.get(), { shareLimit: 10 });
  fail = false; await failing.setShareLimit(12); assert.deepEqual(failing.get(), { shareLimit: 12 });
});

test('default allows ten shares; custom and unlimited apply across managers and existing rooms stay active', async t => {
  const registrationSecret = secret(), relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  const owner = await startOwner({ ownerDir, relayUrl: relay.url, registrationSecret, rpcFactory: async () => new Rpc() });
  t.after(() => owner.close()); const local = await manager(t, owner), other = await manager(t, owner);
  assert.equal(local.messages[0].settings.shareLimit, 10);
  for (let i = 0; i < 10; i++) assert.equal((await local.request({ type: 'share', threadId: `synthetic-${i}` })).type, 'share-result');
  const blocked = await local.request({ type: 'share', threadId: 'eleventh' });
  assert.equal(blocked.code, 'SHARE_LIMIT_REACHED'); assert.deepEqual(blocked.values, { limit: 10 });
  assert.equal(owner.rooms.size, 10);
  await local.request({ type: 'set-share-limit', shareLimit: 11 });
  await until(() => other.messages.some(m => m.settings?.shareLimit === 11));
  assert.equal((await other.request({ type: 'share', threadId: 'eleventh' })).type, 'share-result');
  await local.request({ type: 'set-share-limit', shareLimit: 1 });
  assert.ok([...owner.rooms.values()].every(r => !r.closed));
  assert.equal((await local.request({ type: 'share', threadId: 'twelfth' })).code, 'SHARE_LIMIT_REACHED');
  for (const invalid of [0, -2, 1.1, 'unlimited', false]) {
    assert.equal((await local.request({ type: 'set-share-limit', shareLimit: invalid })).type, 'error');
  }
  assert.equal((await local.request({ type: 'set-share-limit', shareLimit: null })).type, 'settings-result');
  assert.equal((await local.request({ type: 'share', threadId: 'twelfth' })).type, 'share-result');
  const unauthenticated = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => unauthenticated.terminate()); await once(unauthenticated, 'open');
  const closed = once(unauthenticated, 'close'); unauthenticated.send(JSON.stringify({ type: 'set-share-limit', shareLimit: 1 }));
  assert.equal((await closed)[0], 1008);
  assert.equal((await local.request({ type: 'share', threadId: 'thirteenth' })).type, 'share-result');
  const first = [...owner.rooms.values()][0]; first.close();
  await local.request({ type: 'set-share-limit', shareLimit: 13 });
  assert.equal((await local.request({ type: 'share', threadId: 'replacement' })).type, 'share-result');
});

test('pending shares reserve one slot each, also while a room is starting, and release it after failure', async t => {
  const selections = new Map(), releaseRpc = new Map(), managerSettings = createManagerSettings({ shareLimit: 2 });
  const owner = await startOwner({ ownerDir, registrationSecret: secret(), managerSettings, relayUrl: 'http://127.0.0.1:1',
    selectThread: id => new Promise(resolve => selections.set(id, resolve)),
    rpcFactory: () => new Promise((_resolve, reject) => releaseRpc.set(releaseRpc.size, () => reject(new Error('Synthetic start failure')))) });
  t.after(() => owner.close()); const local = await manager(t, owner);
  local.send({ type: 'share', threadId: 'one' }); await until(() => selections.has('one'));
  selections.get('one')(); await until(() => owner.rooms.size === 1 && releaseRpc.size === 1);
  local.send({ type: 'share', threadId: 'two' }); await until(() => selections.has('two'));
  const blocked = await local.request({ type: 'share', threadId: 'three' }); assert.equal(blocked.code, 'SHARE_LIMIT_REACHED');
  releaseRpc.get(0)(); await until(() => local.messages.some(m => m.message?.includes('共享失败')));
  local.send({ type: 'share', threadId: 'three' }); await until(() => selections.has('three'));
  owner.revokeAll(); selections.get('two')(); selections.get('three')();
  await until(() => local.messages.filter(m => m.message?.includes('取消')).length === 2);
});
