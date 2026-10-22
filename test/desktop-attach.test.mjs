import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DesktopIpc, DesktopRpcClient, attachDesktop, applyDesktopPatches, projectDesktopThread } from '../lib/desktop-ipc.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';
import { SharedRoom } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const state = (id = THREAD) => ({ id, hostId: 'local', title: '合成日常会话', requests: [], threadRuntimeStatus: { type: 'idle' },
  privateSecret: 'never-project', cwd: '/private/workspace', turns: [], turnHistory: { kind: 'canonical', history: {
    generation: 1, isComplete: false, islands: [{ entries: [{ value: 'turn:1' }] }], entitiesByKey: { 'turn:1': {
      turnId: TURN, status: 'completed', params: { clientUserMessageId: 'input:1', input: [{ type: 'text', text: 'A 的既有消息' }] },
      items: [{ id: 'assistant:1', type: 'agentMessage', text: '既有回复' }, { id: 'tool:1', type: 'commandExecution', aggregatedOutput: 'never-project' },
        { id: 'reasoning:1', type: 'reasoning', text: 'never-project' }],
    } },
  } } });

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/co2-attach-'); await fs.chmod(dir, 0o700);
  const endpoint = path.join(dir, 'desktop.sock'), owner = randomUUID(), clientIds = new Map(), sockets = new Set(), requests = [];
  let revision = 0, malformed, holdInput = false, noOwner = false, noOwnerCount = 0, discoveryError, discoveryDelayMs = 0, inputDelayMs = 0, inputTimeout = false;
  const encode = message => { const b = Buffer.from(JSON.stringify(message)), h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
  const send = (socket, message) => socket.write(encode(message));
  const broadcast = (socket, id, change, extra = {}) => send(socket, { type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: owner, targetClientIds: [clientIds.get(socket)], params: { hostId: 'local', conversationId: id, change }, ...extra });
  const server = net.createServer(socket => {
    sockets.add(socket); let buffer = Buffer.alloc(0);
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const n = buffer.readUInt32LE(); if (buffer.length < n + 4) return;
        const m = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4);
        requests.push(m);
        const response = result => send(socket, { type: 'response', resultType: 'success', requestId: m.requestId, method: m.method,
          handledByClientId: m.method === 'initialize' ? clientIds.get(socket) : owner, result });
        if (m.method === 'initialize') { clientIds.set(socket, randomUUID()); response({ clientId: clientIds.get(socket) }); }
        else if (m.method === 'thread-owner-discovery') {
          const reply = () => {
            if (socket.destroyed) return;
            // The official router's error reply has no method or handledByClientId.
            if (discoveryError) send(socket, { type: 'response', resultType: 'error', error: discoveryError, requestId: m.requestId });
            else if (noOwner || noOwnerCount-- > 0) send(socket, { type: 'response', resultType: 'error', error: 'no-client-found', requestId: m.requestId });
            else response({ supportsUntrustedAppInput: true });
          };
          if (discoveryDelayMs) setTimeout(reply, discoveryDelayMs); else reply();
        }
        else if (m.method === 'thread-stream-following-changed' && m.params.following) {
          broadcast(socket, m.params.conversationId, { type: 'snapshot', revision: revision++, conversationState: malformed ?? state(m.params.conversationId) });
        } else if (m.method === 'thread-follower-start-turn' && !holdInput) {
          const reply = () => {
            if (socket.destroyed) return;
            if (inputTimeout) send(socket, { type: 'response', resultType: 'error', error: 'request-timeout', requestId: m.requestId });
            else response({ result: { turn: { id: TURN } } });
          };
          if (inputDelayMs) setTimeout(reply, inputDelayMs); else reply();
        }
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); await fs.chmod(endpoint, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return { endpoint, owner, requests, sockets, clientIds, send, broadcast,
    set malformed(value) { malformed = value; }, set holdInput(value) { holdInput = value; },
    set noOwner(value) { noOwner = value; },
    set noOwnerCount(value) { noOwnerCount = value; }, set discoveryError(value) { discoveryError = value; },
    set discoveryDelayMs(value) { discoveryDelayMs = value; }, set inputDelayMs(value) { inputDelayMs = value; }, set inputTimeout(value) { inputTimeout = value; },
    lastSocket: () => [...sockets].at(-1) };
}

test('attaches existing and newly selected threads through IPC without owning the Desktop lifecycle', async t => {
  const f = await fixture(t), runtime = await attachDesktop({ endpoint: f.endpoint });
  await runtime.selectThread(THREAD); await runtime.selectThread(OTHER);
  assert.deepEqual((await runtime.listThreads()).map(x => x.id), [THREAD, OTHER]);
  assert.ok(!JSON.stringify(await runtime.listThreads()).includes('never-project'));
  runtime.close();
  const ipc = await DesktopIpc.connect(f.endpoint); ipc.close(); // server survived helper exit
  assert.ok(f.requests.every(r => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(r.method)));
});

test('router discovery and forwarded response get separate budgets; no-owner is not misreported as a local timeout', async t => {
  const f = await fixture(t); f.noOwner = true; f.discoveryDelayMs = 60;
  const ipc = await DesktopIpc.connect(f.endpoint, { timeoutMs: 30, routingTimeoutMs: 80, responseGraceMs: 20 });
  t.after(() => ipc.close());
  await assert.rejects(ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: THREAD }, 1), error =>
    error.code === 'DESKTOP_NO_OWNER' && error.elapsedMs >= 50 && /可接入运行状态/.test(error.message));
  assert.equal(f.requests.filter(r => r.method === 'thread-owner-discovery').length, 1);
  assert.equal(f.requests.at(-1).timeoutMs, 30, 'Remote execution budget is not inflated');
});

test('submission response can arrive after routing; remote and local timeouts remain uncertain without replay', async t => {
  const f = await fixture(t);
  const rpc = await DesktopRpcClient.connect(f.endpoint, { timeoutMs: 30, routingTimeoutMs: 80, responseGraceMs: 20 });
  t.after(() => rpc.close());
  await rpc.request('thread/read', { threadId: THREAD });
  f.inputDelayMs = 60;
  const input = { threadId: THREAD, input: [{ type: 'text', text: 'synthetic input' }] };
  assert.equal((await rpc.request('turn/start', input)).turn.id, TURN);
  f.inputTimeout = true;
  await assert.rejects(rpc.request('turn/start', input), error => error.code === 'DESKTOP_IPC_TIMEOUT' && error.phase === 'response' && /不要重复发送/.test(error.message));
  f.holdInput = true;
  await assert.rejects(rpc.request('turn/start', input), error => error.code === 'DESKTOP_IPC_TIMEOUT' && error.phase === 'deadline' && error.method === 'thread-follower-start-turn');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 3);
});

test('sharing keeps loaded threads in place and loads a missing owner once through its exact deep link', async t => {
  const f = await fixture(t); let opened = 0;
  const runtime = await attachDesktop({ endpoint: f.endpoint, openThread: async id => { opened++; assert.equal(id, OTHER); } });
  t.after(() => runtime.close());
  await runtime.selectThread(THREAD, { activate: true });
  assert.equal(opened, 0);
  assert.equal(f.requests.filter(r => r.method === 'thread-owner-discovery').length, 1);
  f.noOwnerCount = 2; // native loading has not completed at the first read-only recheck
  await runtime.selectThread(OTHER, { activate: true });
  assert.equal(opened, 1);
  assert.equal(f.requests.filter(r => r.method === 'thread-owner-discovery').length, 4);
  assert.deepEqual((await runtime.listThreads()).map(t => t.id), [THREAD, OTHER]);
  assert.equal(f.requests.some(r => r.method === 'thread-follower-start-turn'), false);
});

test('missing-owner fallback is bounded and never opens on read-only selection or other IPC failures', async t => {
  const f = await fixture(t); let opened = 0;
  const runtime = await attachDesktop({ endpoint: f.endpoint, openThread: async () => { opened++; } });
  t.after(() => runtime.close());
  f.noOwner = true;
  await assert.rejects(runtime.selectThread(THREAD), error => error.code === 'DESKTOP_NO_OWNER');
  assert.equal(opened, 0);
  await assert.rejects(runtime.selectThread(THREAD, { activate: true }), /已在 Codex 打开此会话/);
  assert.equal(opened, 1);
  assert.equal(f.requests.filter(r => r.method === 'thread-owner-discovery').length, 4);
  f.noOwner = false;
  for (const failure of ['request-timeout', 'unsupported-version']) {
    f.discoveryError = failure;
    await assert.rejects(runtime.selectThread(THREAD, { activate: true }));
  }
  assert.equal(opened, 1);
  assert.deepEqual(await runtime.listThreads(), []);
});

test('cancellation, catalog removal and URL-open failure stop automatic loading before creating a share', async t => {
  const f = await fixture(t); f.noOwner = true; let opened = 0, checks = 0, current = true;
  const runtime = await attachDesktop({ endpoint: f.endpoint,
    catalog: { contains: async () => { checks++; if (checks === 2) current = false; return true; } },
    openThread: async () => { opened++; } });
  t.after(() => runtime.close());
  await assert.rejects(runtime.selectThread(THREAD, { activate: true, canContinue: () => current }), /取消/);
  assert.equal(opened, 0);
  let contains = 0;
  const removed = await attachDesktop({ endpoint: f.endpoint, catalog: { contains: async () => ++contains === 1 }, openThread: async () => { opened++; } });
  t.after(() => removed.close());
  await assert.rejects(removed.selectThread(THREAD, { activate: true }), /归档/);
  assert.equal(opened, 0);
  const failed = await attachDesktop({ endpoint: f.endpoint, openThread: async () => { opened++; throw new Error('synthetic launch failure'); } });
  t.after(() => failed.close());
  await assert.rejects(failed.selectThread(THREAD, { activate: true }), /synthetic launch failure/);
  assert.equal(opened, 1);
  assert.equal(f.requests.some(r => r.method === 'thread-follower-start-turn'), false);
});

test('projects only text; live patches reach ScopedThread and cross-thread/owner/recipient events are ignored', async t => {
  const f = await fixture(t), rpc = await DesktopRpcClient.connect(f.endpoint);
  const scoped = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => { scoped.close(); rpc.close(); });
  await scoped.start();
  assert.deepEqual(scoped.snapshot.items.map(x => x.text), ['A 的既有消息', '既有回复']);
  assert.equal(scoped.snapshot.historyTruncated, true);
  assert.ok(!JSON.stringify(scoped.snapshot).includes('never-project'));
  const original = rpc.revision, socket = f.lastSocket();
  const change = { type: 'snapshot', revision: original + 1, conversationState: state(OTHER) };
  f.broadcast(socket, OTHER, change);
  f.broadcast(socket, THREAD, change, { sourceClientId: randomUUID() });
  f.broadcast(socket, THREAD, change, { targetClientIds: [randomUUID()] });
  await new Promise(r => setTimeout(r, 25)); assert.equal(rpc.revision, original);
  f.broadcast(socket, THREAD, { type: 'patches', baseRevision: original, revision: original + 1,
    patches: [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'items', 0, 'text'], value: '实时新回复' }] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Live projection timed out')), 2000);
    scoped.on('snapshot', s => { if (s.items.some(x => x.text === '实时新回复')) { clearTimeout(timer); resolve(); } });
  });
});

test('native turns with no user input do not create a phantom empty human message', () => {
  const native = state();
  native.turnHistory.history.entitiesByKey['turn:1'].params.input = [];
  const projected = projectDesktopThread(native, THREAD);
  assert.deepEqual(projected.turns[0].items.map(i => i.type), ['agentMessage']);
});

test('Desktop author evidence survives input persistence, repeated text and late history without pinning turn state', async t => {
  const f = await fixture(t), native = state(); f.malformed = native;
  const raw = (id, text, extra = {}) => ({ id, type: 'userMessage', content: [{ type: 'text', text }], ...extra });
  const turn = native.turnHistory.history.entitiesByKey['turn:1'];
  turn.items.unshift(raw('input:1', 'A 的既有消息'));
  const rpc = await DesktopRpcClient.connect(f.endpoint), scoped = new ScopedThread({ rpc, threadId: THREAD, ownerName: '阿明' });
  t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  const sync = async () => {
    const updated = once(rpc, 'state');
    f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
      patches: [{ op: 'replace', path: ['turnHistory'], value: structuredClone(native.turnHistory) }] });
    await updated; await scoped.refresh();
  };
  turn.status = 'inProgress'; turn.items.push(raw('owner-live', '分享者的新输入'));
  await sync();
  assert.equal(scoped.snapshot.items.find(i => i.id === 'owner-live').author.name, '阿明');
  const history = native.turnHistory.history;
  history.entitiesByKey.old = { turnId: 'old-turn', status: 'completed', items: [raw('late-history', '补读历史')] };
  history.islands[0].entries.unshift({ value: 'old' });
  await sync();
  assert.equal(scoped.snapshot.items.find(i => i.id === 'late-history').author.kind, 'unknown');
  for (const name of ['小林', '小周']) {
    f.inputDelayMs = 80;
    const before = f.requests.length;
    const submission = scoped.submitApproved('相同的建议', randomUUID(), { author: { id: name, name, kind: 'guest' } });
    let request;
    for (let i = 0; i < 100 && !request; i++) {
      request = f.requests.slice(before).find(r => r.method === 'thread-follower-start-turn');
      if (!request) await delay(5);
    }
    assert.ok(request);
    const clientId = request.params.turnStart.request.clientUserMessageId;
    turn.items.push(raw(clientId, '相同的建议')); await sync();
    await submission;
    assert.equal(scoped.snapshot.items.find(i => i.id === clientId).author.name, name);
    // Desktop replaces its optimistic id with a persisted id plus clientId.
    turn.items[turn.items.length - 1] = raw(`server-${name}`, '相同的建议', { clientId });
    await sync();
    const matches = scoped.snapshot.items.filter(i => i.id === clientId);
    assert.equal(matches.length, 1); assert.equal(matches[0].author.name, name);
    assert.equal(scoped.snapshot.items.some(i => i.id === `server-${name}`), false);
  }
  const guests = scoped.snapshot.items.filter(i => i.author?.kind === 'guest');
  assert.deepEqual(guests.map(i => i.author.name), ['小林', '小周']);
  turn.status = 'completed'; await sync();
  assert.equal(scoped.snapshot.status, 'idle');
  assert.equal(scoped._liveTurns.size, 0, 'author observations must not pin native text or running state');
  turn.items = turn.items.filter(i => i.id !== 'owner-live'); await sync();
  assert.equal(scoped.snapshot.items.some(i => i.id === 'owner-live'), false);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 2);
  assert.ok(!JSON.stringify(scoped.snapshot).includes('clientUserMessageId'));
  const evidence = scoped._authors.checkpoint(); scoped.close();
  const reopened = new ScopedThread({ rpc, threadId: THREAD, ownerName: '新分享者', authorEvidence: evidence });
  t.after(() => reopened.close()); await reopened.start();
  assert.deepEqual(reopened.snapshot.items.filter(i => i.author?.kind === 'guest').map(i => i.author.name), ['小林', '小周']);
  assert.equal(reopened.snapshot.items.find(i => i.id === 'late-history').author.kind, 'unknown');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 2, 'reopening must not replay inputs');
});

test('native approvals pending at attachment are local-only and clear while the turn remains active', async t => {
  const f = await fixture(t), native = state();
  native.turnHistory.history.entitiesByKey['turn:1'].status = 'inProgress';
  native.requests = [{ method: 'item/commandExecution/requestApproval', id: 'private-approval', params: { command: 'never-project' } }];
  f.malformed = native;
  const rpc = await DesktopRpcClient.connect(f.endpoint), scoped = new ScopedThread({ rpc, threadId: THREAD });
  t.after(() => { scoped.close(); rpc.close(); });
  const approvals = []; scoped.on('approval-state', s => approvals.push(s));
  await scoped.start(); assert.equal(approvals.at(-1).pending, true);
  assert.ok(!JSON.stringify(scoped.snapshot).includes('private-approval'));
  const cleared = new Promise(resolve => scoped.on('approval-state', s => { if (!s.pending) resolve(); }));
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
    patches: [{ op: 'replace', path: ['requests'], value: [] }] });
  await cleared; assert.equal(scoped.snapshot.status, 'running');
  assert.ok(f.requests.every(r => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(r.method)));
});

test('only an explicit local decision submits exact text; no guest options or approval capabilities', async t => {
  const f = await fixture(t), rpc = await DesktopRpcClient.connect(f.endpoint);
  const scoped = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  const room = new SharedRoom({ relayUrl: 'http://127.0.0.1:1', registrationSecret: 'a'.repeat(43), threadId: THREAD, requireApproval: true });
  room.thread = scoped; room.state = 'online'; room.guests.set('guest', { id: 'guest', participantId: 'guest-id', name: 'B', status: 'admitted' });
  const requestId = randomUUID();
  room.receive({ type: 'guest-message', guestId: 'guest', payload: { type: 'proposal', requestId, text: '批准的合成输入' } });
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 0);
  await room.decide(`guest:${requestId}`, true);
  const inputs = f.requests.filter(r => r.method === 'thread-follower-start-turn'); assert.equal(inputs.length, 1);
  const input = inputs[0]; assert.equal(input.targetClientId, f.owner); assert.equal(input.version, 2);
  assert.equal(input.params.turnStart.request.input[0].text, '批准的合成输入');
  assert.deepEqual(input.params.turnStart.context, { inheritThreadSettings: true, attachments: [], commentAttachments: [] });
  assert.equal(room.proposals.get(`guest:${requestId}`).status, 'accepted');
  for (const method of ['account/read', 'thread/list', 'item/permissions/requestApproval', 'thread/start']) await assert.rejects(rpc.request(method), /Unsupported/);
  await assert.rejects(rpc.request('turn/start', { threadId: OTHER, input: [{ type: 'text', text: 'bad' }] }), /Unsupported/);
  await assert.rejects(rpc.request('turn/start', { threadId: THREAD, model: 'bad', input: [{ type: 'text', text: 'bad' }] }), /Unsupported/);
  room.close();
});

test('version changes, stream gaps, mismatched snapshot IDs and disconnects fail closed', async t => {
  for (const kind of ['version', 'gap', 'id', 'disconnect']) {
    const f = await fixture(t), rpc = await DesktopRpcClient.connect(f.endpoint); await rpc.request('thread/read', { threadId: THREAD });
    const closed = once(rpc, 'closed'), socket = f.lastSocket();
    if (kind === 'disconnect') socket.destroy();
    else f.broadcast(socket, THREAD, kind === 'gap' ? { type: 'patches', baseRevision: 9999, revision: 10000, patches: [] } :
      { type: 'snapshot', revision: rpc.revision + 1, conversationState: state(kind === 'id' ? OTHER : THREAD) }, kind === 'version' ? { version: 12 } : {});
    await closed; await assert.rejects(rpc.request('turn/start', {}), /disconnected/);
    assert.equal(rpc.nativeState, null);
  }
});

test('uncertain submission is never replayed and revocation before dispatch prevents input', async t => {
  const f = await fixture(t); f.holdInput = true;
  const rpc = await DesktopRpcClient.connect(f.endpoint, { timeoutMs: 100, routingTimeoutMs: 30, responseGraceMs: 20 });
  const scoped = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  const requestId = randomUUID();
  await assert.rejects(scoped.submitApproved('once', requestId), /unknown/);
  await assert.rejects(scoped.submitApproved('once', requestId), /unknown/);
  await assert.rejects(scoped.submitApproved('revoked', randomUUID(), { canDispatch: () => false }), /revoked/);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('rejects unowned-style endpoints, unsafe patch paths, invalid state and oversized frames', async t => {
  const f = await fixture(t);
  await fs.chmod(path.dirname(f.endpoint), 0o777); await assert.rejects(DesktopIpc.connect(f.endpoint), /protected/); await fs.chmod(path.dirname(f.endpoint), 0o700);
  const alias = path.join(path.dirname(f.endpoint), 'alias.sock'); await fs.symlink(f.endpoint, alias); await assert.rejects(DesktopIpc.connect(alias), /same-user/);
  for (const p of [ ['__proto__', 'polluted'], ['constructor', 'prototype'], ['missing', 'key'] ]) assert.throws(() => applyDesktopPatches({}, [{ op: 'add', path: p, value: true }]));
  assert.equal({}.polluted, undefined); assert.throws(() => projectDesktopThread(state(OTHER), THREAD), /another/);
  const rpc = await DesktopRpcClient.connect(f.endpoint), closed = once(rpc, 'closed');
  const header = Buffer.alloc(4); header.writeUInt32LE(16 * 1024 * 1024 + 1); f.lastSocket().write(header); await closed;
});

test('native connection loss revokes an admitted relay room and pending proposals; fresh sharing needs admission', async t => {
  const f = await fixture(t), registrationSecret = 'a'.repeat(42) + 'Q';
  const relay = await startRelay({ registrationSecret }); t.after(() => relay.close());
  const room = new SharedRoom({ relayUrl: relay.url, registrationSecret, threadId: THREAD, requireApproval: true,
    rpcFactory: () => DesktopRpcClient.connect(f.endpoint) });
  await room.start(); t.after(() => room.close());
  const ws = new WebSocket(relay.url.replace('http:', 'ws:') + '/guest', { origin: relay.url });
  const messages = []; ws.on('message', b => messages.push(JSON.parse(b))); t.after(() => ws.terminate());
  const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await delay(10); } throw new Error('Relay scenario timed out'); };
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name: 'B' }));
  await until(() => room.guests.size === 1);
  assert.equal(messages.some(m => m.type === 'data'), false);
  const guestId = [...room.guests.keys()][0]; room.admit(guestId, true);
  await until(() => messages.some(m => m.payload?.type === 'snapshot'));
  const requestId = randomUUID();
  ws.send(JSON.stringify({ type: 'proposal', requestId, text: 'Never execute after native disconnect' }));
  await until(() => room.proposals.size === 1);
  f.lastSocket().destroy();
  await until(() => messages.some(m => m.type === 'revoked'));
  assert.equal(room.state, 'revoked'); assert.equal(room.guests.size, 0);
  assert.equal(room.proposals.get(`${guestId}:${requestId}`).status, 'rejected');
  assert.equal(room.proposals.get(`${guestId}:${requestId}`).text, '');
  assert.equal(room.view().approvalPending, false);
  assert.match(room.view().lastError, /断开/);
  await assert.rejects(room.decide(`${guestId}:${requestId}`, true), /失效/);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 0);
  // The same native endpoint still works: collaboration shutdown did not kill it.
  const replacement = new SharedRoom({ relayUrl: relay.url, registrationSecret, threadId: THREAD,
    rpcFactory: () => DesktopRpcClient.connect(f.endpoint) });
  await replacement.start(); t.after(() => replacement.close());
  assert.notEqual(replacement.roomId, room.roomId); assert.equal(replacement.guests.size, 0);
});
