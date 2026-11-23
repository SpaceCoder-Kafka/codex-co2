import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_SELECTED = 256;
const RESOURCE_URI = 'ui://co2-desktop-bridge/status.html';
const failure = code => Object.assign(new Error(code), { code });
const READ_SIZE_ERRORS = new Set([
  'Thread history exceeds the read size limit. Try fewer turns. A single oversized turn cannot be read by this tool.',
  'Thread history exceeds the read size limit. Update Codex to use paginated history reads.',
  'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.',
]);
const isReadSizeError = value => typeof value === 'string' && READ_SIZE_ERRORS.has(value);
const WAITING_ERRORS = new Set(['ENOENT', 'manager_connection_failed', 'manager_connection_closed', 'manager_handshake_timeout']);
const UNAVAILABLE_ERRORS = new Set([
  'invalid_runtime_directory', 'unsafe_runtime_directory', 'unsafe_bridge_descriptor', 'invalid_bridge_descriptor',
  'desktop_source_thread_required', 'desktop_pipe_unavailable', 'desktop_ipc_unavailable', 'desktop_ipc_closed',
  'desktop_request_timeout', 'desktop_rpc_failed', 'invalid_desktop_response', 'desktop_read_interface_unavailable',
  'manager_connection_rejected', 'desktop_bridge_closed', 'EACCES', 'EPERM', 'ELOOP',
]);

function startResult(error) {
  if (!error) return { content: [{ type: 'text', text: 'Codex Co² 已连接。' }], structuredContent: { status: 'connected' }, isError: false };
  const waiting = WAITING_ERRORS.has(error.code);
  const reason = waiting ? 'manager_not_ready' : UNAVAILABLE_ERRORS.has(error.code) ? error.code : 'desktop_bridge_unavailable';
  return {
    content: [{ type: 'text', text: waiting ? '正在等待此电脑上的 Codex Co² 启动或重新连接。' : 'Codex Co² 桥接暂不可用，请在 Co² 中检查连接状态。' }],
    structuredContent: waiting ? { status: 'waiting', reason } : { status: 'unavailable', errorCode: reason },
    // The status request succeeded. An unavailable bridge remains disconnected;
    // protocol-level errors would prevent Desktop from rendering this status App.
    isError: false,
  };
}

export async function readBridgeDescriptor(runtimeDir) {
  if (!path.isAbsolute(runtimeDir ?? '')) throw failure('invalid_runtime_directory');
  const directory = await fs.lstat(runtimeDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || (process.getuid && directory.uid !== process.getuid())
    || await fs.realpath(runtimeDir) !== path.resolve(runtimeDir)) throw failure('unsafe_runtime_directory');
  const handle = await fs.open(path.join(runtimeDir, 'desktop-app-bridge.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077)
      || (process.getuid && info.uid !== process.getuid())) throw failure('unsafe_bridge_descriptor');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (value.protocol !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !/^[a-f0-9]{64}$/.test(value.token ?? '') || !/^[a-f0-9-]{36}$/.test(value.generation ?? '')) throw failure('invalid_bridge_descriptor');
  return value;
}

export function createNativeDesktopClient(pipePath) {
  return async (method, params) => {
    if (!pipePath) throw failure('desktop_pipe_unavailable');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      let pending = Buffer.alloc(0);
      let complete = false;
      const finish = (error, result) => {
        if (complete) return;
        complete = true;
        socket.destroy();
        error ? reject(error) : resolve(result);
      };
      socket.setTimeout(12000, () => finish(failure('desktop_request_timeout')));
      socket.once('error', () => finish(failure('desktop_ipc_unavailable')));
      socket.once('close', () => finish(failure('desktop_ipc_closed')));
      socket.once('connect', () => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
        if (body.length > MAX_FRAME) return finish(failure('desktop_request_too_large'));
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
      });
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 4) return;
        const size = pending.readUInt32LE(0);
        if (size > MAX_FRAME) return finish(failure('DESKTOP_APP_RESPONSE_TOO_LARGE'));
        if (pending.length < 4 + size) return;
        try {
          const response = JSON.parse(pending.subarray(4, 4 + size).toString('utf8'));
          if (response.id !== 1) return finish(failure('desktop_rpc_failed'));
          if (response.error) return finish(failure(isReadSizeError(response.error.message) ? 'DESKTOP_APP_RESPONSE_TOO_LARGE' : 'desktop_rpc_failed'));
          finish(null, response.result);
        } catch { finish(failure('invalid_desktop_response')); }
      });
    });
  };
}

function normalizeReadOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_read_options');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'cursor' && typeof item === 'string' && item.length <= 8192) result[key] = item;
    else if (key === 'turnLimit' && Number.isInteger(item) && item >= 1 && item <= 10) result[key] = item;
    else if (['includeTurns', 'includeOutputs'].includes(key) && typeof item === 'boolean') result[key] = item;
    else if (key === 'maxOutputCharsPerItem' && Number.isInteger(item) && item >= 0 && item <= 20000) result[key] = item;
    else throw failure('invalid_read_options');
  }
  return result;
}

export async function startDesktopBridge({ runtimeDir, sourceThreadId, nativeRequest, onClose = () => {} }) {
  if (typeof sourceThreadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sourceThreadId)) throw failure('desktop_source_thread_required');
  const catalog = await nativeRequest('tools/list', { threadStartKind: 'all' });
  if (!Array.isArray(catalog?.tools) || !catalog.tools.some(tool => tool.name === 'read_thread')) throw failure('desktop_read_interface_unavailable');
  const descriptor = await readBridgeDescriptor(runtimeDir);
  const selected = new Set();
  const pendingIds = new Set();
  let closed = false;
  let connected = false;
  let input = Buffer.alloc(0);
  let response;
  let heartbeat;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const request = http.request({ hostname: '127.0.0.1', port: descriptor.port, method: 'POST', path: '/bridge/connect', headers: {
    Host: `127.0.0.1:${descriptor.port}`, Authorization: `Bearer ${descriptor.token}`,
    'X-Co2-Generation': descriptor.generation, 'Content-Type': 'application/x-ndjson',
  } });
  const close = (code = 'desktop_bridge_closed') => {
    if (closed) return;
    closed = true;
    connected = false;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    request.destroy();
    response?.destroy();
    selected.clear();
    rejectReady(failure(code));
    onClose({ code });
  };
  const timeout = setTimeout(() => close('manager_handshake_timeout'), 5000);
  timeout.unref();
  function send(message) {
    if (closed) return false;
    const frame = Buffer.from(`${JSON.stringify(message)}\n`);
    if (frame.length > MAX_FRAME || request.writableLength + frame.length > MAX_FRAME * 2) {
      close('bridge_backpressure'); return false;
    }
    request.write(frame);
    return true;
  }
  async function handle(message) {
    if (!connected) {
      if (message?.type !== 'ready' || message.protocol !== 1 || message.generation !== descriptor.generation) throw failure('invalid_manager_handshake');
      connected = true;
      clearTimeout(timeout);
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), 10000);
      heartbeat.unref();
      resolveReady();
      return;
    }
    if (message?.type === 'select' && typeof message.threadId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(message.threadId)) {
      if (!selected.has(message.threadId) && selected.size >= MAX_SELECTED) throw failure('too_many_selected_threads');
      selected.add(message.threadId);
      return;
    }
    if (message?.type !== 'read_page' || typeof message.id !== 'string' || message.id.length > 100
      || pendingIds.has(message.id) || pendingIds.size >= 32) throw failure('unexpected_manager_message');
    pendingIds.add(message.id);
    try {
      if (!selected.has(message.threadId)) throw failure('thread_not_selected');
      const options = normalizeReadOptions(message.options);
      const result = await nativeRequest('tools/call', {
        arguments: { ...options, threadId: message.threadId, hostId: 'local' },
        callerSource: 'codex', callId: `co2-read-${message.id}`, hostId: 'local', namespace: 'codex_app',
        threadId: sourceThreadId, tool: 'read_thread', turnId: `mcp-turn-${message.id}`,
      });
      if (result?.success !== true) {
        const oversized = result?.contentItems?.some(item => item.type === 'inputText' && isReadSizeError(item.text));
        throw failure(oversized ? 'DESKTOP_APP_RESPONSE_TOO_LARGE' : 'desktop_read_failed');
      }
      let page;
      for (const item of result.contentItems ?? []) {
        if (item.type !== 'inputText' || typeof item.text !== 'string') continue;
        try {
          const value = JSON.parse(item.text);
          if (value?.schemaVersion === 1 && value?.thread?.id === message.threadId && value?.thread?.hostId === 'local') { page = value; break; }
        } catch { /* Only the expected structured read result is forwarded. */ }
      }
      if (!page) throw failure('desktop_thread_mismatch');
      send({ type: 'reply', id: message.id, result: page });
    } catch (error) {
      send({ type: 'reply', id: message.id, error: { code: error.code ?? 'desktop_read_failed' } });
    } finally { pendingIds.delete(message.id); }
  }
  request.once('error', () => close('manager_connection_failed'));
  request.once('response', value => {
    response = value;
    if (value.statusCode !== 200) return close('manager_connection_rejected');
    value.on('error', () => close('manager_connection_closed'));
    value.on('end', () => close('manager_connection_closed'));
    value.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (!closed) {
        const end = input.indexOf(10);
        if (end < 0) { if (input.length > MAX_FRAME) close('frame_too_large'); return; }
        if (end > MAX_FRAME) return close('frame_too_large');
        let message;
        try { message = JSON.parse(input.subarray(0, end).toString('utf8')); }
        catch { return close('invalid_manager_frame'); }
        input = input.subarray(end + 1);
        handle(message).catch(error => close(error.code ?? 'invalid_manager_frame'));
      }
    });
  });
  send({ type: 'hello', protocol: 1, generation: descriptor.generation, sourceThreadId });
  await ready;
  return { get connected() { return connected; }, generation: descriptor.generation, close };
}

/** Keep the genuine Desktop source context across manager credential rotations. */
export function createDesktopBridgeController({ runtimeDir, nativeRequest, pollMs = 1000 }) {
  let bridge;
  let sourceThreadId;
  let lastAttemptGeneration;
  let stopped = false;
  let timer;
  let connectingPromise = Promise.resolve();
  let closingPromise;

  function serialize(operation) {
    const result = connectingPromise.catch(() => {}).then(async () => {
      if (stopped) throw failure('desktop_bridge_closed');
      return operation();
    });
    connectingPromise = result;
    return result;
  }

  async function connect(descriptor) {
    if (bridge?.connected && bridge.generation === descriptor.generation) return;
    lastAttemptGeneration = descriptor.generation;
    bridge?.close();
    // An old stream's close callback may schedule a check, but cannot clear a newer stream.
    const next = await startDesktopBridge({ runtimeDir, sourceThreadId, nativeRequest, onClose: schedule });
    if (stopped) { next.close(); throw failure('desktop_bridge_closed'); }
    bridge = next;
    lastAttemptGeneration = next.generation;
  }

  function schedule() {
    if (stopped || !sourceThreadId || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await serialize(async () => {
          if (bridge?.connected) return;
          const descriptor = await readBridgeDescriptor(runtimeDir);
          // The App can open after a timed-out manager removed its descriptor.
          // Genuine source metadata permits the next safe descriptor's first attempt;
          // a failed stream never competes for the same generation indefinitely.
          if (descriptor.generation !== lastAttemptGeneration) await connect(descriptor);
        });
      } catch { /* Only explicit new manager generations or a new App call trigger retries. */ }
      finally { schedule(); }
    }, pollMs);
    timer.unref();
  }

  return {
    get connected() { return bridge?.connected === true; },
    start(source) {
      if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(source)) return Promise.reject(failure('desktop_source_thread_required'));
      return serialize(async () => {
        sourceThreadId = source;
        try { await connect(await readBridgeDescriptor(runtimeDir)); }
        finally { schedule(); }
      });
    },
    close() {
      if (closingPromise) return closingPromise;
      stopped = true;
      clearTimeout(timer);
      bridge?.close();
      closingPromise = connectingPromise.catch(() => {}).then(() => { bridge?.close(); });
      return closingPromise;
    },
  };
}

const statusHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Co²</title>
<style>body{font:16px system-ui;padding:32px;color:#222}pre{white-space:pre-wrap}</style>
<h1>Codex Co²</h1><p>连接此电脑上的 Co²，读取你明确选择共享的会话。</p><pre id="status">正在连接…</pre><button id="reconnect" type="button">重新连接</button>
<script>(()=>{
let sequence=0,initialized=false,lastDeepLink;
const send=m=>parent.postMessage(m,'*');
const changedDeepLink=context=>{
  const url=context?.['openai/deepLink']?.url;
  if(typeof url!=='string'||url.length===0||url===lastDeepLink)return false;
  lastDeepLink=url;
  return true;
};
const connect=()=>{
  if(!initialized)return;
  document.getElementById('status').textContent='正在连接…';
  send({jsonrpc:'2.0',id:'co2-connect-'+(++sequence),method:'tools/call',params:{name:'start_bridge',arguments:{}}});
};
document.getElementById('reconnect').onclick=connect;
addEventListener('message',e=>{
  if(e.source!==parent||e.data?.jsonrpc!=='2.0')return;
  const m=e.data;
  if(m.id==='co2-init'&&m.result&&!initialized){
    changedDeepLink(m.result.hostContext);
    initialized=true;
    send({jsonrpc:'2.0',method:'ui/notifications/initialized'});
    connect();
  }
  if(m.method==='ui/notifications/host-context-changed'){
    const changed=changedDeepLink(m.params);
    if(initialized&&changed)connect();
  }
  if(typeof m.id==='string'&&m.id.startsWith('co2-connect-'))document.getElementById('status').textContent=JSON.stringify(m.result?.structuredContent??m.result??m.error,null,2);
  if(m.method==='ui/notifications/tool-result')document.getElementById('status').textContent=JSON.stringify(m.params?.structuredContent??m.params,null,2);
});
send({jsonrpc:'2.0',id:'co2-init',method:'ui/initialize',params:{protocolVersion:'2025-11-21',appInfo:{name:'co2-desktop-bridge',version:'0.1.0'},appCapabilities:{}}});
})();</script></html>`;

export function serveBridgeMcp({ runtimeDir = process.env.CO2_BRIDGE_RUNTIME_DIR, pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH } = {}) {
  const nativeRequest = createNativeDesktopClient(pipePath);
  const controller = createDesktopBridgeController({ runtimeDir, nativeRequest });
  const tool = { name: 'start_bridge', title: '连接 Codex Co²', description: 'Start or check the local Co² connection for explicitly selected chats on this Desktop. Returns connected, waiting, or unavailable status. No model or guest send is started.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }] } } };
  async function handle(request) {
    if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'co2-desktop-bridge', version: '0.1.0' } };
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list') return { tools: [tool] };
    if (request.method === 'resources/list') return { resources: [{ uri: RESOURCE_URI, name: 'Codex Co² connection', mimeType: 'text/html;profile=mcp-app' }] };
    if (request.method === 'resources/templates/list') return { resourceTemplates: [] };
    if (request.method === 'resources/read' && request.params?.uri === RESOURCE_URI) return { contents: [{ uri: RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: statusHtml }] };
    if (request.method !== 'tools/call' || request.params?.name !== 'start_bridge') throw failure('unsupported_mcp_method');
    const metadata = request.params._meta ?? {};
    const sourceThreadId = metadata.threadId ?? metadata.thread_id ?? metadata['openai/threadId'] ?? metadata['openai/thread_id'];
    try { await controller.start(sourceThreadId); return startResult(); }
    catch (error) { return startResult(error); }
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line) > MAX_FRAME) { process.exitCode = 1; input.close(); return; }
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!Object.hasOwn(request, 'id')) return;
    handle(request).then(result => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`),
      error => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.code ?? 'bridge_failed' } })}\n`));
  });
  input.once('close', () => { controller.close().finally(() => process.exit(process.exitCode ?? 0)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serveBridgeMcp();
