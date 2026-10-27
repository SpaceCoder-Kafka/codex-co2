import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { RpcClient } from '../lib/rpc.mjs';
import { resolveCli } from '../lib/runtime.mjs';
import { startOwner, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { InviteRecovery } from '../lib/invite-recovery.mjs';
import { startResponsesFixture } from './fixtures/responses-server.mjs';

let binary;
if (process.env.CODEX_COOP_INTEGRATION === '1') { try { binary = resolveCli().cliPath; } catch {} }
const version = binary ? spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }) : { status: 1, stdout: '' };
const skip = process.env.CODEX_COOP_INTEGRATION !== '1'
  ? 'Set CODEX_COOP_INTEGRATION=1 for the isolated real-backend sharing test'
  : version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.163.0'
    ? 'Requires exact Codex 0.163.0; set CODEX_COOP_CLI to its path'
    : false;

async function until(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(15);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(url, origin, peers) {
  const ws = new WebSocket(url, { origin, handshakeTimeout: 3000, perMessageDeflate: false });
  const messages = [];
  const peer = { ws, messages, closed: false, send: value => ws.send(JSON.stringify(value)) };
  peers.push(peer);
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  ws.on('error', () => {});
  ws.on('close', code => { peer.closed = true; peer.closeCode = code; });
  await once(ws, 'open');
  return peer;
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
}

test('real backend → fixed-thread host → relay → guest protocol enforces admission and local message policy', { skip, timeout: 60000 }, async t => {
  // All state and provider traffic are synthetic. These are WS protocol clients,
  // not a claim that native Desktop or an actual browser UI has been exercised.
  const root = await fs.mkdtemp('/tmp/coop-share-it-');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const workspace = path.join(root, 'workspace');
  const socketPath = path.join(root, 'rpc.sock');
  const assets = path.join(root, 'assets');
  const peers = [];
  const fixture = await startResponsesFixture();
  const recovery = new InviteRecovery();
  const rpcClients = [];
  let child, relay, owner;
  let stderr = '';
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    if (owner) await owner.close();
    if (relay) await relay.close();
    recovery.close();
    for (const rpc of rpcClients) rpc.close();
    await stopBackend(child);
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await Promise.all([home, codexHome, workspace, assets].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  for (const file of ['index.html', 'owner.js', 'owner.css', 'guest.js', 'style.css']) await fs.writeFile(path.join(assets, file), 'synthetic test asset');
  await fs.writeFile(path.join(codexHome, 'config.toml'), `
model = "gpt-5.1-codex"
model_provider = "coop_share_test"
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
[model_providers.coop_share_test]
name = "Synthetic sharing fixture"
base_url = "${fixture.origin}/v1"
wire_api = "responses"
env_key = "CODEX_COOP_FAKE_API_KEY"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
  child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`], {
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
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-6000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${stderr}`);
    return fs.stat(socketPath).then(stat => stat.isSocket(), () => false);
  }, 'private Unix socket');
  const ownerRpc = await RpcClient.connect(socketPath, { name: 'coop_sharing_integration_owner' });
  rpcClients.push(ownerRpc);
  const backendEvents = [];
  ownerRpc.on('notification', event => backendEvents.push(event));

  async function seed(prompt) {
    const created = await ownerRpc.request('thread/start', { cwd: workspace, modelProvider: 'coop_share_test', model: 'gpt-5.1-codex', sandbox: 'read-only', approvalPolicy: 'never' });
    const threadId = created.thread.id;
    const turn = await ownerRpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    await until(() => backendEvents.some(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === turn.turn.id), 'synthetic seed turn');
    return { threadId, turnId: turn.turn.id };
  }
  const selected = await seed('Visible shared seed');
  const other = await seed('SECRET_UNSHARED_CONVERSATION');
  const baselineRequests = fixture.requests.length;
  assert.equal(baselineRequests, 2);
  const registrationSecret = secret();
  relay = await startRelay({ registrationSecret, publicDir: assets, recovery });
  owner = await startOwner({ socketPath, relayUrl: relay.url, registrationSecret, ownerDir: assets, recovery, connection: { state: 'local' } });
  const ownerWsUrl = owner.baseUrl.replace(/^http/, 'ws') + '/owner';
  const ownerToken = new URLSearchParams(new URL(owner.url).hash.slice(1)).get('owner');

  await t.test('owner endpoint rejects cross-origin connections and incorrect local capability', async () => {
    await assert.rejects(connect(ownerWsUrl, 'https://attacker.example', peers));
    const wrong = await connect(ownerWsUrl, owner.baseUrl, peers);
    wrong.send({ type: 'auth', token: secret() });
    await until(() => wrong.closed, 'wrong owner token rejected');
    assert.equal(wrong.closeCode, 1008);
    assert.equal(wrong.messages.some(message => message.type === 'state'), false);
    assert.equal(owner.rooms.size, 0);
  });

  const local = await connect(ownerWsUrl, owner.baseUrl, peers);
  local.send({ type: 'auth', token: ownerToken });
  await until(() => local.messages.some(message => message.type === 'state'), 'authenticated local owner state');
  local.send({ type: 'share', threadId: selected.threadId, ownerName: 'Synthetic owner', requireApproval: true });
  const room = await until(() => [...owner.rooms.values()].find(value => value.state === 'online'), 'room registration');
  assert.equal(room.threadId, selected.threadId);

  async function join(name) {
    const peer = await connect(relay.url.replace(/^http/, 'ws') + '/guest', relay.url, peers);
    peer.send({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name });
    const pending = await until(() => peer.messages.find(message => message.type === 'pending'), 'pending guest');
    await until(() => room.guests.has(pending.guestId), 'local join request');
    return { peer, id: pending.guestId };
  }
  async function admit(guest) {
    local.send({ type: 'admit', roomId: room.roomId, guestId: guest.id });
    await until(() => guest.peer.messages.some(message => message.type === 'admitted'), 'owner admission');
    return until(() => guest.peer.messages.find(message => message.type === 'data' && message.payload.type === 'snapshot'), 'initial scoped snapshot');
  }

  const guest = await join('Synthetic browser guest');
  await t.test('invite is insufficient to obtain history; admitted history contains only selected text', async () => {
    room.deliver(room.thread.snapshot);
    await delay(100);
    assert.equal(guest.peer.messages.some(message => message.type === 'data'), false);
    const first = await admit(guest);
    assert.ok(first.payload.items.some(item => item.text.includes('Visible shared seed')));
    assert.equal(first.payload.items.find(item => item.role === 'user').author.kind, 'unknown');
    assert.equal(JSON.stringify(guest.peer.messages).includes('SECRET_UNSHARED_CONVERSATION'), false);
    assert.equal(JSON.stringify(guest.peer.messages).includes(selected.threadId), false);
    assert.equal(JSON.stringify(guest.peer.messages).includes(other.threadId), false);
    assert.equal(JSON.stringify(guest.peer.messages).includes(workspace), false);
  });

  await t.test('automatic renewal preserves the original invitation and admission without new model requests', async renewalTest => {
    const oldExpiry = room.expiresAt, invite = room.view().inviteUrl, startedAt = room.startedAt;
    const calls = fixture.requests.length;
    let now = oldExpiry - 300000;
    const clock = renewalTest.mock.method(Date, 'now', () => now);
    try {
      room.lastHeartbeat = now; room.maybeRenew();
      await until(() => room.expiresAt === oldExpiry + 3600000, 'acknowledged lease renewal');
      now = oldExpiry + 1;
      assert.equal(room.closed, false);
      const arriving = await join('Synthetic guest after original expiry');
      local.send({ type: 'deny', roomId: room.roomId, guestId: arriving.id });
      await until(() => arriving.peer.closed, 'new arrival denied without read access');
      assert.equal(room.guests.get(guest.id).status, 'admitted');
      assert.equal(room.view().inviteUrl, invite); assert.equal(room.startedAt, startedAt);
      assert.equal(fixture.requests.length, calls);
    } finally {
      clock.mock.restore(); room.lastHeartbeat = Date.now(); room.scheduleExpiry();
    }
  });

  await t.test('other-thread events, tool output and metadata stay out of guest transport', async () => {
    // Exercise defensive filtering even if a future app-server broadcasts broadly.
    room.rpc.emit('notification', { method: 'item/started', params: { threadId: other.threadId, turnId: other.turnId,
      item: { id: 'foreign-item', type: 'agentMessage', text: 'SECRET_FOREIGN_EVENT' } } });
    room.rpc.emit('notification', { method: 'item/started', params: { threadId: selected.threadId, turnId: selected.turnId,
      item: { id: 'tool-item', type: 'commandExecution', aggregatedOutput: 'SECRET_TOOL_OUTPUT', command: 'SECRET_COMMAND' } } });
    room.rpc.emit('notification', { method: 'item/started', params: { threadId: selected.threadId, turnId: selected.turnId,
      item: { id: 'text-with-metadata', type: 'agentMessage', text: 'Safe visible text', cwd: 'SECRET_METADATA_PATH', reasoning: 'SECRET_REASONING' } } });
    await until(() => guest.peer.messages.some(message => message.type === 'data' && message.payload.items?.some(item => item.text === 'Safe visible text')), 'sanitized live message');
    assert.equal(JSON.stringify(guest.peer.messages).includes('SECRET_'), false);
  });

  const proposal = { type: 'proposal', requestId: randomUUID(), text: 'Owner-reviewed synthetic guest instruction' };
  await t.test('proposal causes no model call until owner approves, then executes exactly once and streams', async () => {
    guest.peer.send(proposal);
    const pending = await until(() => [...room.proposals.values()].find(value => value.requestId === proposal.requestId), 'pending proposal');
    assert.equal(pending.status, 'pending');
    await delay(150);
    assert.equal(fixture.requests.length, baselineRequests);
    const before = await ownerRpc.request('thread/read', { threadId: selected.threadId, includeTurns: true });
    assert.equal(before.thread.turns.length, 1);
    const held = fixture.holdNextResponse({ holdCompletion: true });
    local.send({ type: 'approve', roomId: room.roomId, proposalId: pending.id });
    try {
      await held.arrived;
      assert.equal(fixture.requests.length, baselineRequests + 1);
      await until(() => pending.status === 'accepted', 'owner decision response');
      held.release();
      await until(() => guest.peer.messages.some(message => message.type === 'data' && message.payload.type === 'snapshot'
        && message.payload.status === 'running' && message.payload.items.some(item => item.text.includes('Synthetic answer 3'))), 'real-time streamed assistant text');
    } finally { held.release(); held.complete(); }
    await until(() => backendEvents.some(event => event.method === 'turn/completed' && event.params.threadId === selected.threadId && event.params.turn.id === pending.turnId), 'guest turn completion');
    guest.peer.send(proposal);
    await until(() => guest.peer.messages.some(message => message.type === 'duplicate' && message.requestId === proposal.requestId), 'duplicate input rejection');
    await delay(100);
    assert.equal(fixture.requests.length, baselineRequests + 1);
    const history = await ownerRpc.request('thread/read', { threadId: selected.threadId, includeTurns: true });
    assert.equal(history.thread.turns.length, 2);
    assert.ok(JSON.stringify(history.thread.turns.at(-1)).includes(proposal.text));
    await until(() => guest.peer.messages.some(message => message.payload?.items?.some(item => item.text === proposal.text && item.author?.name === 'Synthetic browser guest' && item.author.kind === 'guest')), 'approved guest author reaches snapshot');
    const unrelated = await ownerRpc.request('thread/read', { threadId: other.threadId, includeTurns: true });
    assert.equal(unrelated.thread.turns.length, 1);
    assert.equal(child.exitCode, null);
  });

  await t.test('an independent Desktop-like RPC initiator streams user and assistant text through the same admitted guest connection', async () => {
    const nativeLike = await RpcClient.connect(socketPath, { name: 'coop_sharing_integration_desktop_like' });
    rpcClients.push(nativeLike);
    await nativeLike.request('thread/resume', { threadId: selected.threadId });
    const startIndex = guest.peer.messages.length;
    const directPrompt = 'Synthetic direct Desktop-origin message';
    const held = fixture.holdNextResponse();
    let turn;
    try {
      turn = await nativeLike.request('turn/start', { threadId: selected.threadId, input: [{ type: 'text', text: directPrompt }] });
      await held.arrived;
      await until(() => guest.peer.messages.slice(startIndex).some(message => message.type === 'data'
        && message.payload.type === 'snapshot' && message.payload.items.some(item => item.role === 'user' && item.text === directPrompt && item.author?.name === 'Synthetic owner' && item.author.kind === 'host')), 'external user message visible without guest refresh');
    } finally { held.release(); }
    await until(() => guest.peer.messages.slice(startIndex).some(message => message.type === 'data'
      && message.payload.type === 'snapshot' && message.payload.items.some(item => item.role === 'assistant' && item.text === 'Synthetic answer 4')), 'external assistant reply visible without guest refresh');
    await until(() => backendEvents.some(event => event.method === 'turn/completed'
      && event.params.threadId === selected.threadId && event.params.turn.id === turn.turn.id), 'external turn completion');
    // Include the host's completion-triggered history reconciliation and delivery throttle.
    await delay(250);
    const latest = guest.peer.messages.filter(message => message.type === 'data' && message.payload.type === 'snapshot').at(-1).payload;
    assert.equal(latest.items.at(-1).text, 'Synthetic answer 4');
    assert.equal(latest.status, 'idle');
    assert.equal(guest.peer.closed, false);
    assert.equal(room.guests.get(guest.id).status, 'admitted');
    assert.equal(fixture.requests.length, baselineRequests + 2);
    const history = await nativeLike.request('thread/read', { threadId: selected.threadId, includeTurns: true });
    assert.equal(history.thread.turns.length, 3);
  });

  await t.test('revocation immediately stops data; reconnect requires fresh admission and never replays execution', async () => {
    local.send({ type: 'remove-guest', roomId: room.roomId, guestId: guest.id });
    await until(() => guest.peer.closed, 'revoked guest disconnect');
    assert.ok(guest.peer.messages.some(message => message.type === 'revoked'));
    const priorCount = guest.peer.messages.length;
    room.deliver({ type: 'snapshot', title: 'new', items: [{ id: 'later', role: 'assistant', text: 'POST_REVOCATION_CONTENT' }], status: 'idle', revision: 9999 });
    await delay(100);
    assert.equal(guest.peer.messages.length, priorCount);
    const rejoined = await join('Reconnected browser guest');
    assert.notEqual(rejoined.id, guest.id);
    await delay(100);
    assert.equal(rejoined.peer.messages.some(message => message.type === 'data'), false);
    assert.equal(fixture.requests.length, baselineRequests + 2);
    await admit(rejoined);
    await delay(100);
    assert.equal(fixture.requests.length, baselineRequests + 2);
    assert.equal(JSON.stringify(rejoined.peer.messages).includes('SECRET_'), false);
    // A browser cannot select another thread or forward even a read-only RPC.
    rejoined.peer.send({ type: 'thread/read', threadId: other.threadId });
    await until(() => rejoined.peer.closed, 'arbitrary RPC rejected');
    assert.ok(rejoined.peer.messages.some(message => message.type === 'invalid-message'));
    assert.equal(fixture.requests.length, baselineRequests + 2);
  });
  await t.test('turning off approval submits the next guest message once through the pinned backend', async () => {
    const direct = await join('Synthetic direct guest'); await admit(direct);
    local.send({ type: 'set-message-policy', roomId: room.roomId, requireApproval: false });
    await until(() => direct.peer.messages.some(m => m.payload?.type === 'message-policy' && m.payload.requireApproval === false), 'direct policy reaches guest');
    const input = { type: 'proposal', requestId: randomUUID(), text: 'Synthetic direct message without per-message approval' };
    direct.peer.send(input);
    await until(() => direct.peer.messages.some(m => m.payload?.requestId === input.requestId && m.payload.status === 'accepted'), 'automatic submission accepted');
    await until(() => direct.peer.messages.some(m => m.payload?.type === 'snapshot' && m.payload.status === 'idle'
      && m.payload.items.some(i => i.text === 'Synthetic answer 5')
      && m.payload.items.some(i => i.text === input.text && i.author?.name === 'Synthetic direct guest' && i.author.kind === 'guest')), 'automatic reply and author stream');
    direct.peer.send(input);
    await until(() => direct.peer.messages.some(m => m.type === 'duplicate' && m.requestId === input.requestId), 'automatic input duplicate rejected');
    assert.equal(fixture.requests.length, baselineRequests + 3);
    assert.equal((await ownerRpc.request('thread/read', { threadId: other.threadId, includeTurns: true })).thread.turns.length, 1);
  });
  await t.test('expired invitation recovery requires a local decision, returns to the same thread and grants only its requester', async () => {
    const count = fixture.requests.length;
    room.close({ reason: 'expired' });
    const request = { type: 'request', roomId: room.roomId, inviteToken: room.inviteToken,
      requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic late recipient' };
    const recoveryPeer = await connect(relay.url.replace(/^http/, 'ws') + '/recovery', relay.url, peers);
    recoveryPeer.send(request);
    await until(() => recoveryPeer.messages.some(m => m.type === 'recovery-request' && m.status === 'pending'), 'recovery request saved');
    assert.equal(fixture.requests.length, count);
    local.send({ type: 'approve-recovery', requestId: request.requestId });
    const approved = await until(() => recoveryPeer.messages.find(m => m.type === 'recovery-request' && m.status === 'approved'), 'recovery approved');
    const fragment = new URLSearchParams(new URL(approved.inviteUrl).hash.slice(1));
    const recovered = await connect(relay.url.replace(/^http/, 'ws') + '/guest', relay.url, peers);
    recovered.send({ type: 'join', roomId: fragment.get('room'), inviteToken: fragment.get('invite'), name: request.name, sessionId: request.visitorToken });
    const snapshot = await until(() => recovered.messages.find(m => m.payload?.type === 'snapshot'), 'recovered thread snapshot');
    assert.ok(snapshot.payload.items.some(item => item.text === 'Visible shared seed'));
    assert.equal(JSON.stringify(recovered.messages).includes('SECRET_UNSHARED_CONVERSATION'), false);
    assert.ok(recovered.messages.some(m => m.type === 'admitted'));
    assert.equal(fixture.requests.length, count, 'recovery never sends an Agent message');
    const stranger = await connect(relay.url.replace(/^http/, 'ws') + '/guest', relay.url, peers);
    stranger.send({ type: 'join', roomId: fragment.get('room'), inviteToken: fragment.get('invite'), name: request.name, sessionId: secret() });
    await until(() => stranger.messages.some(m => m.type === 'pending'), 'same-name stranger awaits admission');
    await delay(50);
    assert.equal(stranger.messages.some(m => m.type === 'data' || m.type === 'admitted'), false);
    local.send({ type: 'revoke', roomId: fragment.get('room') });
    await until(() => recovered.closed, 'recovered share revoked');
    assert.equal(recovery.watch(request, relay.url).status, 'unavailable');
  });
  t.diagnostic('Pinned backend 0.163.0; one isolated PID; actual Responses fixture + Unix RPC + local owner WebSocket + relay + guest WebSocket. Approved guest input, independent Desktop-like RPC input and invitation recovery exercised. No native Desktop, browser rendering, or public-network claim.');
});
