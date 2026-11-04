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
import { activityItem, activityDetail } from '../lib/thread-activities.mjs';
import { GuestUploads, attachmentInput } from '../lib/guest-uploads.mjs';
import { MessageAuthors } from '../lib/message-authors.mjs';
import { NATIVE_INPUT_DIGEST, NATIVE_INPUT_ID } from '../lib/user-presentation.mjs';

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
  let revision = 0, malformed, holdInput = false, noOwner = false, noOwnerCount = 0, discoveryError, discoveryDelayMs = 0, inputDelayMs = 0, inputTimeout = false, inputObserver;
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
          inputObserver?.(m);
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
    set inputObserver(value) { inputObserver = value; }, lastSocket: () => [...sockets].at(-1) };
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

test('projects text and rejects malformed activity; live patches preserve thread/owner/recipient scope', async t => {
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

test('native activity snapshots, completion patches and deletion retain display fields without leaking capabilities', async t => {
  const f = await fixture(t), native = state();
  const turn = native.turnHistory.history.entitiesByKey['turn:1'];
  turn.status = 'inProgress';
  turn.items.push({ id: 'command-valid', type: 'commandExecution', command: 'synthetic check', status: 'inProgress',
    aggregatedOutput: 'initial output', cwd: '/synthetic/project', terminalId: 'private-terminal', arguments: { secret: 'private-args' } },
  { id: 'tool-valid', type: 'mcpToolCall', server: 'fixture', tool: 'inspect', status: 'completed',
    result: { content: [{ type: 'text', text: 'tool output' }], _meta: { token: 'private-token' } }, appContext: { resourceUri: 'private-resource' } },
  { id: 'steps-valid', type: 'todo-list', plan: [{ step: 'Verify', status: 'in_progress' }] });
  f.malformed = native;
  const rpc = await DesktopRpcClient.connect(f.endpoint); t.after(() => rpc.close());
  const first = (await rpc.request('thread/read', { threadId: THREAD })).thread;
  const command = first.turns[0].items.find(item => item.id === 'command-valid');
  assert.equal(command.status, 'running');
  assert.ok(!JSON.stringify(first).includes('private-'));
  const before = activityItem(command, 'synthetic-room');
  const completed = once(rpc, 'state');
  const itemPath = ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'items'];
  const commandIndex = turn.items.findIndex(item => item.id === 'command-valid');
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1, patches: [
    { op: 'replace', path: [...itemPath, commandIndex, 'status'], value: 'completed' },
    { op: 'replace', path: [...itemPath, commandIndex, 'aggregatedOutput'], value: 'final output' },
    { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'diff'], value: '-before\n+after' },
  ] });
  await completed;
  const after = activityItem(rpc.thread.turns[0].items.find(item => item.id === command.id), 'synthetic-room');
  assert.equal(after.status, 'completed'); assert.notEqual(after.detailId, before.detailId);
  assert.equal(JSON.parse(activityDetail(after).bytes).text, 'final output');
  assert.ok(rpc.thread.turns[0].items.some(item => item.type === 'fileChange'));
  const deleted = once(rpc, 'state');
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1, patches: [
    { op: 'remove', path: [...itemPath, commandIndex] },
    { op: 'remove', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'diff'] },
  ] });
  await deleted;
  assert.equal(rpc.thread.turns[0].items.some(item => item.id === command.id), false);
  assert.equal(rpc.thread.turns[0].items.some(item => item.type === 'fileChange'), false);
  assert.ok(f.requests.every(request => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(request.method)));
});

test('native turns with no user input do not create a phantom empty human message', () => {
  const native = state();
  native.turnHistory.history.entitiesByKey['turn:1'].params.input = [];
  const projected = projectDesktopThread(native, THREAD);
  assert.deepEqual(projected.turns[0].items.map(i => i.type), ['agentMessage']);
});

test('both Desktop histories preserve cross-chat steering, opening input and safe native user presentation', () => {
  for (const kind of ['legacy', 'canonical']) {
    const native = state(), turn = native.turnHistory.history.entitiesByKey['turn:1'];
    turn.turnStartedAtMs = 1793660000000; turn.durationMs = 56999.9;
    const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: 'private-call-id', question: '验收范围？', answer: '本机浏览器' }]) + '\n</send_user_message_question_reply>';
    turn.items.push({ id: 'cross-chat', type: 'steeringUserMessage', input: [{ type: 'text', text: reply }],
      clientUserMessageId: 'chatgpt-messaging:private-chat-id:private-message-id', restoreMessage: { createdAt: 1793660000123,
        context: { mcpAppModelContextAttachments: [{ token: 'private-token' }] } } },
    { id: 'execute-plan', type: 'userMessage', content: [{ type: 'text', text: 'PLEASE IMPLEMENT THIS PLAN:\n# fallback plan' }] },
    { id: 'native-plan', type: 'planImplementation', planContent: '# Native preferred plan', isCompleted: true, turnId: 'private-turn-handle' });
    if (kind === 'legacy') { native.turns = [turn]; native.turnHistory = { kind: 'legacy' }; }
    const projected = projectDesktopThread(native, THREAD).turns[0];
    assert.equal(projected.durationMs, 56999.9, 'duration stays native milliseconds without rounding');
    const users = projected.items.filter(item => item.type === 'userMessage');
    assert.deepEqual(users.map(item => item.id), ['input:1', 'cross-chat', 'execute-plan']);
    assert.equal(users[0].createdAt, turn.turnStartedAtMs);
    assert.deepEqual(JSON.parse(JSON.stringify(users[1])), { id: 'cross-chat', type: 'userMessage', content: [{ type: 'text', text: '本机浏览器' }], createdAt: 1793660000123,
      source: { kind: 'chatgpt' }, presentation: { kind: 'question_reply', replies: [{ question: '验收范围？', answer: '本机浏览器' }] } });
    assert.deepEqual(users[2].presentation, { kind: 'plan_execution', plan: '# Native preferred plan' });
    assert.equal(users[2].content[0].text, '是的，执行此计划');
    assert.ok(!JSON.stringify(projected).includes('private-'));
  }
});

test('a persisted native user replaces its steering entry without leaking external source correlation', () => {
  const native = state(), turn = native.turnHistory.history.entitiesByKey['turn:1'];
  const input = [{ type: 'text', text: '跨聊天补充' }];
  turn.items = [{ id: 'steering', type: 'steeringUserMessage', input,
    clientUserMessageId: 'chatgpt-messaging:private-room', serverUserMessageId: 'persisted', restoreMessage: { createdAt: 1793660000123 } },
  { id: 'persisted', type: 'userMessage', content: input, clientId: 'chatgpt-messaging:private-room' }];
  const result = projectDesktopThread(native, THREAD).turns[0].items;
  assert.deepEqual(result.filter(item => item.type === 'userMessage').map(item => item.id), ['input:1', 'persisted']);
  assert.deepEqual(result.at(-1).source, { kind: 'chatgpt' }); assert.equal(result.at(-1).createdAt, 1793660000123);
  assert.ok(!JSON.stringify(result).includes('private-room'));
});

test('canonical projection merges the Desktop local tail without reordering loaded history or losing its assistant, steering and diff', () => {
  const native = state();
  const old = native.turnHistory.history.entitiesByKey['turn:1'];
  old.items = [{ id: 'old-answer', type: 'agentMessage', phase: 'commentary', text: '已载历史' }];
  native.turnHistory.history.islands[0].entries.unshift({ value: 'older' });
  native.turnHistory.history.entitiesByKey.older = { turnId: 'older-turn', status: 'completed', params: { input: [] },
    items: [{ id: 'older-answer', type: 'agentMessage', text: '更早历史' }] };
  native.turns = [{ ...old, durationMs: 1234.5, items: [...old.items,
    { id: 'tail-user', type: 'steeringUserMessage', input: [{ type: 'text', text: '已解锁' }], restoreMessage: { createdAt: 1793660000123 } },
    { id: 'tail-answer', type: 'agentMessage', phase: 'commentary', text: '解锁后的完整说明' },
    { id: 'tail-files', type: 'fileChange', status: 'completed', changes: Array.from({ length: 7 }, (_, index) => ({ path: `/synthetic/file-${index}`, kind: 'update', diff: '-old\n+new' })) }],
    diff: 'diff --git a/tail.mjs b/tail.mjs\n--- a/tail.mjs\n+++ b/tail.mjs\n-old\n+new\n' }];
  const result = projectDesktopThread(native, THREAD);
  assert.deepEqual(result.turns.map(turn => turn.id), ['older-turn', TURN]);
  const merged = result.turns[1];
  assert.equal(merged.durationMs, 1234.5);
  assert.ok(merged.items.some(item => item.id === 'tail-user' && item.content[0].text === '已解锁'));
  assert.ok(merged.items.some(item => item.id === 'tail-answer' && item.text === '解锁后的完整说明'));
  assert.equal(merged.items.filter(item => item.type === 'fileChange').length, 1);
  assert.equal(activityItem(merged.items.at(-1), 'synthetic').summary.fileCount, 8);
  native.turns = [];
  const rolledBack = projectDesktopThread(native, THREAD);
  assert.deepEqual(rolledBack.turns.map(turn => turn.id), ['older-turn', TURN]);
  assert.ok(!JSON.stringify(rolledBack).includes('tail-answer')); assert.equal(rolledBack.turns[1].items.some(item => item.type === 'fileChange'), false);
});

test('canonical merge follows native pagination, local steering and terminal assistant precedence', () => {
  const native = state(), history = native.turnHistory.history.entitiesByKey['turn:1'];
  history.params.input = []; history.status = 'completed'; history.durationMs = 4500;
  history.itemsPagination = { hasLoadedOldest: false };
  history.items = [{ id: 'first', type: 'agentMessage', text: '历史分页正文', phase: 'commentary' },
    { id: 'shared', type: 'agentMessage', text: '分页已缓存版本', phase: 'commentary' }];
  const overlay = { ...history, status: 'inProgress', durationMs: 999, itemsPagination: undefined,
    items: [{ id: 'shared', type: 'agentMessage', text: '尾部同ID版本', phase: 'commentary' },
      { id: 'tail', type: 'agentMessage', text: '尾部新增', phase: 'final_answer' }] };
  native.turns = [overlay];
  let merged = projectDesktopThread(native, THREAD).turns[0];
  assert.equal(merged.status, 'completed'); assert.equal(merged.durationMs, 4500);
  assert.deepEqual(merged.items.filter(item => item.type === 'agentMessage').map(item => item.text), ['历史分页正文', '分页已缓存版本', '尾部新增']);
  delete history.itemsPagination; history.items.unshift({ id: 'steering', type: 'steeringUserMessage', input: [{ type: 'text', text: '中途输入' }] });
  merged = projectDesktopThread(native, THREAD).turns[0];
  assert.ok(merged.items.some(item => item.type === 'userMessage' && item.content[0].text === '中途输入'));
  assert.equal(merged.items.find(item => item.id === 'shared').text, '尾部同ID版本', 'native steering merge refreshes matching assistant text');
  history.items = [{ id: 'first', type: 'agentMessage', text: '保留历史' }, { id: 'older-tool', type: 'commandExecution', command: 'fixture', status: 'completed' }];
  overlay.items = [{ id: 'short-final', type: 'agentMessage', phase: 'final_answer', text: '短尾部最终回复' }];
  merged = projectDesktopThread(native, THREAD).turns[0];
  assert.deepEqual(merged.items.map(item => item.id), ['first', 'older-tool', 'short-final']);
  overlay.items = [{ id: 'replacement', type: 'agentMessage', text: '替换历史' }, { id: 'new-last', type: 'agentMessage', text: '替换终点' }];
  merged = projectDesktopThread(native, THREAD).turns[0];
  assert.deepEqual(merged.items.map(item => item.id), ['replacement', 'new-last'], 'a complete equal-length native overlay can replace and remove prior items');
});

test('native local turns without a turn ID remain visible with stable display-only keys and safe ChatGPT provenance', () => {
  for (const kind of ['legacy', 'canonical']) {
    const native = state(), local = { turnId: null, status: 'completed', params: { input: [] }, items: [
      { id: 'local-user', type: 'steeringUserMessage', input: [{ type: 'text', text: '跨聊天审查输入' }],
        messageMetadata: { aeon: { version: 1, sourceChannel: 'chatgpt', sourceId: 'private-source', threadId: 'private-chat' } },
        restoreMessage: { createdAt: 1793660000123 } }] };
    if (kind === 'canonical') {
      native.turnHistory.history.islands[0].entries.push({ value: 'local-entry' });
      native.turnHistory.history.entitiesByKey['local-entry'] = local;
    } else { native.turns = [native.turnHistory.history.entitiesByKey['turn:1'], local]; native.turnHistory = { kind: 'legacy' }; }
    const projected = projectDesktopThread(native, THREAD), display = projected.turns.at(-1);
    assert.match(display.id, /^co2:local-turn:[a-f0-9]{64}$/);
    assert.equal(display.items[0].type, 'userMessage'); assert.equal(display.items[0].content[0].text, '跨聊天审查输入');
    assert.deepEqual(display.items[0].source, { kind: 'chatgpt' });
    local.items.push({ id: 'local-answer', type: 'agentMessage', text: '接续说明' });
    assert.equal(projectDesktopThread(native, THREAD).turns.at(-1).id, display.id, 'later content does not replace the local grouping key');
    assert.ok(!JSON.stringify(projected).includes('private-'));
    if (kind === 'canonical') native.turnHistory.history.islands[0].entries.pop(); else native.turns.pop();
    assert.ok(!projectDesktopThread(native, THREAD).turns.some(turn => turn.id === display.id), 'history removal revokes the display turn');
  }
});

test('both native histories display only the instruction delivered by exact delegation output and never grant source-thread or file scope', () => {
  for (const kind of ['legacy', 'canonical']) {
    const native = state(), turn = native.turnHistory.history.entitiesByKey['turn:1'];
    turn.items.push({ id: 'delivered-review', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
      output: '<codex_delegation><source_thread_id>private-origin-thread</source_thread_id><input>审查当前改动 [测试文件](/synthetic/report.pdf)</input></codex_delegation>',
      arguments: { context: 'private-context' }, callId: 'private-call', executionHandle: 'private-execution',
      messageMetadata: { aeon: { version: 1, sourceChannel: 'chatgpt', sourceId: 'private-source', threadId: 'private-thread' } } });
    if (kind === 'legacy') { native.turns = [turn]; native.turnHistory = { kind: 'legacy' }; }
    const result = projectDesktopThread(native, THREAD), delivered = result.turns[0].items.find(item => item.id === 'delivered-review');
    assert.deepEqual(delivered, { id: 'delivered-review', type: 'userMessage', content: [{ type: 'text', text: '审查当前改动 [测试文件](/synthetic/report.pdf)' }], source: { kind: 'chatgpt' } });
    assert.ok(!JSON.stringify(result).includes('private-')); assert.ok(!JSON.stringify(result).includes('executionHandle'));
    for (const output of ['```xml\n' + turn.items.at(-1).output + '\n```', '<codex_delegation>partial',
      turn.items.at(-1).output.replace('</input>', '<extra>private-context</extra></input>')]) {
      turn.items.at(-1).output = output;
      assert.equal(projectDesktopThread(native, THREAD).turns[0].items.some(item => item.id === 'delivered-review'), false);
    }
  }
});

test('native overlay and local-turn patches replace and roll back their exact projection without stale local execution handles', async t => {
  const f = await fixture(t), native = state(); f.malformed = native;
  const rpc = await DesktopRpcClient.connect(f.endpoint), scoped = new ScopedThread({ rpc, threadId: THREAD });
  t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  const waitFor = condition => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { scoped.off('snapshot', seen); reject(new Error('Overlay projection refresh timed out')); }, 2000);
    const seen = value => { if (condition(value)) { clearTimeout(timer); scoped.off('snapshot', seen); resolve(value); } };
    scoped.on('snapshot', seen);
  });
  const patch = patches => f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1, patches });
  const old = native.turnHistory.history.entitiesByKey['turn:1'];
  const overlay = { ...old, items: [...old.items, { id: 'new-final', type: 'agentMessage', text: 'overlay final', phase: 'final_answer' }], diff: '-one\n+two' };
  let changed = waitFor(value => value.items.some(item => item.text === 'overlay final'));
  patch([{ op: 'replace', path: ['turns'], value: [overlay] }]); await changed;
  assert.ok(scoped.snapshot.items.some(item => item.text === '既有回复')); assert.ok(scoped.snapshot.items.some(item => item.kind === 'diff'));
  const oldDetail = scoped.snapshot.items.find(item => item.kind === 'diff').detailId;
  changed = waitFor(value => !value.items.some(item => item.text === 'overlay final'));
  patch([{ op: 'replace', path: ['turns'], value: [] }]); await changed;
  assert.ok(scoped.snapshot.items.some(item => item.text === '既有回复')); assert.equal(scoped.hasActivity(oldDetail), false);
  const local = { turnId: null, status: 'completed', params: { input: [] }, items: [{ id: 'local-delivery', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
    output: '<codex_delegation><source_thread_id>private-source</source_thread_id><input>当前会话的审查输入</input></codex_delegation>' }] };
  changed = waitFor(value => value.items.some(item => item.text === '当前会话的审查输入'));
  patch([{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'local-entry'], value: local },
    { op: 'add', path: ['turnHistory', 'history', 'islands', 0, 'entries', 1], value: { value: 'local-entry' } }]); await changed;
  const visible = scoped.snapshot.items.find(item => item.text === '当前会话的审查输入');
  assert.equal(visible.role, 'user'); assert.deepEqual(visible.source, { kind: 'cross_chat' }); assert.match(visible.turnId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(scoped.snapshot).includes('private-source'));
  changed = waitFor(value => !value.items.some(item => item.text === '当前会话的审查输入'));
  patch([{ op: 'remove', path: ['turnHistory', 'history', 'islands', 0, 'entries', 1] }]); await changed;
  assert.ok(f.requests.every(request => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(request.method)), 'local presentation IDs never become execution requests');
});

test('legacy and canonical Desktop history preserve only known assistant phases and valid native turn durations', () => {
  for (const kind of ['legacy', 'canonical']) {
    const native = state();
    const turn = native.turnHistory.history.entitiesByKey['turn:1'];
    turn.durationMs = 5432;
    turn.items = [{ id: 'work', type: 'agentMessage', text: 'Working', phase: 'commentary', reasoning: 'private-reasoning' },
      { id: 'final', type: 'agentMessage', text: 'Done', phase: 'final_answer' },
      { id: 'unknown', type: 'agentMessage', text: 'Visible', phase: 'private-phase', channel: 'analysis' }];
    if (kind === 'legacy') { native.turns = [turn]; native.turnHistory = { kind: 'legacy' }; }
    const result = projectDesktopThread(native, THREAD).turns[0];
    assert.equal(result.durationMs, 5432);
    assert.deepEqual(result.items.filter(item => item.type === 'agentMessage').map(item => item.phase), ['commentary', 'final_answer', undefined]);
    assert.ok(!JSON.stringify(result).includes('private-'));
    for (const invalid of [-1, Infinity, '1000', 7 * 24 * 60 * 60 * 1000 + 1]) {
      turn.durationMs = invalid;
      assert.equal(projectDesktopThread(native, THREAD).turns[0].durationMs, undefined);
    }
  }
});

test('Desktop completion patches refresh grouping state and phase without retaining metadata after turn deletion', async t => {
  const f = await fixture(t), native = state();
  const turn = native.turnHistory.history.entitiesByKey['turn:1'];
  turn.status = 'inProgress'; turn.items[0].phase = 'commentary';
  f.malformed = native;
  const rpc = await DesktopRpcClient.connect(f.endpoint); t.after(() => rpc.close());
  const scoped = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => scoped.close());
  await scoped.start();
  const first = scoped.snapshot.items.find(item => item.role === 'assistant');
  assert.equal(first.phase, 'commentary');
  const anchorFor = (value, turnId) => value.items.find(item => item.turnId === turnId && item.turnStatus !== undefined);
  assert.equal(anchorFor(scoped.snapshot, first.turnId).turnStatus, 'running');
  const waitFor = condition => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { scoped.off('snapshot', seen); reject(new Error('Synthetic presentation refresh timed out')); }, 2000);
    const seen = value => { if (condition(value)) { clearTimeout(timer); scoped.off('snapshot', seen); resolve(value); } };
    scoped.on('snapshot', seen);
  });
  const completed = waitFor(value => value.items.some(item => item.phase === 'final_answer' && item.turnId === first.turnId)
    && anchorFor(value, first.turnId)?.turnStatus === 'completed');
  const base = ['turnHistory', 'history', 'entitiesByKey', 'turn:1'];
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1, patches: [
    { op: 'replace', path: [...base, 'status'], value: 'completed' },
    { op: 'add', path: [...base, 'durationMs'], value: 4567 },
    { op: 'replace', path: [...base, 'items', 0, 'phase'], value: 'final_answer' },
  ] });
  const result = await completed;
  assert.ok(result.items.every(item => item.turnId === first.turnId));
  const anchor = anchorFor(result, first.turnId);
  assert.equal(anchor.turnStatus, 'completed'); assert.equal(anchor.turnDurationMs, 4567);
  assert.equal(result.items.filter(item => item.turnStatus !== undefined).length, 1);
  assert.ok(result.items.filter(item => item !== anchor).every(item => item.turnDurationMs === undefined));
  const deleted = waitFor(value => value.items.length === 0);
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
    patches: [{ op: 'remove', path: ['turnHistory', 'history', 'islands', 0, 'entries', 0] }] });
  await deleted;
  assert.equal(scoped._turnPresentation.size, 0);
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

test('new Desktop turns retain host and guest authors through optimistic promotion and server persistence', async t => {
  for (const role of ['host', 'guest']) for (const responseFirst of [false, true]) {
    await t.test(`${role}, response ${responseFirst ? 'before' : 'after'} promotion`, async t => {
      const f = await fixture(t), native = state();
      native.turnHistory.history.entitiesByKey['turn:1'].turnId = 'old-turn';
      f.malformed = native;
      const rpc = await DesktopRpcClient.connect(f.endpoint);
      const scoped = new ScopedThread({ rpc, threadId: THREAD, ownerName: '阿明' });
      t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
      const sync = async () => {
        const updated = once(rpc, 'state');
        f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
          patches: [{ op: 'replace', path: ['turnHistory'], value: structuredClone(native.turnHistory) }] });
        await updated; await scoped.refresh();
      };
      let clientId = randomUUID(), submission;
      if (role === 'guest') {
        f.inputDelayMs = responseFirst ? 0 : 100;
        submission = scoped.submitApproved('新回合输入', randomUUID(), { author: { id: 'guest', name: '小林', kind: 'guest' } });
        let request;
        for (let i = 0; i < 100 && !request; i++) {
          request = f.requests.find(r => r.method === 'thread-follower-start-turn');
          if (!request) await delay(5);
        }
        assert.ok(request); clientId = request.params.turnStart.request.clientUserMessageId;
        if (responseFirst) await submission;
      }
      const history = native.turnHistory.history;
      const turn = { turnId: null, status: 'inProgress', params: { clientUserMessageId: clientId,
        input: [{ type: 'text', text: '新回合输入' }] }, items: [] };
      history.entitiesByKey.new = turn; history.islands[0].entries.push({ value: 'new' }); await sync();
      turn.turnId = TURN; await sync();
      if (submission) await submission;
      assert.equal(scoped.snapshot.items.find(i => i.id === clientId).author.kind, role);
      turn.items.push({ id: 'persisted-user', clientId, type: 'userMessage', content: turn.params.input });
      turn.status = 'completed'; await sync();
      assert.equal(scoped.snapshot.items.find(i => i.id === clientId).author.kind, role);
      const evidence = scoped._authors.checkpoint(); scoped.close();
      const reopened = new ScopedThread({ rpc, threadId: THREAD, ownerName: '新名称', authorEvidence: evidence });
      t.after(() => reopened.close()); await reopened.start();
      assert.equal(reopened.snapshot.items.find(i => i.id === clientId).author.kind, role);
      assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, role === 'guest' ? 1 : 0);
    });
  }
});

test('old pending attribution cannot block a new Desktop owner input, including restart and persisted echoes', { timeout: 5000 }, async t => {
  const authors = new MessageAuthors('阿明'); authors.observe([], new Map());
  authors.begin('old-request', '旧访客输入', { id: 'old-guest', name: '小林', kind: 'guest' });
  authors.observe([{ id: 'input:1', role: 'user', text: '旧访客输入' }], new Map([['input:1', TURN]]), 'input:1');
  const f = await fixture(t), native = state(); f.malformed = native;
  native.turnHistory.history.entitiesByKey['turn:1'].params.input[0].text = '旧访客输入';
  const rpc = await DesktopRpcClient.connect(f.endpoint);
  const scoped = new ScopedThread({ rpc, threadId: THREAD, ownerName: '阿明', authorEvidence: authors.checkpoint() });
  t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  const history = native.turnHistory.history, clientId = randomUUID();
  history.entitiesByKey.owner = { turnId: 'owner-turn', status: 'inProgress', params: { clientUserMessageId: clientId,
    input: [{ type: 'text', text: '分享者的新消息' }] }, items: [] };
  history.islands[0].entries.push({ value: 'owner' });
  const sync = async () => {
    const updated = once(rpc, 'state');
    f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
      patches: [{ op: 'replace', path: ['turnHistory'], value: structuredClone(native.turnHistory) }] });
    await updated; await scoped.refresh();
  };
  await sync();
  assert.equal(scoped.snapshot.items.find(i => i.id === clientId).author.kind, 'host');
  assert.equal(scoped.snapshot.items.find(i => i.id === 'input:1').author.kind, 'unknown');
  assert.ok(scoped.snapshot.items.every(i => !Object.getOwnPropertySymbols(i).some(k => [NATIVE_INPUT_DIGEST, NATIVE_INPUT_ID].includes(k))));
  history.entitiesByKey.owner.items.push({ id: 'server-owner', clientId, type: 'userMessage', content: history.entitiesByKey.owner.params.input });
  history.entitiesByKey.owner.status = 'completed'; await sync();
  const steerId = randomUUID(); history.entitiesByKey.owner.status = 'inProgress';
  history.entitiesByKey.owner.items.push({ id: 'steering-owner', type: 'steeringUserMessage', clientUserMessageId: steerId,
    input: [{ type: 'text', text: '分享者的中途补充' }] }); await sync();
  assert.equal(scoped.snapshot.items.find(i => i.id === steerId).author.kind, 'host');
  history.entitiesByKey.owner.items.push({ id: 'server-steering-owner', type: 'userMessage', clientId: steerId,
    content: [{ type: 'text', text: '分享者的中途补充' }] });
  history.entitiesByKey.owner.status = 'completed'; await sync();
  assert.equal(scoped.snapshot.items.find(i => i.id === steerId).author.kind, 'host');
  const saved = scoped._authors.checkpoint(); scoped.close();
  const reopened = new ScopedThread({ rpc, threadId: THREAD, ownerName: '重启后', authorEvidence: saved });
  t.after(() => reopened.close()); await reopened.start();
  assert.equal(reopened.snapshot.items.find(i => i.id === clientId).author.kind, 'host');
  assert.ok(!JSON.stringify(saved).includes('分享者的新消息'));
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 0);
});

test('Desktop guest identity is checkpointed before dispatch; a lost reply never taints same-text owner input', async t => {
  const f = await fixture(t), native = state(); f.malformed = native; f.inputTimeout = true;
  let saved, identityBeforeDispatch = false;
  f.inputObserver = request => { identityBeforeDispatch = saved?.submissions[0]?.[1].clientUserMessageId === request.params.turnStart.request.clientUserMessageId; };
  const rpc = await DesktopRpcClient.connect(f.endpoint);
  const scoped = new ScopedThread({ rpc, threadId: THREAD, ownerName: '阿明', onAuthorsChanged: e => { saved = e; } });
  t.after(() => { scoped.close(); rpc.close(); }); await scoped.start();
  await assert.rejects(scoped.submitApproved('相同正文', randomUUID(), { author: { id: 'guest', name: '小林', kind: 'guest' } }), { code: 'SUBMISSION_UNCERTAIN' });
  const request = f.requests.find(r => r.method === 'thread-follower-start-turn');
  const clientId = request.params.turnStart.request.clientUserMessageId;
  assert.equal(saved.submissions[0][1].clientUserMessageId, clientId);
  assert.equal(identityBeforeDispatch, true);
  assert.equal(saved.submissions[0][1].status, 'unknown');
  const turn = native.turnHistory.history.entitiesByKey['turn:1'];
  turn.status = 'inProgress';
  const ownerId = randomUUID();
  turn.items.push({ id: 'owner-same-text', type: 'steeringUserMessage', clientUserMessageId: ownerId, input: [{ type: 'text', text: '相同正文' }] });
  const updated = once(rpc, 'state');
  f.broadcast(f.lastSocket(), THREAD, { type: 'patches', baseRevision: rpc.revision, revision: rpc.revision + 1,
    patches: [{ op: 'replace', path: ['turnHistory'], value: structuredClone(native.turnHistory) }] });
  await updated; await scoped.refresh();
  assert.equal(scoped.snapshot.items.find(i => i.id === ownerId).author.kind, 'host');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
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

test('uploaded images and ordinary/audio/video files use the existing Desktop follower with trusted native metadata only', async t => {
  const f = await fixture(t), rpc = await DesktopRpcClient.connect(f.endpoint); t.after(() => rpc.close());
  await rpc.request('thread/read', { threadId: THREAD });
  const store = new GuestUploads(path.join(path.dirname(f.endpoint), '.coop'), randomUUID()); t.after(() => store.close());
  const thread = new ScopedThread({ rpc, threadId: THREAD }); await thread.start(); t.after(() => thread.close());
  const cases = [ ['image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64')],
    ['file.docx', Buffer.from('PK synthetic docx')], ['audio.wav', Buffer.from('RIFF synthetic audio')], ['video.mp4', Buffer.from('synthetic video')] ];
  for (const [name, bytes] of cases) {
    const id = randomUUID(); store.receive('guest', { type: 'upload-start', uploadId: id, name, size: bytes.length });
    store.receive('guest', { type: 'upload-chunk', uploadId: id, index: 0, data: bytes.toString('base64') });
    store.receive('guest', { type: 'upload-finish', uploadId: id });
    const attachments = store.claim('guest', [id]); await thread.submitApproved('', randomUUID(), { attachments });
    const native = f.requests.filter(r => r.method === 'thread-follower-start-turn').at(-1);
    assert.equal(native.targetClientId, f.owner); assert.equal(native.params.conversationId, THREAD); assert.equal(native.version, 2);
    assert.deepEqual(native.params.turnStart.context, { inheritThreadSettings: true, attachments: [{ label: name, path: attachments[0].path,
      fsPath: attachments[0].path, ...(name.endsWith('.png') ? { isImageAttachment: true } : {}) }], commentAttachments: [] });
    assert.equal(native.params.turnStart.request.input[0].text_elements.length, 0);
    assert.match(native.params.turnStart.request.input[0].text, /## My request:/);
    assert.equal(native.params.turnStart.request.input.length, name.endsWith('.png') ? 2 : 1);
    assert.deepEqual(await fs.readFile(attachments[0].path), bytes);
  }
  const count = f.requests.filter(r => r.method === 'thread-follower-start-turn').length;
  for (const attachments of [[{ path: '/synthetic/private', image: true }], [{ path: cases[0][0] }]]) await assert.rejects(rpc.request('turn/start',
    { threadId: THREAD, input: [{ type: 'text', text: 'bad' }], attachments }), /Unsupported/);
  await assert.rejects(rpc.request('turn/start', { threadId: THREAD, input: [{ type: 'text', text: 'bad' }, { type: 'localImage', path: '/synthetic/private' }] }), /Unsupported/);
  rpc.nativeState.environments = [{ environmentId: 'remote-synthetic', cwd: '/synthetic/remote' }]; assert.equal(rpc.canUploadAttachments(), false);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, count);
  // Scripted IPC confirms request shape, not native rendering or model/audio understanding.
});
