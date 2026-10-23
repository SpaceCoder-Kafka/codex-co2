import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { SharedRoom, startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';

const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); } throw new Error('Synthetic LAN manager timeout'); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const network = (overrides = {}) => ({ intranetOnly: false, lanAddress: null, interfaces: [{ name: 'en0', address: '192.168.40.2' }], configurable: true, ...overrides });
async function manager(t, owner, authenticate = true) {
  const ws = new WebSocket(owner.baseUrl.replace('http:', 'ws:') + '/owner', { origin: owner.baseUrl });
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes))); ws.on('error', () => {});
  t.after(() => ws.terminate()); await once(ws, 'open');
  const send = value => ws.send(JSON.stringify(value));
  if (authenticate) {
    send({ type: 'auth', token: new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner') });
    await until(() => messages.some(message => message.type === 'state'));
  }
  return { ws, messages, send };
}
async function ownerFixture(t, overrides = {}) {
  const owner = await startOwner({ ownerDir: new URL('../owner', import.meta.url).pathname, registrationSecret: secret(), getNetwork: () => network(), ...overrides });
  t.after(() => owner.close()); return owner;
}

test('LAN invitation origin is separate from protected loopback host transport and never permits a generic HTTP downgrade', () => {
  const options = { relayUrl: 'http://127.0.0.1:8787', registrationSecret: secret(), threadId: 'synthetic', inviteOrigin: 'http://192.168.40.2:8788', intranetOnly: true };
  const room = new SharedRoom(options);
  assert.equal(room.relayUrl, 'http://127.0.0.1:8787');
  assert.match(room.view().inviteUrl, /^http:\/\/192\.168\.40\.2:8788\/#room=/);
  for (const change of [{ intranetOnly: false }, { inviteOrigin: 'http://8.8.8.8:8788' }, { inviteOrigin: 'http://internal.example:8788' },
    { inviteOrigin: 'http://192.168.40.2:8788/private' }, { inviteOrigin: 'https://192.168.40.2:8788' }, { relayUrl: 'http://192.168.40.2:8787' },
    { relayUrl: 'https://synthetic.example' }]) assert.throws(() => new SharedRoom({ ...options, ...change }));
});

test('network settings require local owner authentication and exact capability fields', async t => {
  let calls = 0;
  const owner = await ownerFixture(t, { setNetwork: async () => { calls++; } });
  const unauthenticated = await manager(t, owner, false);
  const closed = once(unauthenticated.ws, 'close'); unauthenticated.send({ type: 'set-network-mode', intranetOnly: true });
  await closed; assert.equal(calls, 0);
  const local = await manager(t, owner);
  for (const input of [{ intranetOnly: 'true' }, { intranetOnly: true, lanAddress: '8.8.8.8' },
    { intranetOnly: true, relayUrl: 'http://192.168.40.2:8787' }, { intranetOnly: true, ownerToken: secret() }]) {
    const before = local.messages.filter(message => message.type === 'error').length;
    local.send({ type: 'set-network-mode', ...input });
    await until(() => local.messages.filter(message => message.type === 'error').length > before);
  }
  assert.equal(calls, 0);
});

test('a network switch holds a shared lock across manager windows and blocks sharing, checks and rebuilds', async t => {
  const saved = deferred(); let current = network(), sets = 0, relayStarts = 0, checks = 0, rebuilds = 0;
  const owner = await ownerFixture(t, { getNetwork: () => current,
    setNetwork: async value => { sets++; await saved.promise; current = network(value); },
    ensureRelay: async () => { relayStarts++; throw new Error('Must not start while changing'); },
    checkConnection: async () => { checks++; }, rebuildRelay: async () => { rebuilds++; } });
  const first = await manager(t, owner), second = await manager(t, owner);
  first.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.40.2' });
  await until(() => sets === 1 && second.messages.some(message => message.type === 'state' && message.networkBusy));
  for (const request of [{ type: 'share', threadId: 'synthetic' }, { type: 'reshare', threadId: 'synthetic' },
    { type: 'check-connection' }, { type: 'rebuild-relay' }, { type: 'set-network-mode', intranetOnly: false }]) second.send(request);
  await until(() => second.messages.filter(message => message.type === 'error').length === 5);
  assert.equal(relayStarts, 0); assert.equal(checks, 0); assert.equal(rebuilds, 0); assert.equal(sets, 1);
  saved.resolve(); await until(() => first.messages.some(message => message.type === 'network-result'));
  assert.ok(second.messages.some(message => message.type === 'state' && !message.networkBusy && message.network.intranetOnly));
});

test('pending shares and active rooms prevent mode changes, including from another manager', async t => {
  const pending = deferred(); let sets = 0, starts = 0;
  const owner = await ownerFixture(t, { setNetwork: async () => { sets++; }, ensureRelay: async () => { starts++; return pending.promise; } });
  const first = await manager(t, owner), second = await manager(t, owner);
  first.send({ type: 'share', threadId: 'synthetic' }); await until(() => starts === 1);
  second.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.40.2' });
  await until(() => second.messages.some(message => message.type === 'error' && message.operation === 'set-network-mode'));
  assert.equal(sets, 0); assert.ok(second.messages.some(message => message.networkBusy));
  owner.revokeAll(); pending.resolve('http://127.0.0.1:1');
  await until(() => first.messages.some(message => message.type === 'error'));
  owner.rooms.set('active', { closed: false, view: () => ({ state: 'online', roomId: 'active', guests: [], proposals: [] }), close() { this.closed = true; } });
  const errors = second.messages.filter(message => message.type === 'error').length;
  second.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.40.2' });
  await until(() => second.messages.filter(message => message.type === 'error').length > errors);
  assert.equal(sets, 0);
});

test('failed network changes release the lock and never send a success result', async t => {
  let sets = 0;
  const owner = await ownerFixture(t, { setNetwork: async () => { sets++; throw new Error('Synthetic selection unavailable'); } });
  const local = await manager(t, owner);
  local.send({ type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.40.2' });
  await until(() => local.messages.some(message => message.type === 'error'));
  assert.equal(sets, 1); assert.equal(local.messages.some(message => message.type === 'network-result'), false);
  assert.equal(local.messages.filter(message => message.type === 'state').at(-1).networkBusy, false);
});

test('new LAN rooms use the trusted local invitation descriptor, ignoring caller capability injection', async t => {
  const registrationSecret = secret();
  let serverCount = 0;
  const relay = await startRelay({ registrationSecret, lanAddress: '192.168.40.2', createHttpServer(handler) {
    const server = http.createServer(handler);
    if (serverCount++ === 1) {
      const listen = server.listen;
      server.listen = function(port, host, callback) { return listen.call(this, port, '127.0.0.1', callback); };
    }
    return server;
  } }); t.after(() => relay.close());
  class Rpc extends EventEmitter {
    async request(_method, params) { return { thread: { id: params.threadId, name: 'Synthetic LAN', status: { type: 'idle' }, turns: [] } }; }
    close() {}
  }
  const owner = await ownerFixture(t, { registrationSecret, relayUrl: relay.url, rpcFactory: async () => new Rpc(),
    getNetwork: () => network({ intranetOnly: true, lanAddress: '192.168.40.2' }), getInviteOrigin: () => 'http://192.168.40.2:8788' });
  const local = await manager(t, owner);
  local.send({ type: 'share', threadId: 'synthetic', inviteOrigin: 'http://8.8.8.8:80', intranetOnly: false });
  await until(() => local.messages.some(message => message.type === 'share-result'));
  const room = [...owner.rooms.values()][0];
  assert.equal(room.relayUrl, relay.url); assert.equal(room.inviteOrigin, 'http://192.168.40.2:8788');
  assert.match(room.view().inviteUrl, /^http:\/\/192\.168\.40\.2:8788/);
});
