import { EventEmitter } from 'node:events';
import { MessageAuthors } from './message-authors.mjs';
import { randomBytes } from 'node:crypto';
import { imageRefs, assistantImageRefs, readImage, inlineImageBytes, imageMessageText } from './thread-images.mjs';
import { fileRefs, readFilePreview } from './thread-files.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVALS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval',
]);

function textItem(item, imageKey) {
  if (!item || typeof item.id !== 'string') return null;
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    const images = assistantImageRefs(item.id, item.text, imageKey);
    return { id: item.id, role: 'assistant', text: item.text, ...(images.length ? { images } : {}) };
  }
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    const text = item.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n');
    const images = imageRefs(item.id, item.content, imageKey);
    const files = fileRefs(item.id, item.content, imageKey);
    return { id: item.id, role: 'user', text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
  }
  return null;
}

function running(turn) { return turn?.status === 'inProgress' || turn?.status === 'running'; }

const SNAPSHOT_BYTES = 48 * 1024 - 1;
const LIVE_TURN_LIMIT = 64;
const LIVE_ITEM_LIMIT = 4096;
const LIVE_TEXT_BYTES = 2 * 1024 * 1024;
function boundedSnapshot(snapshot) {
  const originalTitle = snapshot.title;
  const bounded = { ...snapshot, title: [...originalTitle].slice(0, 512).join(''), items: [], historyTruncated: true };
  let truncated = snapshot.historyTruncated === true || originalTitle !== bounded.title;
  const fits = () => Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= SNAPSHOT_BYTES;
  for (let index = snapshot.items.length - 1; index >= 0; index--) {
    const originalItem = snapshot.items[index];
    const item = { ...originalItem, text: imageMessageText(originalItem),
      ...(originalItem.images ? { images: originalItem.images.map(({ id, name, index, url }) => ({ id, name,
        ...(index !== undefined ? { index } : {}), ...(url ? { url } : {}) })) } : {}),
      ...(originalItem.files ? { files: originalItem.files.map(({ id, name, kind }) => ({ id, name, kind })) } : {}) };
    bounded.items.unshift(item);
    if (fits()) continue;
    truncated = true;
    // Preserve a tail of the oldest included message; newest messages stay in order.
    const original = item.text;
    // Truncation changes Markdown token positions. Do not bind references from
    // the full reply to a different image in its truncated tail.
    if (item.role === 'assistant') delete item.images;
    let low = 0, high = original.length;
    item.text = '';
    if (!fits()) { bounded.items.shift(); break; }
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      item.text = original.slice(-size);
      if (fits()) low = size;
      else high = size - 1;
    }
    let start = original.length - low;
    // Avoid starting at the second half of an emoji surrogate pair.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(original[start]) && /[\uD800-\uDBFF]/.test(original[start - 1])) start++;
    item.text = original.slice(start);
    break;
  }
  if (bounded.items.length !== snapshot.items.length) truncated = true;
  if (!truncated) delete bounded.historyTruncated;
  return bounded;
}

// This adapter limits RPC/data scope, not the actions an agent can infer from a prompt.
// Only the local host may submit input authorized by its message policy or an owner decision.
// The caller owns the RPC connection and must disconnect it after closing this adapter.
export class ScopedThread extends EventEmitter {
  constructor({ rpc, threadId, ownerName, authorEvidence, onAuthorsChanged }) {
    super();
    if (!rpc?.request || typeof threadId !== 'string' || !threadId) throw new Error('A fixed thread and RPC client are required');
    this.rpc = rpc;
    this.threadId = threadId;
    this._imageKey = randomBytes(32);
    this._authors = ownerName === undefined ? null : new MessageAuthors(ownerName, { evidence: authorEvidence, onChange: onAuthorsChanged });
    this._snapshot = { type: 'snapshot', title: '共享会话', items: [], status: 'offline', revision: 0 };
    this._turns = new Map();
    this._itemTurns = new Map();
    // Live events can lead thread/read's persisted history. Retain only the
    // unacknowledged event overlay, then release it when history catches up.
    this._liveTurns = new Map();
    this._liveItems = 0;
    this._liveTextBytes = 0;
    this._liveImageBytes = 0;
    this._submissions = new Map();
    this._submissionTail = Promise.resolve();
    this._started = false;
    this._closed = false;
    this._change = 0;
    this._onNotification = message => this._notification(message);
    this._onServerRequest = message => this._serverRequest(message);
    this._onClosed = () => this._publish({ status: 'offline' });
  }

  get snapshot() {
    return boundedSnapshot(this._authors ? { ...this._snapshot, items: this._authors.decorate(this._snapshot.items) } : this._snapshot);
  }

  hasImage(id) {
    return !this._closed && this._snapshot.status !== 'offline'
      && this.snapshot.items.some(item => item.images?.some(image => image.id === id));
  }

  async readImage(id) {
    if (!this.hasImage(id)) throw new Error('Unavailable image');
    const ref = this._snapshot.items.flatMap(item => item.images ?? []).find(image => image.id === id);
    const result = await readImage(ref);
    if (!this.hasImage(id)) throw new Error('Unavailable image');
    return result;
  }

  hasFile(id) {
    return !this._closed && this._snapshot.status !== 'offline'
      && this.snapshot.items.some(item => item.files?.some(file => file.id === id));
  }

  async readFile(id) {
    if (!this.hasFile(id)) throw new Error('Unavailable file');
    const ref = this._snapshot.items.flatMap(item => item.files ?? []).find(file => file.id === id);
    const result = await readFilePreview(ref);
    if (!this.hasFile(id)) throw new Error('Unavailable file');
    return result;
  }

  async start() {
    if (this._closed) throw new Error('Scoped thread is closed');
    if (this._started) return this.snapshot;
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._start();
    try { return await this._startPromise; }
    finally { this._startPromise = null; }
  }

  async _start() {
    // Check the selected thread before subscribing. Never list or discover other threads.
    const read = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true });
    this._validateThread(read);
    if (this._closed) throw new Error('Scoped thread is closed');
    this._load(read.thread);
    this.rpc.on('notification', this._onNotification);
    this.rpc.on('serverRequest', this._onServerRequest);
    this.rpc.on('closed', this._onClosed);
    try {
      const resumed = await this.rpc.request('thread/resume', { threadId: this.threadId });
      this._validateThread(resumed);
      if (this._closed) throw new Error('Scoped thread is closed');
      this._started = true;
      // read is authoritative even if resume was configured to omit old turns.
      await this.refresh();
      return this.snapshot;
    } catch (error) {
      this._detach();
      this._started = false;
      this._publish({ status: 'offline' });
      throw error;
    }
  }

  _validateThread(result) {
    if (result?.thread?.id !== this.threadId) {
      this.close();
      throw new Error('Backend returned a different thread; sharing stopped');
    }
  }

  async refresh() {
    if (this._closed) throw new Error('Scoped thread is closed');
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const change = this._change;
      const result = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true });
      this._validateThread(result);
      if (this._closed) return this.snapshot;
      // A response requested before a live delta must not overwrite that newer text.
      if (change === this._change) this._load(result.thread);
      else this._scheduleRefresh();
      return this.snapshot;
    })();
    try { return await this._refreshPromise; }
    finally { this._refreshPromise = null; }
  }

  _load(thread) {
    const records = new Map();
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (typeof turn.id !== 'string') continue;
      const record = { running: running(turn), items: new Map() };
      for (const raw of Array.isArray(turn.items) ? turn.items : []) {
        const item = textItem(raw, this._imageKey);
        if (item && !record.items.has(item.id)) record.items.set(item.id, item);
      }
      records.set(turn.id, record);
    }
    for (const [turnId, live] of this._liveTurns) {
      let record = records.get(turnId);
      const acknowledged = live.final && record && !record.running && [...live.items.values()].every(item => {
        const stored = record.items.get(item.id);
        return stored?.role === item.role && stored.text === item.text
          && JSON.stringify(stored.images?.map(i => i.id)) === JSON.stringify(item.images?.map(i => i.id))
          && JSON.stringify(stored.files?.map(i => i.id)) === JSON.stringify(item.files?.map(i => i.id));
      });
      if (acknowledged) {
        // Once reconciled, later reads can reflect an owner's history rollback.
        // Rollback while events are still ahead of persistence is ambiguous;
        // this prototype requires stopping/restarting sharing for that case.
        this._forgetLiveTurn(turnId);
        continue;
      }
      if (!record) { record = { running: live.running, items: new Map() }; records.set(turnId, record); }
      record.running = live.running;
      for (const [id, item] of live.items) record.items.set(id, item);
    }
    const turns = new Map(), itemTurns = new Map(), items = [];
    for (const [turnId, record] of records) {
      turns.set(turnId, record.running);
      for (const item of record.items.values()) {
        if (itemTurns.has(item.id)) continue;
        itemTurns.set(item.id, turnId);
        items.push(item);
      }
    }
    this._turns = turns;
    this._itemTurns = itemTurns;
    // A lagging top-level "active" status must not undo an observed completion.
    const active = [...turns.values()].some(Boolean) || (turns.size === 0 && thread.status?.type === 'active');
    this._publish({ title: typeof thread.name === 'string' && thread.name.trim() ? thread.name : '共享会话', items,
      historyTruncated: thread.historyTruncated === true, status: active ? 'running' : 'idle' });
  }

  _rememberTurn(turnId, active, final = false) {
    let live = this._liveTurns.get(turnId);
    if (!live) {
      if (this._liveTurns.size >= LIVE_TURN_LIMIT) { this._liveLimit(); return null; }
      live = { running: active, final, items: new Map() };
      this._liveTurns.set(turnId, live);
    } else { live.running = active; live.final = final; }
    return live;
  }

  _rememberItem(turnId, item) {
    let live = this._liveTurns.get(turnId);
    if (!live) live = this._rememberTurn(turnId, Boolean(this._turns.get(turnId)));
    if (!live) return false;
    const previous = live.items.get(item.id);
    const itemCount = this._liveItems + (previous ? 0 : 1);
    const bytes = this._liveTextBytes + Buffer.byteLength(item.text) - (previous ? Buffer.byteLength(previous.text) : 0);
    const imageBytes = this._liveImageBytes + inlineImageBytes(item) - (previous ? inlineImageBytes(previous) : 0);
    if (itemCount > LIVE_ITEM_LIMIT || bytes > LIVE_TEXT_BYTES || imageBytes > 32 * 1024 * 1024) { this._liveLimit(); return false; }
    this._liveItems = itemCount;
    this._liveTextBytes = bytes;
    this._liveImageBytes = imageBytes;
    live.items.set(item.id, item);
    return true;
  }

  _forgetLiveTurn(turnId) {
    const live = this._liveTurns.get(turnId);
    if (!live) return;
    this._liveItems -= live.items.size;
    for (const item of live.items.values()) {
      this._liveTextBytes -= Buffer.byteLength(item.text);
      this._liveImageBytes -= inlineImageBytes(item);
    }
    this._liveTurns.delete(turnId);
  }

  _liveLimit() {
    this.close();
    this.emit('fault', { code: 'live-buffer-limit' });
  }

  _publish(update, liveItemId = null) {
    if (this._closed) return;
    if (update.items && this._authors) {
      try { this._authors.observe(update.items, this._itemTurns, liveItemId); }
      catch { this.close(); this.emit('fault', { code: 'author-metadata-limit' }); return; }
    }
    this._change++;
    this._snapshot = { ...this._snapshot, ...update, revision: this._snapshot.revision + 1 };
    this.emit('snapshot', this.snapshot);
  }

  _scheduleRefresh() {
    if (this._closed || this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refresh().catch(() => this.emit('fault', { code: 'refresh-failed' }));
    }, 100);
    this._refreshTimer.unref?.();
  }

  _notification(message) {
    if (this._closed) return;
    const p = message?.params;
    // No fallback to an item ID or a remembered turn: notifications must name this thread.
    if (!p || p.threadId !== this.threadId) return;
    switch (message.method) {
      case 'thread/approval/changed':
        if (typeof p.pending === 'boolean') this.emit('approval-state', { pending: p.pending });
        break;
      case 'item/userMessage/observed': {
        // Desktop patches carry whole state, not app-server item events. Keep
        // their live author evidence separate from the text overlay: native
        // state remains authoritative for text, completion and rollback.
        if (!this._authors || typeof p.turnId !== 'string') return;
        const item = textItem(p.item, this._imageKey);
        if (item?.role !== 'user') return;
        const previousTurn = this._itemTurns.get(item.id);
        if (previousTurn !== undefined && previousTurn !== p.turnId) return;
        try { this._authors.observe([item], new Map([[item.id, p.turnId]]), item.id); }
        catch { this.close(); this.emit('fault', { code: 'author-metadata-limit' }); return; }
        this._scheduleRefresh();
        break;
      }
      case 'turn/started': {
        if (typeof p.turn?.id !== 'string') return;
        if (!this._rememberTurn(p.turn.id, true)) return;
        this._turns.set(p.turn.id, true);
        this._publish({ status: 'running' });
        break;
      }
      case 'turn/completed': {
        if (!this._turns.has(p.turn?.id)) { this._scheduleRefresh(); return; }
        if (!this._rememberTurn(p.turn.id, false, true)) return;
        this._turns.set(p.turn.id, false);
        this._publish({ status: [...this._turns.values()].some(Boolean) ? 'running' : 'idle' });
        this._scheduleRefresh();
        break;
      }
      case 'item/started':
      case 'item/completed': {
        if (!this._turns.has(p.turnId)) { this._scheduleRefresh(); return; }
        const item = textItem(p.item, this._imageKey);
        if (!item) return;
        const previousTurn = this._itemTurns.get(item.id);
        if (previousTurn !== undefined && previousTurn !== p.turnId) return;
        const index = this._snapshot.items.findIndex(value => value.id === item.id);
        if (index !== -1 && this._snapshot.items[index].role !== item.role) return;
        if (!this._rememberItem(p.turnId, item)) return;
        this._itemTurns.set(item.id, p.turnId);
        const items = this._snapshot.items.slice();
        if (index === -1) items.push(item);
        else items[index] = item;
        this._publish({ items }, item.id);
        break;
      }
      case 'item/agentMessage/delta': {
        if (typeof p.delta !== 'string' || !this._turns.has(p.turnId) || this._itemTurns.get(p.itemId) !== p.turnId) return;
        const index = this._snapshot.items.findIndex(item => item.id === p.itemId && item.role === 'assistant');
        if (index === -1) return;
        const items = this._snapshot.items.slice();
        items[index] = textItem({ id: p.itemId, type: 'agentMessage', text: items[index].text + p.delta }, this._imageKey);
        if (!this._rememberItem(p.turnId, items[index])) return;
        this._publish({ items });
        break;
      }
      case 'thread/name/updated':
      case 'thread/status/changed':
        this._scheduleRefresh();
        break;
      // Unknown methods, child-agent events, tool output and reasoning never reach guests.
      default: break;
    }
  }

  _serverRequest(message) {
    const p = message?.params;
    if (this._closed || p?.threadId !== this.threadId || !APPROVALS.has(message.method)) return;
    if (p.turnId !== undefined && !this._turns.has(p.turnId)) return;
    // Owner-only signal. Never send an answer: Desktop remains the approval authority.
    this.emit('approval-pending', { type: 'approval-pending', kind: message.method });
  }

  async submitApproved(text, requestId, { canDispatch, author } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Prompt must contain 1–8000 characters');
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new Error('A UUID request ID is required');
    if (canDispatch !== undefined && typeof canDispatch !== 'function') throw new Error('Dispatch authorization must be a local callback');
    requestId = requestId.toLowerCase();
    const saved = this._submissions.get(requestId);
    if (saved) {
      if (saved.text !== text) throw new Error('Request ID already used with a different prompt');
      return saved.result;
    }
    if (!this._started || this._closed || this._snapshot.status === 'offline') throw new Error('Shared thread is not connected');
    // Never evict IDs and accidentally permit an old accepted input to execute again.
    if (this._submissions.size >= 1000) throw new Error('Submission limit reached; start a new sharing session');
    const result = this._submissionTail.then(async () => {
      if (this._closed || this._snapshot.status === 'offline') throw new Error('Shared thread is not connected');
      // Admission can be revoked while an earlier submission is awaiting its RPC.
      // Recheck immediately before dispatch; never turn a stale owner click into work.
      if (canDispatch && canDispatch() !== true) {
        const error = new Error('Submission authorization was revoked before dispatch');
        error.code = 'SUBMISSION_REVOKED';
        throw error;
      }
      let response;
      const attribution = author && this._authors ? this._authors.begin(requestId, text, author) : null;
      try {
        response = await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }] });
      } catch {
        if (attribution && !this._closed) { this._authors.uncertain(attribution); this._publish({}); }
        const error = new Error('Submission outcome is unknown; this request will not be retried');
        error.code = 'SUBMISSION_UNCERTAIN';
        throw error;
      }
      if (typeof response?.turn?.id !== 'string') {
        if (attribution && !this._closed) { this._authors.uncertain(attribution); this._publish({}); }
        const error = new Error('Submission outcome is unknown; backend omitted the turn ID');
        error.code = 'SUBMISSION_UNCERTAIN';
        throw error;
      }
      if (attribution && !this._closed) { this._authors.complete(attribution, response.turn); this._publish({}); }
      return { turnId: response.turn.id };
    });
    this._submissions.set(requestId, { text, result });
    this._submissionTail = result.catch(() => {});
    return result;
  }

  _detach() {
    this.rpc.off('notification', this._onNotification);
    this.rpc.off('serverRequest', this._onServerRequest);
    this.rpc.off('closed', this._onClosed);
  }

  close() {
    if (this._closed) return;
    this._publish({ status: 'offline' });
    this._closed = true;
    this._started = false;
    clearTimeout(this._refreshTimer);
    this._detach();
    this._liveTurns.clear();
    this._liveItems = 0;
    this._liveTextBytes = 0;
    this._liveImageBytes = 0;
    this._snapshot.items = [];
    this._authors?.clear();
  }
}
