import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { imageInputParts } from './thread-images.mjs';
import { fileInputParts, nativeFileParts } from './thread-files.mjs';

const LIMIT = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_OWNER_MESSAGE = '尚未找到此会话的可接入运行状态，请重新生成邀请以加载会话。';
const runFile = promisify(execFile);
async function openDesktopThread(threadId) {
  if (process.platform !== 'darwin') throw new Error('当前系统无法自动打开 Codex 会话，请在 Codex 打开后重试。');
  try {
    await runFile('/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${threadId}`], { timeout: 5000 });
  } catch { throw new Error('无法打开 Codex 会话，请确认 Codex 已安装并正在运行后重试。'); }
}
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
const own = (o, k) => o != null && Object.hasOwn(o, k);
const safeKey = k => (typeof k === 'string' || Number.isSafeInteger(k)) && !['__proto__', 'constructor', 'prototype'].includes(String(k));
export const desktopIpcPath = () => path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock');
function requestTimeout(method, elapsedMs, phase) {
  const message = method === 'initialize' ? '连接 Codex 超时，请确认 Codex 正在运行后重试。'
    : method === 'thread-owner-discovery' ? '查找会话超时，请确认 Codex 可响应后重试。'
    : method === 'thread-follower-start-turn' ? '消息提交响应超时，结果待核实；请在 Codex 确认，不要重复发送。'
    : '等待 Codex 响应超时，请检查连接后重试。';
  return Object.assign(new Error(message), { code: 'DESKTOP_IPC_TIMEOUT', method, elapsedMs, phase });
}

// An existing, same-user endpoint only. Never create a router, chmod the user's
// directories, spawn Codex, or read authentication/history files.
export async function checkDesktopEndpoint(endpoint) {
  if (!path.isAbsolute(endpoint)) throw new Error('Desktop IPC requires an absolute local socket');
  const [socket, parent] = await Promise.all([fs.lstat(endpoint), fs.lstat(path.dirname(endpoint))]);
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o022) ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) {
    throw new Error('Desktop IPC must be a same-user socket in a protected directory');
  }
}

export class DesktopIpc extends EventEmitter {
  static async connect(endpoint = desktopIpcPath(), { timeoutMs = 10000, routingTimeoutMs = 10000, responseGraceMs = 1000 } = {}) {
    await checkDesktopEndpoint(endpoint);
    const ipc = new DesktopIpc(net.connect(endpoint), timeoutMs, { routingTimeoutMs, responseGraceMs });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ipc.close(); reject(new Error('Desktop IPC connection timed out')); }, timeoutMs);
        ipc.socket.once('connect', () => { clearTimeout(timer); resolve(); });
        ipc.socket.once('error', () => { clearTimeout(timer); reject(new Error('Desktop IPC connection failed')); });
      });
      const result = await ipc.request('initialize', { clientType: 'codex-co2' });
      if (!UUID.test(result.result?.clientId ?? '')) throw new Error('Unsupported Desktop IPC initialization');
      ipc.clientId = result.result.clientId;
      return ipc;
    } catch (error) { ipc.close(); throw error; }
  }
  constructor(socket, timeoutMs, { routingTimeoutMs = 10000, responseGraceMs = 1000 } = {}) {
    super(); Object.assign(this, { socket, timeoutMs, routingTimeoutMs, responseGraceMs });
    this.clientId = 'initializing-client'; this.pending = new Map(); this.buffer = Buffer.alloc(0); this.closed = false;
    socket.on('data', data => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE();
          if (size === 0 || size > LIMIT) throw new Error('Unsupported Desktop IPC frame size');
          if (this.buffer.length < size + 4) return;
          const message = JSON.parse(this.buffer.subarray(4, size + 4));
          this.buffer = this.buffer.subarray(size + 4);
          if (message.type === 'response') {
            const pending = this.pending.get(message.requestId);
            if (!pending) continue;
            this.pending.delete(message.requestId); clearTimeout(pending.timer);
            if (message.resultType === 'success' && message.method === pending.method &&
                (!pending.target || message.handledByClientId === pending.target)) pending.resolve(message);
            else if (message.resultType === 'error' && message.error === 'request-timeout') {
              pending.reject(requestTimeout(pending.method, Date.now() - pending.startedAt, 'response'));
            } else pending.reject(Object.assign(new Error(message.error === 'no-client-found' ? NO_OWNER_MESSAGE : 'Desktop refused the request or its protocol changed'),
              { code: message.resultType === 'error' && message.error === 'no-client-found' ? 'DESKTOP_NO_OWNER' : 'DESKTOP_PROTOCOL',
                method: pending.method, elapsedMs: Date.now() - pending.startedAt, phase: 'routing' }));
          } else if (message.type === 'client-discovery-request') {
            // This helper never becomes a thread owner or handles execution/approval requests.
            this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
          } else if (message.type === 'broadcast') this.emit('broadcast', message);
        }
      } catch { this.close(); }
    });
    socket.on('error', () => this.close()); socket.on('close', () => this.close());
  }
  send(message) {
    if (this.closed || this.socket.destroyed) throw new Error('Desktop IPC disconnected');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > LIMIT || this.socket.writableLength + body.length > LIMIT) throw new Error('Desktop IPC backpressure limit');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  request(method, params, version = 0, target) {
    const requestId = randomUUID(), startedAt = Date.now();
    return new Promise((resolve, reject) => {
      // The Desktop router first discovers a capable client (up to 10 s), then
      // starts the forwarded request's timeoutMs. A matching local deadline
      // expires before its no-client-found/request-timeout reply reaches us.
      // Give both phases time to finish; never dispatch a second request.
      const deadlineMs = this.timeoutMs + (method === 'initialize' ? 0 : this.routingTimeoutMs + this.responseGraceMs);
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(requestTimeout(method, Date.now() - startedAt, 'deadline')); }, deadlineMs);
      this.pending.set(requestId, { resolve, reject, timer, method, target, startedAt });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version,
        ...(target ? { targetClientId: target } : {}), timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  follow(threadId, owner, following) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      targetClientIds: [owner], version: 1, params: { hostId: 'local', conversationId: threadId, following } });
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Desktop IPC disconnected; not retried')); }
    this.pending.clear(); this.buffer = Buffer.alloc(0); this.socket.destroy(); this.emit('closed');
  }
}

// Immer array paths, with strict bounds and own-property traversal. Native
// snapshots are private memory; only projectDesktopThread's whitelist escapes.
export function applyDesktopPatches(state, patches) {
  if (!Array.isArray(patches) || patches.length > 10000) throw new Error('Unsupported Desktop patches');
  for (const p of patches) {
    if (!['add', 'replace', 'remove'].includes(p?.op) || !Array.isArray(p.path) || !p.path.length || !p.path.every(safeKey)) throw new Error('Unsupported Desktop patch path');
    let target = state;
    for (const key of p.path.slice(0, -1)) {
      if (!own(target, key) || typeof target[key] !== 'object' || target[key] === null) throw new Error('Desktop patch parent missing');
      target = target[key];
    }
    const key = p.path.at(-1);
    if (Array.isArray(target)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > target.length || (p.op !== 'add' && key === target.length)) throw new Error('Desktop patch index invalid');
      if (p.op === 'add') target.splice(key, 0, p.value);
      else if (p.op === 'remove') target.splice(key, 1);
      else target[key] = p.value;
    } else {
      if (!target || typeof target !== 'object' || (p.op !== 'add' && !own(target, key))) throw new Error('Desktop patch key missing');
      if (p.op === 'remove') delete target[key];
      else Object.defineProperty(target, key, { value: p.value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (Buffer.byteLength(JSON.stringify(state)) > LIMIT) throw new Error('Desktop state exceeds private memory limit');
  return state;
}

export function projectDesktopThread(state, threadId) {
  if (state?.id !== threadId || state.hostId !== 'local') throw new Error('Desktop returned another thread');
  let turns = state.turns;
  const history = state.turnHistory;
  if (history?.kind === 'canonical') {
    const h = history.history;
    if (!Array.isArray(h?.islands) || !h.entitiesByKey) throw new Error('Unsupported Desktop history');
    turns = h.islands.flatMap(island => island.entries.map(entry => {
      if (!own(h.entitiesByKey, entry.value)) throw new Error('Missing Desktop history entity');
      return h.entitiesByKey[entry.value];
    }));
  } else if (history && history.kind !== 'legacy') throw new Error('Unsupported Desktop history kind');
  if (!Array.isArray(turns)) throw new Error('Unsupported Desktop turns');
  const textItem = item => {
    if (typeof item?.id !== 'string') return [];
    if (item.type === 'agentMessage' && typeof item.text === 'string') return [{ id: item.id, type: 'agentMessage', text: item.text }];
    if (item.type === 'userMessage' && Array.isArray(item.content)) return [{ id: item.id, type: 'userMessage', content: item.content
      .filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text }))
      .concat(imageInputParts(item.content), fileInputParts(item.content), nativeFileParts(item.attachments)) }];
    return [];
  };
  return { id: threadId, name: typeof state.title === 'string' ? state.title : '共享会话',
    status: { type: state.threadRuntimeStatus?.type === 'active' ? 'active' : 'idle' },
    historyTruncated: history?.kind === 'canonical' ? history.history.isComplete !== true : state.turnsPagination?.hasLoadedOldest !== true,
    turns: turns.filter(t => typeof t?.turnId === 'string').map(t => {
      const nativeItems = Array.isArray(t.items) ? t.items : [];
      const items = nativeItems.flatMap(textItem);
      const initialId = t.params?.clientUserMessageId;
      const files = nativeFileParts(t.params?.attachments);
      // Desktop assigns the persisted item a server id; clientId keeps the
      // original params.clientUserMessageId. Match one user only, and keep
      // that private association out of the shared projection.
      const candidates = typeof initialId === 'string' ? nativeItems.filter(i => i.type === 'userMessage'
        && (i.id === initialId || i.clientId === initialId)) : [];
      const initial = candidates.length === 1 && items.find(i => i.type === 'userMessage' && i.id === candidates[0].id);
      if (initial) initial.content.push(...files);
      // Keep the optimistic input and its persisted replacement one logical
      // message. A unique native clientId is the id we sent to Desktop; it is
      // presentation correlation only, never an execution capability.
      for (const item of items) {
        if (item.type !== 'userMessage') continue;
        const raw = nativeItems.find(i => i.type === 'userMessage' && i.id === item.id);
        const clientId = raw?.clientId;
        if (typeof clientId === 'string' && clientId && nativeItems.filter(i => i.type === 'userMessage'
          && (i.clientId === clientId || i.id === clientId)).length === 1) item.id = clientId;
      }
      const input = Array.isArray(t.params?.input) ? t.params.input.concat(files) : files;
      if (!items.some(i => i.type === 'userMessage')
        && (input.some(p => p?.type === 'text' && p.text) || imageInputParts(input).length || fileInputParts(input).length)) {
        items.unshift(...textItem({ id: initialId ?? `${t.turnId}:input`, type: 'userMessage', content: input }));
      }
      return { id: t.turnId, status: t.status, items };
    }) };
}

// Narrow facade for the existing ScopedThread. There is no generic RPC tunnel,
// tool approval method, account method, config mutation or native owner claim.
export class DesktopRpcClient extends EventEmitter {
  static async connect(endpoint, options) { return new DesktopRpcClient(await DesktopIpc.connect(endpoint, options)); }
  constructor(ipc) {
    super(); this.ipc = ipc; this.closed = false;
    ipc.on('broadcast', m => this.receive(m));
    ipc.on('closed', () => this.close());
  }
  async bind(threadId) {
    if (!UUID.test(threadId ?? '')) throw new Error('请填写有效的 Codex 会话 ID');
    if (this.threadId && this.threadId !== threadId) throw new Error('Desktop connection is fixed to one thread');
    if (this.binding) return this.binding;
    this.threadId = threadId;
    this.binding = (async () => {
      const owner = await this.ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
      if (!UUID.test(owner.handledByClientId ?? '') || owner.result?.supportsUntrustedAppInput !== true) throw new Error('请先在日常 Codex 打开此会话；当前 Desktop 不支持安全接入');
      this.owner = owner.handledByClientId;
      await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); this.off('state', ready); this.off('closed', gone); error ? reject(error) : resolve(); };
        const ready = () => finish(), gone = () => finish(new Error('Desktop disconnected during attachment'));
        const timer = setTimeout(() => finish(new Error('Desktop snapshot timed out')), this.ipc.timeoutMs);
        this.once('state', ready); this.once('closed', gone);
        try { this.ipc.follow(threadId, this.owner, true); } catch (error) { finish(error); }
      });
    })();
    try { await this.binding; } catch (error) { this.close(); throw error; }
  }
  receive(m) {
    if (this.closed || !this.owner) return;
    if (m.method === 'client-status-changed' && m.params?.clientId === this.owner && m.params.status === 'disconnected') return this.close();
    if (m.method !== 'thread-stream-state-changed' || m.sourceClientId !== this.owner ||
        m.params?.hostId !== 'local' || m.params.conversationId !== this.threadId ||
        !Array.isArray(m.targetClientIds) || !m.targetClientIds.includes(this.ipc.clientId)) return;
    try {
      if (m.version !== 11) throw new Error('Unsupported Desktop stream version');
      const c = m.params.change;
      if (!Number.isSafeInteger(c?.revision) || c.revision < 0) throw new Error('Invalid Desktop revision');
      if (c.type === 'snapshot') {
        if (this.revision !== undefined && c.revision <= this.revision) return;
        this.nativeState = c.conversationState;
      } else if (c.type === 'patches' && this.nativeState && c.baseRevision === this.revision && c.revision === this.revision + 1) {
        applyDesktopPatches(this.nativeState, c.patches);
      } else throw new Error('Desktop stream gap; reconnect explicitly');
      const previous = this.thread;
      this.thread = projectDesktopThread(this.nativeState, this.threadId); this.revision = c.revision;
      this.emit('state');
      // A patch adding input to an active turn is a live observation. Initial
      // snapshots and hydrated completed turns remain unattributed history.
      if (previous && c.type === 'patches') {
        const known = new Set(previous.turns.flatMap(t => t.items.map(i => i.id)));
        for (const turn of this.thread.turns) {
          if (!['inProgress', 'running'].includes(turn.status)) continue;
          const added = turn.items.filter(i => i.type === 'userMessage' && !known.has(i.id));
          if (!added.length) continue;
          for (const item of added) this.emit('notification', { method: 'item/userMessage/observed', params: { threadId: this.threadId, turnId: turn.id, item } });
        }
      }
      this.emit('notification', { method: 'thread/status/changed', params: { threadId: this.threadId } });
      this.publishApprovals();
    } catch { this.close(); }
  }
  publishApprovals() {
    // Only a boolean local-owner signal escapes native request state. Never
    // expose request IDs, commands, permission objects or an answer capability.
    const pending = (Array.isArray(this.nativeState?.requests) ? this.nativeState.requests : []).some(r => APPROVALS.has(r?.method));
    this.emit('notification', { method: 'thread/approval/changed', params: { threadId: this.threadId, pending } });
  }
  async request(method, params = {}) {
    if (this.closed) throw new Error('Desktop disconnected; reconnect explicitly');
    if (!['thread/read', 'thread/resume', 'turn/start'].includes(method)) throw new Error('Unsupported Desktop capability');
    if (method !== 'turn/start') {
      if (Object.keys(params).some(k => !['threadId', 'includeTurns'].includes(k))) throw new Error('Unsupported Desktop read options');
      await this.bind(params.threadId);
      if (this.closed) throw new Error('Desktop disconnected');
      // Resume/read also reports approvals already pending at attachment time.
      this.publishApprovals();
      return { thread: this.thread };
    }
    // No await before dispatch: ScopedThread just rechecked local approval and
    // revocation. Never rediscover an owner or retry an uncertain submission.
    if (!this.thread || params.threadId !== this.threadId || Object.keys(params).some(k => !['threadId', 'input'].includes(k)) ||
        params.input?.length !== 1 || params.input[0]?.type !== 'text' || typeof params.input[0].text !== 'string' ||
        !params.input[0].text.trim() || params.input[0].text.length > 8000 ||
        Object.keys(params.input[0]).some(k => !['type', 'text'].includes(k))) throw new Error('Unsupported Desktop input');
    const clientUserMessageId = randomUUID();
    const result = await this.ipc.request('thread-follower-start-turn', { conversationId: this.threadId,
      turnStart: { request: { threadId: this.threadId, clientUserMessageId, input: [{ type: 'text', text: params.input[0].text, text_elements: [] }] },
        context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } } }, 2, this.owner);
    const response = result.result?.result;
    return typeof response?.turn?.id === 'string'
      ? { ...response, turn: { ...response.turn, clientUserMessageId } } : response;
  }
  close() {
    if (this.closed) return; this.closed = true;
    if (this.owner && !this.ipc.closed) { try { this.ipc.follow(this.threadId, this.owner, false); } catch {} }
    this.nativeState = null; this.thread = null; this.ipc.close(); this.emit('closed');
  }
}

export async function attachDesktop({ endpoint = desktopIpcPath(), catalog, openThread = openDesktopThread } = {}) {
  const probe = await DesktopIpc.connect(endpoint); probe.close();
  const threads = new Map(), clients = new Set(); let closed = false;
  const rpcFactory = async () => {
    if (closed) throw new Error('Desktop attachment closed');
    const rpc = await DesktopRpcClient.connect(endpoint);
    if (closed) { rpc.close(); throw new Error('Desktop attachment closed'); }
    clients.add(rpc); rpc.once('closed', () => clients.delete(rpc)); return rpc;
  };
  return { endpoint, rpcFactory,
    async selectThread(threadId, { activate = false, canContinue = () => true } = {}) {
      if (!UUID.test(threadId ?? '')) throw new Error('请填写有效的 Codex 会话 ID');
      if (catalog && !await catalog.contains(threadId)) throw new Error('会话已归档或不在当前 Codex 索引中，请刷新列表');
      if (closed) throw new Error('Desktop attachment closed');
      const checkCurrent = () => {
        if (closed || !canContinue()) throw new Error('本次共享已取消，请重新操作');
      };
      const read = async () => {
        checkCurrent();
        const rpc = await rpcFactory();
        try {
          const { thread } = await rpc.request('thread/read', { threadId });
          checkCurrent();
          threads.set(threadId, { id: threadId, name: thread.name });
        } finally { rpc.close(); }
      };
      try { await read(); }
      catch (error) {
        // Only an explicit share may load a missing owner. A timeout or protocol
        // failure is not proof of a missing owner and must not trigger navigation.
        if (!activate || error.code !== 'DESKTOP_NO_OWNER') throw error;
        checkCurrent();
        if (catalog && !await catalog.contains(threadId)) throw new Error('会话已归档或不在当前 Codex 索引中，请刷新列表');
        checkCurrent();
        await openThread(threadId);
        // Opening a URL acknowledges delivery, not completion of native loading.
        // Retry only read-only attachment, with one navigation and a fixed bound.
        for (let attempt = 0; attempt < 2; attempt++) {
          await delay(500); checkCurrent();
          try { await read(); return; }
          catch (error) {
            if (error.code !== 'DESKTOP_NO_OWNER') throw error;
            if (attempt === 1) throw Object.assign(new Error('已在 Codex 打开此会话，但尚未能接入。请等待会话加载完成后重试。'),
              { code: error.code, method: error.method, phase: error.phase, elapsedMs: error.elapsedMs });
          }
        }
      }
    },
    listThreads: options => catalog ? catalog.list(options) : Promise.resolve([...threads.values()]),
    close() { closed = true; threads.clear(); for (const rpc of clients) rpc.close(); },
  };
}
