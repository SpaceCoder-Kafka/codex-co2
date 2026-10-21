import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '../lib/rpc.mjs';
import { resolveCli } from '../lib/runtime.mjs';
import { startResponsesFixture } from './fixtures/responses-server.mjs';

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
});
