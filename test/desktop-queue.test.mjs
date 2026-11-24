import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopQueue } from '../lib/desktop-queue.mjs';
import { attachmentInput, GuestUploads, UPLOAD_CHUNK_BYTES } from '../lib/guest-uploads.mjs';

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

function claimedUploads(t, root, files = [
    ['notes.txt', Buffer.from('synthetic notes')],
    ['recording.wav', Buffer.from('synthetic recording')],
    ['first.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['second.png', Buffer.from('89504e470d0a1a0a01', 'hex')],
  ]) {
  const store = new GuestUploads(path.join(root, '.coop'), randomUUID());
  t.after(() => store.close());
  const ids = files.map(([name, bytes]) => {
    const uploadId = randomUUID();
    store.receive('guest', { type: 'upload-start', uploadId, name, size: bytes.length });
    let index = 0;
    for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) {
      store.receive('guest', { type: 'upload-chunk', uploadId, index: index++, data: bytes.subarray(start, start + UPLOAD_CHUNK_BYTES).toString('base64') });
    }
    store.receive('guest', { type: 'upload-finish', uploadId });
    return uploadId;
  });
  return store.claim('guest', ids);
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

test('submissions without claimed files accept only plain text', async t => {
  const f = await fixture(t);
  for (const input of [[{ type: 'localImage', path: '/private/image.png' }], [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'text', text_elements: [{ unauthorized: true }] }]]) {
    await assert.rejects(f.queue.submit(submission({ input })), e => e.outcome === 'notSubmitted');
  }
  assert.equal(f.calls.length, 0);
});

test('native file descriptions require claimed uploads, while ordinary mentions and the request body remain plain text', async t => {
  const f = await fixture(t), [file] = claimedUploads(t, f.root);
  const native = attachmentInput('read this', [file])[0].text;
  const pasted = native.replace('# Files mentioned by the user:', '# Files pasted by the user:').replace('## notes.txt:', '## "notes.txt":');
  const sender = '<codex_multi_user_message><account_user_id>a</account_user_id><name>A</name><email>a</email>' +
    '<profile_picture_url></profile_picture_url><body>' + pasted.replaceAll('"', '&quot;') + '</body></codex_multi_user_message>';
  const messages = [native, pasted, sender, native.replace('## My request:', '## My request for Codex:')];
  for (const text of messages) {
    await assert.rejects(f.queue.submit(submission({ input: [{ type: 'text', text }] })),
      e => e.code === 'DESKTOP_QUEUE_FILE_CONTEXT' && e.outcome === 'notSubmitted' && !e.safeMessage.includes(file.path));
  }
  const [header, ...body] = native.split('\n');
  await assert.rejects(f.queue.submit(submission({ input: [{ type: 'text', text: header }, { type: 'text', text: body.join('\n') }] })),
    e => e.code === 'DESKTOP_QUEUE_FILE_CONTEXT');
  assert.equal(f.calls.length, 0);
  for (const text of [file.path, '## My request:\n' + native, 'Discuss # Files mentioned by the user: syntax.',
    native.replace('## notes.txt:', 'plain example:')]) {
    await f.queue.submit(submission({ clientUserMessageId: randomUUID(), input: [{ type: 'text', text }] }));
  }
  const input = attachmentInput(native, [file]);
  await f.queue.submit(submission({ clientUserMessageId: randomUUID(), attachments: [file], input }));
  assert.equal(f.calls.length, 5);
});

test('claimed files use their generated text references and the worker sends the verified image bytes', async t => {
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method !== 'thread/queue/add') return normalReply(request, child);
    const input = request.params.input.map(item => item.type === 'image' ? { ...item, detail: null } : item);
    child.reply({ id: 2, result: { queuedSubmission: { id: queueId, clientUserMessageId: request.params.clientUserMessageId, input } } });
  } });
  const attachments = claimedUploads(t, f.root);
  for (const [index, files] of [[0, attachments], [1, attachments.slice(0, 2)]]) {
    const input = attachmentInput(index === 0 ? '' : 'text', files);
    const result = await f.queue.submit(submission({ clientUserMessageId: randomUUID(), input, attachments: files }));
    assert.equal(result.id, queueId);
    const { params } = f.children[index].requests.find(request => request.method === 'thread/queue/add');
    assert.deepEqual(Object.keys(params).sort(), ['threadId', 'input', 'clientUserMessageId'].sort());
    assert.deepEqual(params.input[0], { ...input[0], text_elements: [] });
    for (const file of files) assert.ok(params.input[0].text.includes(file.path));
    const images = await Promise.all(files.filter(file => file.image).map(async file =>
      ({ type: 'image', url: 'data:image/png;base64,' + (await fs.readFile(file.path)).toString('base64') })));
    assert.deepEqual(params.input.slice(1), images);
  }
});

test('forged file handles, mismatched images and noncanonical descriptions are rejected before spawning the worker', async t => {
  const f = await fixture(t);
  const attachments = claimedUploads(t, f.root), input = attachmentInput('text', attachments);
  for (const fields of [
    { attachments: attachments.map(a => ({ ...a })) }, { attachments: null }, { attachments: Array(1) },
    { input: input.slice(0, -1) }, { input: [input[0], input[2], input[1]] },
    { input: [{ type: 'text', text: 'no trusted file metadata' }, ...input.slice(1)] },
    { input: attachmentInput('x'.repeat(8001), attachments) },
    { input: [input[0], { type: 'localAudio', path: attachments[1].path }, input[2]] },
    { input: [input[0], { ...input[1], path: attachments[0].path }, input[2]] },
    { input: [input[0], { ...input[1], detail: 'high' }, input[2]] },
  ]) {
    await assert.rejects(f.queue.submit(submission({ input, attachments, ...fields })), e => e.outcome === 'notSubmitted');
  }
  assert.equal(f.calls.length, 0);
});

test('a changed upload cannot be written after the worker initializes', async t => {
  const f = await fixture(t, { onRequest() {} });
  const attachments = claimedUploads(t, f.root);
  const result = f.queue.submit(submission({ input: attachmentInput('', attachments), attachments }));
  await until(() => f.children[0]?.requests.length === 1);
  // An internal caller changing its array after submit cannot bypass file verification.
  const [file] = attachments.splice(0);
  await fs.writeFile(file.path, 'changed');
  f.children[0].reply({ id: 1, result: { userAgent: 'Synthetic' } });
  await assert.rejects(result, e => e.code === 'ATTACHMENT_INVALID' && e.outcome === 'notSubmitted');
  assert.ok(!f.children[0].requests.some(r => r.method === 'thread/queue/add'));
});

test('a queue receipt must echo the authorized files and their order', async t => {
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method !== 'thread/queue/add') return normalReply(request, child);
    const [text, first, second] = request.params.input;
    child.reply({ id: 2, result: { queuedSubmission: { id: queueId, input: [text, second, first], clientUserMessageId } } });
  } });
  const attachments = claimedUploads(t, f.root);
  await assert.rejects(f.queue.submit(submission({ input: attachmentInput('', attachments), attachments })),
    e => e.code === 'DESKTOP_QUEUE_UNKNOWN' && e.outcome === 'unknown');
  assert.equal(f.queue.pendingWakeCount, 0);
});

test('inline native receipts match each image by MIME, size and SHA-256 even above the text output budget', async t => {
  const png = Buffer.alloc(1600001, 23); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  const jpg = Buffer.from('ffd8ffe000000012', 'hex');
  const images = [ { type: 'image', url: 'data:image/png;base64,' + png.toString('base64'), detail: null },
    { type: 'image', url: 'data:image/jpeg;base64,' + jpg.toString('base64') } ];
  const f = await fixture(t, { onRequest(request, child) {
    if (request.method !== 'thread/queue/add') return normalReply(request, child);
    assert.ok(request.params.input[1].url === images[0].url && request.params.input[2].url === images[1].url);
    const input = [request.params.input[0], ...images], q = { id: queueId, clientUserMessageId, input };
    const bytes = Buffer.from(JSON.stringify({ id: 2, result: { queuedSubmission: q } }) + '\n');
    assert.ok(bytes.length > 2 * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 1021) child.stdout.write(bytes.subarray(offset, offset + 1021));
  } });
  const attachments = claimedUploads(t, f.root, [['large.png', png], ['photo.jpg', jpg]]);
  const input = attachmentInput('text', attachments);
  // A guest cannot supply an inline image, even if it exactly matches a claim.
  await assert.rejects(f.queue.submit(submission({ input: [input[0], ...images], attachments })), e => e.outcome === 'notSubmitted');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.queue.submit(submission({ input, attachments }))).id, queueId);
});

test('an altered, noncanonical or reordered inline image receipt remains unknown', async t => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex'), second = Buffer.concat([png, Buffer.from('different')]);
  const original = 'data:image/png;base64,' + png.toString('base64');
  const other = 'data:image/png;base64,' + second.toString('base64');
  const receipt = (url, fields = {}) => ({ type: 'image', url, ...fields });
  for (const echo of [
    [receipt(original.replace('image/png', 'image/gif')), receipt(other)],
    [receipt(original.replace('iVB', 'jVB')), receipt(other)],
    [receipt(original.slice(0, -1) + '!'), receipt(other)], [receipt(other), receipt(original)],
    [receipt(original, { fileId: 'synthetic' }), receipt(other)], [receipt(original, { detail: 'high' }), receipt(other)],
    [receipt('https://example.invalid/image.png'), receipt(other)], [receipt(original)],
  ]) {
    const f = await fixture(t, { onRequest(request, child) {
      if (request.method !== 'thread/queue/add') return normalReply(request, child);
      child.reply({ id: 2, result: { queuedSubmission: { id: queueId, clientUserMessageId, input: [request.params.input[0], ...echo] } } });
    } });
    const attachments = claimedUploads(t, f.root, [['first.png', png], ['second.png', second]]);
    await assert.rejects(f.queue.submit(submission({ input: attachmentInput('', attachments), attachments })), e => e.outcome === 'unknown');
    assert.equal(f.queue.pendingWakeCount, 0);
  }
});
