import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { GuestUploads } from '../lib/guest-uploads.mjs';
import { createDesktopUploadHistory } from '../lib/desktop-upload-history.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { attachDesktopApp, desktopAppCapabilities } from '../lib/desktop-app-adapter.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const page = (id = THREAD, turns = [], nextCursor = null) => ({ schemaVersion: 1,
  thread: { id, hostId: 'local', title: '合成会话', status: { type: 'idle' }, preview: 'do not project', cwd: '/synthetic' },
  page: { order: 'newest_first', limit: 10, nextCursor, hasMore: nextCursor !== null }, turns });
const turn = (id, items = []) => ({ id, status: 'completed', durationMs: 5, items });
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });

class Bridge extends EventEmitter {
  ready = Promise.resolve();
  connected = true;
  selected = new Set();
  selections = [];
  reads = [];
  handler = async id => page(id);
  async selectThread(id) { this.selections.push(id); this.selected.add(id); }
  async readPage(id, options) {
    assert.ok(this.selected.has(id));
    this.reads.push({ id, ...options }); return this.handler(id, options);
  }
  disconnect() { this.connected = false; this.emit('disconnected'); }
  async reconnect() { this.connected = false; }
  close() { this.connected = false; this.emit('closed'); }
}

async function fixture(t, options = {}) {
  const bridge = options.bridge ?? new Bridge(), calls = [], indexed = new Set([THREAD, OTHER]);
  const catalog = { contains: async id => indexed.has(id), list: async () => [...indexed].map(id => ({ id, name: '合成目录项' })) };
  const queue = options.queue ?? { async submit(p) {
    if (!p.canDispatch()) throw Object.assign(new Error('revoked'), { code: 'SUBMISSION_REVOKED', outcome: 'notSubmitted' });
    calls.push(p); return { id: 'native-queue-id', clientUserMessageId: p.clientUserMessageId, wakePending: false };
  } };
  const attachment = await attachDesktopApp({ bridge, catalog, queue, ...options });
  t.after(() => attachment.close());
  return { bridge, calls, indexed, attachment };
}
const submit = (rpc, input = [{ type: 'text', text: '合成访客输入' }], options = { canDispatch: () => true }) =>
  rpc.request('turn/start', { threadId: THREAD, input, clientUserMessageId: CLIENT }, options);

test('catalog membership and explicit selection precede all body reads', async t => {
  const { bridge, attachment, indexed } = await fixture(t);
  const rpc = await attachment.rpcFactory();
  await assert.rejects(rpc.request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_SCOPE' });
  assert.equal(bridge.reads.length, 0);
  indexed.delete(OTHER);
  await assert.rejects(attachment.selectThread(OTHER), { code: 'DESKTOP_APP_SCOPE' });
  assert.deepEqual(bridge.selections, []);
  await attachment.selectThread(THREAD);
  assert.equal((await rpc.request('thread/read', { threadId: THREAD })).thread.id, THREAD);
  assert.equal(bridge.reads.every(call => call.id === THREAD), true);
  assert.equal(attachment.read, undefined);
});

test('pagination preserves complete text and stable IDs without invented identity or attachment capabilities', async t => {
  const bridge = new Bridge();
  const body = '  合成正文\n' + '长'.repeat(22000) + '\n  ';
  const original = { ...user('user-new', body), clientId: CLIENT, createdAt: 123, messageMetadata: { secret: true },
    attachments: [{ fsPath: '/synthetic/private.txt' }], content: [
      { type: 'text', text: body, codexDelegation: { sourceThreadId: OTHER } },
      { type: 'localImage', path: '/synthetic/safe.png' },
      { type: 'mention', name: 'not-an-attachment', path: '/synthetic/private.txt' },
      { type: 'localFile', path: '/synthetic/private.txt' },
      { type: 'image', url: 'data:image/png;base64,AAAA', fileId: 'opaque' }, null,
    ] };
  bridge.handler = async (id, { cursor }) => cursor
    ? page(id, [turn('old', [user('user-old', '历史合成消息')])])
    : page(id, [turn('new', [original, { id: 'assistant', type: 'agentMessage', text: body, phase: 'commentary' },
      { id: 'reasoning', type: 'reasoning', content: ['private reasoning'] },
      { id: 'child', type: 'collabAgentToolCall', receiverThreadIds: [OTHER] }])], 'older');
  const { attachment } = await fixture(t, { bridge });
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory(), { thread } = await rpc.request('thread/read', { threadId: THREAD, includeTurns: true });
  assert.deepEqual(thread.turns.map(t => t.id), ['old', 'new']);
  assert.equal(thread.turns[1].items[0].content[0].text, body);
  assert.deepEqual(thread.turns[1].items[0].content, [{ type: 'text', text: body }, { type: 'localImage', path: '/synthetic/safe.png' }]);
  assert.equal(thread.turns[1].items[0].clientId, undefined);
  assert.equal(thread.turns[1].items[0].createdAt, undefined);
  assert.equal(thread.turns[1].items[1].text, body);
  assert.equal(thread.turns[1].items.length, 2);
  assert.equal(thread.preview, undefined);
  assert.equal(thread.historyTruncated, undefined);
  assert.deepEqual(bridge.reads[0], { id: THREAD, turnLimit: 10, includeTurns: true, includeOutputs: true, maxOutputCharsPerItem: 20000 });
});

test('clients bind one previously selected thread even when the manager shares several', async t => {
  const { attachment } = await fixture(t);
  await attachment.selectThread(THREAD); await attachment.selectThread(OTHER);
  const a = await attachment.rpcFactory(), b = await attachment.rpcFactory();
  assert.equal((await a.request('thread/resume', { threadId: THREAD })).thread.id, THREAD);
  assert.equal((await b.request('thread/read', { threadId: OTHER })).thread.id, OTHER);
  await assert.rejects(a.request('thread/read', { threadId: OTHER }), { code: 'DESKTOP_APP_SCOPE' });
  await assert.rejects(a.request('thread/list', {}), { code: 'DESKTOP_APP_METHOD' });
  await assert.rejects(a.request('thread/read', { threadId: THREAD, cwd: '/elsewhere' }), { code: 'DESKTOP_APP_OPTIONS' });
  await assert.rejects(a.request('thread/read', { threadId: THREAD }, { model: 'another' }), { code: 'DESKTOP_APP_OPTIONS' });
});

test('native queued acknowledgement is immediate and never fabricates a turn or input readback', async t => {
  const { attachment, calls } = await fixture(t);
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory();
  const result = await submit(rpc);
  assert.deepEqual(result, { queued: { id: 'native-queue-id', clientUserMessageId: CLIENT }, wakePending: false });
  assert.equal(result.turn, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, [{ type: 'text', text: '合成访客输入', text_elements: [] }]);
  assert.equal(rpc.supportsClientMessageId, true);
  assert.equal(rpc.capabilities.authorBinding, false);
  assert.equal(rpc.supportsUploadedAttachments, true);
  assert.equal(rpc.canUploadAttachments(), false);
  assert.throws(() => rpc.validateUploadedAttachments(), { code: 'DESKTOP_APP_UPLOAD_UNAVAILABLE' });
  assert.equal(attachment.capabilities, desktopAppCapabilities);
});

test('queue authorization is rechecked after asynchronous worker preparation', async t => {
  let permitted = true, writes = 0, release;
  const prepared = new Promise(resolve => { release = resolve; });
  const { attachment } = await fixture(t, { queue: { async submit(p) {
    await prepared;
    if (!p.canDispatch()) throw Object.assign(new Error('revoked'), { code: 'SUBMISSION_REVOKED' });
    writes++; return { id: 'queue', clientUserMessageId: p.clientUserMessageId, wakePending: false };
  } } });
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory(), pending = submit(rpc, undefined, { canDispatch: () => permitted });
  permitted = false; release();
  await assert.rejects(pending, { code: 'SUBMISSION_REVOKED' });
  assert.equal(writes, 0);
  await assert.rejects(submit(rpc, undefined, {}), { code: 'SUBMISSION_REVOKED' });
});

test('unsupported inputs and execution options never reach the queue', async t => {
  const { attachment, calls } = await fixture(t);
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory();
  for (const input of [[{ type: 'localImage', path: '/synthetic/a.png' }], [{ type: 'text', text: 'x', text_elements: [{}] }],
    [{ type: 'text', text: ' ' }], [{ type: 'text', text: 'a'.repeat(8001) }]]) {
    await assert.rejects(submit(rpc, input), { code: 'DESKTOP_APP_OPTIONS' });
  }
  await assert.rejects(rpc.request('turn/start', { threadId: THREAD, input: [{ type: 'text', text: 'x' }], model: 'other' }, { canDispatch: () => true }), { code: 'DESKTOP_APP_OPTIONS' });
  await assert.rejects(rpc.request('turn/start', { threadId: THREAD, input: [{ type: 'text', text: 'x' }], attachments: [] }, { canDispatch: () => true }), { code: 'DESKTOP_APP_OPTIONS' });
  assert.equal(calls.length, 0);
});

test('unknown enqueue outcomes are not retried and a confirmed enqueue survives wake failure', async t => {
  let calls = 0;
  const error = Object.assign(new Error('lost reply'), { code: 'QUEUE_UNKNOWN', outcome: 'unknown' });
  const { attachment } = await fixture(t, { queue: { async submit() { calls++; throw error; } } });
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory();
  await assert.rejects(submit(rpc), caught => caught === error);
  assert.equal(calls, 1);
  const second = await fixture(t, { queue: { async submit(p) { return { id: 'queued', clientUserMessageId: p.clientUserMessageId, wakePending: true }; } } });
  await second.attachment.selectThread(THREAD);
  assert.equal((await submit(await second.attachment.rpcFactory())).wakePending, true);
});

test('changed queue acknowledgement identity is uncertain, never accepted', async t => {
  const { attachment } = await fixture(t, { queue: { async submit() { return { id: 'queue', clientUserMessageId: OTHER, wakePending: false }; } } });
  await attachment.selectThread(THREAD);
  await assert.rejects(submit(await attachment.rpcFactory()), { code: 'SUBMISSION_UNCERTAIN', outcome: 'unknown' });
});

test('poll notifications carry only the bound target and stop after disconnect', async t => {
  const { attachment, bridge } = await fixture(t, { pollIntervalMs: 10 });
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory();
  await rpc.request('thread/read', { threadId: THREAD });
  // The production poller is unref'ed. Keep the synthetic client alive until its notification arrives.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);
  const [notification] = await once(rpc, 'notification', { signal: controller.signal }).finally(() => clearTimeout(deadline));
  assert.deepEqual(notification, { method: 'thread/status/changed', params: { threadId: THREAD } });
  const closed = once(rpc, 'closed'); bridge.disconnect(); await closed;
  let count = 0; rpc.on('notification', () => count++);
  await delay(30); assert.equal(count, 0);
  await assert.rejects(attachment.rpcFactory(), { code: 'DESKTOP_APP_DISCONNECTED' });
});

test('disconnect invalidates an in-flight snapshot and local queue authorization', async t => {
  const { attachment, bridge } = await fixture(t);
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory();
  let release;
  bridge.handler = () => new Promise(resolve => { release = resolve; });
  const pending = rpc.request('thread/read', { threadId: THREAD });
  bridge.disconnect(); release(page());
  await assert.rejects(pending, { code: 'DESKTOP_APP_DISCONNECTED' });
  assert.equal(rpc.closed, true);
});

test('canceled manager selection does not authorize a later read', async t => {
  const { attachment, bridge } = await fixture(t);
  let current = true;
  bridge.handler = async id => { current = false; return page(id); };
  await assert.rejects(attachment.selectThread(THREAD, { canContinue: () => current }), { code: 'DESKTOP_APP_SCOPE' });
  await assert.rejects((await attachment.rpcFactory()).request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_SCOPE' });
});

test('wrong scopes, repeated cursors and reused item IDs fail closed', async t => {
  for (const handler of [
    async () => page(OTHER),
    async id => page(id, [], 'same-cursor'),
    async id => page(id, [turn('one', [user('same-item', 'a')]), turn('two', [user('same-item', 'b')])]),
  ]) {
    const bridge = new Bridge(); bridge.handler = handler;
    const { attachment } = await fixture(t, { bridge });
    await assert.rejects(attachment.selectThread(THREAD), { code: 'DESKTOP_APP_INCOMPATIBLE' });
  }
});

test('overlapping history pages keep the latest authoritative version', async t => {
  const bridge = new Bridge();
  bridge.handler = async (id, { cursor }) => cursor
    ? page(id, [turn('new', [user('new-user', 'stale')]), turn('old', [user('old-user', 'older')])])
    : page(id, [turn('new', [user('new-user', 'latest')])], 'older');
  const { attachment } = await fixture(t, { bridge }); await attachment.selectThread(THREAD);
  const { thread } = await (await attachment.rpcFactory()).request('thread/read', { threadId: THREAD });
  assert.deepEqual(thread.turns.map(t => t.id), ['old', 'new']);
  assert.equal(thread.turns[1].items[0].content[0].text, 'latest');
});

test('activity truncation is preserved and incomplete delegation is not leaked', async t => {
  const bridge = new Bridge(); bridge.handler = async id => page(id, [turn('turn', [
    { id: 'command', type: 'commandExecution', command: 'synthetic-command', commandTruncated: true, output: { text: 'partial', truncated: true }, status: 'completed' },
    { id: 'diff', type: 'fileChange', changes: [{ path: '/synthetic/a', kind: { type: 'update' }, diff: { text: '+partial', truncated: true } }], status: 'completed' },
    { id: 'delegation', type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: `<codex_delegation><source_thread_id>${OTHER}`, truncated: true } },
  ])]);
  const { attachment } = await fixture(t, { bridge }); await attachment.selectThread(THREAD);
  const { thread } = await (await attachment.rpcFactory()).request('thread/read', { threadId: THREAD });
  assert.equal(thread.turns[0].items.length, 2);
  assert.equal(thread.turns[0].items[0].activityTruncated, true);
  assert.equal(thread.turns[0].items[0].aggregatedOutput, 'partial');
  assert.equal(thread.turns[0].items[1].activityTruncated, true);
  assert.ok(!JSON.stringify(thread).includes(OTHER));
});

test('size-like error messages without the safe code never trigger a weaker read', async t => {
  const bridge = new Bridge();
  bridge.handler = async () => { throw new Error('Tool response exceeds the size limit. Request fewer turns.'); };
  const { attachment } = await fixture(t, { bridge });
  await assert.rejects(attachment.selectThread(THREAD), /Tool response exceeds/);
  assert.equal(bridge.reads.length, 1);
  await assert.rejects((await attachment.rpcFactory()).request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_SCOPE' });
});

test('safe oversized response codes reduce the page size and reject an oversized single turn', async t => {
  const bridge = new Bridge();
  const oversized = () => Object.assign(new Error('The tool response is unavailable.'), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  bridge.handler = async (id, { turnLimit }) => {
    if (turnLimit > 1) throw oversized();
    return page(id, [turn('one', [user('u', 'complete')])]);
  };
  const { attachment } = await fixture(t, { bridge }); await attachment.selectThread(THREAD);
  assert.deepEqual(bridge.reads.map(r => r.turnLimit), [10, 1]);
  bridge.handler = async () => { throw oversized(); };
  const rpc = await attachment.rpcFactory();
  await assert.rejects(rpc.request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_TURN_TOO_LARGE' });
  assert.deepEqual(bridge.reads.slice(-3).map(({ turnLimit, includeOutputs, maxOutputCharsPerItem }) => ({ turnLimit, includeOutputs, maxOutputCharsPerItem })), [
    { turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 },
    { turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 20000 },
    { turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 },
  ]);
  assert.equal(rpc.closed, true);
});

test('omitting oversized execution details preserves same-cursor text, continues older pages and reports limits', async t => {
  const bridge = new Bridge();
  const text = 'Unmodified synthetic user input\n<xml>body</xml>';
  bridge.handler = async (id, options) => {
    if (!options.cursor && options.includeOutputs) throw Object.assign(new Error('Safe size code'), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
    if (options.cursor === 'older') return page(id, [turn('older-turn', [user('older-input', 'Older input')])]);
    return page(id, [turn('newest-turn', [user('user-text', text),
      { id: 'command', type: 'commandExecution', command: 'synthetic', status: 'completed' },
      { id: 'assistant-text', type: 'agentMessage', text: 'Unmodified response\nwith details' }])], 'older');
  };
  const { attachment } = await fixture(t, { bridge }); await attachment.selectThread(THREAD);
  const { thread } = await (await attachment.rpcFactory()).request('thread/read', { threadId: THREAD });
  assert.equal(thread.historyTruncated, true); assert.equal(thread.historyDetailsOmitted, true);
  assert.deepEqual(thread.turns.map(turn => turn.id), ['older-turn', 'newest-turn']);
  assert.equal(thread.turns[1].items[0].content[0].text, text);
  assert.equal(thread.turns[1].items[1].activityTruncated, true);
  assert.equal(thread.turns[1].items[2].text, 'Unmodified response\nwith details');
  assert.deepEqual(bridge.reads.slice(0, 4).map(({ cursor, turnLimit, includeOutputs, maxOutputCharsPerItem }) =>
    [cursor ?? null, turnLimit, includeOutputs, maxOutputCharsPerItem]), [
    [null, 10, true, 20000], [null, 1, true, 20000], [null, 1, false, 0], ['older', 10, true, 20000],
  ]);
  assert.ok(bridge.reads.every(read => read.id === THREAD));
});

test('unrelated errors at every fallback stage abort without skipping a page or authorizing the scope', async t => {
  for (const failureStage of [0, 1, 2]) {
    const bridge = new Bridge(); let stage = 0;
    bridge.handler = async () => { throw Object.assign(new Error('Synthetic failure'), {
      code: stage++ === failureStage ? 'desktop_read_failed' : 'DESKTOP_APP_RESPONSE_TOO_LARGE',
    }); };
    const { attachment } = await fixture(t, { bridge });
    await assert.rejects(attachment.selectThread(THREAD), { code: 'desktop_read_failed' });
    assert.equal(bridge.reads.length, failureStage + 1);
    await assert.rejects((await attachment.rpcFactory()).request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_SCOPE' });
  }
});

test('bounded history explicitly reports that older pages remain', async t => {
  const bridge = new Bridge();
  bridge.handler = async (id, { cursor }) => {
    const index = Number(cursor ?? 0);
    return page(id, [turn(`turn-${index}`, [user(`user-${index}`, `synthetic ${index}`)])], String(index + 1));
  };
  const { attachment } = await fixture(t, { bridge }); await attachment.selectThread(THREAD);
  const { thread } = await (await attachment.rpcFactory()).request('thread/read', { threadId: THREAD });
  assert.equal(thread.historyTruncated, true);
  assert.equal(thread.turns.length, 256);
  assert.equal(thread.turns.at(-1).id, 'turn-0');
});

test('reconnect launches only the bridge and requires manager reselection without enqueue replay', async t => {
  let launches = 0;
  const bridge = new Bridge();
  const { attachment, calls } = await fixture(t, { bridge, launchBridge: async () => { launches++; bridge.connected = true; bridge.emit('connected'); } });
  await attachment.selectThread(THREAD); await submit(await attachment.rpcFactory());
  await attachment.reconnect();
  assert.equal(launches, 1); assert.equal(calls.length, 1);
  await assert.rejects((await attachment.rpcFactory()).request('thread/read', { threadId: THREAD }), { code: 'DESKTOP_APP_SCOPE' });
  await attachment.selectThread(THREAD);
  assert.equal((await (await attachment.rpcFactory()).request('thread/read', { threadId: THREAD })).thread.id, THREAD);
});

test('attachment close is idempotent and waits for bridge cleanup', async t => {
  const { attachment, bridge } = await fixture(t);
  let resolveClose, closedCalls = 0, settled = false;
  bridge.close = () => { closedCalls++; return new Promise(resolve => { resolveClose = resolve; }); };
  const first = attachment.close(), second = attachment.close();
  assert.equal(first, second);
  first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(closedCalls, 1); assert.equal(settled, false);
  await assert.rejects(attachment.rpcFactory(), { code: 'DESKTOP_APP_DISCONNECTED' });
  resolveClose(); await first;
  assert.equal(settled, true);
  assert.equal(attachment.close(), first);
});

test('attachment forwards real bridge recovery once and removes connection listeners on close', async t => {
  const bridge = new Bridge();
  const { attachment } = await fixture(t, { bridge, launchBridge: async () => {
    bridge.connected = true; bridge.emit('connected');
  } });
  let recoveries = 0; attachment.on('connected', () => { recoveries++; });
  bridge.disconnect(); bridge.connected = true; bridge.emit('connected');
  assert.equal(recoveries, 1, 'a plugin recovery is visible without calling attachment.reconnect');
  await attachment.reconnect();
  assert.equal(recoveries, 2, 'manual reconnect does not emit a duplicate completion');
  await attachment.close();
  assert.equal(bridge.listenerCount('connected'), 0);
  bridge.connected = true; bridge.emit('connected'); assert.equal(recoveries, 2);
});

test('the room can enable attachments on ordinary local Desktop reads, while incompatible targets revoke that permission', async t => {
  const bridge = new Bridge();
  let metadata = { kind: 'codex' };
  bridge.handler = async id => {
    const result = page(id);
    Object.assign(result.thread, metadata);
    return result;
  };
  const { attachment } = await fixture(t, { bridge, uploadHistory: { filesFor: () => [] } });
  await attachment.selectThread(THREAD);
  const rpc = await attachment.rpcFactory(), refresh = () => rpc.request('thread/read', { threadId: THREAD });
  assert.equal(rpc.canConfigureLocalUploads(), false);
  for (const incompatible of [{ kind: 'chatgpt' }, { kind: 'codex', mode: 'durable' }, { kind: 'codex', mode: 'new-mode' },
    { kind: 'codex', environments: [{ environmentId: 'local' }, { environmentId: 'remote' }] },
    { kind: 'codex', environments: [{}] }]) {
    // The current native schema omits execution mode and environments.
    metadata = { kind: 'codex' }; await refresh();
    assert.equal(rpc.canConfigureLocalUploads(), true);
    assert.equal(rpc.canUploadAttachments(), false, 'only the room establishes its effective policy');
    rpc.setLocalUploadPermission(true);
    assert.equal(rpc.canUploadAttachments(), true);
    metadata = incompatible; await refresh();
    assert.equal(rpc.canConfigureLocalUploads(), false);
    assert.equal(rpc.canUploadAttachments(), false);
    assert.throws(() => rpc.setLocalUploadPermission(true), { code: 'DESKTOP_APP_UPLOAD_UNAVAILABLE' });
  }
});

test('room-authorized uploads and originals recover in the selected thread after re-sharing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-attachments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, '.coop'), store = new GuestUploads(runtime, randomUUID());
  t.after(() => store.close());
  const samples = [
    ['screenshot.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['review.pdf', Buffer.from('%PDF-1.7\nsynthetic')],
    ['report.docx', Buffer.from('504b0304', 'hex')],
    ['empty.bin', Buffer.alloc(0)],
  ];
  const ids = samples.map(([name, bytes]) => {
    const uploadId = randomUUID();
    store.receive('guest', { type: 'upload-start', uploadId, name, size: bytes.length });
    if (bytes.length) store.receive('guest', { type: 'upload-chunk', uploadId, index: 0, data: bytes.toString('base64') });
    store.receive('guest', { type: 'upload-finish', uploadId });
    return uploadId;
  });
  const attachments = store.claim('guest', ids), bridge = new Bridge();
  let messages = [], gated = false, mode, pending, resume;
  bridge.handler = async id => {
    const result = page(id, [turn('turn', messages)]);
    Object.assign(result.thread, { kind: 'codex', mode }); return result;
  };
  const setup = async (id = THREAD) => {
    const { attachment } = await fixture(t, { bridge, uploadHistory: createDesktopUploadHistory(runtime),
      queue: { async submit(request) {
        if (gated) { pending(); await new Promise(resolve => { resume = resolve; }); }
        if (!request.canDispatch()) throw Object.assign(new Error('revoked'), { code: 'SUBMISSION_REVOKED', outcome: 'notSubmitted' });
        messages = [{ id: 'native-item-id', type: 'userMessage', content: request.input }];
        return { id: randomUUID(), clientUserMessageId: request.clientUserMessageId, wakePending: false };
      } } });
    await attachment.selectThread(id);
    const rpc = await attachment.rpcFactory(), scoped = new ScopedThread({ rpc, threadId: id });
    t.after(() => scoped.close()); await scoped.start();
    return { rpc, scoped };
  };
  const { rpc, scoped } = await setup();
  assert.equal(rpc.canConfigureLocalUploads(), true);
  assert.equal(rpc.canUploadAttachments(), false);
  await assert.rejects(scoped.submitApproved('', randomUUID(), { canDispatch: () => true, attachments }), { code: 'ATTACHMENT_INVALID' });
  rpc.setLocalUploadPermission(true);
  const receipt = await scoped.submitApproved('Review together', randomUUID(), { canDispatch: () => true, attachments });
  assert.equal(receipt.kind, 'queued'); await scoped.refresh();
  assert.deepEqual(messages[0].content.map(p => p.type), ['text', 'localImage']);
  // Desktop can persist an inline image, whose bytes app-tools omits on read.
  messages[0].content = [messages[0].content[0], { type: 'image' }];
  const reopened = await setup();
  assert.equal(reopened.rpc.canUploadAttachments(), false);
  const [item] = reopened.scoped.snapshot.items;
  assert.equal(item.text, 'Review together');
  assert.equal(item.images.length, 1);
  assert.deepEqual(item.files.map(f => f.name), samples.map(([name]) => name));
  assert.equal(item.files[0].previewImageId, item.images[0].id);
  for (const [i, file] of item.files.entries()) {
    assert.deepEqual((await reopened.scoped.readFile(file.id, { representation: 'original' })).bytes, samples[i][1]);
  }
  // Pasting the exact task text into a different thread grants no file rights.
  messages = [user('copy', messages[0].content[0].text)];
  assert.equal((await setup(OTHER)).scoped.snapshot.items[0].files, undefined);

  // Turning off and on during worker startup cannot authorize the original submission.
  gated = true;
  const started = new Promise(resolve => { pending = resolve; });
  const rejected = scoped.submitApproved('', randomUUID(), { canDispatch: () => true, attachments });
  await started; rpc.setLocalUploadPermission(false); rpc.setLocalUploadPermission(true); resume();
  await assert.rejects(rejected, { code: 'SUBMISSION_REVOKED' });
  mode = 'durable'; await scoped.refresh();
  assert.equal(rpc.canUploadAttachments(), false);
  assert.throws(() => rpc.setLocalUploadPermission(true), { code: 'DESKTOP_APP_UPLOAD_UNAVAILABLE' });
});
