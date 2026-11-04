import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { imageInputParts } from './thread-images.mjs';
import { fileInputParts, nativeFileParts } from './thread-files.mjs';
import { projectActivity, aggregateTurnActivities } from './thread-activities.mjs';
import { userPresentation, userMessageMetadata, delegatedUserIntent, USER_SOURCE_TEXT, NATIVE_INPUT_DIGEST, NATIVE_INPUT_ID } from './user-presentation.mjs';
import { WINDOWS_DESKTOP_PIPE, connectWindowsDesktop, openDesktopLink } from './platform.mjs';
import { trustedAttachments, desktopAttachments } from './guest-uploads.mjs';

const LIMIT = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_OWNER_MESSAGE = '尚未找到此会话的可接入运行状态，请重新生成邀请以加载会话。';
async function openDesktopThread(threadId) {
  try {
    await openDesktopLink(threadId);
  } catch { throw new Error('无法打开 Codex 会话，请确认 Codex 已安装并正在运行后重试。'); }
}
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
const own = (o, k) => o != null && Object.hasOwn(o, k);
const safeKey = k => (typeof k === 'string' || Number.isSafeInteger(k)) && !['__proto__', 'constructor', 'prototype'].includes(String(k));
// The Windows name is established from the official Desktop's bundled IPC
// platform implementation; authentication is performed on the connected native
// handle by the packaged bridge, rather than inferred from a filesystem path.
export const desktopIpcPath = () => process.platform === 'win32' ? WINDOWS_DESKTOP_PIPE : path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock');
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
  if (process.platform === 'win32') {
    if (endpoint !== WINDOWS_DESKTOP_PIPE) throw new Error('Unsupported official Desktop named pipe');
    return; // Connected server SID + pipe DACL are checked before any IPC bytes.
  }
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
    const native = process.platform === 'win32';
    const socket = native ? await connectWindowsDesktop(endpoint, { timeoutMs }) : net.connect(endpoint);
    const ipc = new DesktopIpc(socket, timeoutMs, { routingTimeoutMs, responseGraceMs });
    try {
      if (!native) await new Promise((resolve, reject) => {
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

const agentItem = item => item?.type === 'agentMessage';
const citationFinalItem = item => agentItem(item) && item.phase === 'final_answer' && typeof item.text === 'string'
  && own(item, 'memoryCitation') && typeof item.memoryCitation === 'object';

// Desktop's canonical history is accompanied by an independently updated local
// tail in state.turns. These helpers mirror the display merge (FT/dl/MOe/jOe/
// kOe in the static Desktop bundle), before the existing field whitelist. They
// do not copy any additional native data into the public projection.
function mergeDesktopItems(existing, incoming) {
  const byId = new Map(existing.map(item => [item?.id, item]));
  const matched = new Map(), replacements = new Map();
  for (const item of incoming) {
    const sameId = byId.get(item?.id);
    if (sameId) { matched.set(item.id, sameId.id); replacements.set(sameId.id, sameId); continue; }
    if (!citationFinalItem(item)) continue;
    const sameFinal = existing.find(value => !replacements.has(value?.id) && citationFinalItem(value) && value.text === item.text);
    if (!sameFinal) continue;
    matched.set(item.id, sameFinal.id);
    replacements.set(sameFinal.id, { ...sameFinal, ...item, id: sameFinal.id, memoryCitation: item.memoryCitation ?? sameFinal.memoryCitation });
  }
  const before = new Map(); let pending = [];
  for (const item of incoming) {
    const id = matched.get(item?.id);
    if (id === undefined) { pending.push(item); continue; }
    if (!pending.length) continue;
    const target = replacements.get(id)?.id ?? id;
    before.set(target, [...before.get(target) ?? [], ...pending]); pending = [];
  }
  return [...existing.flatMap(item => [...before.get(item?.id) ?? [], replacements.get(item?.id) ?? item]), ...pending];
}

function mergeDesktopTurn(history, overlay) {
  const previous = Array.isArray(history.items) ? history.items : [], next = Array.isArray(overlay.items) ? overlay.items : [];
  let items = next;
  if (history.itemsPagination != null || overlay.itemsPagination != null) items = mergeDesktopItems(previous, next);
  else if (previous.some(item => item?.type === 'steeringUserMessage')) {
    const latest = new Map(next.map(item => [item?.id, item]));
    items = mergeDesktopItems(previous.map(item => agentItem(item) ? latest.get(item.id) ?? item : item), next);
  } else if (previous.length > next.length) {
    items = previous;
    const final = next.findLast(item => agentItem(item) && item.phase === 'final_answer');
    if (final) {
      const retained = previous.find(item => agentItem(item) && (item.id === final.id || item.phase === 'final_answer' && item.text === final.text));
      if (!retained) items = [...previous, final];
      else if (retained.id !== final.id) items = previous.map(item => item === retained
        ? { ...retained, ...final, id: retained.id, memoryCitation: final.memoryCitation ?? retained.memoryCitation } : item);
    }
  }
  const pagination = history.itemsPagination == null ? overlay.itemsPagination : { ...overlay.itemsPagination, ...history.itemsPagination };
  const params = history.params?.clientUserMessageId != null && history.params?.input?.length > 0 && overlay.params?.input?.length === 0
    ? history.params : overlay.params;
  return { ...overlay, params, items,
    status: history.status !== 'inProgress' && overlay.status === 'inProgress' && pagination != null ? history.status : overlay.status,
    diff: overlay.diff ?? history.diff,
    turnStartedAtMs: history.turnStartedAtMs ?? overlay.turnStartedAtMs,
    durationMs: history.durationMs ?? overlay.durationMs,
    finalAssistantStartedAtMs: history.finalAssistantStartedAtMs ?? overlay.finalAssistantStartedAtMs,
    ...(pagination != null ? { itemsPagination: pagination } : {}) };
}

function desktopTurns(state) {
  const history = state.turnHistory;
  if (history?.kind !== 'canonical') {
    if (history && history.kind !== 'legacy') throw new Error('Unsupported Desktop history kind');
    if (!Array.isArray(state.turns)) throw new Error('Unsupported Desktop turns');
    return state.turns.map((turn, index) => ({ turn, key: `legacy:${index}` }));
  }
  const h = history.history;
  // Older snapshots may omit an empty local tail. A present malformed tail is
  // still rejected; it is never treated as a different source of authority.
  const tail = state.turns === undefined ? [] : state.turns;
  if (!Array.isArray(h?.islands) || !h.entitiesByKey || !Array.isArray(tail)) throw new Error('Unsupported Desktop history');
  const records = h.islands.flatMap(island => island.entries.map(entry => {
    if (!own(h.entitiesByKey, entry.value)) throw new Error('Missing Desktop history entity');
    return { turn: h.entitiesByKey[entry.value], key: entry.value };
  }));
  const known = new Set(records.flatMap(({ turn }) => typeof turn?.turnId === 'string' ? [turn.turnId] : []));
  const overlays = new Map(tail.flatMap(turn => typeof turn?.turnId === 'string' ? [[turn.turnId, turn]] : []));
  const before = new Map(); let pending = [];
  tail.forEach((turn, index) => {
    const id = turn?.turnId;
    if (typeof id !== 'string' || !known.has(id)) { pending.push({ turn, key: `overlay:${index}` }); return; }
    if (pending.length) { before.set(id, [...before.get(id) ?? [], ...pending]); pending = []; }
  });
  return [...records.flatMap(({ turn, key }) => [
    ...before.get(turn?.turnId) ?? [],
    { key, turn: overlays.has(turn?.turnId) ? mergeDesktopTurn(turn, overlays.get(turn.turnId)) : turn },
  ]), ...pending].filter(({ turn }) => !(turn?.turnId == null && turn?.turnStartedAtMs == null
    && turn?.status === 'completed' && turn?.error == null && Array.isArray(turn?.items) && turn.items.length === 0));
}

function presentationTurnId(turn, key) {
  if (typeof turn?.turnId === 'string' && turn.turnId) return turn.turnId;
  if (turn?.turnId !== null) return null;
  const anchor = typeof turn.params?.clientUserMessageId === 'string' ? ['client', turn.params.clientUserMessageId]
    : typeof turn.items?.[0]?.id === 'string' ? ['item', turn.items[0].id] : ['entry', key];
  // A local turn has no native execution handle. This key is used only by the
  // display adapter; turn/start continues to submit against the fixed thread.
  return 'co2:local-turn:' + createHash('sha256').update(JSON.stringify(anchor)).digest('hex');
}

function originalInputEvidence(input, clientId) {
  if (!Array.isArray(input) || input.some(p => p?.type === 'text' && typeof p.text !== 'string')) return {};
  return { [NATIVE_INPUT_DIGEST]: createHash('sha256').update(input.filter(p => p?.type === 'text').map(p => p.text).join('\n')).digest('hex'),
    ...(typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 256 ? { [NATIVE_INPUT_ID]: clientId } : {}) };
}

export function projectDesktopThread(state, threadId) {
  if (state?.id !== threadId || state.hostId !== 'local') throw new Error('Desktop returned another thread');
  const history = state.turnHistory;
  const turns = desktopTurns(state);
  const textItem = (item, context = {}) => {
    if (typeof item?.id !== 'string') return [];
    if (item.type === 'functionCallOutput') {
      const intent = delegatedUserIntent(item);
      if (intent) return textItem({ id: item.id, type: 'userMessage', content: [{ type: 'text', text: intent.text }], source: intent.source }, context);
      // Never expose an unrecognized or incomplete delegation wrapper as an
      // ordinary tool log: it can contain IDs of conversations outside scope.
      if (typeof item.output === 'string' && item.output.includes('<codex_delegation')) return [];
    }
    if (item.type === 'agentMessage' && typeof item.text === 'string') return [{ id: item.id, type: 'agentMessage', text: item.text,
      ...(['commentary', 'final_answer'].includes(item.phase) ? { phase: item.phase } : {}) }];
    if (['userMessage', 'steeringUserMessage'].includes(item.type)) {
      const input = item.type === 'steeringUserMessage' ? item.input : item.content;
      if (!Array.isArray(input)) return [];
      const originalText = input.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
      const display = userPresentation(originalText, context.plan);
      return [{ id: item.id, type: 'userMessage', content: (input.some(p => p?.type === 'text') ? [{ type: 'text', text: display.text }] : [])
        .concat(imageInputParts(input), fileInputParts(input), nativeFileParts(item.attachments)),
      ...(display.presentation ? { presentation: display.presentation, [USER_SOURCE_TEXT]: originalText } : {}),
      ...(item.type === 'steeringUserMessage' ? originalInputEvidence(item.input, item.clientUserMessageId) : {}), ...userMessageMetadata(item, context) }];
    }
    const activity = projectActivity(item);
    return activity ? [activity] : [];
  };
  return { id: threadId, name: typeof state.title === 'string' ? state.title : '共享会话',
    status: { type: state.threadRuntimeStatus?.type === 'active' ? 'active' : 'idle' },
    historyTruncated: history?.kind === 'canonical' ? history.history.isComplete !== true : state.turnsPagination?.hasLoadedOldest !== true,
    turns: turns.flatMap(({ turn: t, key }) => {
      const turnId = presentationTurnId(t, key);
      if (!turnId) return [];
      const nativeItems = Array.isArray(t.items) ? t.items : [];
      const plan = nativeItems.findLast(i => i?.type === 'planImplementation' && typeof i.planContent === 'string')?.planContent
        ?? nativeItems.findLast(i => i?.type === 'plan' && typeof i.text === 'string')?.text;
      const items = nativeItems.flatMap(item => textItem(item, { plan }));
      for (const steering of nativeItems.filter(item => item?.type === 'steeringUserMessage')) {
        const persisted = nativeItems.filter(item => item?.type === 'userMessage' && (item.id === steering.serverUserMessageId
          || (typeof steering.clientUserMessageId === 'string' && item.clientId === steering.clientUserMessageId)));
        if (persisted.length !== 1) continue;
        const replacement = items.find(item => item.id === persisted[0].id && item.type === 'userMessage');
        const duplicate = items.findIndex(item => item.id === steering.id && item.type === 'userMessage');
        if (replacement && duplicate >= 0) {
          Object.assign(replacement, userMessageMetadata(steering));
          Object.assign(replacement, originalInputEvidence(steering.input, steering.clientUserMessageId));
          items.splice(duplicate, 1);
        }
      }
      const initialId = t.params?.clientUserMessageId;
      const files = nativeFileParts(t.params?.attachments);
      // Desktop assigns the persisted item a server id; clientId keeps the
      // original params.clientUserMessageId. Match one user only, and keep
      // that private association out of the shared projection.
      const candidates = typeof initialId === 'string' ? nativeItems.filter(i => (i.type === 'userMessage'
        && (i.id === initialId || i.clientId === initialId)) || (i.type === 'steeringUserMessage'
          && (i.id === initialId || i.clientUserMessageId === initialId))) : [];
      const initial = candidates.length === 1 && items.find(i => i.type === 'userMessage' && i.id === candidates[0].id);
      if (initial) { initial.content.push(...files); Object.assign(initial, originalInputEvidence(t.params?.input, initialId), userMessageMetadata(candidates[0], { createdAt: t.turnStartedAtMs, clientId: initialId })); }
      // Keep the optimistic input and its persisted replacement one logical
      // message. A unique native clientId is the id we sent to Desktop; it is
      // presentation correlation only, never an execution capability.
      for (const item of items) {
        if (item.type !== 'userMessage') continue;
        const steering = nativeItems.find(i => i.type === 'steeringUserMessage' && i.id === item.id);
        if (steering && typeof steering.clientUserMessageId === 'string' && steering.clientUserMessageId
          && !steering.clientUserMessageId.startsWith('chatgpt-messaging:')
          && nativeItems.filter(i => i.type === 'userMessage' && (i.clientId === steering.clientUserMessageId || i.id === steering.clientUserMessageId)
            || i.type === 'steeringUserMessage' && (i.clientUserMessageId === steering.clientUserMessageId || i.id === steering.clientUserMessageId)).length === 1) {
          item.id = steering.clientUserMessageId;
          continue;
        }
        const raw = nativeItems.find(i => i.type === 'userMessage' && i.id === item.id);
        const clientId = raw?.clientId;
        if (typeof clientId === 'string' && clientId && !clientId.startsWith('chatgpt-messaging:') && nativeItems.filter(i => i.type === 'userMessage'
          && (i.clientId === clientId || i.id === clientId)).length === 1) item.id = clientId;
      }
      const input = Array.isArray(t.params?.input) ? t.params.input.concat(files) : files;
      const openingPresent = Boolean(initial) || nativeItems.some(item => item?.type === 'userMessage'
        && JSON.stringify(item.content) === JSON.stringify(t.params?.input));
      if (!initial && openingPresent) {
        const matches = nativeItems.filter(item => item?.type === 'userMessage'
          && JSON.stringify(item.content) === JSON.stringify(t.params?.input));
        if (matches.length === 1) {
          const opening = items.find(item => item.id === (matches[0].clientId && !matches[0].clientId.startsWith('chatgpt-messaging:')
            ? matches[0].clientId : matches[0].id));
          if (opening) Object.assign(opening, userMessageMetadata(matches[0], { createdAt: t.turnStartedAtMs, clientId: initialId }));
        }
      }
      if (!openingPresent
        && (input.some(p => p?.type === 'text' && p.text) || imageInputParts(input).length || fileInputParts(input).length)) {
        const id = typeof initialId === 'string' && !initialId.startsWith('chatgpt-messaging:') ? initialId : `${turnId}:input`;
        const opening = textItem({ id, type: 'userMessage', content: input }, { plan, createdAt: t.turnStartedAtMs, clientId: initialId });
        if (typeof initialId === 'string') for (const item of opening) Object.assign(item, originalInputEvidence(t.params?.input, initialId));
        items.unshift(...opening);
      }
      return [{ id: turnId, status: t.status,
        items: aggregateTurnActivities(turnId, t.diff, items, t.status, t.params?.cwd ?? state.cwd),
        ...(Number.isFinite(t.durationMs) && t.durationMs >= 0 && t.durationMs <= 7 * 24 * 60 * 60 * 1000
          ? { durationMs: t.durationMs } : {}) }];
    }) };
}

// Narrow facade for the existing ScopedThread. There is no generic RPC tunnel,
// tool approval method, account method, config mutation or native owner claim.
export class DesktopRpcClient extends EventEmitter {
  static async connect(endpoint, options) { return new DesktopRpcClient(await DesktopIpc.connect(endpoint, options)); }
  constructor(ipc) {
    super(); this.ipc = ipc; this.closed = false;
    this.supportsUploadedAttachments = true;
    this.supportsClientMessageId = true;
    ipc.on('broadcast', m => this.receive(m));
    ipc.on('closed', () => this.close());
  }
  canUploadAttachments() {
    const env = this.nativeState?.environments?.[0];
    return this.nativeState?.mode !== 'durable' && (!env || env.environmentId === 'local');
  }
  validateUploadedAttachments() {
    if (!this.canUploadAttachments()) throw new Error('当前执行环境无法接收主机本地附件');
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
    const attachments = params.attachments ?? [];
    if (attachments.length) this.validateUploadedAttachments();
    const images = trustedAttachments(attachments) ? attachments.filter(a => a.image) : [];
    if (!this.thread || params.threadId !== this.threadId || Object.keys(params).some(k => !['threadId', 'input', 'attachments', 'clientUserMessageId'].includes(k)) ||
        (params.clientUserMessageId !== undefined && !UUID.test(params.clientUserMessageId)) ||
        !trustedAttachments(attachments) || params.input?.length !== 1 + images.length || params.input[0]?.type !== 'text' || typeof params.input[0].text !== 'string' ||
        !params.input[0].text.trim() || params.input[0].text.length > (attachments.length ? 20000 : 8000) ||
        Object.keys(params.input[0]).some(k => !['type', 'text'].includes(k)) || images.some((a, i) => params.input[i+1]?.type !== 'localImage'
          || params.input[i+1]?.path !== a.path || Object.keys(params.input[i+1]).some(k => !['type', 'path'].includes(k)))) throw new Error('Unsupported Desktop input');
    const clientUserMessageId = params.clientUserMessageId ?? randomUUID();
    const result = await this.ipc.request('thread-follower-start-turn', { conversationId: this.threadId,
      turnStart: { request: { threadId: this.threadId, clientUserMessageId, input: params.input.map(p => p.type === 'text' ? { ...p, text_elements: [] } : { ...p }) },
        context: { inheritThreadSettings: true, attachments: desktopAttachments(attachments), commentAttachments: [] } } }, 2, this.owner);
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
