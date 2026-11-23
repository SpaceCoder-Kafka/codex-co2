import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopQueue } from '../lib/desktop-queue.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const clientUserMessageId = '22222222-2222-4222-8222-222222222222';
const secondClientId = '33333333-3333-4333-8333-333333333333';
const queueId = '44444444-4444-4444-8444-444444444444';
const submission = extra => ({ threadId, clientUserMessageId, input: [{ type: 'text', text: 'Synthetic private message 中文。' }],
  canDispatch: () => true, ...extra });
const until = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(1); } assert.fail('condition timed out'); };

function childProcess(onRequest, { ignoreEnd = false, ignoreKill = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.exitCode = null; child.signalCode = null;
  child.requests = []; child.kills = [];
  child.finish = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal; child.stdout.end();
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.reply = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.accept = request => child.reply({ id: request.id, result: { queuedSubmission: {
    id: queueId, input: request.params.input, clientUserMessageId: request.params.clientUserMessageId, responsesapiClientMetadata: null,
  } } });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line); child.requests.push(request);
        queueMicrotask(() => onRequest(request, child));
      }
      callback();
    },
    final(callback) { callback(); if (!ignoreEnd) queueMicrotask(() => child.finish()); },
  });
  child.kill = signal => { child.kills.push(signal); if (!ignoreKill) child.finish(null, signal); return true; };
  return child;
}

const normalReply = (request, child) => {
  if (request.method === 'initialize') child.reply({ id: request.id, result: { userAgent: 'Synthetic official CLI' } });
  if (request.method === 'thread/queue/add') child.accept(request);
};

async function fixture(t, { onRequest = normalReply, childOptions, ...options } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-queue-'));
  const calls = [], children = [], wakeCalls = [];
  const queue = createDesktopQueue({ cliPath: '/synthetic/official/codex',
    environment: { HOME: root, CODEX_HOME: path.join(root, 'codex'),
      OPENAI_API_KEY: 'do-not-inherit', CODEX_APP_SERVER_WS_URL: 'wss://not-used.invalid', NODE_OPTIONS: '--not-used',
      CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1' },
    timeoutMs: 1000, shutdownTimeoutMs: 10, wakeTimeoutMs: 1000,
    wakeThread: async id => { wakeCalls.push(id); },
    spawnProcess(...args) {
      calls.push(args);
      const child = childProcess(onRequest, typeof childOptions === 'function' ? childOptions(children.length) : childOptions);
      children.push(child); return child;
    }, ...options,
  });
  t.after(async () => { await queue.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { queue, root, calls, children, wakeCalls, daemon: path.join(root, 'codex/app-server-control/app-server-control.sock') };
}

test('short-lived writer only initializes and appends once, with normal home and no credential environment', async t => {
  const f = await fixture(t);
  const result = await f.queue.submit(submission());
  assert.deepEqual(result, { id: queueId, clientUserMessageId, wakePending: true });
  assert.deepEqual(await f.queue.wakePending(), { pending: 0 });
  assert.deepEqual(f.wakeCalls, [threadId]);
  await until(() => f.children[0].exitCode === 0);
  assert.deepEqual(f.children[0].requests.map(r => r.method), ['initialize', 'initialized', 'thread/queue/add']);
  assert.equal(f.children[0].requests[0].params.capabilities.experimentalApi, true);
  const [executable, args, options] = f.calls[0];
  assert.equal(executable, '/synthetic/official/codex');
  assert.deepEqual(args.slice(-3), ['app-server', '--listen', 'stdio://']);
  assert.ok(args.includes('cli_auth_credentials_store="ephemeral"'));
  assert.equal(options.env.HOME, f.root);
  assert.equal(options.env.CODEX_HOME, path.join(f.root, 'codex'));
  assert.equal(options.env.CODEX_APP_SERVER_USE_LOCAL_DAEMON, '0');
  for (const key of ['OPENAI_API_KEY', 'CODEX_APP_SERVER_WS_URL', 'NODE_OPTIONS']) assert.equal(options.env[key], undefined);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
});

test('duplicate caller IDs share their original outcome; a conflicting payload cannot reuse an ID', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.queue.submit(submission()), f.queue.submit(submission())]);
  assert.equal(a.id, b.id); assert.equal(f.calls.length, 1);
  await f.queue.wakePending();
  assert.equal((await f.queue.submit(submission())).wakePending, false);
  await assert.rejects(f.queue.submit(submission({ input: [{ type: 'text', text: 'Other content' }] })),
    e => e.code === 'DESKTOP_QUEUE_DUPLICATE_ID' && e.outcome === 'notSubmitted');
  assert.equal(f.children[0].requests.filter(r => r.method === 'thread/queue/add').length, 1);
});

test('workers are serialized until the previous owned process exits', async t => {
  const f = await fixture(t, { childOptions: index => ({ ignoreEnd: index === 0 }), shutdownTimeoutMs: 500 });
  await f.queue.submit(submission());
  const next = f.queue.submit(submission({ clientUserMessageId: secondClientId }));
  await delay(10); assert.equal(f.calls.length, 1);
  f.children[0].finish();
  assert.equal((await next).clientUserMessageId, secondClientId);
  assert.equal(f.calls.length, 2);
});

test('admission is checked after initialization and immediately before queue dispatch', async t => {
  let allowed = true, checks = 0;
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method === 'initialize') return;
    normalReply(request, child);
  } });
  const result = f.queue.submit(submission({ canDispatch: () => { checks++; return allowed; } }));
  await until(() => f.children[0]?.requests.length === 1);
  assert.equal(checks, 0); allowed = false;
  f.children[0].reply({ id: 1, result: { userAgent: 'Synthetic' } });
  await assert.rejects(result, e => e.code === 'SUBMISSION_REVOKED' && e.outcome === 'notSubmitted');
  assert.equal(checks, 1);
  assert.deepEqual(f.children[0].requests.map(r => r.method), ['initialize', 'initialized']);
});

test('missing, asynchronous and throwing admission callbacks all fail closed', async t => {
  for (const canDispatch of [undefined, async () => true, async () => { throw Error('private'); }, () => { throw Error('private'); }]) {
    const f = await fixture(t);
    await assert.rejects(f.queue.submit(submission({ canDispatch })), e => e.code === 'SUBMISSION_REVOKED');
    assert.ok(!f.children[0].requests.some(r => r.method === 'thread/queue/add'));
  }
});

test('duplicate initialization replies cannot append twice, including split UTF-8 queue replies', async t => {
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method === 'initialize') {
      child.reply({ id: 1, result: { userAgent: 'Synthetic' } });
      child.reply({ id: 1, result: { userAgent: 'Synthetic duplicate' } });
    }
    if (request.method === 'thread/queue/add') {
      const bytes = Buffer.from(JSON.stringify({ id: 2, result: { queuedSubmission: {
        id: queueId, input: request.params.input, clientUserMessageId,
      } } }) + '\n');
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    }
  } });
  assert.equal((await f.queue.submit(submission())).id, queueId);
  assert.equal(f.children[0].requests.filter(r => r.method === 'thread/queue/add').length, 1);
});

test('reentrant close from admission cannot dispatch after authorization is checked', async t => {
  const f = await fixture(t);
  await assert.rejects(f.queue.submit(submission({ canDispatch: () => { void f.queue.close(); return true; } })),
    e => e.outcome === 'notSubmitted');
  assert.ok(!f.children[0].requests.some(r => r.method === 'thread/queue/add'));
});

test('a daemon endpoint prevents spawning; an endpoint appearing during initialization prevents submission', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.daemon), { recursive: true }); await fs.writeFile(f.daemon, 'synthetic endpoint');
  await assert.rejects(f.queue.submit(submission()), e => e.code === 'DESKTOP_QUEUE_DAEMON_UNSUPPORTED');
  assert.equal(f.calls.length, 0);
  const g = await fixture(t, { onRequest() {} });
  const pending = g.queue.submit(submission());
  await until(() => g.children[0]?.requests.length === 1);
  await fs.mkdir(path.dirname(g.daemon), { recursive: true }); await fs.writeFile(g.daemon, 'synthetic endpoint');
  g.children[0].reply({ id: 1, result: { userAgent: 'Synthetic' } });
  await assert.rejects(pending, e => e.code === 'DESKTOP_QUEUE_DAEMON_UNSUPPORTED');
  assert.ok(!g.children[0].requests.some(r => r.method === 'thread/queue/add'));
});

test('unconfirmed writes stay unknown and are never submitted again', async t => {
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method === 'thread/queue/add') child.finish(1); else normalReply(request, child);
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(f.queue.submit(submission()), e => e.code === 'DESKTOP_QUEUE_UNKNOWN' && e.outcome === 'unknown');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.queue.wakePending(), { pending: 0 });
  assert.deepEqual(f.wakeCalls, []);
});

test('bad queue IDs, mismatched caller IDs and changed input cannot become accepted outcomes', async t => {
  for (const mutation of [q => { q.id = 'not-a-uuid'; }, q => { q.clientUserMessageId = secondClientId; },
    q => { q.input = [{ type: 'text', text: 'native private text' }]; }]) {
    const f = await fixture(t, { onRequest(request, child) {
      if (request.method !== 'thread/queue/add') return normalReply(request, child);
      const q = { id: queueId, input: request.params.input, clientUserMessageId }; mutation(q);
      child.reply({ id: request.id, result: { queuedSubmission: q } });
    } });
    await assert.rejects(f.queue.submit(submission()), e => e.code === 'DESKTOP_QUEUE_UNKNOWN' && !e.message.includes('native private text'));
    assert.equal(f.queue.pendingWakeCount, 0);
  }
});

test('RPC errors and malformed stdout expose only fixed diagnostics', async t => {
  for (const [code, outcome] of [[-32602, 'rejected'], [-32603, 'unknown']]) {
    const f = await fixture(t, { onRequest(request, child) {
      if (request.method !== 'thread/queue/add') return normalReply(request, child);
      child.reply({ id: request.id, error: { code, message: 'native-private-message-and-path' } });
    } });
    await assert.rejects(f.queue.submit(submission()), e => e.outcome === outcome && !e.message.includes('native-private'));
  }
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method === 'thread/queue/add') child.stdout.write('native-private not json\n'); else normalReply(request, child);
  } });
  await assert.rejects(f.queue.submit(submission()), e => e.outcome === 'unknown' && !e.message.includes('native-private'));
});

test('timeouts distinguish pre-dispatch failure from an unknown committed write', async t => {
  for (const initialized of [false, true]) {
    const f = await fixture(t, { timeoutMs: 30, onRequest(request, child) {
      if (initialized && request.method === 'initialize') normalReply(request, child);
    } });
    await assert.rejects(f.queue.submit(submission()), e => e.outcome === (initialized ? 'unknown' : 'notSubmitted'));
    assert.equal(f.calls.length, 1);
  }
});

test('wake failures retain accepted outcomes and retry only the wake operation', async t => {
  let attempts = 0;
  const f = await fixture(t, { wakeThread: async () => { if (++attempts === 1) throw Error('private wake error'); } });
  assert.equal((await f.queue.submit(submission())).id, queueId);
  assert.deepEqual(await f.queue.wakePending(), { pending: 1 });
  assert.equal((await f.queue.submit(submission())).wakePending, true);
  assert.deepEqual(await f.queue.wakePending(), { pending: 0 });
  assert.equal(attempts, 2); assert.equal(f.calls.length, 1);
});

test('acceptance does not wait for a hung wake, and close cancels pending wake work', async t => {
  let signal;
  const f = await fixture(t, { wakeThread: async (_id, options) => { signal = options.signal; await new Promise(() => {}); } });
  const result = await f.queue.submit(submission());
  assert.equal(result.wakePending, true);
  await until(() => signal);
  await f.queue.close();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await f.queue.wakePending(), { pending: 0 });
});

test('close prevents queued dispatch and bounds teardown to the owned worker', async t => {
  const f = await fixture(t, { childOptions: { ignoreEnd: true, ignoreKill: true }, onRequest() {}, shutdownTimeoutMs: 5 });
  const first = f.queue.submit(submission());
  const firstResult = assert.rejects(first, e => e.outcome === 'notSubmitted');
  await until(() => f.children.length === 1);
  const second = f.queue.submit(submission({ clientUserMessageId: secondClientId }));
  const secondResult = assert.rejects(second, e => e.outcome === 'notSubmitted');
  await f.queue.close(); await Promise.all([firstResult, secondResult]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.children[0].kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(f.queue.submit(submission()), e => e.code === 'DESKTOP_QUEUE_CLOSED');
});

test('only text inputs enter this phase of the queue writer', async t => {
  const f = await fixture(t);
  for (const input of [[{ type: 'localImage', path: '/private/image.png' }], [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'text', text_elements: [{ unauthorized: true }] }]]) {
    await assert.rejects(f.queue.submit(submission({ input })), e => e.outcome === 'notSubmitted');
  }
  assert.equal(f.calls.length, 0);
});
