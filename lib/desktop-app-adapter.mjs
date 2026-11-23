import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { projectActivity } from './thread-activities.mjs';
import { imageInputParts } from './thread-images.mjs';
import { delegatedUserIntent } from './user-presentation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/u.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const failure = (message, code = 'DESKTOP_APP_INCOMPATIBLE') => Object.assign(new Error(message), { code });
const MAX_PAGES = 256, MAX_HISTORY_BYTES = 16 * 1024 * 1024;

export const desktopAppCapabilities = Object.freeze({
  transport: 'desktop-app-tools', updates: 'polling', uploads: false,
  submission: 'native-queue', clientMessageId: true, authorBinding: false,
  historicalAttachments: 'partial', toolOutputMaxChars: 20000,
  singleTurnResponseMaxBytes: 1024 * 1024,
});

function connected(bridge) {
  return bridge.connected === true || bridge.connected === undefined && bridge.ready === true;
}

function waitConnected(bridge) {
  if (typeof bridge.waitConnected === 'function') return bridge.waitConnected({ timeoutMs: 30000 });
  if (connected(bridge)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); bridge.off('connected', ready); bridge.off('ready', ready); bridge.off('closed', gone); };
    const ready = () => { if (connected(bridge)) { clean(); resolve(); } };
    const gone = () => { clean(); reject(failure('Codex 桥接已关闭', 'DESKTOP_APP_DISCONNECTED')); };
    const timer = setTimeout(() => { clean(); reject(failure('Codex 桥接连接超时，请重新连接', 'DESKTOP_APP_DISCONNECTED')); }, 20000);
    bridge.on('connected', ready); bridge.on('ready', ready); bridge.once('closed', gone);
    ready();
  });
}

function output(value) {
  if (value === undefined || value === null) return { text: '', truncated: false };
  if (!record(value) || typeof value.text !== 'string' || typeof value.truncated !== 'boolean') {
    throw failure('Codex 返回了不兼容的工具输出');
  }
  return { text: value.text, truncated: value.truncated };
}

function projectItem(raw) {
  if (!record(raw) || !identifier(raw.id)) return null;
  if (raw.type === 'userMessage') {
    if (!Array.isArray(raw.content)) throw failure('Codex 返回了不兼容的消息正文');
    // App-tools omits clientId, original file attachments and inline image
    // bytes. Never reconstruct any of them from text, mentions or queue IDs.
    const text = raw.content.filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => ({ type: 'text', text: p.text }));
    return { id: raw.id, type: raw.type, content: [...text, ...imageInputParts(raw.content.filter(p => p?.type === 'localImage'))] };
  }
  if (raw.type === 'agentMessage') {
    if (typeof raw.text !== 'string') throw failure('Codex 返回了不兼容的助手正文');
    return { id: raw.id, type: raw.type, text: raw.text,
      ...(['commentary', 'final_answer'].includes(raw.phase) ? { phase: raw.phase } : {}) };
  }
  if (raw.type === 'functionCallOutput') {
    const result = output(raw.output);
    const native = { id: raw.id, type: raw.type, name: raw.name, namespace: raw.namespace,
      output: result.text, activityTruncated: result.truncated };
    const intent = !result.truncated && delegatedUserIntent(native);
    if (intent) return { id: raw.id, type: 'userMessage', content: [{ type: 'text', text: intent.text }], source: intent.source };
    // Incomplete delegation envelopes may contain other conversation IDs.
    if (result.text.includes('<codex_delegation')) return null;
    return projectActivity(native);
  }
  if (raw.type === 'commandExecution') {
    const result = output(raw.output);
    return projectActivity({ ...raw, aggregatedOutput: result.text,
      activityTruncated: result.truncated || raw.commandTruncated === true });
  }
  if (raw.type === 'fileChange') {
    if (!Array.isArray(raw.changes)) throw failure('Codex 返回了不兼容的变更记录');
    let truncated = false;
    const changes = raw.changes.filter(record).map(change => {
      const result = output(change.diff);
      truncated ||= result.truncated || change.diff == null;
      return { path: change.path, kind: change.kind, diff: result.text };
    });
    return projectActivity({ id: raw.id, type: raw.type, status: raw.status, changes, activityTruncated: truncated });
  }
  if (['mcpToolCall', 'dynamicToolCall', 'plan'].includes(raw.type)) {
    // No argument previews, child-agent contents or reasoning are forwarded.
    return projectActivity({ id: raw.id, type: raw.type, server: raw.server, tool: raw.tool,
      status: raw.status, success: raw.success, durationMs: raw.durationMs, text: raw.text,
      activityTruncated: raw.argumentsPreview?.truncated === true });
  }
  return null;
}

function pageThread(page, threadId) {
  if (page?.schemaVersion !== 1 || page.thread?.id !== threadId || page.thread?.hostId !== 'local'
    || page.page?.order !== 'newest_first' || typeof page.page?.hasMore !== 'boolean'
    || !(page.page.nextCursor === null || identifier(page.page.nextCursor)) || !Array.isArray(page.turns)
    || page.page.hasMore !== (page.page.nextCursor !== null)) throw failure('Codex 返回了不兼容的会话分页');
  const status = page.thread.status;
  if (!record(status) || !['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)
    || status.type === 'active' && (!Array.isArray(status.activeFlags) || !status.activeFlags.every(identifier))) {
    throw failure('Codex 返回了不兼容的会话状态');
  }
  return { id: threadId, name: typeof page.thread.title === 'string' ? page.thread.title : threadId,
    status: status.type === 'active' ? { type: 'active', activeFlags: [...status.activeFlags] } : { type: status.type } };
}

async function readThread(bridge, threadId, isCurrent) {
  let cursor, thread, bytes = 0, historyTruncated = false, historyDetailsOmitted = false;
  const cursors = new Set(), turns = new Map(), itemTurns = new Map();
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    if (!isCurrent()) throw failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED');
    let page, detailsOmitted = false;
    const attempts = [
      { turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 },
      { turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 20000 },
      { turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 },
    ];
    for (const [index, options] of attempts.entries()) {
      if (!isCurrent()) throw failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED');
      try {
        page = await bridge.readPage(threadId, { ...(cursor ? { cursor } : {}), includeTurns: true, ...options });
        detailsOmitted = !options.includeOutputs;
        historyDetailsOmitted ||= detailsOmitted;
        break;
      } catch (error) {
        if (error?.code !== 'DESKTOP_APP_RESPONSE_TOO_LARGE') throw error;
        if (index === attempts.length - 1) {
          throw failure('这条会话的回合在省略执行细节后仍超过读取上限，当前 Codex 接口无法读取', 'DESKTOP_APP_TURN_TOO_LARGE');
        }
      }
    }
    if (!isCurrent()) throw failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED');
    const meta = pageThread(page, threadId);
    thread ??= meta;
    for (const raw of page.turns) {
      if (!identifier(raw?.id) || typeof raw.status !== 'string' || !Array.isArray(raw.items)) throw failure('Codex 返回了不兼容的回合');
      // Pagination may overlap while a turn is updated. The newest page wins.
      if (turns.has(raw.id)) continue;
      const items = raw.items.map(projectItem).filter(Boolean);
      if (detailsOmitted) for (const item of items) {
        if (!['userMessage', 'agentMessage'].includes(item.type)) item.activityTruncated = true;
      }
      for (const item of items) {
        if (itemTurns.has(item.id)) throw failure('Codex 返回了重复的消息标识');
        itemTurns.set(item.id, raw.id);
      }
      const turn = { id: raw.id, status: raw.status, items,
        ...(Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? { durationMs: raw.durationMs } : {}) };
      bytes += Buffer.byteLength(JSON.stringify(turn));
      if (bytes > MAX_HISTORY_BYTES) { historyTruncated = true; break; }
      turns.set(raw.id, turn);
    }
    if (historyTruncated || !page.page.hasMore) break;
    cursor = page.page.nextCursor;
    if (cursors.has(cursor)) throw failure('Codex 返回了重复的分页游标');
    cursors.add(cursor);
    if (pageIndex === MAX_PAGES - 1) historyTruncated = true;
  }
  return { ...thread, turns: [...turns.values()].reverse(),
    ...(historyTruncated || historyDetailsOmitted ? { historyTruncated: true } : {}),
    ...(historyDetailsOmitted ? { historyDetailsOmitted: true } : {}) };
}

class DesktopAppRpc extends EventEmitter {
  supportsClientMessageId = true;
  supportsUploadedAttachments = false;
  capabilities = desktopAppCapabilities;
  constructor(attachment) { super(); this.attachment = attachment; this.closed = false; this.threadId = null; }
  canUploadAttachments() { return false; }
  validateUploadedAttachments() { throw failure('当前 Codex 接入方式仅支持文字，暂不支持上传附件', 'DESKTOP_APP_UPLOAD_UNAVAILABLE'); }
  validateSubmission() {
    if (this.closed || !this.threadId || !this.attachment.isSelected(this.threadId)) throw failure('共享会话已断开', 'DESKTOP_APP_DISCONNECTED');
  }
  bind(threadId) {
    if (!UUID.test(threadId ?? '') || this.threadId && this.threadId !== threadId) throw failure('连接只能访问已选择的这一条会话', 'DESKTOP_APP_SCOPE');
    if (this.closed || !this.attachment.isSelected(threadId)) throw failure('请先由分享者选择这条会话', 'DESKTOP_APP_SCOPE');
    if (!this.threadId) {
      this.threadId = threadId;
      this.timer = setInterval(() => {
        if (!this.closed) this.emit('notification', { method: 'thread/status/changed', params: { threadId } });
      }, this.attachment.pollIntervalMs);
      this.timer.unref?.();
    }
  }
  async request(method, params, options = {}) {
    if (!['thread/read', 'thread/resume', 'turn/start'].includes(method)) throw failure('不允许调用此 Codex 方法', 'DESKTOP_APP_METHOD');
    const keys = method === 'turn/start' ? ['threadId', 'input', 'clientUserMessageId'] : ['threadId', 'includeTurns'];
    if (!only(params, keys) || params.includeTurns !== undefined && typeof params.includeTurns !== 'boolean'
      || !only(options, method === 'turn/start' ? ['canDispatch'] : [])) throw failure('不允许指定这些 Codex 参数', 'DESKTOP_APP_OPTIONS');
    this.bind(params.threadId);
    if (method !== 'turn/start') {
      try { return { thread: await this.attachment.read(this.threadId) }; }
      catch (error) { this.close(error); throw error; }
    }
    this.validateSubmission();
    if (typeof options.canDispatch !== 'function') throw failure('提交缺少本地授权检查', 'SUBMISSION_REVOKED');
    const input = params.input;
    if (!Array.isArray(input) || !input.length || input.length > 16 || input.some(p => !only(p, ['type', 'text', 'text_elements'])
      || p.type !== 'text' || typeof p.text !== 'string' || p.text_elements !== undefined && (!Array.isArray(p.text_elements) || p.text_elements.length))) {
      throw failure('当前 Codex 接入方式仅支持文字输入', 'DESKTOP_APP_OPTIONS');
    }
    const text = input.map(p => p.text).join('\n');
    if (!text.trim() || text.length > 8000) throw failure('文字消息长度必须在 1 到 8000 字符之间', 'DESKTOP_APP_OPTIONS');
    const clientUserMessageId = params.clientUserMessageId ?? randomUUID();
    if (!UUID.test(clientUserMessageId)) throw failure('无效的消息标识', 'DESKTOP_APP_OPTIONS');
    const result = await this.attachment.queue.submit({ threadId: this.threadId,
      input: input.map(p => ({ type: 'text', text: p.text, text_elements: [] })), clientUserMessageId,
      canDispatch: () => !this.closed && this.attachment.isSelected(this.threadId) && options.canDispatch() === true });
    if (!identifier(result?.id) || result.clientUserMessageId !== clientUserMessageId || typeof result.wakePending !== 'boolean') {
      throw Object.assign(failure('排队结果无法确认，此消息不会自动重发', 'SUBMISSION_UNCERTAIN'), { outcome: 'unknown' });
    }
    return { queued: { id: result.id, clientUserMessageId }, wakePending: result.wakePending };
  }
  close(reason) {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.emit('closed', reason);
  }
}

export async function attachDesktopApp({ bridge, catalog, queue, ensureInstalled, launchBridge, pollIntervalMs = 1000 } = {}) {
  if (!bridge?.on || typeof bridge.readPage !== 'function' || typeof bridge.selectThread !== 'function'
    || typeof catalog?.contains !== 'function' || typeof catalog?.list !== 'function' || typeof queue?.submit !== 'function'
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) throw new TypeError('Invalid Desktop app attachment dependencies');
  await bridge.ready;
  await ensureInstalled?.();
  if (!connected(bridge) && launchBridge) await launchBridge();
  await waitConnected(bridge);
  const attachment = new EventEmitter(), selected = new Map(), clients = new Set(), reads = new Map();
  let closed = false, generation = 0, closePromise = null;
  const disconnect = reason => {
    generation++; selected.clear(); reads.clear();
    for (const rpc of [...clients]) rpc.close(reason ?? failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED'));
    attachment.emit('disconnected');
  };
  const notifyConnected = () => { if (!closed && connected(bridge)) attachment.emit('connected'); };
  bridge.on('connected', notifyConnected); bridge.on('disconnected', disconnect); bridge.on('closed', disconnect);
  const read = threadId => {
    if (closed || !connected(bridge)) return Promise.reject(failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED'));
    if (reads.has(threadId)) return reads.get(threadId);
    const current = generation;
    const pending = readThread(bridge, threadId, () => !closed && generation === current && connected(bridge))
      .finally(() => { if (reads.get(threadId) === pending) reads.delete(threadId); });
    reads.set(threadId, pending); return pending;
  };
  const context = { queue, pollIntervalMs, read,
    isSelected: threadId => !closed && connected(bridge) && selected.has(threadId) };
  Object.assign(attachment, {
    endpoint: 'desktop-app-tools', capabilities: desktopAppCapabilities,
    async rpcFactory() {
      if (closed || !connected(bridge)) throw failure('Codex 桥接已断开', 'DESKTOP_APP_DISCONNECTED');
      const rpc = new DesktopAppRpc(context);
      clients.add(rpc); rpc.once('closed', () => clients.delete(rpc)); return rpc;
    },
    async selectThread(threadId, options = {}) {
      if (!only(options, ['activate', 'canContinue']) || options.activate !== undefined && typeof options.activate !== 'boolean'
        || options.canContinue !== undefined && typeof options.canContinue !== 'function') throw failure('无效的会话选择参数', 'DESKTOP_APP_OPTIONS');
      if (!UUID.test(threadId ?? '')) throw failure('请填写有效的 Codex 会话 ID', 'DESKTOP_APP_SCOPE');
      const current = generation, check = () => {
        if (closed || generation !== current || options.canContinue?.() === false) throw failure('本次共享已取消，请重新操作', 'DESKTOP_APP_SCOPE');
      };
      check();
      if (!await catalog.contains(threadId)) throw failure('会话已归档或不在当前 Codex 索引中，请刷新列表', 'DESKTOP_APP_SCOPE');
      check(); await bridge.selectThread(threadId); check();
      const thread = await read(threadId); check();
      selected.set(threadId, { id: threadId, name: thread.name });
    },
    listThreads: options => catalog.list(options),
    async reconnect() {
      if (closed) throw failure('Codex 接入已关闭', 'DESKTOP_APP_DISCONNECTED');
      disconnect(); await bridge.reconnect();
      await ensureInstalled?.();
      if (!connected(bridge) && launchBridge) await launchBridge();
      await waitConnected(bridge);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.resolve().then(() => {
        disconnect(); bridge.off('connected', notifyConnected); bridge.off('disconnected', disconnect); bridge.off('closed', disconnect);
        return bridge.close();
      });
      return closePromise;
    },
  });
  return attachment;
}
