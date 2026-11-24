import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '../lib/rpc.mjs';
import { resolveCli } from '../lib/runtime.mjs';
import { importReceiverSnapshot } from '../lib/receiver-import.mjs';
import { createContentMarkdown } from '../lib/markdown-parser.mjs';
import { startResponsesFixture } from './fixtures/responses-server.mjs';
import { GuestUploads, attachmentInput } from '../lib/guest-uploads.mjs';
import { createDesktopQueue } from '../lib/desktop-queue.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';
import { randomUUID } from 'node:crypto';

let binary;
if (process.env.CODEX_COOP_INTEGRATION === '1') { try { binary = resolveCli().cliPath; } catch {} }
const version = binary ? spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }) : { status: 1, stdout: '' };
const skip = process.env.CODEX_COOP_INTEGRATION !== '1'
  ? 'Run npm run test:integration to exercise the isolated real backend'
  : version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.163.0'
    ? 'Requires exact Codex 0.163.0 binary; set CODEX_COOP_CLI to its path'
    : false;

async function until(predicate, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
}

test('two protocol clients share one runtime, live events, and reconnect history (not Desktop proof)', { skip, timeout: 60000 }, async t => {
  // macOS Unix-domain paths must be short; the usual os.tmpdir() path can be long.
  const root = await fs.mkdtemp('/tmp/codex-coop-it-');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const workspace = path.join(root, 'workspace');
  const socket = path.join(root, 'server.sock');
  const fixture = await startResponsesFixture();
  const clients = [];
  let child;
  let stderr = '';
  t.after(async () => {
    for (const client of clients) client.close();
    await stopBackend(child);
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await Promise.all([home, codexHome, workspace].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  await fs.writeFile(path.join(codexHome, 'config.toml'), `
model = "gpt-5.1-codex"
model_provider = "coop_test"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[features]
shell_snapshot = false
[model_providers.coop_test]
name = "Collaboration local test fixture"
base_url = "${fixture.origin}/v1"
wire_api = "responses"
env_key = "CODEX_COOP_FAKE_API_KEY"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
  // Deliberately do not inherit the caller's credentials or provider settings.
  child = spawn(binary, ['app-server', '--listen', `unix://${socket}`], {
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: codexHome,
      TMPDIR: root, LANG: 'en_US.UTF-8', CODEX_COOP_FAKE_API_KEY: 'synthetic-test-only',
      HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin,
      http_proxy: fixture.origin, https_proxy: fixture.origin, all_proxy: fixture.origin,
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited ${child.exitCode}: ${stderr}`);
    return fs.stat(socket).then(s => s.isSocket(), () => false);
  }, 'Unix control socket');

  const eventsA = [], eventsB = [];
  const a = await RpcClient.connect(socket, { name: 'coop_integration_a' });
  clients.push(a);
  a.on('notification', event => eventsA.push(event));
  const b = await RpcClient.connect(socket, { name: 'coop_integration_b' });
  clients.push(b);
  b.on('notification', event => eventsB.push(event));

  const started = await a.request('thread/start', { cwd: workspace, modelProvider: 'coop_test', model: 'gpt-5.1-codex', sandbox: 'read-only', approvalPolicy: 'never' });
  const threadId = started.thread.id;
  assert.ok(threadId);
  // A newly started, empty thread has no durable rollout yet in 0.163.0.
  // Seed a real synthetic turn before B joins through thread/resume.
  const seed = await a.request('turn/start', { threadId, input: [{ type: 'text', text: 'Create the synthetic shared conversation' }] });
  await until(() => eventsA.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.turn.id), 'initial rollout');
  assert.equal(eventsA.find(e => e.method === 'turn/completed' && e.params.turn.id === seed.turn.id).params.turn.status, 'completed');
  const resumed = await b.request('thread/resume', { threadId });
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.cwd, workspace);
  assert.equal(resumed.modelProvider, 'coop_test');

  const first = await a.request('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic participant A turn' }] });
  const firstId = first.turn.id;
  await until(() => [eventsA, eventsB].every(events => events.some(e => e.method === 'turn/completed' && e.params.turn.id === firstId)), `both clients receiving completion ${firstId}`);
  assert.equal(fixture.requests.length, 2, 'Each input must produce exactly one local model request');
  for (const [label, events] of [['A', eventsA], ['B', eventsB]]) {
    assert.equal(events.filter(e => e.method === 'turn/started' && e.params.turn.id === firstId).length, 1, `${label} receives one turn start`);
    assert.ok(events.some(e => e.method === 'item/agentMessage/delta' && e.params.delta.includes('Synthetic answer 2')), `${label} receives live text deltas`);
    assert.equal(events.find(e => e.method === 'turn/completed' && e.params.turn.id === firstId).params.turn.status, 'completed');
  }

  const reverse = await b.request('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic participant B while A is still connected' }] });
  await until(() => [eventsA, eventsB].every(events => events.some(e => e.method === 'turn/completed' && e.params.turn.id === reverse.turn.id)), 'B input broadcast to both clients');
  assert.equal(fixture.requests.length, 3);
  for (const events of [eventsA, eventsB]) {
    assert.ok(events.some(e => e.method === 'item/agentMessage/delta' && e.params.delta.includes('Synthetic answer 3')), 'B live output reaches each connected client');
  }

  a.close();
  const second = await b.request('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic participant B continues after A disconnects' }] });
  await until(() => eventsB.some(e => e.method === 'turn/completed' && e.params.turn.id === second.turn.id), 'B completing after A disconnects');
  assert.equal(fixture.requests.length, 4);
  assert.equal(child.exitCode, null, 'Disconnecting A does not kill the runtime');
  const reconnected = await RpcClient.connect(socket, { name: 'coop_integration_a_reconnected' });
  clients.push(reconnected);
  const restored = await reconnected.request('thread/resume', { threadId });
  assert.equal(restored.thread.id, threadId);
  assert.equal(restored.cwd, workspace);
  assert.equal(restored.modelProvider, 'coop_test');
  assert.equal(restored.model, 'gpt-5.1-codex');
  const history = await reconnected.request('thread/read', { threadId, includeTurns: true });
  assert.equal(history.thread.turns.length, 4);
  assert.deepEqual(history.thread.turns.map(turn => turn.id), [seed.turn.id, firstId, reverse.turn.id, second.turn.id]);
  await delay(200);
  assert.equal(fixture.requests.length, 4, 'Reconnect must not replay a completed input');
  t.diagnostic(`Pinned backend 0.163.0; one PID; thread ${threadId}; two clients received native streaming events in both directions; four requests, four turns including seed. Native Desktop and independent accounts remain unverified.`);

  await t.test('a second participant submitting while busy steers the existing turn', { timeout: 15000 }, async () => {
    const resumedEvents = [];
    reconnected.on('notification', event => resumedEvents.push(event));
    const before = fixture.requests.length;
    const held = fixture.holdNextResponse();
    let active, during;
    try {
      active = await reconnected.request('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic active request held open' }] });
      await until(() => fixture.requests.length === before + 1, 'held model request');
      during = await b.request('turn/start', { threadId, input: [{ type: 'text', text: 'Synthetic busy follow-up from B' }] });
      assert.equal(during.turn.id, active.turn.id, 'Busy turn/start must refer to the existing turn rather than a second runner');
    } finally {
      held.release();
    }
    await until(() => [resumedEvents, eventsB].every(events => events.some(e => e.method === 'turn/completed' && e.params.turn.id === active.turn.id)), 'busy turn completing on both connections');
    const completed = resumedEvents.find(e => e.method === 'turn/completed' && e.params.turn.id === active.turn.id);
    assert.equal(completed.params.turn.status, 'completed');
    assert.equal(resumedEvents.filter(e => e.method === 'turn/started' && e.params.turn.id === active.turn.id).length, 1);
    assert.equal(fixture.requests.length, before + 2, 'The pending input produces one continuation request within the same turn');
    assert.ok(JSON.stringify(fixture.requests.at(-1).input).includes('Synthetic busy follow-up from B'), 'The continuation contains B input');
    const afterBusy = await b.request('thread/read', { threadId, includeTurns: true });
    assert.equal(afterBusy.thread.turns.length, 5, 'Two inputs while busy must not produce two independent turns');
    t.diagnostic(`Busy turn/start returned existing turn ${active.turn.id}; both clients observed completion; one additional turn, two synthetic model requests.`);
  });

  await t.test('the official native queue delivers a mixed guest attachment message to the isolated consumer', async () => {
    const uploads = new GuestUploads(path.join(workspace, '.coop'), randomUUID());
    const queue = createDesktopQueue({ cliPath: binary, environment: { HOME: home, CODEX_HOME: codexHome, TMPDIR: root },
      wakeThread: async () => true });
    try {
      const files = [
        ['queued.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64')],
        ['queued.pdf', Buffer.from('%PDF-1.7\nSynthetic queue document')],
      ];
      const ids = files.map(([name, bytes]) => {
        const uploadId = randomUUID();
        uploads.receive('guest', { type: 'upload-start', uploadId, name, size: bytes.length });
        uploads.receive('guest', { type: 'upload-chunk', uploadId, index: 0, data: bytes.toString('base64') });
        uploads.receive('guest', { type: 'upload-finish', uploadId });
        return uploadId;
      });
      const attachments = uploads.claim('guest', ids);
      const before = fixture.requests.length, input = attachmentInput('Review the two queued files.', attachments);
      const receipt = await queue.submit({ threadId, input, attachments, clientUserMessageId: randomUUID(), canDispatch: () => true });
      assert.equal(fixture.requests.length, before);
      const listed = await reconnected.request('thread/queue/list', { threadId });
      const queued = listed.data.find(record => record.id === receipt.id);
      assert.equal(queued.clientUserMessageId, receipt.clientUserMessageId);
      assert.deepEqual(queued.input.map(part => part.type), ['text', 'image']);
      assert.deepEqual(Buffer.from(queued.input[1].url.split(',')[1], 'base64'), files[0][1]);
      const started = await reconnected.request('thread/queue/start', { threadId, queuedSubmissionId: receipt.id });
      await until(() => eventsB.some(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id), 'queued attachments consumed');
      assert.equal(fixture.requests.length, before + 1);
      const parts = fixture.requests.at(-1).input.filter(item => item.role === 'user').at(-1).content;
      assert.ok(parts.some(p => p.type === 'input_image'));
      assert.ok(parts.some(p => p.type === 'input_text' && p.text.includes(attachments[1].path)));
      assert.deepEqual(await fs.readFile(attachments[1].path), files[1][1]);
      const after = await reconnected.request('thread/read', { threadId, includeTurns: true });
      const sent = after.thread.turns.find(turn => turn.id === started.turn.id).items.find(item => item.type === 'userMessage');
      assert.equal(sent.content[0].text, input[0].text);
    } finally { await queue.close(); uploads.close(); }
  });

  await t.test('uploaded images and ordinary/audio/video files reach the isolated pinned backend with model calls confined to loopback', async () => {
    const uploads = new GuestUploads(path.join(workspace, '.coop'), randomUUID());
    const scoped = new ScopedThread({ rpc: reconnected, threadId }); await scoped.start();
    const observed = []; reconnected.on('notification', event => observed.push(event));
    try {
      const cases = [ ['image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64')],
        ['ordinary.txt', Buffer.from('synthetic ordinary file')], ['audio.wav', Buffer.from('RIFF synthetic audio')], ['video.mp4', Buffer.from('synthetic video')] ];
      for (const [name, bytes] of cases) {
        const uploadId = randomUUID(), before = fixture.requests.length;
        uploads.receive('synthetic-guest', { type: 'upload-start', uploadId, name, size: bytes.length });
        uploads.receive('synthetic-guest', { type: 'upload-chunk', uploadId, index: 0, data: bytes.toString('base64') });
        uploads.receive('synthetic-guest', { type: 'upload-finish', uploadId });
        const attachments = uploads.claim('synthetic-guest', [uploadId]);
        const result = await scoped.submitApproved('Inspect the synthetic attachment', randomUUID(), { attachments });
        await until(() => observed.some(e => e.method === 'turn/completed' && e.params.turn.id === result.turnId), name+' completion');
        assert.equal(observed.find(e => e.method === 'turn/completed' && e.params.turn.id === result.turnId).params.turn.status, 'completed');
        assert.equal(fixture.requests.length, before+1); assert.deepEqual(await fs.readFile(attachments[0].path), bytes);
        const payload = JSON.stringify(fixture.requests.at(-1).input);
        assert.ok(payload.includes(attachments[0].path));
        if (name.endsWith('.png')) {
          const parts = fixture.requests.at(-1).input.filter(item => item.role === 'user').at(-1)?.content ?? [];
          assert.ok(parts.some(p => p.type === 'input_image'), 'Uploaded PNG must reach the local model fixture as image input: '+JSON.stringify(parts).slice(-700));
        }
      }
      t.diagnostic(`Synthetic local Responses fixture: image input plus ordinary/audio/video path references accepted by 0.163.0. Deny proxy refused ${fixture.blockedDestinations.length} background connection attempts. This does not prove native Desktop UI, audio modality or semantic file understanding.`);
    } finally { scoped.close(); uploads.close(); }
  });
});

test('recipient imports visible dialogue into a new durable thread with the official worker', { skip, timeout: 60000 }, async t => {
  const root = await fs.mkdtemp('/tmp/co2-receiver-');
  const codexHome = path.join(root, 'codex');
  const home = path.join(root, 'user');
  const runtimeDir = path.join(root, '.coop');
  const socket = path.join(root, 'read.sock');
  const fixture = await startResponsesFixture();
  let reader, verifier;
  t.after(async () => {
    reader?.close();
    await stopBackend(verifier);
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of [codexHome, home]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model = "gpt-5.1-codex"', 'model_provider = "fixture"', 'check_for_update_on_startup = false',
    'approval_policy = "never"', 'sandbox_mode = "read-only"', '[analytics]', 'enabled = false',
    '[feedback]', 'enabled = false', '[model_providers.fixture]', 'name = "Local fixture"',
    'base_url = "' + fixture.origin + '/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', '',
  ].join('\n'), { mode: 0o600 });
  const messages = [
    { role: 'assistant', text: 'Visible fragment after truncation' },
    { role: 'user', text: 'Synthetic test, two lines:\n第二行。' },
    { role: 'user', text: 'Another user message before the reply' },
    { role: 'assistant', text: '<EXTERNAL SESSION IMPORTED>' },
    { role: 'assistant', text: 'Second assistant message\n\nwith a blank line' },
  ];
  const snapshot = { version: 1, title: 'Synthetic receiver', truncated: true, messages };
  const local = { executable: binary, codexHome };
  await assert.rejects(importReceiverSnapshot({ snapshot, runtimeDir }, { ...local, codexHome: path.join(root, 'absent') }),
    error => Boolean(error.safeMessage));
  await assert.rejects(importReceiverSnapshot({ snapshot: { ...snapshot, messages: [] }, runtimeDir }, local));
  const legacyResult = await importReceiverSnapshot({ snapshot, runtimeDir }, local);
  assert.deepEqual(Object.keys(legacyResult), ['threadId']);
  const { threadId } = legacyResult;
  assert.match(threadId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await fs.readdir(runtimeDir), ['imported-projects'], 'staged source cleaned after worker exit');
  assert.equal(fixture.requests.length, 0, 'import performs no generation');
  verifier = spawn(binary, ['app-server', '--listen', 'unix://' + socket], {
    cwd: root, stdio: 'ignore', env: {
      HOME: home, CODEX_HOME: codexHome, TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
      HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin,
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    },
  });
  await until(() => fs.stat(socket).then(s => s.isSocket(), () => false), 'independent verifier');
  reader = await RpcClient.connect(socket);
  const { thread } = await reader.request('thread/read', { threadId, includeTurns: true });
  assert.equal(thread.id, threadId);
  assert.equal(thread.name, 'Synthetic receiver（可见片段）');
  assert.equal(thread.turns.length, 3);
  assert.match(thread.turns[0].items[0].content[0].text, /Co² 自动生成的导入说明/);
  assert.equal(thread.turns[0].items[1].text, messages[0].text);
  assert.equal(thread.turns[1].items[0].content[0].text, messages[1].text);
  assert.equal(thread.turns[2].items[0].content[0].text, messages[2].text);
  assert.equal(thread.turns[2].items[1].text, messages[3].text);
  assert.equal(thread.turns[2].items[2].text, messages[4].text);
  assert.deepEqual((await reader.request('thread/list', { limit: 10, modelProviders: [] })).data.map(t => t.id), [threadId]);
  assert.equal((await reader.request('thread/resume', { threadId })).thread.id, threadId);
  const completed = new Set();
  reader.on('notification', event => {
    if (event.method === 'turn/completed') completed.add(event.params.turn.id);
  });
  const { turn } = await reader.request('turn/start', { threadId, input: [{ type: 'text', text: 'Continue the synthetic chat' }] });
  await until(() => completed.has(turn.id), 'synthetic follow-up completion');
  assert.equal(fixture.requests.length, 1);
  assert.equal((await reader.request('thread/read', { threadId, includeTurns: true })).thread.turns.length, 4);

  await t.test('attachment originals and their native history references survive source removal', async () => {
    const source = path.join(root, 'synthetic-sharing-host');
    await fs.mkdir(source);
    // Byte preservation includes text that a preview would decode, and binary
    // files that the guest can only download. This test never invokes a viewer.
    const originals = new Map([
      ['evidence.csv', Buffer.from([255, 254, 97, 0, 44, 0, 98, 0])],
      ['photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64')],
      ['recording.wav', Buffer.from('RIFF synthetic audio')],
      ['old.ppt', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
      ['video.mp4', Buffer.from('synthetic video bytes')],
      ['report.pdf', Buffer.from('%PDF-1.7 synthetic')],
    ]);
    const refs = [...originals.keys()].map((name, i) => ({
      kind: name === 'photo.png' ? 'image' : 'file', name, id: String(i + 1).padStart(64, '0'),
    }));
    for (const [name, bytes] of originals) await fs.writeFile(path.join(source, name), bytes);
    const [csv, photo, audio, ppt, video, pdf] = refs;
    const missing = { id: 'f'.repeat(64), name: 'missing.docx', kind: 'file' };
    const withAssets = { version: 2, title: 'Synthetic attachments', truncated: false, messages: [
      { role: 'user', text: '', attachments: [csv, photo, audio, ppt, video] },
      { role: 'assistant', text: 'The [PDF report](/sharing-host/report.pdf) is ready.',
        attachments: [{ ...pdf, syntax: 'link', index: 0 }] },
      { role: 'user', text: 'Check the files', attachments: [csv, missing] },
    ] };
    const downloads = [];
    const projects = path.join(runtimeDir, 'imported-projects');
    const before = await fs.readdir(projects);
    await assert.rejects(importReceiverSnapshot({ runtimeDir, snapshot: withAssets, fetchAsset: ref =>
      fs.readFile(path.join(source, ref.name)) }, { ...local, executable: path.join(root, 'absent-cli') }));
    assert.deepEqual(await fs.readdir(projects), before, 'a pre-submission failure discards its private attachment directory');
    const imported = await importReceiverSnapshot({ runtimeDir, snapshot: withAssets, fetchAsset: ref => {
      downloads.push(ref.id); return fs.readFile(path.join(source, ref.name));
    } }, local);
    assert.notEqual(imported.threadId, threadId);
    assert.equal(imported.attachments.saved, originals.size);
    assert.equal(imported.attachments.missing, 1);
    assert.deepEqual(downloads, [...refs.map(ref => ref.id), missing.id]);
    await fs.rm(source, { recursive: true });
    assert.deepEqual(await fs.readdir(runtimeDir), ['imported-projects']);
    const resumed = await reader.request('thread/resume', { threadId: imported.threadId });
    const { thread: copy } = await reader.request('thread/read', { threadId: imported.threadId, includeTurns: true });
    assert.equal(copy.id, resumed.thread.id);
    assert.equal(copy.turns.length, 2);
    const first = copy.turns[0].items[0].content[0].text;
    const reply = copy.turns[0].items[1].text;
    const last = copy.turns[1].items[0].content[0].text;
    assert.match(reply, /^The \[PDF report\]\(.*report.pdf\) is ready\.$/);
    assert.doesNotMatch(reply, /sharing-host/);
    assert.match(last, /Check the files[\s\S]*missing.docx.*未保存/);
    const parser = createContentMarkdown();
    function paths(text) {
      return parser.parse(text, {}).flatMap(token => token.children ?? [])
        .filter(t => t.type === 'link_open' || t.type === 'image')
        .map(t => decodeURIComponent(t.attrGet(t.type === 'image' ? 'src' : 'href')));
    }
    const saved = [...paths(first), ...paths(reply)];
    assert.equal(saved.length, originals.size);
    assert.deepEqual(paths(last), [saved[0]], 'the next user turn references its original copy');
    for (const [i, target] of saved.entries()) {
      assert.equal(path.dirname(target), path.join(resumed.cwd, 'attachments'));
      assert.deepEqual(await fs.readFile(target), originals.get(refs[i].name));
    }
    assert.equal(fixture.requests.length, 1, 'the import and independent readback made no model call');
  });
});
