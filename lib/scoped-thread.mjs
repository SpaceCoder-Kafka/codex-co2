import { EventEmitter } from 'node:events';
import { MessageAuthors } from './message-authors.mjs';
import { createHmac, randomBytes } from 'node:crypto';
import { imageRefs, assistantImageRefs, readImage, inlineImageBytes, imageMessageText, structuredImageIndices } from './thread-images.mjs';
import { fileRefs, assistantFileRefs, readFilePreview } from './thread-files.mjs';
import { activityItem, activityDetail, aggregateTurnActivities } from './thread-activities.mjs';
import { userPresentation, safeUserPresentation, userMessageMetadata, USER_SOURCE_TEXT } from './user-presentation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVALS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval',
]);

function textItem(item, imageKey) {
  if (!item || typeof item.id !== 'string') return null;
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    const images = assistantImageRefs(item.id, item.text, imageKey);
    const files = assistantFileRefs(item.id, item.text, imageKey);
    return { id: item.id, role: 'assistant', text: item.text,
      ...(['commentary', 'final_answer'].includes(item.phase) ? { phase: item.phase } : {}),
      ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
  }
  if (['userMessage', 'steeringUserMessage'].includes(item.type) && Array.isArray(item.content ?? item.input)) {
    const content = item.content ?? item.input;
    const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n');
    const images = imageRefs(item.id, content, imageKey);
    const files = fileRefs(item.id, content, imageKey);
    const normalized = userPresentation(text);
    const presentation = safeUserPresentation(item.presentation) ?? normalized.presentation;
    const out = { id: item.id, role: 'user', text: normalized.text, ...userMessageMetadata(item),
      ...(presentation ? { presentation } : {}), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
    const originalText = item[USER_SOURCE_TEXT] ?? (normalized.presentation ? text : undefined);
    if (typeof originalText === 'string') out[USER_SOURCE_TEXT] = originalText;
    const attachmentImageIndices = structuredImageIndices(imageMessageText(out), content);
    if (attachmentImageIndices.length) out.attachmentImageIndices = attachmentImageIndices;
    return out;
  }
  return activityItem(item, imageKey);
}

function running(turn) { return TURN_STATUSES.get(turn?.status) === 'running'; }

const TURN_STATUSES = new Map([
  ['inProgress', 'running'], ['in_progress', 'running'], ['running', 'running'],
  ['completed', 'completed'], ['complete', 'completed'], ['succeeded', 'completed'],
  ['failed', 'failed'], ['error', 'failed'],
  ['interrupted', 'interrupted'], ['cancelled', 'interrupted'], ['canceled', 'interrupted'],
]);
function turnPresentation(turn) {
  const status = TURN_STATUSES.get(turn?.status);
  const duration = turn?.durationMs;
  return { ...(status ? { turnStatus: status } : {}),
    ...(Number.isFinite(duration) && duration >= 0 && duration <= 7 * 24 * 60 * 60 * 1000
      ? { turnDurationMs: duration } : {}) };
}

const SNAPSHOT_BYTES = 48 * 1024 - 1;
const LIVE_TURN_LIMIT = 64;
const LIVE_ITEM_LIMIT = 4096;
const LIVE_TEXT_BYTES = 2 * 1024 * 1024;
const authorItems = items => items.map(item => typeof item[USER_SOURCE_TEXT] === 'string' ? { ...item, text: item[USER_SOURCE_TEXT] } : item);
const liveTextBytes = item => Buffer.byteLength(item.text) + Buffer.byteLength(JSON.stringify(item.presentation ?? null))
  + (typeof item[USER_SOURCE_TEXT] === 'string' ? Buffer.byteLength(item[USER_SOURCE_TEXT]) : 0)
  + (item.role === 'activity' ? activityDetail(item).bytes.length : 0);
function terminalDiffs(items, itemTurns) {
  const last = new Map(), diffs = new Map();
  items.forEach((item, index) => {
    const turn = itemTurns.get(item.id);
    if (turn === undefined) return;
    last.set(turn, index);
    if (item.kind === 'diff' && item.role === 'activity') {
      if (!diffs.has(turn)) diffs.set(turn, []);
      diffs.get(turn).push(item);
    }
  });
  return items.flatMap((item, index) => {
    const turn = itemTurns.get(item.id);
    return [...(turn !== undefined && item.kind === 'diff' && item.role === 'activity' ? [] : [item]),
      ...(last.get(turn) === index ? diffs.get(turn) ?? [] : [])];
  });
}
function compactTurnPresentation(items) {
  const firstByTurn = new Map();
  for (const item of items) {
    if (typeof item.turnId !== 'string') continue;
    const first = firstByTurn.get(item.turnId);
    if (!first) { firstByTurn.set(item.turnId, item); continue; }
    for (const field of ['turnStatus', 'turnDurationMs']) {
      if (first[field] === undefined && item[field] !== undefined) first[field] = item[field];
      delete item[field];
    }
  }
  return firstByTurn;
}
function boundedSnapshot(snapshot) {
  const originalTitle = snapshot.title;
  const bounded = { ...snapshot, title: [...originalTitle].slice(0, 512).join(''), items: [], historyTruncated: true };
  let truncated = snapshot.historyTruncated === true || originalTitle !== bounded.title;
  const presentations = new Map();
  const fits = () => Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= SNAPSHOT_BYTES;
  for (let index = snapshot.items.length - 1; index >= 0; index--) {
    const originalItem = snapshot.items[index];
    if (originalItem.role === 'activity') continue;
    const item = { ...originalItem, text: imageMessageText(originalItem),
      ...(originalItem.images ? { images: originalItem.images.map(({ id, name, index, url, syntax, linkIndex, label }) => ({ id, name,
        ...(index !== undefined ? { index } : {}), ...(url ? { url } : {}), ...(syntax ? { syntax } : {}),
        ...(linkIndex !== undefined ? { linkIndex } : {}), ...(label !== undefined ? { label } : {}) })) } : {}),
      ...(originalItem.files ? { files: originalItem.files.map(({ id, name, kind, index, syntax, label }) => ({ id, name, kind,
        ...(index !== undefined ? { index, syntax } : {}), ...(label !== undefined ? { label } : {}) })) } : {}) };
    delete item[USER_SOURCE_TEXT];
    if (item.source) item.source = { kind: item.source.kind };
    if (item.attachmentImageIndices) item.attachmentImageIndices = [...item.attachmentImageIndices];
    if (item.presentation) { presentations.set(item.id, safeUserPresentation(item.presentation)); delete item.presentation; }
    bounded.items.unshift(item);
    if (fits()) continue;
    truncated = true;
    // Preserve a tail of the oldest included message; newest messages stay in order.
    const original = item.text;
    // Truncation changes Markdown token positions. Do not bind references from
    // the full reply to a different image in its truncated tail.
    if (item.role === 'assistant') { delete item.images; delete item.files; }
    delete item.attachmentImageIndices;
    presentations.delete(item.id);
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
  // The selected dialogue suffix and every retained text byte are fixed above.
  // Repeating presentation metadata on every item can consume several KiB in
  // long turns. One anchor per visible turn is enough for all its cards/body.
  const turnAnchors = compactTurnPresentation(bounded.items);
  const originals = snapshot.items.filter(item => item.role === 'activity').reverse();
  const important = originals.filter(item => ['diff', 'plan'].includes(item.kind));
  const ordinary = originals.filter(item => !['diff', 'plan'].includes(item.kind));
  const selected = new Map();
  const stub = original => ({ id: original.id, role: 'activity', text: original.text, kind: original.kind,
    detailId: original.detailId, ...(original.status ? { status: original.status } : {}),
    ...(original.turnId ? { turnId: original.turnId } : {}),
    ...(!turnAnchors.has(original.turnId) && original.turnStatus ? { turnStatus: original.turnStatus } : {}),
    ...(!turnAnchors.has(original.turnId) && original.turnDurationMs !== undefined ? { turnDurationMs: original.turnDurationMs } : {}) });
  const include = original => {
    const item = stub(original); bounded.items.push(item);
    // Keep the read handle even if optional turn presentation cannot fit.
    if (!fits()) { delete item.turnStatus; delete item.turnDurationMs; }
    if (!fits()) { bounded.items.pop(); truncated = true; return false; }
    selected.set(original.id, item);
    if (item.turnId && !turnAnchors.has(item.turnId)) turnAnchors.set(item.turnId, item);
    return true;
  };
  // Reserve lightweight entries for every important artifact before allocating
  // previews or old tool rows. Details still use the existing activity-request.
  let missingImportant = false;
  for (const original of important) if (!include(original)) missingImportant = true;
  // Optional user plan/question previews follow dialogue in the budget. They
  // never evict an important activity handle or the user's original text.
  for (const item of bounded.items) {
    if (!presentations.has(item.id)) continue;
    item.presentation = presentations.get(item.id);
    if (!fits()) { delete item.presentation; truncated = true; }
  }
  for (const original of important) {
    const item = selected.get(original.id);
    if (!item) continue;
    if (original.summary) {
      item.summary = { fileCount: original.summary.fileCount, added: original.summary.added, removed: original.summary.removed,
        files: original.summary.files.map(({ path, added, removed }) => ({ path, added, removed })), remaining: original.summary.remaining };
      if (!fits()) { delete item.summary; truncated = true; }
    }
    if (original.preview) {
      item.preview = original.preview;
      if (!fits()) { delete item.preview; truncated = true; }
    }
  }
  // Do not replace an omitted Diff/plan with unrelated, smaller tool rows.
  if (!missingImportant) for (const original of ordinary) include(original);
  const omittedActivities = originals.length - selected.size;
  if (omittedActivities) {
    bounded.omittedActivities = omittedActivities;
    if (!fits()) delete bounded.omittedActivities;
    truncated = true;
  }
  const order = new Map(snapshot.items.map((item, index) => [item.id, index]));
  bounded.items.sort((a, b) => order.get(a.id) - order.get(b.id));
  compactTurnPresentation(bounded.items);
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
    this._snapshot = { type: 'snapshot', title: '共享会话', items: [], status: 'offline', revision: 0,
      capabilities: ['file-original', 'activity-details'] };
    this._turns = new Map();
    this._itemTurns = new Map();
    this._turnPresentation = new Map();
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
    // Grouping IDs are room-local presentation keys, never native turn handles.
    const items = this._snapshot.items.map(item => {
      const turnId = this._itemTurns.get(item.id);
      return turnId === undefined ? item : { ...item,
        turnId: createHmac('sha256', this._imageKey).update(JSON.stringify(['turn', turnId])).digest('hex'),
        ...this._turnPresentation.get(turnId) };
    });
    return boundedSnapshot({ ...this._snapshot, items: this._authors ? this._authors.decorate(items) : items });
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

  async readFile(id, options) {
    if (!this.hasFile(id)) throw new Error('Unavailable file');
    const ref = this._snapshot.items.flatMap(item => item.files ?? []).find(file => file.id === id);
    const result = await readFilePreview(ref, options);
    if (!this.hasFile(id)) throw new Error('Unavailable file');
    return result;
  }

  hasActivity(id) {
    return !this._closed && this._snapshot.status !== 'offline'
      && this.snapshot.items.some(item => item.role === 'activity' && item.detailId === id);
  }

  async readActivity(id) {
    if (!this.hasActivity(id)) throw new Error('Unavailable activity');
    const item = this._snapshot.items.find(item => item.role === 'activity' && item.detailId === id);
    const result = activityDetail(item);
    if (!this.hasActivity(id)) throw new Error('Unavailable activity');
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
      const record = { running: running(turn), presentation: turnPresentation(turn), items: new Map() };
      const rawItems = Array.isArray(turn.items) ? turn.items : [];
      for (const raw of aggregateTurnActivities(turn.id, turn.diff, rawItems, turn.status, turn.cwd)) {
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
          && stored.detailId === item.detailId
          && stored.phase === item.phase
          && JSON.stringify(stored.presentation) === JSON.stringify(item.presentation)
          && JSON.stringify(stored.source) === JSON.stringify(item.source) && stored.createdAt === item.createdAt
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
      if (!record) { record = { running: live.running, presentation: {}, items: new Map() }; records.set(turnId, record); }
      record.running = live.running;
      // A completion event supersedes stale running metadata. Do not invent
      // timing when that event did not include it; a reconciled read restores
      // any duration subsequently supplied by persisted history.
      record.presentation = live.final ? { ...live.presentation } : { ...record.presentation, ...live.presentation };
      for (const [id, item] of live.items) record.items.set(id, item);
    }
    const turns = new Map(), itemTurns = new Map(), presentations = new Map(), items = [];
    for (const [turnId, record] of records) {
      turns.set(turnId, record.running);
      presentations.set(turnId, record.presentation);
      for (const item of record.items.values()) {
        if (itemTurns.has(item.id)) continue;
        itemTurns.set(item.id, turnId);
        items.push(item);
      }
    }
    this._turns = turns;
    this._itemTurns = itemTurns;
    this._turnPresentation = presentations;
    // A lagging top-level "active" status must not undo an observed completion.
    const active = [...turns.values()].some(Boolean) || (turns.size === 0 && thread.status?.type === 'active');
    this._publish({ title: typeof thread.name === 'string' && thread.name.trim() ? thread.name : '共享会话', items,
      historyTruncated: thread.historyTruncated === true, status: active ? 'running' : 'idle' });
  }

  _rememberTurn(turnId, active, final = false, presentation) {
    let live = this._liveTurns.get(turnId);
    if (!live) {
      if (this._liveTurns.size >= LIVE_TURN_LIMIT) { this._liveLimit(); return null; }
      live = { running: active, final, presentation: presentation ?? {}, items: new Map() };
      this._liveTurns.set(turnId, live);
    } else { live.running = active; live.final = final; if (presentation) live.presentation = presentation; }
    return live;
  }

  _rememberItem(turnId, item) {
    let live = this._liveTurns.get(turnId);
    if (!live) live = this._rememberTurn(turnId, Boolean(this._turns.get(turnId)));
    if (!live) return false;
    const previous = live.items.get(item.id);
    const itemCount = this._liveItems + (previous ? 0 : 1);
    const cost = liveTextBytes;
    const bytes = this._liveTextBytes + cost(item) - (previous ? cost(previous) : 0);
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
      this._liveTextBytes -= liveTextBytes(item);
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
    if (update.items) update = { ...update, items: terminalDiffs(update.items, this._itemTurns) };
    if (update.items && this._authors) {
      try { this._authors.observe(authorItems(update.items), this._itemTurns, liveItemId); }
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
        try { this._authors.observe(authorItems([item]), new Map([[item.id, p.turnId]]), item.id); }
        catch { this.close(); this.emit('fault', { code: 'author-metadata-limit' }); return; }
        this._scheduleRefresh();
        break;
      }
      case 'turn/started': {
        if (typeof p.turn?.id !== 'string') return;
        const presentation = { ...turnPresentation(p.turn), turnStatus: 'running' };
        if (!this._rememberTurn(p.turn.id, true, false, presentation)) return;
        this._turnPresentation.set(p.turn.id, presentation);
        this._turns.set(p.turn.id, true);
        this._publish({ status: 'running' });
        break;
      }
      case 'turn/completed': {
        if (!this._turns.has(p.turn?.id)) { this._scheduleRefresh(); return; }
        const presentation = turnPresentation(p.turn);
        if (!this._rememberTurn(p.turn.id, false, true, presentation)) return;
        this._turnPresentation.set(p.turn.id, presentation);
        this._turns.set(p.turn.id, false);
        this._publish({ status: [...this._turns.values()].some(Boolean) ? 'running' : 'idle' });
        this._scheduleRefresh();
        break;
      }
      case 'turn/diff/updated':
      case 'turn/plan/updated': {
        if (!this._turns.has(p.turnId)) return;
        const raw = message.method === 'turn/plan/updated'
          ? { id: `${p.turnId}:plan`, type: 'todo-list', explanation: p.explanation, plan: p.plan }
          : this._combinedDiff(p.turnId, null, p.diff);
        if (raw) this._notification({ method: 'item/started', params: { threadId: this.threadId, turnId: p.turnId, item: raw } });
        break;
      }
      case 'item/started':
      case 'item/completed': {
        if (!this._turns.has(p.turnId)) { this._scheduleRefresh(); return; }
        const raw = p.item?.type === 'fileChange' ? this._combinedDiff(p.turnId, p.item) : p.item;
        const item = textItem(raw, this._imageKey);
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
        items[index] = textItem({ id: p.itemId, type: 'agentMessage', phase: items[index].phase,
          text: items[index].text + p.delta }, this._imageKey);
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

  _combinedDiff(turnId, incoming, diff) {
    const previous = this._snapshot.items.filter(item => this._itemTurns.get(item.id) === turnId && item.kind === 'diff')
      .map(item => ({ id: item.id, type: 'fileChange', status: item.status,
        changes: JSON.parse(activityDetail(item).bytes).files.map(file => ({ ...file, kind: { type: file.kind } })) }));
    // A turn/diff event has already produced the authoritative aggregate before
    // entering the common item path. Do not merge its previous revision again.
    if (incoming && previous.length === 1 && incoming.id === previous[0].id) return incoming;
    return aggregateTurnActivities(turnId, diff, [...previous, ...(incoming ? [incoming] : [])],
      incoming?.status ?? (this._turns.get(turnId) ? 'running' : 'completed')).find(item => item.type === 'fileChange');
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
    this._turnPresentation.clear();
    this._liveItems = 0;
    this._liveTextBytes = 0;
    this._liveImageBytes = 0;
    this._snapshot.items = [];
    this._authors?.clear();
  }
}
