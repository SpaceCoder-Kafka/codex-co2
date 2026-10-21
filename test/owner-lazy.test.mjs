import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { startOwner, secret } from '../lib/host.mjs';
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await delay(10); } throw new Error('owner timeout'); };

test('language resources are fixed local assets and never initialize a backend or public access', async t => {
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: secret(),
    rpcFactory: () => { throw new Error('Static assets must not connect to a backend'); },
    ensureRelay: () => { throw new Error('Static assets must not initialize public access'); } });
  t.after(() => owner.close());
  for (const route of ['/i18n.js', '/locales.json']) {
    const response = await fetch(owner.baseUrl + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
    const source = await response.text();
    assert.ok(!source.includes(new URL(owner.url).hash));
  }
  for (const route of ['/locales.json/extra', '/i18n.js?path=auth.json', '/owner/locales.json']) {
    assert.equal((await fetch(owner.baseUrl + route)).status, 404);
  }
  assert.equal(owner.rooms.size, 0);
});

test('invalid requests never start a tunnel; revoke-all cancels pending shares; a retry cannot duplicate a pending thread', async t => {
  let finish, starts = 0, rpcCalls = 0;
  const owner = await startOwner({ socketPath: 'synthetic', ownerDir: new URL('../owner', import.meta.url).pathname,
    registrationSecret: secret(), ensureRelay: () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    rpcFactory: async () => { rpcCalls++; throw new Error('Must not create a room after revoke'); } });
  t.after(() => owner.close());
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => ws.terminate()); const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  await once(ws, 'open');
  const send = message => ws.send(JSON.stringify(message));
  send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => messages.some(m => m.type === 'state'));
  send({ type: 'share', threadId: 'synthetic', ownerName: '' });
  await until(() => messages.some(m => m.type === 'error')); assert.equal(starts, 0);
  send({ type: 'share', threadId: 'synthetic', ownerName: 'A' });
  await until(() => starts === 1);
  send({ type: 'share', threadId: 'synthetic', ownerName: 'A' });
  await delay(20); assert.equal(starts, 1);
  owner.revokeAll(); finish('https://synthetic.example');
  await until(() => messages.some(m => m.message?.includes('取消')));
  assert.equal(owner.rooms.size, 0); assert.equal(rpcCalls, 0);
});

test('attached selection lookup cannot race two invitations for the same daily thread', async t => {
  let lookupResolve, relayResolve, starts = 0;
  const lookup = new Promise(resolve => { lookupResolve = resolve; });
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: secret(), attached: true,
    listThreads: () => lookup, ensureRelay: () => { starts++; return new Promise(resolve => { relayResolve = resolve; }); } });
  t.after(() => owner.close());
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => ws.terminate()); const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') }));
  await until(() => messages.some(m => m.type === 'state'));
  for (let i = 0; i < 2; i++) ws.send(JSON.stringify({ type: 'share', threadId: 'selected', ownerName: 'A' }));
  await delay(20); lookupResolve([{ id: 'selected' }]);
  await until(() => messages.some(m => m.type === 'error') && starts === 1);
  assert.equal(starts, 1); owner.revokeAll(); relayResolve('https://synthetic.example');
  await until(() => messages.some(m => m.message?.includes('取消')));
  assert.equal(owner.rooms.size, 0);
});

test('catalog selection precedes public resources; revoke while opening a chat prevents invitation creation', async t => {
  let resolveSelection, selections = [], starts = 0;
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: secret(), attached: true,
    listThreads: async () => ({ threads: [{ id: 'selected', name: 'Synthetic' }], nextCursor: null, total: 1 }),
    selectThread: async (id, options) => {
      selections.push({ id, options });
      if (id !== 'selected') throw new Error('Not in catalog');
      await new Promise(resolve => { resolveSelection = resolve; });
    }, ensureRelay: async () => { starts++; throw new Error('Must not start'); } });
  t.after(() => owner.close());
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => ws.terminate()); const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  await once(ws, 'open');
  const send = m => ws.send(JSON.stringify(m));
  send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
  await until(() => messages.some(m => m.type === 'state'));
  send({ type: 'share', threadId: 'foreign', ownerName: 'A' });
  await until(() => messages.some(m => m.message === 'Not in catalog')); assert.equal(starts, 0);
  send({ type: 'share', threadId: 'selected', ownerName: 'A' }); await until(() => resolveSelection);
  owner.revokeAll(); resolveSelection();
  await until(() => messages.some(m => m.message?.includes('取消')));
  assert.equal(starts, 0); assert.equal(owner.rooms.size, 0);
  assert.equal(selections.at(-1).id, 'selected');
  assert.equal(selections.at(-1).options.activate, true);
  assert.equal(selections.at(-1).options.canContinue(), false);
});

test('owner lookup failure preserves its actionable message and structural diagnostic without starting public access', async t => {
  const diagnostics = []; let starts = 0;
  const message = '此会话尚未在 Codex 中加载。';
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: secret(),
    selectThread: async () => { throw Object.assign(new Error(message), { code: 'DESKTOP_NO_OWNER', method: 'thread-owner-discovery', phase: 'routing', elapsedMs: 10020, privateText: 'never-log-this' }); },
    ensureRelay: async () => { starts++; throw new Error('Must not start'); }, onDiagnostic: event => diagnostics.push(event) });
  t.after(() => owner.close());
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  t.after(() => ws.terminate()); const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') }));
  await until(() => messages.some(m => m.type === 'state'));
  ws.send(JSON.stringify({ type: 'share', threadId: 'selected', ownerName: 'A' }));
  await until(() => messages.some(m => m.type === 'error'));
  assert.equal(messages.find(m => m.type === 'error').message, message);
  assert.deepEqual(diagnostics, [{ event: 'desktop-ipc-failure', operation: 'share', code: 'DESKTOP_NO_OWNER', method: 'thread-owner-discovery', phase: 'routing', elapsedMs: 10020 }]);
  assert.equal(starts, 0); assert.equal(owner.rooms.size, 0);
  assert.ok(!JSON.stringify({ messages, diagnostics }).includes('never-log-this'));
});
