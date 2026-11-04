import { createHash, randomUUID } from 'node:crypto';
import { displayName } from './display-name.mjs';
import { NATIVE_INPUT_DIGEST, NATIVE_INPUT_ID } from './user-presentation.mjs';

const unknown = (historical = false) => ({ id: 'unknown', name: historical ? '历史消息 · 作者未知' : '作者待确认', kind: 'unknown' });
const digest = text => createHash('sha256').update(text).digest('hex');
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const localTurn = value => typeof value === 'string' && /^co2:local-turn:[a-f0-9]{64}$/.test(value);
const authorValue = (value, kind) => value?.kind === kind && identifier(value.id) && displayName(value.name)
  ? { id: value.id, name: displayName(value.name), kind } : null;

// A private checkpoint contains attribution evidence, never message bodies or
// admission/execution credentials. Keep unresolved correlations so a later
// duplicate can still invalidate a formerly unique text/turn match.
export function cleanAuthorEvidence(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !Array.isArray(value.entries) || value.entries.length > 16384
    || !Array.isArray(value.submissions) || value.submissions.length > 16384) throw new Error('作者恢复记录格式不兼容');
  const entries = value.entries.map(([id, e]) => {
    if (!identifier(id) || !e || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || e.sequence > value.sequence
      || (e.turnId !== null && !identifier(e.turnId)) || !fingerprint(e.digest)
      || typeof e.historical !== 'boolean' || typeof e.live !== 'boolean'
      || (e.inputDigest !== undefined && !fingerprint(e.inputDigest))
      || (e.inputId !== undefined && !identifier(e.inputId))
      || (e.live && !authorValue(e.hostAuthor, 'host'))) throw new Error('作者恢复记录格式不兼容');
    return [id, { sequence: e.sequence, turnId: e.turnId, digest: e.digest, historical: e.historical, live: e.live,
      ...(e.live ? { hostAuthor: authorValue(e.hostAuthor, 'host') } : {}),
      ...(e.inputDigest !== undefined ? { inputDigest: e.inputDigest } : {}), ...(e.inputId !== undefined ? { inputId: e.inputId } : {}) }];
  });
  const submissions = value.submissions.map(([id, r]) => {
    if (!identifier(id) || !r || !Number.isSafeInteger(r.before) || r.before < 0 || r.before > value.sequence
      || !fingerprint(r.digest) || !authorValue(r.author, 'guest') || !['pending', 'accepted', 'unknown'].includes(r.status)
      || (r.turnId !== null && !identifier(r.turnId)) || (r.status === 'accepted' && r.turnId === null)
      || (r.clientUserMessageId !== undefined && !identifier(r.clientUserMessageId))
      || (r.responseIds !== null && (!Array.isArray(r.responseIds) || r.responseIds.length > 16384 || !r.responseIds.every(identifier)))) throw new Error('作者恢复记录格式不兼容');
    return [id, { before: r.before, digest: r.digest, author: authorValue(r.author, 'guest'), status: r.status,
      turnId: r.turnId, responseIds: r.responseIds === null ? null : [...r.responseIds],
      ...(r.clientUserMessageId !== undefined ? { clientUserMessageId: r.clientUserMessageId } : {}) }];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length || new Set(submissions.map(([id]) => id)).size !== submissions.length) throw new Error('作者恢复记录格式不兼容');
  return { sequence: value.sequence, entries, submissions };
}

// Presentation metadata. Never changes prompts or authorizes execution.
// Correlations are deliberately recomputed: a second identical item in a busy
// turn can invalidate an earlier unique text/turn match.
export class MessageAuthors {
  constructor(name, { evidence, onChange = () => {} } = {}) {
    this.host = { id: randomUUID(), name: displayName(name) || '分享者', kind: 'host' };
    const saved = evidence && cleanAuthorEvidence(evidence);
    this.entries = new Map(saved?.entries);
    this.submissions = new Map(saved?.submissions.map(([id, r]) => [id, { ...r, responseIds: r.responseIds && new Set(r.responseIds) }]));
    this.sequence = saved?.sequence ?? 0;
    this.initialized = Boolean(saved);
    this.onChange = onChange;
    this.dirty = true;
    this.resolved = new Map();
  }
  observe(items, itemTurns, liveItemId = null) {
    let changed = false;
    for (const item of items) {
      if (item.role !== 'user') continue;
      const saved = this.entries.get(item.id), textDigest = digest(item.text), turnId = itemTurns.get(item.id) ?? null;
      const inputDigest = fingerprint(item[NATIVE_INPUT_DIGEST]) ? item[NATIVE_INPUT_DIGEST] : undefined;
      const inputId = identifier(item[NATIVE_INPUT_ID]) ? item[NATIVE_INPUT_ID] : undefined;
      if (saved) {
        // Desktop promotes an optimistic local turn to a native execution ID.
        // The same message ID and digest keep their original observation evidence.
        const inputChanged = saved.inputDigest !== undefined && inputDigest !== undefined && saved.inputDigest !== inputDigest
          || saved.inputId !== undefined && inputId !== undefined && saved.inputId !== inputId;
        const promoted = !inputChanged && saved.digest === textDigest && localTurn(saved.turnId) && turnId !== null && !localTurn(turnId);
        if (promoted) { saved.turnId = turnId; changed = true; }
        else if (saved.digest !== textDigest || saved.turnId !== turnId || inputChanged) {
          // Reused/changed native identities cannot inherit a saved author's claim.
          saved.digest = textDigest; saved.turnId = turnId; saved.historical = true; saved.live = false; delete saved.hostAuthor;
          delete saved.inputDigest;
          delete saved.inputId;
          changed = true;
        }
        if (inputDigest !== undefined && saved.inputDigest !== inputDigest) { saved.inputDigest = inputDigest; changed = true; }
        if (inputId !== undefined && saved.inputId !== inputId) { saved.inputId = inputId; changed = true; }
        if (!saved.live && liveItemId === item.id) { saved.live = true; saved.hostAuthor = { ...this.host }; changed = true; }
        continue;
      }
      // Bound metadata as well as the adapter's event buffers. Fail closed
      // instead of evicting an ID and later inventing a different attribution.
      if (this.entries.size >= 16384) throw new Error('Author metadata limit reached');
      const live = liveItemId === item.id;
      this.entries.set(item.id, { sequence: ++this.sequence, turnId, digest: textDigest, historical: !this.initialized, live,
        ...(inputDigest !== undefined ? { inputDigest } : {}),
        ...(inputId !== undefined ? { inputId } : {}),
        ...(live ? { hostAuthor: { ...this.host } } : {}) });
      changed = true;
    }
    this.initialized = true;
    if (changed) { this.dirty = true; this.onChange(this.checkpoint()); }
  }
  begin(id, text, author, { clientUserMessageId } = {}) {
    const name = displayName(author?.name);
    if (!name || typeof author.id !== 'string' || author.kind !== 'guest') throw new Error('Invalid local message author');
    if (clientUserMessageId !== undefined && !identifier(clientUserMessageId)) throw new Error('Invalid local input identity');
    if (this.submissions.size >= 16384 && !this.submissions.has(id)) throw new Error('Author metadata limit reached');
    const record = { before: this.sequence, digest: digest(text), author: { id: author.id, name, kind: 'guest' }, status: 'pending', turnId: null, responseIds: null,
      ...(clientUserMessageId !== undefined ? { clientUserMessageId } : {}) };
    this.submissions.set(id, record);
    this.dirty = true;
    this.onChange(this.checkpoint());
    return record;
  }
  complete(record, turn) {
    record.status = 'accepted';
    this.dirty = true;
    record.turnId = turn.id;
    // Desktop echoes the locally generated input id through its clientId when
    // persisting a message. Prefer that exact association over text matching.
    if (typeof turn.clientUserMessageId === 'string') record.responseIds = new Set([turn.clientUserMessageId]);
    // Some backends include items in the response; use their IDs when present.
    const ids = (Array.isArray(turn.items) ? turn.items : []).filter(item => typeof item?.id === 'string' && item.type === 'userMessage'
      && Array.isArray(item.content) && digest(item.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')) === record.digest
      && (!this.entries.has(item.id) || this.entries.get(item.id).sequence > record.before)).map(item => item.id);
    if (ids.length && !record.responseIds) record.responseIds = new Set(ids);
    this.onChange(this.checkpoint());
  }
  uncertain(record) { record.status = 'unknown'; this.dirty = true; this.onChange(this.checkpoint()); }
  resolve() {
    if (!this.dirty) return;
    const claims = new Map();
    const candidates = new Map();
    for (const record of this.submissions.values()) {
      const matches = [];
      for (const [id, entry] of this.entries) {
        if (record.clientUserMessageId !== undefined && record.clientUserMessageId !== (entry.inputId ?? id)) continue;
        if (entry.sequence <= record.before || entry.digest !== record.digest) continue;
        // Older versions marked local-to-native transitions as historical. Only
        // an accepted exact message ID and native turn can recover that claim;
        // historical text similarity alone never establishes authorship.
        const exactResponse = record.responseIds?.has(id) || record.responseIds?.has(entry.inputId);
        if (entry.historical && !(record.status === 'accepted' && record.turnId === entry.turnId && exactResponse)) continue;
        if (record.turnId && record.turnId !== entry.turnId) continue;
        if (record.responseIds && !exactResponse) continue;
        matches.push(id);
        if (!claims.has(id)) claims.set(id, []);
        claims.get(id).push(record);
      }
      candidates.set(record, matches);
    }
    this.resolved.clear();
    for (const [id, entry] of this.entries) {
      let author = unknown(entry?.historical);
      if (entry && (!entry.historical || claims.has(id))) {
        const records = claims.get(id) || [];
        if (records.length === 1 && records[0].status === 'accepted' && candidates.get(records[0]).length === 1) author = records[0].author;
        else if (!records.length) {
          // An unmatched input during an uncertain/ambiguous dispatch is not
          // proof of Desktop origin (the backend may have transformed text).
          const unresolved = [...this.submissions.values()].some(r => entry.sequence > r.before
            && (r.clientUserMessageId === undefined || entry.inputId === undefined || r.clientUserMessageId === entry.inputId)
            && (!r.responseIds || entry.inputId === undefined || r.responseIds.has(id) || r.responseIds.has(entry.inputId))
            // Native original input is preserved independently of display text.
            // Different original inputs cannot be this pending submission. Old
            // records without input IDs remain conservative for matching input.
            && (entry.inputDigest === undefined || entry.inputDigest === r.digest)
            && (!r.turnId || r.turnId === entry.turnId)
            && (r.status !== 'accepted' || candidates.get(r).length !== 1 || claims.get(candidates.get(r)[0])?.length !== 1));
          if (!unresolved) author = entry.live ? entry.hostAuthor : unknown(true);
        }
      }
      this.resolved.set(id, author);
    }
    this.dirty = false;
  }
  decorate(items) {
    this.resolve();
    return items.map(item => item.role === 'user' ? { ...item, author: { ...(this.resolved.get(item.id) || unknown(true)) } } : { ...item });
  }
  checkpoint() {
    return { sequence: this.sequence, entries: [...this.entries].map(([id, e]) => [id, { ...e, ...(e.hostAuthor ? { hostAuthor: { ...e.hostAuthor } } : {}) }]),
      submissions: [...this.submissions].map(([id, r]) => [id, { ...r, author: { ...r.author }, responseIds: r.responseIds && [...r.responseIds] }]) };
  }
  clear() { this.entries.clear(); this.submissions.clear(); this.resolved.clear(); this.dirty = true; }
}
