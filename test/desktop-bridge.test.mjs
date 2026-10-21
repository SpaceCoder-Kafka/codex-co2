import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { startDesktopBridge } from '../lib/desktop-bridge.mjs';

async function until(predicate, description, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out: ${description}`);
}

async function fixture(t, { delayUpgrade = 0 } = {}) {
  const root = await fs.mkdtemp('/tmp/coop-bridge-');
  const socketPath = path.join(root, 'rpc.sock');
  const runtimeDir = path.join(root, "isolated runtime's state");
  const codexHome = path.join(root, "separate Codex's home");
  await fs.mkdir(runtimeDir, { mode: 0o700 });
  await fs.mkdir(codexHome, { mode: 0o700 });
  const profile = path.join(runtimeDir, 'desktop-profile');
  await fs.mkdir(profile, { mode: 0o755 });
  await fs.chmod(profile, 0o755);
  const backend = http.createServer((_req, res) => res.writeHead(404).end());
  const backendWs = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const backendConnections = [], received = [], clients = [], sockets = new Set(), timers = new Set();
  backend.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  backend.on('upgrade', (req, socket, head) => {
    const upgrade = () => {
      if (!socket.destroyed) backendWs.handleUpgrade(req, socket, head, ws => backendWs.emit('connection', ws));
    };
    if (delayUpgrade) {
      const timer = setTimeout(() => { timers.delete(timer); upgrade(); }, delayUpgrade);
      timers.add(timer);
    } else upgrade();
  });
  backendWs.on('connection', ws => {
    backendConnections.push(ws);
    ws.on('error', () => {});
    ws.on('message', (bytes, binary) => received.push({ text: bytes.toString(), binary }));
  });
  await new Promise(resolve => backend.listen(socketPath, resolve));
  const appPath = "/Applications/Synthetic Owner's App.app";
  const bridge = await startDesktopBridge({ socketPath, runtimeDir, codexHome, appPath });
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    await bridge.close();
    for (const timer of timers) clearTimeout(timer);
    for (const ws of backendWs.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => backendWs.close(resolve));
    await new Promise(resolve => backend.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function connect(url = bridge.url, options = {}) {
    const ws = new WebSocket(url, { handshakeTimeout: 1000, perMessageDeflate: false, ...options });
    const peer = { ws, messages: [], closed: false };
    clients.push(peer);
    ws.on('error', () => {});
    ws.on('close', () => { peer.closed = true; });
    ws.on('message', (bytes, binary) => peer.messages.push({ text: bytes.toString(), binary }));
    await once(ws, 'open');
    return peer;
  }
  return { ...bridge, root, runtimeDir, codexHome, profile, appPath, connect, backendConnections, received };
}

test('privileged bridge binds loopback and rejects browser Origins, wrong Host, and any different capability path', async t => {
  const bridge = await fixture(t);
  const parsed = new URL(bridge.url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.match(parsed.pathname, /^\/desktop\/[A-Za-z0-9_-]{43}$/);
  for (const origin of [`http://${parsed.host}`, 'https://attacker.example', 'null']) {
    await assert.rejects(bridge.connect(bridge.url, { origin }));
  }
  for (const host of [`localhost:${parsed.port}`, 'attacker.example', '127.0.0.1:1']) {
    await assert.rejects(bridge.connect(bridge.url, { headers: { Host: host } }));
  }
  for (const suffix of ['/desktop/wrong', '/', `${parsed.pathname}?copy=1`, `${parsed.pathname}/`]) {
    await assert.rejects(bridge.connect(`${parsed.origin}${suffix}`));
  }
  assert.equal(bridge.backendConnections.length, 0, 'rejected requests never reach the Unix backend');
  const page = await fetch(bridge.url.replace(/^ws:/, 'http:'));
  assert.equal(page.status, 404);
  assert.equal(await page.text(), '');
});

test('capability path forwards ordered RPC text frames in both directions, including pre-handshake input', async t => {
  const bridge = await fixture(t, { delayUpgrade: 100 });
  const client = await bridge.connect();
  const requests = [
    JSON.stringify({ id: 7, method: 'initialize', params: { clientInfo: { name: 'synthetic' } } }),
    JSON.stringify({ method: 'initialized', params: {} }),
    JSON.stringify({ id: 8, method: 'thread/read', params: { threadId: 'synthetic-only' } }),
  ];
  requests.forEach(message => client.ws.send(message));
  await until(() => bridge.received.length === requests.length, 'buffered frames forwarded');
  assert.deepEqual(bridge.received, requests.map(text => ({ text, binary: false })));
  assert.equal(bridge.backendConnections.length, 1);
  const messages = [
    JSON.stringify({ id: 8, result: { thread: { id: 'synthetic-only' } } }),
    JSON.stringify({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'synthetic-only' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'synthetic-only', delta: '合成回复 😀' } }),
  ];
  messages.forEach(message => bridge.backendConnections[0].send(message));
  await until(() => client.messages.length === messages.length, 'server frames forwarded');
  assert.deepEqual(client.messages, messages.map(text => ({ text, binary: false })));
  assert.equal(bridge.received.length, requests.length, 'transport never answers approval requests or injects initialization');
});

test('launcher isolates CODEX_HOME and Electron profile, safely quotes paths, and is owner-only', async t => {
  const bridge = await fixture(t);
  const launcher = await fs.readFile(bridge.launcher, 'utf8');
  assert.equal((await fs.stat(bridge.launcher)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(bridge.profile)).mode & 0o777, 0o700, 'an existing permissive profile is tightened');
  // Parse its shell arguments using a harmless printf stand-in, never execute open/Desktop.
  const harmless = launcher.replace('exec /usr/bin/open ', "printf '%s\\0' ");
  const child = spawn('/bin/sh', ['-c', harmless], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', data => chunks.push(data));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const args = Buffer.concat(chunks).toString().split('\0').slice(0, -1);
  assert.deepEqual(args, [
    '-n', '--env', `CODEX_HOME=${bridge.codexHome}`, '--env', `CODEX_ELECTRON_USER_DATA_PATH=${bridge.profile}`,
    '--env', `CODEX_APP_SERVER_WS_URL=${bridge.url}`, bridge.appPath, '--args', `--user-data-dir=${bridge.profile}`,
  ]);
  assert.deepEqual(await fs.readdir(bridge.codexHome), [], 'writing the launcher does not touch credentials or conversations');
});

test('client disconnect closes only its upstream; bridge close tears down peers/listener and is idempotent', async t => {
  const bridge = await fixture(t);
  const first = await bridge.connect();
  await until(() => bridge.backendConnections.length === 1, 'first upstream');
  first.ws.close();
  await until(() => bridge.backendConnections[0].readyState === WebSocket.CLOSED, 'upstream after client disconnect');
  const second = await bridge.connect();
  await until(() => bridge.backendConnections.length === 2, 'second upstream');
  await Promise.all([bridge.close(), bridge.close()]);
  await until(() => second.closed && bridge.backendConnections[1].readyState === WebSocket.CLOSED, 'close reaches both peers');
  await assert.rejects(bridge.connect(), /ECONNREFUSED|socket hang up/);
  await bridge.close();
});

test('upstream disconnect terminates the paired client', async t => {
  const bridge = await fixture(t);
  const client = await bridge.connect();
  await until(() => bridge.backendConnections.length === 1, 'upstream connection');
  bridge.backendConnections[0].terminate();
  await until(() => client.closed, 'paired downstream terminated');
});

test('launcher write failure rejects and leaves no unowned listening server', { timeout: 6000 }, async t => {
  const root = await fs.mkdtemp('/tmp/coop-bridge-fail-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // EISDIR occurs after listen; use a subprocess so an accidental leaked listener
  // produces a bounded test failure instead of keeping the complete suite alive.
  await fs.mkdir(path.join(root, 'Open-Test-Desktop.command'));
  const code = `import {startDesktopBridge} from ${JSON.stringify(new URL('../lib/desktop-bridge.mjs', import.meta.url).href)};
try { await startDesktopBridge({socketPath:${JSON.stringify(path.join(root, 'unused.sock'))},codexHome:${JSON.stringify(path.join(root, 'home'))},runtimeDir:${JSON.stringify(root)}}); process.exitCode=3; }
catch(error) { process.exitCode=error.code==='EISDIR'?0:4; }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2500);
  const [exitCode] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(timedOut, false, 'failed startup must not leave a listening server keeping the process alive');
  assert.equal(exitCode, 0);
});

test('bridge close retires its own launcher but preserves a newer replacement', async t => {
  const bridge = await fixture(t);
  await fs.writeFile(bridge.launcher, 'newer launcher');
  await bridge.close();
  assert.equal(await fs.readFile(bridge.launcher, 'utf8'), 'newer launcher');
  const second = await fixture(t);
  await second.close();
  await assert.rejects(fs.stat(second.launcher), { code: 'ENOENT' });
});
