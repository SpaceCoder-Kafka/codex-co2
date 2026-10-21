import { randomUUID } from 'node:crypto';
import { displayName } from './display-name.mjs';

const unknown = (historical = false) => ({ id: 'unknown', name: historical ? '历史消息 · 作者未知' : '作者待确认', kind: 'unknown' });

// Room-local presentation metadata. Never changes prompts or authorizes execution.
// Correlations are deliberately recomputed: a second identical item in a busy
// turn can invalidate an earlier unique text/turn match.
export class MessageAuthors {
  constructor(name) {
    this.host = { id: randomUUID(), name: displayName(name) || '分享者', kind: 'host' };
    this.entries = new Map();
    this.submissions = new Map();
    this.sequence = 0;
    this.initialized = false;
    this.dirty = true;
    this.resolved = new Map();
  }
  observe(items, itemTurns, liveItemId = null) {
    for (const item of items) {
      if (item.role !== 'user') continue;
      const saved = this.entries.get(item.id);
      if (saved) {
        if (saved.text !== item.text) { saved.text = item.text; this.dirty = true; }
        if (!saved.live && liveItemId === item.id) { saved.live = true; this.dirty = true; }
        continue;
      }
      // Bound metadata as well as the adapter's event buffers. Fail closed
      // instead of evicting an ID and later inventing a different attribution.
      if (this.entries.size >= 16384) throw new Error('Author metadata limit reached');
      this.entries.set(item.id, { sequence: ++this.sequence, turnId: itemTurns.get(item.id), text: item.text, historical: !this.initialized, live: liveItemId === item.id });
      this.dirty = true;
    }
    this.initialized = true;
  }
  begin(id, text, author) {
    const name = displayName(author?.name);
    if (!name || typeof author.id !== 'string' || author.kind !== 'guest') throw new Error('Invalid local message author');
    const record = { before: this.sequence, text, author: { id: author.id, name, kind: 'guest' }, status: 'pending', turnId: null, responseIds: null };
    this.submissions.set(id, record);
    this.dirty = true;
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
      && Array.isArray(item.content) && item.content.filter(p => p?.type === 'text').map(p => p.text).join('\n') === record.text
      && (!this.entries.has(item.id) || this.entries.get(item.id).sequence > record.before)).map(item => item.id);
    if (ids.length && !record.responseIds) record.responseIds = new Set(ids);
  }
  uncertain(record) { record.status = 'unknown'; this.dirty = true; }
  resolve() {
    if (!this.dirty) return;
    const claims = new Map();
    const candidates = new Map();
    for (const record of this.submissions.values()) {
      const matches = [];
      for (const [id, entry] of this.entries) {
        if (entry.historical || entry.sequence <= record.before || entry.text !== record.text) continue;
        if (record.turnId && record.turnId !== entry.turnId) continue;
        if (record.responseIds && !record.responseIds.has(id)) continue;
        matches.push(id);
        if (!claims.has(id)) claims.set(id, []);
        claims.get(id).push(record);
      }
      candidates.set(record, matches);
    }
    this.resolved.clear();
    for (const [id, entry] of this.entries) {
      let author = unknown(entry?.historical);
      if (entry && !entry.historical) {
        const records = claims.get(id) || [];
        if (records.length === 1 && records[0].status === 'accepted' && candidates.get(records[0]).length === 1) author = records[0].author;
        else if (!records.length) {
          // An unmatched input during an uncertain/ambiguous dispatch is not
          // proof of Desktop origin (the backend may have transformed text).
          const unresolved = [...this.submissions.values()].some(r => entry.sequence > r.before
            && (!r.turnId || r.turnId === entry.turnId)
            && (r.status !== 'accepted' || candidates.get(r).length !== 1 || claims.get(candidates.get(r)[0])?.length !== 1));
          if (!unresolved) author = entry.live ? this.host : unknown(true);
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
  clear() { this.entries.clear(); this.submissions.clear(); this.resolved.clear(); this.dirty = true; }
}
