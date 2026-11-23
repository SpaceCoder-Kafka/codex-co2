import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createDesktopAppBridge } from '../lib/desktop-app-bridge.mjs';
import { createDesktopBridgeController, createNativeDesktopClient, readBridgeDescriptor, startDesktopBridge } from '../plugins/co2-desktop-bridge/server.mjs';

async function fixture(t) {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-app-bridge-test-')));
  const manager = createDesktopAppBridge({ runtimeDir });
  await manager.ready;
  t.after(async () => { await manager.close(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, manager, descriptor: await readBridgeDescriptor(runtimeDir) };
}

function catalogOrRead(calls) {
  return async (method, params) => {
    calls.push({ method, params });
    if (method === 'tools/list') return { tools: [{ name: 'read_thread' }] };
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
      schemaVersion: 1, thread: { id: params.arguments.threadId, hostId: 'local', title: 'Synthetic chat' },
      page: { order: 'newest_first', nextCursor: null, hasMore: false }, turns: [],
    }) }] };
  };
}

function connectRaw(descriptor, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: descriptor.port, method: 'POST', path: '/bridge/connect', agent: false, headers: {
      Host: `127.0.0.1:${descriptor.port}`, Authorization: `Bearer ${descriptor.token}`,
      'X-Co2-Generation': descriptor.generation, 'Content-Type': 'application/x-ndjson', ...headers,
    } }, response => { response.resume(); resolve({ request, response }); });
    request.once('error', reject);
    request.write(body ?? `${JSON.stringify({ type: 'hello', protocol: 1, generation: descriptor.generation, sourceThreadId: 'synthetic-source' })}\n`);
  });
}

function mcpProcess(t, { runtimeDir, pipePath }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/co2-desktop-bridge/server.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, CO2_BRIDGE_RUNTIME_DIR: runtimeDir, ...(pipePath ? { CODEX_APP_TOOLS_PIPE_PATH: pipePath } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0, buffer = '', stderr = '';
  const pending = new Map();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  t.after(async () => {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    const result = await exited; clearTimeout(timeout);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic MCP request timed out')); }, 2000);
    pending.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('only explicitly selected chats can cross the authenticated read-only Desktop bridge', async t => {
  const { runtimeDir, manager } = await fixture(t);
  const calls = [];
  let connectedEvents = 0;
  const onConnected = () => { connectedEvents += 1; };
  manager.on('connected', onConnected);
  manager.once('connected', () => { connectedEvents += 1; });
  manager.selectThread('synthetic-a');
  manager.selectThread('synthetic-b');
  const waiter = manager.waitConnected();
  const bridge = await startDesktopBridge({ runtimeDir, sourceThreadId: 'synthetic-extension', nativeRequest: catalogOrRead(calls) });
  t.after(() => bridge.close());
  await waiter;
  assert.equal(manager.connected, true);
  assert.equal(manager.sourceThreadId, 'synthetic-extension');
  assert.equal(connectedEvents, 2);
  manager.off('connected', onConnected);
  assert.equal(manager.eventEmitter.listenerCount('connected'), 0);
  await assert.rejects(manager.readPage('not-selected', {}), { code: 'thread_not_selected' });
  await assert.rejects(manager.readPage('synthetic-a', { tool: 'send_message_to_thread' }), { code: 'invalid_read_options' });
  const result = await manager.readPage('synthetic-a', { includeTurns: true, includeOutputs: true, turnLimit: 10, maxOutputCharsPerItem: 20000 });
  assert.equal(result.thread.id, 'synthetic-a');
  assert.deepEqual(calls.map(call => call.method), ['tools/list', 'tools/call']);
  const call = calls[1].params;
  assert.equal(call.tool, 'read_thread');
  assert.equal(call.threadId, 'synthetic-extension');
  assert.equal(call.arguments.threadId, 'synthetic-a');
  assert.equal(call.arguments.hostId, 'local');
  assert.equal(call.namespace, 'codex_app');
  await manager.readPage('synthetic-b', {});
  assert.equal(calls.at(-1).params.arguments.threadId, 'synthetic-b');
});

test('token, generation, Host, Origin and duplicate connections are rejected', async t => {
  const { runtimeDir, manager, descriptor } = await fixture(t);
  for (const headers of [{ Authorization: 'Bearer wrong' }, { 'X-Co2-Generation': 'old' }, { Host: 'localhost' }, { Origin: 'http://127.0.0.1' }]) {
    const { request, response } = await connectRaw(descriptor, headers);
    assert.equal(response.statusCode, 403);
    request.destroy();
  }
  const bridge = await startDesktopBridge({ runtimeDir, sourceThreadId: 'synthetic-source', nativeRequest: catalogOrRead([]) });
  t.after(() => bridge.close());
  const { request, response } = await connectRaw(descriptor);
  assert.equal(response.statusCode, 409);
  request.destroy();
  assert.equal(manager.connected, true);
});

test('reconnect rotates credentials, rejects pending reads and restores only selected scopes', async t => {
  const { runtimeDir, manager, descriptor } = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  manager.selectThread('synthetic-a');
  const bridge = await startDesktopBridge({ runtimeDir, sourceThreadId: 'synthetic-source', nativeRequest: async method => method === 'tools/list'
    ? { tools: [{ name: 'read_thread' }] } : blocked });
  t.after(() => bridge.close());
  const pendingRead = manager.readPage('synthetic-a', {});
  const rejected = assert.rejects(pendingRead, { code: 'desktop_bridge_reconnecting' });
  await manager.reconnect();
  await rejected;
  assert.equal(manager.connected, false);
  assert.equal(manager.sourceThreadId, null);
  const next = await readBridgeDescriptor(runtimeDir);
  assert.notEqual(next.token, descriptor.token);
  assert.notEqual(next.generation, descriptor.generation);
  const { request, response } = await connectRaw(descriptor);
  assert.equal(response.statusCode, 403);
  request.destroy();
  const replacement = await startDesktopBridge({ runtimeDir, sourceThreadId: 'new-synthetic-source', nativeRequest: catalogOrRead([]) });
  t.after(() => replacement.close());
  assert.equal((await manager.readPage('synthetic-a', {})).thread.id, 'synthetic-a');
  await assert.rejects(manager.readPage('not-selected', {}), { code: 'thread_not_selected' });
  release({ success: false });
});

test('malformed or oversized peer frames disconnect and pause the bridge', async t => {
  const { manager, descriptor } = await fixture(t);
  const { request } = await connectRaw(descriptor);
  assert.equal(manager.connected, true);
  const disconnected = once(manager.eventEmitter, 'disconnected');
  request.write('x'.repeat(8 * 1024 * 1024 + 1));
  await disconnected;
  assert.equal(manager.connected, false);
  request.destroy();
});

test('a response for another chat is rejected before it reaches the adapter', async t => {
  const { manager, descriptor } = await fixture(t);
  manager.selectThread('synthetic-a');
  const { request, response } = await connectRaw(descriptor);
  t.after(() => request.destroy());
  let input = '';
  response.on('data', chunk => {
    input += chunk;
    let end;
    while ((end = input.indexOf('\n')) >= 0) {
      const message = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (message.type === 'read_page') request.write(`${JSON.stringify({ type: 'reply', id: message.id, result: { thread: { id: 'another-chat' } } })}\n`);
    }
  });
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'desktop_thread_mismatch' });
});

test('runtime state is private, symlinks are refused, and close revokes the descriptor', async t => {
  const { runtimeDir, manager } = await fixture(t);
  const descriptorPath = path.join(runtimeDir, 'desktop-app-bridge.json');
  assert.equal((await fs.stat(runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(descriptorPath)).mode & 0o777, 0o600);
  await fs.chmod(runtimeDir, 0o755);
  await assert.rejects(readBridgeDescriptor(runtimeDir), { code: 'unsafe_runtime_directory' });
  await fs.chmod(runtimeDir, 0o700);
  await fs.chmod(descriptorPath, 0o640);
  await assert.rejects(readBridgeDescriptor(runtimeDir), { code: 'unsafe_bridge_descriptor' });
  await fs.chmod(descriptorPath, 0o600);
  const link = `${runtimeDir}-link`;
  await fs.symlink(runtimeDir, link);
  t.after(() => fs.unlink(link));
  const unsafe = createDesktopAppBridge({ runtimeDir: link });
  await assert.rejects(unsafe.ready, { code: 'unsafe_runtime_directory' });
  await assert.rejects(readBridgeDescriptor(link), { code: 'unsafe_runtime_directory' });
  await unsafe.close();
  const nestedUnsafe = createDesktopAppBridge({ runtimeDir: path.join(link, 'new-child') });
  await assert.rejects(nestedUnsafe.ready, { code: 'unsafe_runtime_directory' });
  await nestedUnsafe.close();
  await assert.rejects(fs.stat(path.join(runtimeDir, 'new-child')), { code: 'ENOENT' });
  const existingChild = path.join(runtimeDir, 'existing-child');
  await fs.mkdir(existingChild, { mode: 0o700 });
  await assert.rejects(readBridgeDescriptor(path.join(link, 'existing-child')), { code: 'unsafe_runtime_directory' });
  let nestedClose;
  manager.once('closed', () => { nestedClose = manager.close(); });
  const closePromise = manager.close();
  assert.equal(manager.close(), closePromise);
  assert.equal(nestedClose, closePromise);
  await closePromise;
  await assert.rejects(fs.stat(descriptorPath), { code: 'ENOENT' });
  await assert.rejects(manager.waitConnected(), { code: 'desktop_bridge_closed' });
});

test('only exact native size errors propagate as a safe adapter retry code', async t => {
  const { runtimeDir, manager } = await fixture(t);
  manager.selectThread('synthetic-a');
  const nativeErrors = [
    'Thread history exceeds the read size limit. Try fewer turns. A single oversized turn cannot be read by this tool.',
    'Thread history exceeds the read size limit. Update Codex to use paginated history reads.',
    'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.',
    'secret synthetic response exceeds the size limit',
  ];
  const bridge = await startDesktopBridge({ runtimeDir, sourceThreadId: 'synthetic-source', nativeRequest: async method => {
    if (method === 'tools/list') return { tools: [{ name: 'read_thread' }] };
    return { success: false, contentItems: [{ type: 'inputText', text: nativeErrors.shift() }] };
  } });
  t.after(() => bridge.close());
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  await assert.rejects(manager.readPage('synthetic-a', {}), error => error.code === 'desktop_read_failed' && !error.message.includes('secret'));
  assert.equal(manager.connected, true);
});

test('native framed RPC hides arbitrary errors and recognizes only exact size failures', async t => {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-client-test-')));
  const pipePath = path.join(runtimeDir, 'native.sock');
  let response = { jsonrpc: '2.0', id: 1, error: { message: 'Thread history exceeds the read size limit. Try fewer turns. A single oversized turn cannot be read by this tool.' } };
  const server = net.createServer(socket => socket.once('data', () => {
    const body = Buffer.from(JSON.stringify(response));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.end(frame);
  }));
  await new Promise(resolve => server.listen(pipePath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  const request = createNativeDesktopClient(pipePath);
  await assert.rejects(request('tools/call', {}), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  response = { jsonrpc: '2.0', id: 1, error: { message: 'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.' } };
  await assert.rejects(request('tools/call', {}), { code: 'DESKTOP_APP_RESPONSE_TOO_LARGE' });
  response = { jsonrpc: '2.0', id: 1, error: { message: 'secret diagnostic' } };
  await assert.rejects(request('tools/call', {}), error => error.code === 'desktop_rpc_failed' && !error.message.includes('secret'));
});

test('the plugin refuses a remote host or incompatible schema despite a matching thread id', async t => {
  const { runtimeDir, manager } = await fixture(t);
  manager.selectThread('synthetic-a');
  let page = { schemaVersion: 1, thread: { id: 'synthetic-a', hostId: 'remote' }, turns: [] };
  const bridge = await startDesktopBridge({ runtimeDir, sourceThreadId: 'synthetic-source', nativeRequest: async method => method === 'tools/list'
    ? { tools: [{ name: 'read_thread' }] }
    : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(page) }] } });
  t.after(() => bridge.close());
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'desktop_read_failed' });
  page = { ...page, schemaVersion: 2, thread: { id: 'synthetic-a', hostId: 'local' } };
  await assert.rejects(manager.readPage('synthetic-a', {}), { code: 'desktop_read_failed' });
});

test('connection waiting can be cancelled without leaving listeners', async t => {
  const { manager } = await fixture(t);
  const controller = new AbortController();
  const promise = manager.waitConnected({ signal: controller.signal });
  controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(promise, /synthetic cancellation/);
  await assert.rejects(manager.waitConnected({ timeoutMs: 5 }), { code: 'desktop_bridge_connect_timeout' });
  assert.equal(manager.eventEmitter.listenerCount('connected'), 0);
});

test('an authenticated MCP process follows a new manager generation without another App call', async t => {
  const { runtimeDir, manager } = await fixture(t);
  const calls = [];
  const controller = createDesktopBridgeController({ runtimeDir, nativeRequest: catalogOrRead(calls), pollMs: 5 });
  t.after(() => controller.close());
  manager.selectThread('synthetic-selected');
  await Promise.all([controller.start('synthetic-source'), controller.start('synthetic-source')]);
  assert.equal(calls.filter(call => call.method === 'tools/list').length, 1);
  await manager.reconnect();
  await manager.waitConnected({ timeoutMs: 1000 });
  assert.equal(manager.sourceThreadId, 'synthetic-source');
  assert.equal((await manager.readPage('synthetic-selected', {})).thread.id, 'synthetic-selected');
  await assert.rejects(manager.readPage('not-selected', {}), { code: 'thread_not_selected' });
  assert.equal(calls.filter(call => call.method === 'tools/list').length, 2);
  const closePromise = controller.close();
  assert.equal(controller.close(), closePromise);
  await closePromise;
  await manager.reconnect();
  await assert.rejects(manager.waitConnected({ timeoutMs: 30 }), { code: 'desktop_bridge_connect_timeout' });
});

test('automatic recovery requires genuine source metadata and never retries a failed generation', async t => {
  const { runtimeDir, manager } = await fixture(t);
  let catalogCalls = 0;
  const controller = createDesktopBridgeController({ runtimeDir, pollMs: 5, nativeRequest: async method => {
    assert.equal(method, 'tools/list');
    catalogCalls += 1;
    if (catalogCalls === 1) throw Object.assign(new Error('synthetic native rejection'), { code: 'desktop_ipc_unavailable' });
    return { tools: [{ name: 'read_thread' }] };
  } });
  t.after(() => controller.close());
  await assert.rejects(controller.start(undefined), { code: 'desktop_source_thread_required' });
  await manager.reconnect();
  await assert.rejects(manager.waitConnected({ timeoutMs: 25 }), { code: 'desktop_bridge_connect_timeout' });
  assert.equal(catalogCalls, 0);
  await assert.rejects(controller.start('synthetic-source'), { code: 'desktop_ipc_unavailable' });
  await assert.rejects(manager.waitConnected({ timeoutMs: 25 }), { code: 'desktop_bridge_connect_timeout' });
  assert.equal(catalogCalls, 1);
  await manager.reconnect();
  await manager.waitConnected({ timeoutMs: 1000 });
  assert.equal(catalogCalls, 2);
  assert.equal(manager.sourceThreadId, 'synthetic-source');
});

test('a genuine App call made after manager timeout connects when a new descriptor appears', async t => {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-late-manager-test-')));
  const calls = [];
  const controller = createDesktopBridgeController({ runtimeDir, nativeRequest: catalogOrRead(calls), pollMs: 5 });
  let manager;
  t.after(async () => { await controller.close(); await manager?.close(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  await assert.rejects(controller.start('synthetic-late-source'), { code: 'ENOENT' });
  assert.equal(calls.length, 0);
  manager = createDesktopAppBridge({ runtimeDir });
  await manager.ready;
  manager.selectThread('synthetic-selected');
  await manager.waitConnected({ timeoutMs: 1000 });
  assert.equal(manager.sourceThreadId, 'synthetic-late-source');
  assert.equal((await manager.readPage('synthetic-selected', {})).thread.id, 'synthetic-selected');
  assert.equal(calls.filter(call => call.method === 'tools/list').length, 1);
  await manager.reconnect();
  await manager.waitConnected({ timeoutMs: 1000 });
  assert.equal(manager.sourceThreadId, 'synthetic-late-source');
  assert.equal(calls.filter(call => call.method === 'tools/list').length, 2);
});

test('MCP start reports waiting without breaking its App and later reports a real connection', async t => {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-mcp-status-test-')));
  const pipePath = path.join(runtimeDir, 'native.sock');
  let manager, nativeCalls = 0;
  const native = net.createServer(socket => socket.once('data', () => {
    nativeCalls += 1;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_thread' }] } }));
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.end(frame);
  }));
  await new Promise(resolve => native.listen(pipePath, resolve));
  t.after(async () => { await manager?.close(); await new Promise(resolve => native.close(resolve)); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  const request = mcpProcess(t, { runtimeDir, pipePath });
  const params = { name: 'start_bridge', arguments: {}, _meta: { threadId: 'synthetic-status-source' } };
  await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'synthetic', version: '1' }, capabilities: {} });
  const catalog = await request('tools/list');
  assert.deepEqual(catalog.result.tools[0]._meta.ui, { resourceUri: 'ui://co2-desktop-bridge/status.html', visibility: ['app'] });
  assert.deepEqual(catalog.result.tools[0]._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  const waiting = await request('tools/call', params);
  assert.equal(waiting.error, undefined);
  assert.deepEqual(waiting.result.structuredContent, { status: 'waiting', reason: 'manager_not_ready' });
  assert.equal(waiting.result.isError, false);
  assert.equal(nativeCalls, 0);
  const resource = await request('resources/read', { uri: 'ui://co2-desktop-bridge/status.html' });
  assert.match(resource.result.contents[0].text, /ui\/initialize/);
  manager = createDesktopAppBridge({ runtimeDir });
  await manager.ready;
  await manager.waitConnected({ timeoutMs: 2000 });
  const connected = await request('tools/call', params);
  assert.deepEqual(connected.result.structuredContent, { status: 'connected' });
  assert.equal(manager.sourceThreadId, 'synthetic-status-source');
  assert.equal(nativeCalls, 1);
});

test('MCP unavailable status stays renderable without claiming a connection or allowing invalid methods', async t => {
  const { runtimeDir, manager } = await fixture(t);
  const request = mcpProcess(t, { runtimeDir });
  await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'synthetic', version: '1' }, capabilities: {} });
  const missingSource = await request('tools/call', { name: 'start_bridge', arguments: {} });
  assert.deepEqual(missingSource.result.structuredContent, { status: 'unavailable', errorCode: 'desktop_source_thread_required' });
  const noNative = await request('tools/call', { name: 'start_bridge', arguments: {}, _meta: { threadId: 'synthetic-source' } });
  assert.deepEqual(noNative.result.structuredContent, { status: 'unavailable', errorCode: 'desktop_pipe_unavailable' });
  assert.equal(noNative.result.isError, false);
  assert.equal(manager.connected, false);
  await fs.chmod(runtimeDir, 0o755);
  const unsafe = await request('tools/call', { name: 'start_bridge', arguments: {}, _meta: { threadId: 'synthetic-source' } });
  assert.deepEqual(unsafe.result.structuredContent, { status: 'unavailable', errorCode: 'unsafe_runtime_directory' });
  assert.equal(unsafe.result.isError, false);
  await fs.chmod(runtimeDir, 0o700);
  const resource = await request('resources/read', { uri: 'ui://co2-desktop-bridge/status.html' });
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  const invalid = await request('not/a/method');
  assert.equal(invalid.result, undefined);
  assert.equal(typeof invalid.error.code, 'number');
});

test('the App reconnects only for new parent deep links after initialization', async t => {
  const { runtimeDir } = await fixture(t);
  const request = mcpProcess(t, { runtimeDir });
  const resource = await request('resources/read', { uri: 'ui://co2-desktop-bridge/status.html' });
  const script = resource.result.contents[0].text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const sent = [], elements = { status: { textContent: '' }, reconnect: {} };
  const parent = { postMessage(message, target) { assert.equal(target, '*'); sent.push(JSON.parse(JSON.stringify(message))); } };
  let receive;
  runInNewContext(script, {
    parent,
    document: { getElementById(id) { assert.ok(Object.hasOwn(elements, id)); return elements[id]; } },
    addEventListener(name, handler) { assert.equal(name, 'message'); receive = handler; },
  }, { timeout: 1000 });
  const calls = () => sent.filter(message => message.method === 'tools/call');
  const deliver = (data, source = parent) => receive({ source, data: { jsonrpc: '2.0', ...data } });
  const context = url => ({ 'openai/deepLink': { url } });
  const changed = (params, source) => deliver({ method: 'ui/notifications/host-context-changed', params }, source);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'ui/initialize');
  changed(context('/?nonce=initial'));
  elements.reconnect.onclick();
  deliver({ id: 'co2-init', result: { hostContext: context('/?nonce=forged') } }, {});
  assert.equal(calls().length, 0);

  deliver({ id: 'co2-init', result: { hostContext: context('/?nonce=initial') } });
  assert.equal(calls().length, 1);
  assert.equal(sent.filter(message => message.method === 'ui/notifications/initialized').length, 1);
  changed(context('/?nonce=initial'));
  changed({ theme: 'dark', containerDimensions: { width: 800, height: 600 } });
  changed({ 'openai/deepLink': { url: '' } });
  changed({ hostContext: context('/?nonce=wrong-shape') });
  changed(context('/?nonce=forged'), {});
  deliver({ jsonrpc: '1.0', method: 'ui/notifications/host-context-changed', params: context('/?nonce=invalid-rpc') });
  assert.equal(calls().length, 1);

  changed(context('/?nonce=next'));
  changed(context('/?nonce=next'));
  changed({ theme: 'light', ...context('/?nonce=next') });
  deliver({ id: 'co2-init', result: { hostContext: context('/?nonce=duplicate-init') } });
  assert.equal(calls().length, 2);
  // The URL is only an opaque trigger: no navigation or thread scope is derived from it.
  changed(context('opaque:thread=must-not-be-selected'));
  assert.equal(calls().length, 3);
  elements.reconnect.onclick();
  assert.equal(calls().length, 4);
  for (const call of calls()) assert.deepEqual(call.params, { name: 'start_bridge', arguments: {} });
});
