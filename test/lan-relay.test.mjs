import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startRelay } from '../lib/relay.mjs';

const secret = () => randomBytes(32).toString('base64url');
const lanAddress = '192.168.20.10';
const status = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers, agent: false }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
});

// All real sockets stay on loopback. Synthetic socket metadata exercises the
// production LAN guard without discovering or exposing the operator's network.
async function fixture(t, options = {}) {
  let count = 0;
  const network = { peer: '192.168.20.11', local: lanAddress };
  const registrationSecret = secret();
  const relay = await startRelay({ lanAddress, registrationSecret, ...options,
    publicDir: new URL('../public', import.meta.url).pathname,
    createHttpServer(handler) {
      const server = http.createServer(handler);
      if (count++ === 1) {
        const nativeListen = server.listen;
        server.listen = function (port, host, callback) {
          assert.equal(host, lanAddress);
          return nativeListen.call(this, port, '127.0.0.1', callback);
        };
        const syntheticPeer = req => {
          Object.defineProperties(req.socket, {
            localAddress: { configurable: true, value: network.local },
            remoteAddress: { configurable: true, value: network.peer },
          });
        };
        server.prependListener('request', syntheticPeer);
        server.prependListener('upgrade', syntheticPeer);
      }
      return server;
    },
  });
  t.after(() => relay.close());
  const url = `http://127.0.0.1:${relay.lanServer.address().port}`;
  const headers = { Host: new URL(relay.inviteOrigin).host };
  return { relay, registrationSecret, network, url, headers };
}

async function connection(url, options) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'), options);
  const messages = [], waiting = new Set();
  ws.on('error', () => {});
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); for (const check of [...waiting]) check(); });
  await once(ws, 'open');
  return {
    ws,
    send: value => ws.send(JSON.stringify(value)),
    next(type) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`No ${type}`)); }, 2000);
        function check() {
          const index = messages.findIndex(message => message.type === type);
          if (index < 0) return;
          clearTimeout(timer); waiting.delete(check); resolve(messages.splice(index, 1)[0]);
        }
        waiting.add(check); check();
      });
    },
  };
}

test('LAN guest listener enforces actual private peer, exact Host and local address before serving anything', async t => {
  const f = await fixture(t);
  assert.match(f.relay.url, /^http:\/\/127\.0\.0\.1:/);
  assert.match(f.relay.inviteOrigin, /^http:\/\/192\.168\.20\.10:/);
  assert.equal(await status(f.url, f.headers), 200);
  assert.equal(await status(f.url + '/health', f.headers), 200);
  assert.equal(await status(f.url, { ...f.headers, Host: 'attacker.example' }), 403);
  assert.equal(await status(f.url, { ...f.headers, 'X-Forwarded-For': '192.168.20.12' }), 403);
  f.network.peer = '198.51.100.20';
  assert.equal(await status(f.url, f.headers), 403);
  f.network.peer = '10.10.20.30'; // Routed private company subnet is allowed.
  assert.equal(await status(f.url, f.headers), 200);
  f.network.local = '192.168.20.99';
  assert.equal(await status(f.url, f.headers), 403);
  assert.equal(await status(f.relay.url), 403, 'LAN mode does not serve guest assets on the host listener');
  assert.equal(await status(f.relay.url + '/health'), 200);
  assert.throws(() => f.relay.setAllowedOrigins(['https://attacker.example']), /fixed/);
});

test('the verified Bonjour hostname and raw IP require their own matching browser origin', async t => {
  const hostname = 'co2-test.local', f = await fixture(t, { lanHostname: hostname });
  const port = new URL(f.url).port;
  assert.equal(f.relay.guestOrigin, `http://${hostname}:${port}`);
  const aliasOrigin = f.relay.guestOrigin, alias = { Host: `${hostname}:${port}` };
  f.relay.setAllowedOrigins([f.relay.inviteOrigin]);
  assert.equal(await status(f.url + '/health', alias), 200);
  assert.equal(await status(f.url + '/health', { Host: `another.local:${port}` }), 403);
  assert.equal(await status(f.relay.url + '/health', alias), 403);
  await assert.rejects(connection(f.url + '/host', { headers: alias }), /403/);
  await assert.rejects(connection(f.url + '/guest', { headers: alias, origin: f.relay.inviteOrigin }), /403/);
  await assert.rejects(connection(f.url + '/guest', { headers: f.headers, origin: aliasOrigin }), /403/);
  await assert.rejects(connection(f.url + '/guest', { headers: alias, origin: `http://another.local:${port}` }), /403/);
  await assert.rejects(connection(f.url + '/guest', { headers: alias }), /403/);
  for (const name of ['another.example', 'x.co2-test.local', '*.local', 'co2-test.local:80', '192.168.20.10']) {
    assert.throws(() => f.relay.setLanHostname(name), /hostname/);
  }
  f.network.peer = '127.0.0.1'; assert.equal(await status(f.url, alias), 403);
  f.network.peer = '10.0.0.2'; f.network.local = '192.168.30.10'; assert.equal(await status(f.url, alias), 403);
  f.network.local = lanAddress;
  f.relay.setLanHostname(null);
  assert.equal(f.relay.guestOrigin, f.relay.inviteOrigin);
  assert.equal(await status(f.url, alias), 403); assert.equal(await status(f.url, f.headers), 200);
  f.relay.setLanHostname(hostname);
  const guest = await connection(f.url + '/guest', { headers: alias, origin: aliasOrigin });
  guest.ws.close();
});

test('only the current address-specific landing name can check the stable visitor endpoint', async t => {
  const hostname = 'co2-test.local', entry = 'v4-c0a8140a.' + hostname;
  const f = await fixture(t, { lanHostname: hostname });
  const port = f.relay.lanServer.address().port;
  f.relay.setLanHostname(hostname, entry);
  const origin = 'http://' + entry + ':' + port;
  const entryHost = { Host: entry + ':' + port };
  const canonical = { Host: hostname + ':' + port };
  assert.equal(f.relay.entryOrigin, origin);
  assert.equal(await status(f.url + '/', entryHost), 200);
  assert.equal(await status(f.url + '/entry.js', entryHost), 200);
  assert.equal(await status(f.url + '/guest.js', entryHost), 404);
  assert.equal(await status(f.url + '/lan-entry-check', { ...canonical, Origin: origin }), 204);
  assert.equal(await status(f.url + '/lan-entry-check', { ...canonical, Origin: 'http://somewhere.local:' + port }), 403);
  assert.equal(await status(f.url + '/lan-entry-check', { ...f.headers, Origin: origin }), 404);
  assert.equal(await status(f.url + '/', { ...entryHost, Via: 'proxy' }), 403);
  assert.equal(await status(f.url + '/', { Host: 'v4-c0a8140b.' + hostname + ':' + port }), 403);
  assert.throws(() => f.relay.setLanHostname(hostname, 'v4-c0a8140b.' + hostname), /entry hostname/);
  for (const endpoint of ['/guest', '/recovery', '/host']) {
    await assert.rejects(connection(f.url + endpoint, { headers: entryHost, origin }), /403/);
  }
  f.relay.setLanHostname(null);
  assert.equal(await status(f.url + '/', entryHost), 403);
});

test('LAN recovery uses the numeric checkpoint on both origins and returns approved links on the guest’s own origin', async t => {
  const recovery = new EventEmitter(), requestId = randomUUID(), receiptToken = secret();
  const restarts = [];
  const f = await fixture(t, { lanHostname: 'co2-test.local', recovery, resumeLanRoom: (_proof, origin) => { restarts.push(origin); return false; } });
  const physical = f.relay.inviteOrigin, alias = f.relay.guestOrigin;
  const fragment = '/#room=' + randomUUID() + '&invite=' + secret() + '&scope=' + randomUUID();
  let outcome = { type: 'recovery-request', requestId, status: 'pending' };
  recovery.getRestartAuthorization = (_proof, origin) => { assert.equal(origin, physical); return true; };
  const reopened = await connection(f.url + '/guest', { headers: { Host: new URL(alias).host }, origin: alias });
  reopened.send({ type: 'join', roomId: randomUUID(), inviteToken: secret(), name: 'Synthetic guest' });
  await reopened.next('join-rejected');
  assert.deepEqual(restarts, [physical]);
  recovery.watch = (_message, origin) => { assert.equal(origin, physical); return outcome; };
  recovery.watcher = (_message, origin) => { assert.equal(origin, physical); return () => outcome; };
  const visitor = await connection(f.url + '/recovery', { headers: { Host: new URL(alias).host }, origin: alias });
  visitor.send({ type: 'watch', requestId, receiptToken });
  assert.equal((await visitor.next('recovery-request')).status, 'pending');
  const direct = await connection(f.url + '/recovery', { headers: f.headers, origin: physical });
  direct.send({ type: 'watch', requestId, receiptToken }); await direct.next('recovery-request');
  f.relay.setLanHostname(null); // DNS change does not disconnect either authenticated, already-open socket.
  outcome = { ...outcome, status: 'approved', inviteUrl: physical + fragment }; recovery.emit('change');
  assert.equal((await visitor.next('recovery-request')).inviteUrl, alias + fragment);
  assert.equal((await direct.next('recovery-request')).inviteUrl, physical + fragment);
  visitor.send({ type: 'watch', requestId, receiptToken });
  assert.equal((await visitor.next('recovery-request')).inviteUrl, alias + fragment);
  outcome = { ...outcome, inviteUrl: 'http://another.local:8787' + fragment };
  visitor.send({ type: 'watch', requestId, receiptToken });
  await visitor.next('recovery-unavailable');
});

test('LAN invitation preserves explicit admission, scoped messages and revocation while /host stays loopback', async t => {
  const f = await fixture(t);
  const guestOptions = { headers: f.headers, origin: f.relay.inviteOrigin };
  await assert.rejects(connection(f.url + '/host', { headers: f.headers }), /403/);
  await assert.rejects(connection(f.url + '/guest', { headers: f.headers, origin: 'https://attacker.example' }), /403/);
  await assert.rejects(connection(f.relay.url + '/guest', { origin: f.relay.inviteOrigin }), /403/);
  const host = await connection(f.relay.url + '/host');
  const credentials = { type: 'register', registrationSecret: f.registrationSecret, roomId: randomUUID(),
    hostToken: secret(), inviteToken: secret(), expiresAt: Date.now() + 60000, inviteExpiresAt: Date.now() + 3600000 };
  host.send(credentials); await host.next('registered');
  const guest = await connection(f.url + '/guest', guestOptions);
  guest.send({ type: 'join', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: 'Synthetic guest' });
  const { guestId } = await guest.next('pending'); await host.next('join-request');
  host.send({ type: 'deliver', payload: { synthetic: 'not-yet-admitted' } });
  host.send({ type: 'admit', guestId }); await guest.next('admitted');
  host.send({ type: 'deliver', payload: { synthetic: 'after-admission' } });
  assert.equal((await guest.next('data')).payload.synthetic, 'after-admission');
  guest.send({ type: 'proposal', requestId: randomUUID(), text: 'Synthetic LAN input' });
  assert.equal((await host.next('guest-message')).payload.text, 'Synthetic LAN input');
  host.send({ type: 'revoke' }); await guest.next('revoked');
  f.network.peer = '203.0.113.20';
  await assert.rejects(connection(f.url + '/guest', guestOptions), /403/);
});

test('LAN listener startup failure closes the already-open host listener without leaving partial access', async () => {
  const servers = [];
  await assert.rejects(startRelay({ lanAddress, registrationSecret: secret(), createHttpServer(handler) {
    const server = http.createServer(handler); servers.push(server);
    if (servers.length === 2) server.listen = function () { queueMicrotask(() => this.emit('error', new Error('Synthetic bind failure'))); return this; };
    return server;
  } }), /Synthetic bind failure/);
  assert.equal(servers[0].listening, false);
  for (const invalid of ['0.0.0.0', '127.0.0.1', '198.51.100.1', 'localhost', '::']) {
    await assert.rejects(startRelay({ lanAddress: invalid, registrationSecret: secret() }), /LAN relay/);
  }
});
