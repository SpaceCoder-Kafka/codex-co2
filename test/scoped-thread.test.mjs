import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ScopedThread } from '../lib/scoped-thread.mjs';

const THREAD = 'selected-thread';

class FakeRpc extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.answers = [];
    this.closed = false;
    this.thread = { id: THREAD, name: 'Shared test', status: { type: 'idle' }, turns: [
      { id: 'seed', status: 'completed', items: [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
        { id: 'assistant', type: 'agentMessage', text: 'Ready' },
      ] },
    ] };
  }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.handler) {
      const result = this.handler(method, params);
      if (result !== undefined) return result;
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: structuredClone(this.thread) };
    if (method === 'turn/start') return { turn: { id: 'submitted-turn' } };
    throw new Error('Unexpected method');
  }
  respond(...args) { this.answers.push(args); }
  close() { this.closed = true; }
  notification(method, params) { this.emit('notification', { method, params }); }
}

async function fixture(t) {
  const rpc = new FakeRpc();
  const bridge = new ScopedThread({ rpc, threadId: THREAD });
  t.after(() => bridge.close());
  await bridge.start();
  return { rpc, bridge };
}

test('start scopes read and resume; snapshot exposes only named text messages', async t => {
  const rpc = new FakeRpc();
  rpc.thread.cwd = '/secret/workspace';
  rpc.thread.preview = 'secret-preview';
  rpc.thread.turns[0].items.push(
    { id: 'command', type: 'commandExecution', aggregatedOutput: 'secret-tool-output' },
    { id: 'reasoning', type: 'reasoning', summary: ['secret-reasoning'] },
    { id: 'file', type: 'fileChange', path: '/secret/path' },
    { id: 'child', type: 'collabAgentToolCall', receiverThreadIds: ['secret-child-thread'] },
  );
  rpc.thread.turns[0].items[0].content.push(
    { type: 'image', url: 'secret-image' }, { type: 'localImage', path: '/secret/attachment' },
    { type: 'mention', path: '/secret/mention', name: 'secret-mention' },
  );
  rpc.thread.turns[0].items[1].path = '/secret/assistant-attachment';
  const bridge = new ScopedThread({ rpc, threadId: THREAD });
  t.after(() => bridge.close());
  const snapshots = [];
  bridge.on('snapshot', snapshot => snapshots.push(snapshot));
  await bridge.start();
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/read', 'thread/resume', 'thread/read']);
  assert.ok(rpc.calls.every(call => call.params.threadId === THREAD));
  assert.deepEqual(rpc.calls[1].params, { threadId: THREAD });
  const turnId = bridge.snapshot.items[0].turnId;
  assert.match(turnId, /^[a-f0-9]{64}$/);
  assert.notEqual(turnId, 'seed');
  assert.deepEqual(bridge.snapshot.items, [
    { id: 'user', role: 'user', text: 'Hello', turnId, turnStatus: 'completed' },
    { id: 'assistant', role: 'assistant', text: 'Ready', turnId },
  ]);
  assert.equal(bridge.snapshot.status, 'idle');
  assert.equal(bridge.snapshot.title, 'Shared test');
  assert.equal(JSON.stringify(snapshots).includes('secret'), false);
  assert.equal(JSON.stringify(snapshots).includes(THREAD), false);
  const copy = bridge.snapshot;
  copy.items[0].text = 'changed by caller';
  assert.equal(bridge.snapshot.items[0].text, 'Hello');
});

test('user presentation survives normalization without changing user role and oversized plan metadata never evicts dialogue', async t => {
  const rpc = new FakeRpc();
  rpc.thread.turns[0].items.unshift({ id: 'plan-user', type: 'userMessage', content: [{ type: 'text', text: '是的，执行此计划' }],
    presentation: { kind: 'plan_execution', plan: '原生计划'.repeat(50000), token: 'private-token' },
    createdAt: 1793660000123, source: { kind: 'chatgpt', roomId: 'private-room' } });
  const bridge = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => bridge.close()); await bridge.start();
  const item = bridge.snapshot.items.find(item => item.id === 'plan-user');
  assert.equal(item.role, 'user'); assert.equal(item.text, '是的，执行此计划'); assert.equal(item.presentation, undefined);
  assert.deepEqual(item.source, { kind: 'chatgpt' }); assert.equal(item.createdAt, 1793660000123);
  assert.ok(bridge.snapshot.items.some(item => item.text === 'Ready'));
  assert.ok(Buffer.byteLength(JSON.stringify(bridge.snapshot)) < 48 * 1024);
  assert.ok(!JSON.stringify(bridge.snapshot).includes('private-'));
});

test('display-normalized question and plan replies retain guest attribution while private source text never leaves the snapshot', async t => {
  const rpc = new FakeRpc(), bridge = new ScopedThread({ rpc, threadId: THREAD, ownerName: '分享者' });
  t.after(() => bridge.close()); await bridge.start();
  const author = { id: 'guest', name: '协作者', kind: 'guest' };
  for (const [index, text] of ['PLEASE IMPLEMENT THIS PLAN:\n# 计划\n\n- 仅本机验证',
    '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: 'private-call-id', question: '验证哪里？', answer: '本机' }]) + '\n</send_user_message_question_reply>'].entries()) {
    const turnId = `presentation-${index}`, itemId = `user-${index}`;
    let release; rpc.handler = method => method === 'turn/start' ? new Promise(resolve => { release = resolve; }) : undefined;
    const pending = bridge.submitApproved(text, randomUUID(), { author }); await delay(0);
    rpc.notification('turn/started', { threadId: THREAD, turn: { id: turnId } });
    rpc.notification('item/started', { threadId: THREAD, turnId, item: { id: itemId, type: 'userMessage', content: [{ type: 'text', text }] } });
    release({ turn: { id: turnId } }); await pending;
    const visible = bridge.snapshot.items.find(item => item.id === itemId);
    assert.equal(visible.role, 'user'); assert.deepEqual(visible.author, author); assert.ok(visible.presentation);
    assert.equal(Object.getOwnPropertySymbols(visible).length, 0);
    assert.ok(!JSON.stringify(visible).includes('private-call-id'));
    visible.presentation.kind = 'mutated';
    assert.notEqual(bridge.snapshot.items.find(item => item.id === itemId).presentation.kind, 'mutated');
    assert.equal(rpc.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, text, 'the execution prompt remains exact');
  }
});

test('live item and cumulative turn diffs share one card and old detail scope is revoked after updates and rollback', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'diff-turn', status: 'inProgress' } });
  const change = (id, name, diff) => ({ id, type: 'fileChange', status: 'completed', changes: [{ path: name, kind: 'update', diff }] });
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'diff-turn', item: change('first', 'a.mjs', '-old\n+new') });
  const first = bridge.snapshot.items.find(item => item.kind === 'diff'); assert.equal(first.summary.fileCount, 1);
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'diff-turn', item: change('second', 'b.mjs', '+two') });
  const cards = bridge.snapshot.items.filter(item => item.kind === 'diff');
  assert.equal(cards.length, 1); assert.equal(cards[0].summary.fileCount, 2); assert.equal(bridge.hasActivity(first.detailId), false);
  const patch = 'diff --git a/a.mjs b/a.mjs\n--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-old\n+final\n';
  rpc.notification('turn/diff/updated', { threadId: THREAD, turnId: 'diff-turn', diff: patch });
  const latest = bridge.snapshot.items.find(item => item.kind === 'diff');
  assert.equal(latest.summary.fileCount, 2); assert.equal(latest.summary.added, 2); assert.equal(latest.summary.removed, 1);
  const details = JSON.parse((await bridge.readActivity(latest.detailId)).bytes);
  assert.equal(details.files.find(file => file.path === 'a.mjs').diff, patch);
  assert.equal(bridge.hasActivity(cards[0].detailId), false);
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'diff-turn', item: { id: 'diff-final', type: 'agentMessage', phase: 'final_answer', text: '全部完成' } });
  assert.equal(bridge.snapshot.items.at(-1).kind, 'diff');
  assert.equal(bridge.snapshot.items.at(-2).id, 'diff-final', 'a later final response moves the existing diff summary below it');
  rpc.thread.turns.push({ id: 'diff-turn', status: 'completed', items: [{ id: latest.id, type: 'fileChange', status: 'running',
    changes: details.files.map(file => ({ ...file, kind: { type: file.kind } })) },
  { id: 'diff-final', type: 'agentMessage', phase: 'final_answer', text: '全部完成' }] });
  rpc.notification('turn/completed', { threadId: THREAD, turn: { id: 'diff-turn', status: 'completed' } });
  await bridge.refresh();
  rpc.thread.turns = rpc.thread.turns.filter(turn => turn.id !== 'diff-turn'); await bridge.refresh();
  assert.equal(bridge.snapshot.items.some(item => item.kind === 'diff'), false);
  await assert.rejects(bridge.readActivity(latest.detailId), /Unavailable/);
});

test('foreign, unscoped and unknown notifications cannot enter snapshots or cause arbitrary RPC', async t => {
  const { rpc, bridge } = await fixture(t);
  const before = bridge.snapshot;
  const count = rpc.calls.length;
  for (const threadId of ['another-thread', undefined]) {
    rpc.notification('turn/started', { threadId, turn: { id: 'foreign-turn' } });
    rpc.notification('item/started', { threadId, turnId: 'seed', item: { id: 'leak', type: 'agentMessage', text: 'secret' } });
    rpc.notification('item/agentMessage/delta', { threadId, turnId: 'seed', itemId: 'assistant', delta: 'secret' });
    rpc.notification('thread/status/changed', { threadId });
  }
  rpc.notification('evil/arbitraryRpc', { threadId: THREAD, method: 'thread/read', target: 'another-thread' });
  rpc.notification('item/commandExecution/outputDelta', { threadId: THREAD, turnId: 'seed', delta: 'secret' });
  rpc.notification('item/reasoning/textDelta', { threadId: THREAD, turnId: 'seed', delta: 'secret' });
  await delay(130);
  assert.deepEqual(bridge.snapshot, before);
  assert.equal(rpc.calls.length, count);
});

test('live text streams only for known turn and matching assistant item membership', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'live' } });
  assert.equal(bridge.snapshot.status, 'running');
  rpc.notification('item/started', { threadId: THREAD, turnId: 'live', item: { id: 'live-answer', type: 'agentMessage', text: '' } });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'live', itemId: 'live-answer', delta: 'Live ' });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'live', itemId: 'live-answer', delta: 'answer' });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'seed', itemId: 'live-answer', delta: 'wrong-turn' });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'live', itemId: 'missing', delta: 'missing-item' });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'seed', itemId: 'user', delta: 'wrong-role' });
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'seed', item: { id: 'live-answer', type: 'agentMessage', text: 'wrong-turn' } });
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'live', item: { id: 'live-answer', type: 'userMessage', content: [{ type: 'text', text: 'wrong-role' }] } });
  assert.equal(bridge.snapshot.items.at(-1).text, 'Live answer');
  rpc.notification('item/completed', { threadId: THREAD, turnId: 'live', item: { id: 'live-answer', type: 'agentMessage', text: 'Final answer' } });
  assert.equal(bridge.snapshot.items.at(-1).text, 'Final answer');
  rpc.notification('turn/completed', { threadId: THREAD, turn: { id: 'live', status: 'completed' } });
  assert.equal(bridge.snapshot.status, 'idle');
});

test('turn presentation keys are room-local and preserve only native phase, status and bounded duration', async t => {
  const rpc = new FakeRpc();
  rpc.thread.turns[0].durationMs = 1234;
  rpc.thread.turns[0].items[1].phase = 'final_answer';
  rpc.thread.turns[0].items.push({ id: 'work', type: 'agentMessage', text: 'Working', phase: 'commentary' },
    { id: 'unknown-phase', type: 'agentMessage', text: 'Keep visible', phase: 'private-phase' },
    { id: 'cmd', type: 'commandExecution', command: 'synthetic check', status: 'completed', aggregatedOutput: 'ok' });
  const first = new ScopedThread({ rpc, threadId: THREAD });
  const second = new ScopedThread({ rpc: new FakeRpc(), threadId: THREAD });
  t.after(() => { first.close(); second.close(); });
  await first.start(); await second.start();
  const items = first.snapshot.items, key = items[0].turnId;
  assert.ok(items.every(item => item.turnId === key));
  assert.equal(items[0].turnStatus, 'completed'); assert.equal(items[0].turnDurationMs, 1234);
  assert.ok(items.slice(1).every(item => item.turnStatus === undefined && item.turnDurationMs === undefined));
  assert.notEqual(key, second.snapshot.items[0].turnId);
  assert.equal(items.find(item => item.id === 'assistant').phase, 'final_answer');
  assert.equal(items.find(item => item.id === 'work').phase, 'commentary');
  assert.equal(items.find(item => item.id === 'unknown-phase').phase, undefined);
  assert.equal(JSON.stringify(first.snapshot).includes('private-phase'), false);
  assert.equal(JSON.stringify(first.snapshot).includes('"seed"'), false);
  for (const duration of [-1, Infinity, '1234', 7 * 24 * 60 * 60 * 1000 + 1]) {
    rpc.thread.turns[0].durationMs = duration;
    rpc.thread.turns[0].status = 'private-status';
    await first.refresh();
    assert.ok(first.snapshot.items.every(item => item.turnDurationMs === undefined && item.turnStatus === undefined));
  }
});

test('live deltas retain phase and one visible turn anchor updates before history catches up', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'live-metadata' } });
  rpc.notification('item/started', { threadId: THREAD, turnId: 'live-metadata', item: {
    id: 'live-work', type: 'agentMessage', phase: 'commentary', text: 'Start' } });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'live-metadata', itemId: 'live-work', delta: ' progress' });
  rpc.notification('item/started', { threadId: THREAD, turnId: 'live-metadata', item: {
    id: 'live-final', type: 'agentMessage', phase: 'final_answer', text: 'Done' } });
  const before = bridge.snapshot.items.filter(item => item.id.startsWith('live-'));
  assert.equal(before[0].turnStatus, 'running');
  assert.ok(before.every(item => item.turnDurationMs === undefined));
  assert.ok(before.slice(1).every(item => item.turnStatus === undefined));
  assert.equal(before[0].phase, 'commentary'); assert.equal(before[0].text, 'Start progress');
  const key = before[0].turnId;
  rpc.notification('turn/completed', { threadId: THREAD, turn: { id: 'live-metadata', status: 'interrupted', durationMs: 321 } });
  await bridge.refresh();
  const ended = bridge.snapshot.items.filter(item => item.id.startsWith('live-'));
  assert.ok(ended.every(item => item.turnId === key));
  assert.equal(ended[0].turnStatus, 'interrupted'); assert.equal(ended[0].turnDurationMs, 321);
  assert.ok(ended.slice(1).every(item => item.turnStatus === undefined && item.turnDurationMs === undefined));
  rpc.thread.turns.push({ id: 'live-metadata', status: 'interrupted', durationMs: 321, items: [
    { id: 'live-work', type: 'agentMessage', phase: 'commentary', text: 'Start progress' },
    { id: 'live-final', type: 'agentMessage', phase: 'final_answer', text: 'Done' },
  ] });
  await bridge.refresh();
  rpc.thread.turns.pop(); await bridge.refresh();
  assert.ok(!bridge.snapshot.items.some(item => item.turnId === key));
});

test('unknown turn asks only the fixed thread for authoritative state', async t => {
  const { rpc, bridge } = await fixture(t);
  const before = bridge.snapshot.items;
  rpc.notification('item/started', { threadId: THREAD, turnId: 'unrecognized', item: { id: 'injected', type: 'agentMessage', text: 'not-yet-authoritative' } });
  assert.deepEqual(bridge.snapshot.items, before);
  await delay(130);
  assert.deepEqual(rpc.calls.at(-1), { method: 'thread/read', params: { threadId: THREAD, includeTurns: true } });
  assert.deepEqual(bridge.snapshot.items, before);
});

test('server approvals remain unanswered and only emit minimal owner metadata', async t => {
  const { rpc, bridge } = await fixture(t);
  const pending = [], snapshots = [];
  bridge.on('approval-pending', event => pending.push(event));
  bridge.on('snapshot', event => snapshots.push(event));
  for (const threadId of [THREAD, 'another-thread', undefined]) rpc.emit('serverRequest', {
    id: 42, method: 'item/commandExecution/requestApproval', params: {
      threadId, turnId: 'seed', command: 'secret-command', cwd: '/secret/path',
    },
  });
  rpc.emit('serverRequest', { id: 43, method: 'account/chatgptAuthTokens/refresh', params: { threadId: THREAD, secret: 'secret' } });
  assert.deepEqual(pending, [{ type: 'approval-pending', kind: 'item/commandExecution/requestApproval' }]);
  assert.equal(snapshots.length, 0);
  assert.equal(rpc.answers.length, 0);
});

test('approved inputs are scoped, preserve native busy semantics, and deduplicate UUIDs', async t => {
  const { rpc, bridge } = await fixture(t);
  const id = randomUUID();
  const output = await Promise.all([
    bridge.submitApproved('Owner reviewed text', id),
    bridge.submitApproved('Owner reviewed text', id.toUpperCase()),
  ]);
  assert.deepEqual(output, [{ turnId: 'submitted-turn' }, { turnId: 'submitted-turn' }]);
  const starts = rpc.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(starts, [{ method: 'turn/start', params: { threadId: THREAD, input: [{ type: 'text', text: 'Owner reviewed text' }] } }]);
  await assert.rejects(bridge.submitApproved('Other text', id), /different prompt/);
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'submitted-turn' } });
  assert.deepEqual(await bridge.submitApproved('Native steering follow-up', randomUUID()), { turnId: 'submitted-turn' });
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(rpc.calls.filter(call => !['thread/read', 'thread/resume', 'turn/start'].includes(call.method)).length, 0);
});

test('uncertain submission outcomes are retained and never retried', async t => {
  const { rpc, bridge } = await fixture(t);
  const id = randomUUID();
  rpc.handler = method => {
    if (method === 'turn/start') return Promise.reject(new Error('RPC timeout: accepted maybe; secret-server-content'));
  };
  for (let i = 0; i < 2; i++) await assert.rejects(bridge.submitApproved('One uncertain input', id), error => {
    assert.equal(error.code, 'SUBMISSION_UNCERTAIN');
    assert.equal(error.message.includes('secret'), false);
    return /not be retried/.test(error.message);
  });
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  await assert.rejects(bridge.submitApproved('Changed uncertain input', id), /different prompt/);
});

test('submission RPCs serialize and a failed response does not block later owner-approved input', async t => {
  const { rpc, bridge } = await fixture(t);
  let release;
  let turnCalls = 0;
  rpc.handler = method => {
    if (method !== 'turn/start') return;
    if (++turnCalls === 1) return new Promise(resolve => { release = resolve; });
    return { turn: { id: 'second-turn' } };
  };
  const first = bridge.submitApproved('First', randomUUID());
  const failed = assert.rejects(first, { code: 'SUBMISSION_UNCERTAIN' });
  const second = bridge.submitApproved('Second', randomUUID());
  await delay(0);
  assert.equal(turnCalls, 1);
  release({ turn: {} });
  await failed;
  assert.deepEqual(await second, { turnId: 'second-turn' });
});

test('wrong backend thread identity fails closed without publishing unrelated content', async t => {
  const { rpc, bridge } = await fixture(t);
  const snapshots = [];
  bridge.on('snapshot', snapshot => snapshots.push(snapshot));
  rpc.thread.id = 'other-thread';
  rpc.thread.name = 'other-private-title';
  rpc.thread.turns[0].items[1].text = 'other-private-answer';
  await assert.rejects(bridge.refresh(), /different thread/);
  assert.equal(bridge.snapshot.status, 'offline');
  assert.equal(JSON.stringify(snapshots).includes('other-private'), false);
  assert.equal(rpc.listenerCount('notification'), 0);
  await assert.rejects(bridge.submitApproved('New prompt', randomUUID()), /not connected/);
});

test('close detaches listeners without closing owner RPC; disconnected adapter cannot submit', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.emit('closed');
  assert.equal(bridge.snapshot.status, 'offline');
  await assert.rejects(bridge.submitApproved('New prompt', randomUUID()), /not connected/);
  bridge.close();
  assert.equal(rpc.closed, false);
  assert.equal(rpc.listenerCount('notification'), 0);
  assert.equal(rpc.listenerCount('serverRequest'), 0);
  assert.equal(rpc.listenerCount('closed'), 0);
});

test('invalid prompts and request IDs never reach app-server', async t => {
  const { rpc, bridge } = await fixture(t);
  const before = rpc.calls.length;
  for (const prompt of ['', '  ', null, 'x'.repeat(8001)]) await assert.rejects(bridge.submitApproved(prompt, randomUUID()), /Prompt/);
  for (const id of ['', 'arbitrary', null]) await assert.rejects(bridge.submitApproved('Text', id), /UUID/);
  assert.equal(rpc.calls.length, before);
});

test('snapshot budget preserves newest messages and explicitly labels omitted history', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.thread.name = '长'.repeat(10000);
  rpc.thread.turns[0].items = [
    { id: 'too-old', type: 'agentMessage', text: 'old secret history' },
    { id: 'large', type: 'agentMessage', text: '😀中文\\\"'.repeat(15000) },
    { id: 'latest', type: 'agentMessage', text: 'Latest message stays complete' },
  ];
  await bridge.refresh();
  const snapshot = bridge.snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 48 * 1024);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.items.at(-1).text, 'Latest message stays complete');
  assert.equal(snapshot.items.some(item => item.id === 'too-old'), false);
  assert.ok(snapshot.items[0].text.length > 0);
  assert.equal(/[\uDC00-\uDFFF]/.test(snapshot.items[0].text[0]), false);
});

test('a 412-item Chinese history keeps old seven-file Diff and late ChatGPT input ahead of small tool rows', async t => {
  const rpc = new FakeRpc(), bodies = new Map();
  const user = (id, text, extra = {}) => { bodies.set(id, text); return { id, type: 'userMessage', content: [{ type: 'text', text }], ...extra }; };
  const assistant = (id, text, phase) => { bodies.set(id, text); return { id, type: 'agentMessage', text, phase }; };
  const changes = count => Array.from({ length: count }, (_, i) => ({ path: `synthetic/view-${i}.dart`, kind: { type: 'update' },
    diff: `--- a/synthetic/view-${i}.dart\n+++ b/synthetic/view-${i}.dart\n@@ -1 +1 @@\n-old\n+new\n` }));
  rpc.thread.turns = Array.from({ length: 4 }, (_, turn) => {
    const items = [user(`user-${turn}`, turn === 0 ? '## 合成用户计划\n\n' + '计划正文'.repeat(250) : `合成用户输入 ${turn}`)];
    if (turn === 3) items.push(user('review-user', '合成 reviewInput latest-user marker', { source: { kind: 'chatgpt' } }));
    for (let i = 0; i < (turn === 3 ? 7 : 6); i++) items.push(assistant(`assistant-${turn}-${i}`,
      `${turn === 1 && i === 0 ? 'afterUnlock marker' : '合成进度'}\n` + '中文正文'.repeat(100), i === 5 ? 'final_answer' : 'commentary'));
    if (turn !== 1) items.push({ id: `diff-${turn}`, type: 'fileChange', status: 'completed', changes: changes(turn === 0 ? 7 : turn === 2 ? 1 : 3) });
    if (turn === 0) items.push({ id: 'important-plan', type: 'plan', text: '合成计划正文'.repeat(100) });
    for (let i = 0; i < (turn === 3 ? 78 : 100); i++) items.push({ id: `command-${turn}-${i}`, type: 'commandExecution', status: 'completed',
      command: `synthetic check ${turn}-${i}`, aggregatedOutput: 'ok' });
    return { id: `turn-${turn}`, status: 'completed', durationMs: 478999 + turn, items };
  });
  assert.equal(rpc.thread.turns.reduce((count, turn) => count + turn.items.length, 0), 412);
  const bridge = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => bridge.close()); await bridge.start();
  const snapshot = bridge.snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 48 * 1024);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.items.filter(item => item.role !== 'activity').length, bodies.size);
  for (const [id, text] of bodies) assert.equal(snapshot.items.find(item => item.id === id)?.text, text, `${id} keeps its full source text`);
  assert.equal(snapshot.items.find(item => item.id === 'review-user').source.kind, 'chatgpt');
  const diffs = snapshot.items.filter(item => item.kind === 'diff');
  assert.equal(diffs.length, 3);
  assert.deepEqual(await Promise.all(diffs.map(async item => JSON.parse((await bridge.readActivity(item.detailId)).bytes).files.length)), [7, 1, 3]);
  assert.ok(snapshot.items.some(item => item.kind === 'plan'));
  assert.equal(snapshot.items.filter(item => item.turnDurationMs !== undefined).length, 4);
  for (const turnId of new Set(snapshot.items.map(item => item.turnId))) {
    const group = snapshot.items.filter(item => item.turnId === turnId);
    assert.equal(group[0].turnStatus, 'completed');
    assert.ok(group.slice(1).every(item => item.turnStatus === undefined && item.turnDurationMs === undefined));
  }
  if (snapshot.omittedActivities !== undefined) assert.ok(snapshot.omittedActivities > 0);
  const oldDetailId = diffs[0].detailId;
  rpc.thread.turns[0].items = rpc.thread.turns[0].items.filter(item => item.type !== 'fileChange');
  await bridge.refresh(); await assert.rejects(bridge.readActivity(oldDetailId));
});

test('oversized activity previews degrade to readable Diff and plan handles without changing the latest body', async t => {
  const rpc = new FakeRpc(), body = '中'.repeat(15750), plan = '合成计划细节'.repeat(1000);
  rpc.thread.turns = [{ id: 'long', status: 'completed', durationMs: 1234, items: [
    { id: 'latest', type: 'agentMessage', phase: 'final_answer', text: body },
    { id: 'important-diff', type: 'fileChange', status: 'completed', changes: Array.from({ length: 7 }, (_, i) => ({
      path: `synthetic/${'文'.repeat(220)}-${i}.dart`, kind: { type: 'update' }, diff: '-old\n+new\n' })) },
    { id: 'important-plan', type: 'plan', text: plan },
  ] }];
  const bridge = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => bridge.close()); await bridge.start();
  const snapshot = bridge.snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 48 * 1024);
  assert.equal(snapshot.items.find(item => item.id === 'latest').text, body);
  const diff = snapshot.items.find(item => item.kind === 'diff'), planCard = snapshot.items.find(item => item.kind === 'plan');
  assert.ok(diff); assert.ok(planCard);
  assert.equal(diff.summary, undefined, 'large summaries cannot replace the read handle');
  assert.equal(JSON.parse((await bridge.readActivity(diff.detailId)).bytes).files.length, 7);
  assert.equal(JSON.parse((await bridge.readActivity(planCard.detailId)).bytes).text, plan);
});

test('a body that leaves no room for an important handle is explicit and does not substitute a smaller tool card', async t => {
  const rpc = new FakeRpc(), body = '中'.repeat(16174);
  rpc.thread.turns = [{ id: 'full', status: 'completed', durationMs: 1000, items: [
    { id: 'latest', type: 'agentMessage', phase: 'final_answer', text: body },
    { id: 'important', type: 'fileChange', status: 'completed', changes: Array.from({ length: 7 }, (_, i) => ({
      path: `synthetic/${i}.js`, kind: { type: 'update' }, diff: '-old\n+new\n' })) },
    { id: 'small', type: 'mcpToolCall', server: 's', tool: 'x', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } },
  ] }];
  const bridge = new ScopedThread({ rpc, threadId: THREAD }); t.after(() => bridge.close()); await bridge.start();
  const snapshot = bridge.snapshot;
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 48 * 1024);
  assert.equal(snapshot.items.find(item => item.id === 'latest').text, body);
  assert.equal(snapshot.items.some(item => item.role === 'activity'), false);
  assert.equal(snapshot.omittedActivities, 2); assert.equal(snapshot.historyTruncated, true);
  const unadvertised = bridge._snapshot.items.find(item => item.kind === 'diff');
  await assert.rejects(bridge.readActivity(unadvertised.detailId));
});

test('bounded idempotency cache refuses new submissions rather than forgetting old accepted IDs', async t => {
  const { rpc, bridge } = await fixture(t);
  const firstId = randomUUID();
  await bridge.submitApproved('First request', firstId);
  for (let i = 1; i < 1000; i++) await bridge.submitApproved('Bounded request', randomUUID());
  await assert.rejects(bridge.submitApproved('Beyond capacity', randomUUID()), /Submission limit/);
  assert.deepEqual(await bridge.submitApproved('First request', firstId), { turnId: 'submitted-turn' });
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1000);
});

test('refresh does not overwrite a live delta with a stale read response', async t => {
  const { rpc, bridge } = await fixture(t);
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'live' } });
  rpc.notification('item/started', { threadId: THREAD, turnId: 'live', item: { id: 'streamed', type: 'agentMessage', text: '' } });
  let release;
  rpc.handler = method => method === 'thread/read' ? new Promise(resolve => { release = resolve; }) : undefined;
  const refresh = bridge.refresh();
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'live', itemId: 'streamed', delta: 'Newer live answer' });
  release({ thread: structuredClone(rpc.thread) });
  await refresh;
  assert.equal(bridge.snapshot.items.at(-1).text, 'Newer live answer');
});

test('authorization revoked while queued prevents dispatch and cannot be retried under the same ID', async t => {
  const { rpc, bridge } = await fixture(t);
  let release;
  rpc.handler = method => method === 'turn/start' ? new Promise(resolve => { release = resolve; }) : undefined;
  const first = bridge.submitApproved('Already dispatched', randomUUID());
  let admitted = true;
  const queuedId = randomUUID();
  const queued = bridge.submitApproved('Revoke before dispatch', queuedId, { canDispatch: () => admitted });
  const rejection = assert.rejects(queued, { code: 'SUBMISSION_REVOKED' });
  await delay(0);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  admitted = false;
  release({ turn: { id: 'first-turn' } });
  await first;
  await rejection;
  await assert.rejects(bridge.submitApproved('Revoke before dispatch', queuedId, { canDispatch: () => true }), { code: 'SUBMISSION_REVOKED' });
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a lagging history read during an external turn must retain streamed assistant text and delta membership', async t => {
  const { rpc, bridge } = await fixture(t);
  const turnId = 'desktop-started-turn';
  const user = { id: 'desktop-user', type: 'userMessage', content: [{ type: 'text', text: 'Only reply desktop-to-phone-ok' }] };
  // Simulate the persistent history containing the user message while live
  // assistant events are already ahead of that read snapshot.
  rpc.thread.turns.push({ id: turnId, status: 'inProgress', items: [user] });
  rpc.thread.status = { type: 'active' };
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: turnId } });
  rpc.notification('item/started', { threadId: THREAD, turnId, item: user });
  rpc.notification('item/started', { threadId: THREAD, turnId, item: { id: 'desktop-answer', type: 'agentMessage', text: '' } });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'desktop-answer', delta: 'desktop-' });
  // No event arrives while this request is pending: the old _change check
  // cannot detect that the returned history was already stale at dispatch.
  await bridge.refresh();
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'desktop-answer', delta: 'to-phone-ok' });
  assert.equal(bridge.snapshot.items.find(item => item.id === 'desktop-answer')?.text, 'desktop-to-phone-ok');
  assert.equal(bridge.snapshot.status, 'running');
});

test('completion reconciliation must not replace an observed final answer with user-only lagging history', async t => {
  const { rpc, bridge } = await fixture(t);
  const turnId = 'desktop-completed-turn';
  const user = { id: 'external-user', type: 'userMessage', content: [{ type: 'text', text: 'Only reply desktop-to-phone-ok' }] };
  const answer = { id: 'external-answer', type: 'agentMessage', text: 'desktop-to-phone-ok' };
  rpc.thread.turns.push({ id: turnId, status: 'inProgress', items: [user] });
  rpc.thread.status = { type: 'active' };
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: turnId } });
  rpc.notification('item/started', { threadId: THREAD, turnId, item: user });
  rpc.notification('item/started', { threadId: THREAD, turnId, item: { ...answer, text: '' } });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: answer.id, delta: answer.text });
  rpc.notification('item/completed', { threadId: THREAD, turnId, item: answer });
  rpc.notification('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'completed' } });
  assert.equal(bridge.snapshot.items.at(-1).text, answer.text);
  // Wait for the real 100 ms completion-triggered reconciliation. There are
  // no more events to repair a final answer if a stale read removes it now.
  await delay(150);
  assert.equal(bridge.snapshot.items.find(item => item.id === answer.id)?.text, answer.text);
  assert.equal(bridge.snapshot.status, 'idle');
});

test('reconciled event overlays are released so a subsequent history rollback can remove the turn', async t => {
  const { rpc, bridge } = await fixture(t);
  const turnId = 'reconciled';
  const answer = { id: 'reconciled-answer', type: 'agentMessage', text: 'Final persisted answer' };
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: turnId } });
  rpc.notification('item/completed', { threadId: THREAD, turnId, item: answer });
  rpc.notification('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'completed' } });
  // Persistence catches up and acknowledges all observed text plus completion.
  rpc.thread.turns.push({ id: turnId, status: 'completed', items: [answer] });
  await bridge.refresh();
  assert.equal(bridge.snapshot.items.at(-1).text, answer.text);
  assert.equal(bridge._liveTurns.size, 0);
  assert.equal(bridge._liveTextBytes, 0);
  assert.equal(bridge._liveItems, 0);
  // This is a rollback after reconciliation, not a lagging read during streaming.
  rpc.thread.turns.pop();
  await bridge.refresh();
  assert.equal(bridge.snapshot.items.some(item => item.id === answer.id), false);
});

test('unreconciled live overlays have a fixed memory budget and fail closed instead of dropping events', async t => {
  const { rpc, bridge } = await fixture(t);
  const faults = [];
  bridge.on('fault', fault => faults.push(fault));
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: 'oversized' } });
  rpc.notification('item/started', { threadId: THREAD, turnId: 'oversized', item: { id: 'huge', type: 'agentMessage', text: '' } });
  rpc.notification('item/agentMessage/delta', { threadId: THREAD, turnId: 'oversized', itemId: 'huge', delta: 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.equal(bridge.snapshot.status, 'offline');
  assert.deepEqual(faults, [{ code: 'live-buffer-limit' }]);
  assert.equal(rpc.listenerCount('notification'), 0);
  assert.equal(bridge._liveTextBytes, 0);
  assert.equal(bridge._liveItems, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(bridge.snapshot)) < 48 * 1024);
});

test('room author attribution survives event-before-response, persisted refresh and snapshot bounds without changing the prompt', async t => {
  const rpc = new FakeRpc();
  const bridge = new ScopedThread({ rpc, threadId: THREAD, ownerName: '分享者阿明' });
  t.after(() => bridge.close());
  await bridge.start();
  assert.equal(bridge.snapshot.items[0].author.name, '历史消息 · 作者未知');
  const turnId = 'same-busy-turn';
  const raw = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
  rpc.notification('turn/started', { threadId: THREAD, turn: { id: turnId } });
  rpc.notification('item/started', { threadId: THREAD, turnId, item: raw('owner-user', '分享者输入') });
  assert.equal(bridge.snapshot.items.at(-1).author.name, '分享者阿明');
  let release;
  rpc.handler = method => method === 'turn/start' ? new Promise(resolve => { release = resolve; }) : undefined;
  const author = { id: 'room-participant', name: '协作者小林', kind: 'guest' };
  const promise = bridge.submitApproved('原始建议', randomUUID(), { author });
  await delay(0);
  rpc.notification('item/started', { threadId: THREAD, turnId, item: raw('guest-user', '原始建议') });
  assert.equal(bridge.snapshot.items.at(-1).author.name, '作者待确认');
  release({ turn: { id: turnId } });
  await promise;
  assert.deepEqual(bridge.snapshot.items.at(-1).author, author);
  assert.deepEqual(rpc.calls.find(c => c.method === 'turn/start').params, { threadId: THREAD, input: [{ type: 'text', text: '原始建议' }] });
  rpc.thread.turns.push({ id: turnId, status: 'completed', items: [raw('owner-user', '分享者输入'), raw('guest-user', '原始建议')] });
  await bridge.refresh();
  assert.deepEqual(bridge.snapshot.items.at(-1).author, author);
  const copy = bridge.snapshot;
  copy.items.at(-1).author.name = '不能修改内部状态';
  assert.equal(bridge.snapshot.items.at(-1).author.name, '协作者小林');
  for (let i = 0; i < 500; i++) rpc.thread.turns.at(-1).items.push(raw(`large-${i}`, '正文'.repeat(100)));
  await bridge.refresh();
  assert.ok(Buffer.byteLength(JSON.stringify(bridge.snapshot)) < 48 * 1024);
  assert.equal(bridge.snapshot.historyTruncated, true);
});
