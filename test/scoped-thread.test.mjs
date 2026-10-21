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
  assert.deepEqual(bridge.snapshot.items, [
    { id: 'user', role: 'user', text: 'Hello' }, { id: 'assistant', role: 'assistant', text: 'Ready' },
  ]);
  assert.equal(bridge.snapshot.status, 'idle');
  assert.equal(bridge.snapshot.title, 'Shared test');
  assert.equal(JSON.stringify(snapshots).includes('secret'), false);
  assert.equal(JSON.stringify(snapshots).includes(THREAD), false);
  const copy = bridge.snapshot;
  copy.items[0].text = 'changed by caller';
  assert.equal(bridge.snapshot.items[0].text, 'Hello');
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
