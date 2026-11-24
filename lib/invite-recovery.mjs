import { EventEmitter } from 'node:events';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { displayName } from './display-name.mjs';
import { privateIPv4 } from './lan-network.mjs';
import { openRecoveryStore } from './recovery-store.mjs';

const DAY = 86400000;
const recoverableReasons = new Set(['expired', 'interrupted', 'paused']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = value => createHash('sha256').update(value).digest('base64url');
const matches = (value, expected) => token(value) && typeof expected === 'string'
  && timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));
const originValue = value => {
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value ? value : null; }
  catch { return null; }
};
const unavailable = requestId => ({ type: 'recovery-request', ...(uuid(requestId) ? { requestId } : {}), status: 'unavailable' });
const lifetime = value => ['1h', '1d', '7d', 'permanent'].includes(value);
const positiveTime = value => Number.isSafeInteger(value) && value > 0;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const invalidStore = () => new Error('邀请恢复记录格式不兼容或已损坏，已停止恢复授权。');

function validateSnapshot(value, origin, now, limits) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw invalidStore(); }
  if (!fields(value, ['version', 'origin', 'checkpointAt', 'rooms', 'requests', 'blocked', 'disabledThreads'])
    || parsed.origin !== origin || parsed.protocol !== 'http:' || !privateIPv4(parsed.hostname) || !parsed.port
    || value.version !== 1 || value.origin !== origin || !positiveTime(value.checkpointAt) || value.checkpointAt > now + 30000
    || !Array.isArray(value.rooms) || value.rooms.length > limits.maxRooms
    || !Array.isArray(value.requests) || value.requests.length > limits.maxRequests
    || !Array.isArray(value.blocked) || value.blocked.length > limits.maxRooms
    || !Array.isArray(value.disabledThreads) || value.disabledThreads.length > limits.maxRooms) throw invalidStore();
  const rooms = new Map(), requests = new Map(), blocked = new Map(), disabledThreads = new Set();
  for (const room of value.rooms) {
    if (!fields(room, ['roomId', 'inviteHash', 'restartInviteHash', 'threadId', 'title', 'ownerName', 'requireApproval', 'desktopUploads', 'inviteLifetime', 'inviteExpiresAt',
      'intranetOnly', 'origin', 'state', 'expiresAt', 'endedAt', 'endReason', 'recoveryExpiresAt', 'requestTimes', 'admissionScope', 'members'])
      || !id(room.roomId) || rooms.has(room.roomId) || !token(room.inviteHash) || !id(room.threadId)
      || (room.restartInviteHash !== undefined && (!token(room.restartInviteHash) || !uuid(room.admissionScope)))
      || typeof room.title !== 'string' || room.title.length > 300 || displayName(room.ownerName) !== room.ownerName
      || typeof room.requireApproval !== 'boolean' || (room.desktopUploads !== undefined && typeof room.desktopUploads !== 'boolean')
      || !lifetime(room.inviteLifetime) || room.intranetOnly !== true || room.origin !== origin
      || !['online', 'offline', 'revoked'].includes(room.state) || !positiveTime(room.expiresAt)
      || (room.inviteExpiresAt !== undefined && room.inviteExpiresAt !== null && !positiveTime(room.inviteExpiresAt))
      || (room.inviteLifetime === 'permanent' && room.inviteExpiresAt !== undefined && room.inviteExpiresAt !== null)
      || !Array.isArray(room.requestTimes) || room.requestTimes.length > limits.requestsPerMinute
      || room.requestTimes.some(time => !positiveTime(time) || time > value.checkpointAt)) throw invalidStore();
    if (room.admissionScope !== undefined || room.members !== undefined) {
      if (!uuid(room.roomId) || !uuid(room.admissionScope)
        || (room.inviteLifetime === 'permanent' ? room.inviteExpiresAt !== null : !positiveTime(room.inviteExpiresAt))
        || !Array.isArray(room.members) || room.members.length > 32
        || room.members.some(member => !fields(member, ['hash', 'name', 'participantId', 'expiresAt'])
          || !token(member.hash) || !uuid(member.participantId) || !displayName(member.name) || displayName(member.name) !== member.name
          || !positiveTime(member.expiresAt) || member.expiresAt > value.checkpointAt + DAY
          || (room.inviteExpiresAt != null && member.expiresAt > room.inviteExpiresAt))
        || new Set(room.members.map(member => member.hash)).size !== room.members.length) throw invalidStore();
    }
    if (room.state === 'revoked') {
      if (!positiveTime(room.endedAt) || room.endedAt > value.checkpointAt || !['revoked', ...recoverableReasons].includes(room.endReason)
        || room.recoveryExpiresAt !== room.endedAt + 7 * DAY) throw invalidStore();
    } else if (room.endedAt !== undefined || room.endReason !== undefined || room.recoveryExpiresAt !== undefined) throw invalidStore();
    rooms.set(room.roomId, { ...room, requestTimes: [...room.requestTimes] });
  }
  for (const request of value.requests) {
    const room = rooms.get(request?.roomId);
    if (!fields(request, ['requestId', 'roomId', 'threadId', 'origin', 'receiptHash', 'visitorHash', 'name', 'createdAt', 'expiresAt', 'status'])
      || !uuid(request.requestId) || requests.has(request.requestId) || !room || request.threadId !== room.threadId || request.origin !== origin
      || !token(request.receiptHash) || !token(request.visitorHash) || request.receiptHash === request.visitorHash
      || displayName(request.name) !== request.name || !positiveTime(request.createdAt) || request.createdAt > value.checkpointAt
      || !positiveTime(request.expiresAt) || request.expiresAt <= request.createdAt || request.expiresAt > request.createdAt + DAY
      || (room.state === 'revoked' ? request.expiresAt > room.recoveryExpiresAt : !room.admissionScope)
      || !['pending', 'failed', 'rejected', 'expired', 'unavailable'].includes(request.status)
      || [...requests.values()].filter(previous => previous.roomId === room.roomId).length >= limits.maxPerRoom) throw invalidStore();
    requests.set(request.requestId, { ...request });
  }
  const threads = new Set([...rooms.values()].map(room => room.threadId));
  for (const item of value.blocked) {
    if (!fields(item, ['threadId', 'hashes']) || !threads.has(item.threadId) || blocked.has(item.threadId)
      || !Array.isArray(item.hashes) || item.hashes.length > 256 || item.hashes.some(value => !token(value))
      || new Set(item.hashes).size !== item.hashes.length) throw invalidStore();
    blocked.set(item.threadId, new Set(item.hashes));
  }
  for (const threadId of value.disabledThreads) {
    if (!threads.has(threadId) || disabledThreads.has(threadId)) throw invalidStore();
    disabledThreads.add(threadId);
  }
  return { rooms, requests, blocked, disabledThreads, checkpointAt: value.checkpointAt };
}

// The broker is owned by the sharing service. Optional LAN persistence retains
// only old-invitation, receipt and visitor hashes, never conversation data.
export class InviteRecovery extends EventEmitter {
  #rooms = new Map();
  #requests = new Map();
  #blocked = new Map();
  #disabledThreads = new Set();
  #closed = false;
  #store;
  #origin;
  #persistenceError = null;
  constructor({ now = () => Date.now(), maxRooms = 256, maxRequests = 256, maxPerRoom = 32, requestsPerMinute = 5 } = {}) {
    super();
    Object.assign(this, { now, maxRooms, maxRequests, maxPerRoom, requestsPerMinute });
    // The relay bounds connections, each of which may watch its own receipt.
    this.setMaxListeners(0);
    this.timer = setInterval(() => { try { this.sweep(); } catch { /* persistence failure already disabled the broker */ } }, 1000);
    this.timer.unref();
  }
  get persistenceEnabled() { return Boolean(this.#store); }
  get persistenceError() { return this.#persistenceError; }
  #failed(error) {
    this.#persistenceError = error;
    this.#closed = true; clearInterval(this.timer);
    this.#rooms.clear(); this.#requests.clear(); this.#blocked.clear(); this.#disabledThreads.clear();
    this.emit('persistence-error', error); this.emit('change');
  }
  #snapshot() {
    const rooms = [...this.#rooms.values()].filter(room => room.intranetOnly && room.origin === this.#origin);
    const ids = new Set(rooms.map(room => room.roomId)), threads = new Set(rooms.map(room => room.threadId));
    return { version: 1, origin: this.#origin, checkpointAt: this.now(), rooms: rooms.map(room => ({
      roomId: room.roomId, inviteHash: room.inviteHash, ...(room.restartInviteHash ? { restartInviteHash: room.restartInviteHash } : {}), threadId: room.threadId, title: room.title,
      ownerName: room.ownerName, requireApproval: room.requireApproval, desktopUploads: room.desktopUploads === true, inviteLifetime: room.inviteLifetime,
      ...(room.inviteExpiresAt !== undefined ? { inviteExpiresAt: room.inviteExpiresAt } : {}),
      intranetOnly: true, origin: room.origin, state: room.state, expiresAt: room.expiresAt,
      ...(room.state === 'revoked' ? { endedAt: room.endedAt, endReason: room.endReason, recoveryExpiresAt: room.recoveryExpiresAt } : {}),
      requestTimes: [...room.requestTimes],
      ...(room.admissionScope ? { admissionScope: room.admissionScope, members: room.members } : {}),
    })),
      requests: [...this.#requests.values()].filter(request => ids.has(request.roomId)).map(request => ({
        requestId: request.requestId, roomId: request.roomId, threadId: request.threadId, origin: request.origin,
        receiptHash: request.receiptHash, visitorHash: request.visitorHash, name: request.name,
        createdAt: request.createdAt, expiresAt: request.expiresAt,
        // Neither a grant nor its target's raw invitation survives restart.
        status: request.status === 'approved' ? 'unavailable' : request.status === 'processing' ? 'failed' : request.status,
      })),
      blocked: [...this.#blocked].filter(([threadId]) => threads.has(threadId)).map(([threadId, hashes]) => ({ threadId, hashes: [...hashes] })),
      disabledThreads: [...this.#disabledThreads].filter(threadId => threads.has(threadId)) };
  }
  #publish() {
    if (this.#store && !this.#closed) {
      try { this.#store.write(this.#snapshot()); }
      catch (error) { this.#failed(error); throw error; }
    }
    this.emit('change');
  }
  async enablePersistence(file, { origin, previousOrigin, inviteForRoom } = {}) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw invalidStore(); }
    if (this.#closed || parsed.origin !== origin || parsed.protocol !== 'http:' || !privateIPv4(parsed.hostname) || !parsed.port) throw invalidStore();
    if (this.#store) {
      if (this.#store.file === file && this.#origin === origin) return;
      if (this.#store.file === file && previousOrigin && this.#origin === previousOrigin) {
        this.moveLanRooms(previousOrigin, origin, inviteForRoom);
        return;
      }
      throw new Error('请先清除旧入口的恢复记录，再切换内网地址。');
    }
    try {
      const store = openRecoveryStore(file);
      if (store.value) {
        const restored = validateSnapshot(store.value, store.value.origin, this.now(), this);
        // Explicit disable/clear leaves a durable empty snapshot. It can be
        // rebound to another selected interface without importing old grants.
        if (store.value.origin !== origin && store.value.origin !== previousOrigin && (restored.rooms.size || restored.requests.size
          || restored.blocked.size || restored.disabledThreads.size)) throw invalidStore();
        if (this.#rooms.size || this.#requests.size) {
          if (restored.rooms.size || restored.requests.size || restored.blocked.size || restored.disabledThreads.size
            || [...this.#rooms.values()].some(room => !room.intranetOnly || room.origin !== origin)) throw invalidStore();
          // Enabling while a foreground share is live may checkpoint into an
          // explicitly cleared store without replacing current in-memory state.
        } else {
          this.#rooms = restored.rooms; this.#requests = restored.requests;
          this.#blocked = restored.blocked; this.#disabledThreads = restored.disabledThreads;
          for (const room of this.#rooms.values()) {
            room.fromCheckpoint = true;
            if (room.state === 'revoked') continue;
            const expired = room.inviteExpiresAt != null && room.inviteExpiresAt <= this.now();
            this.#end(room, expired ? 'expired' : 'interrupted', expired ? room.inviteExpiresAt : restored.checkpointAt);
          }
        }
      } else if ([...this.#rooms.values()].some(room => !room.intranetOnly || room.origin !== origin)) throw invalidStore();
      this.#store = store; this.#origin = origin;
      if (previousOrigin && store.value?.origin === previousOrigin) {
        this.moveLanRooms(previousOrigin, origin, inviteForRoom);
      }
      this.sweep(); this.#publish();
    } catch (error) {
      if (!this.#persistenceError) this.#failed(error);
      throw error;
    }
  }
  disablePersistence() {
    if (this.#persistenceError) throw this.#persistenceError;
    this.clear(); this.#store = undefined; this.#origin = undefined;
  }
  moveLanRooms(previousOrigin, origin, inviteForRoom) {
    // Called only for a local manager's explicit LAN-to-LAN address change.
    // Rotate both lookup and invitation; only personal grants cross the move.
    const from = new URL(previousOrigin), to = new URL(origin);
    if ([from, to].some(url => url.protocol !== 'http:' || !privateIPv4(url.hostname) || !url.port)
      || from.origin !== previousOrigin || to.origin !== origin || from.port !== to.port || previousOrigin === origin) throw invalidStore();
    if (this.#origin === origin && ![...this.#rooms.values()].some(room => room.origin === previousOrigin)) return;
    const rooms = new Map();
    for (const old of this.#rooms.values()) {
      const saved = this.hostRestartAuthorization(old.roomId, previousOrigin);
      if (!saved) continue;
      const roomId = randomUUID();
      rooms.set(roomId, { ...old, roomId, inviteHash: hash(inviteForRoom(roomId)), restartInviteHash: undefined,
        origin, members: saved.members, requestTimes: [] });
    }
    this.#rooms = rooms; this.#requests.clear();
    this.#origin = origin;
    this.#publish();
  }
  #invalidate(request, status = 'unavailable') {
    if (request.status === status && !request.inviteUrl) return false;
    request.status = status;
    delete request.inviteUrl;
    delete request.targetRoomId;
    delete request.grantExpiresAt;
    return true;
  }
  #end(room, reason, at = this.now()) {
    // A delayed lifecycle callback must never undo an explicit owner stop.
    if (room.state === 'revoked' && !recoverableReasons.has(room.endReason) && recoverableReasons.has(reason)) return;
    if (room.endedAt === undefined) room.endedAt = at;
    room.state = 'revoked';
    room.endReason = reason;
    if (reason === 'paused' && room.intranetOnly) room.fromCheckpoint = true;
    if (room.members && !['paused', 'interrupted'].includes(reason)) room.members = [];
    room.recoveryExpiresAt = room.endedAt + 7 * DAY;
  }
  sweep() {
    if (this.#closed) return;
    const now = this.now();
    let changed = false;
    for (const room of this.#rooms.values()) {
      if (room.state !== 'revoked' && room.expiresAt <= now) { this.#end(room, 'expired', room.expiresAt); changed = true; }
    }
    for (const request of this.#requests.values()) {
      const source = this.#rooms.get(request.roomId);
      const target = request.targetRoomId && this.#rooms.get(request.targetRoomId);
      if (request.expiresAt <= now || (request.grantExpiresAt !== undefined && request.grantExpiresAt <= now)) {
        changed = this.#invalidate(request, 'expired') || changed;
      } else if (!source || (source.state === 'revoked' && !recoverableReasons.has(source.endReason))
        || (request.status === 'approved' && (!target || target.state === 'revoked' || target.expiresAt <= now))) {
        changed = this.#invalidate(request) || changed;
      }
      // Keep expired results briefly so an open page receives a definite state;
      // subsequent reopens safely resolve to the same unavailable fallback.
      if (request.expiresAt + 60_000 <= now) { this.#requests.delete(request.requestId); changed = true; }
    }
    for (const [roomId, room] of this.#rooms) {
      if (room.state === 'revoked' && room.recoveryExpiresAt <= now) { this.#rooms.delete(roomId); changed = true; }
      room.requestTimes = room.requestTimes.filter(time => time > now - 60_000);
    }
    for (const threadId of this.#blocked.keys()) {
      if (![...this.#rooms.values()].some(room => room.threadId === threadId)) {
        this.#blocked.delete(threadId); this.#disabledThreads.delete(threadId);
      }
    }
    if (changed) this.#publish();
  }
  registerRoom(input) {
    this.sweep();
    if (this.#closed || !input || !id(input.roomId) || !token(input.inviteToken) || !id(input.threadId)
      || !originValue(input.origin) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now()
      || this.#rooms.has(input.roomId)
      || (this.#store && (!input.intranetOnly || input.origin !== this.#origin || !lifetime(input.inviteLifetime)))) return false;
    const room = {
      roomId: input.roomId, inviteHash: hash(input.inviteToken), threadId: input.threadId,
      title: String(input.title ?? '共享会话').slice(0, 300), ownerName: displayName(input.ownerName) ?? '分享者',
      requireApproval: input.requireApproval === true, desktopUploads: input.desktopUploads === true, inviteLifetime: input.inviteLifetime,
      intranetOnly: input.intranetOnly === true, origin: input.origin,
      ...(input.inviteExpiresAt === null || positiveTime(input.inviteExpiresAt) ? { inviteExpiresAt: input.inviteExpiresAt } : {}),
      state: input.state === 'offline' ? 'offline' : 'online', expiresAt: input.expiresAt, requestTimes: [],
    };
    // A newly selected share supersedes automatic access through older rooms.
    for (const previous of this.#rooms.values()) if (previous.threadId === room.threadId && previous.members) previous.members = [];
    if (this.#rooms.size >= this.maxRooms) { this.#publish(); return false; }
    if (input.intranetOnly && uuid(input.admissionScope)) {
      room.admissionScope = input.admissionScope;
      room.members = [];
    }
    this.#rooms.set(room.roomId, room);
    this.#publish();
    return true;
  }
  checkpointMembers(roomId, scopeId, grants) {
    const room = this.#rooms.get(roomId);
    if (!room?.intranetOnly || !scopeId || room.admissionScope !== scopeId || room.state === 'revoked') return;
    room.members = grants.filter(grant => grant.expiresAt > this.now()).map(grant => ({ ...grant,
      expiresAt: Math.min(grant.expiresAt, room.inviteExpiresAt ?? Infinity) }));
    this.#publish();
  }
  restartRoomIds(origin) {
    return [...this.#rooms.keys()].filter(roomId => this.hostRestartAuthorization(roomId, origin));
  }
  waitingLanRooms() {
    const waiting = [];
    for (const room of this.#rooms.values()) {
      if (this.hostRestartAuthorization(room.roomId, room.origin)) waiting.push({ roomId: room.roomId, title: room.title });
    }
    return waiting;
  }
  stopWaitingLanRoom(roomId) {
    const room = this.#rooms.get(roomId);
    if (!room || !this.hostRestartAuthorization(roomId, room.origin)) return null;
    this.revokeThread(room.threadId);
    return room.admissionScope;
  }
  hostRestartAuthorization(roomId, origin) {
    const room = this.#rooms.get(roomId), now = this.now();
    if (!room?.fromCheckpoint || !room.admissionScope || room.origin !== origin
      || room.state !== 'revoked' || !['interrupted', 'paused'].includes(room.endReason)
      || room.recoveryExpiresAt <= now || (room.inviteExpiresAt != null && room.inviteExpiresAt <= now)
      || this.#disabledThreads.has(room.threadId)) return null;
    // Checkpoints from earlier builds may contain multiple shares of one thread.
    // A later share, including an explicitly stopped one, supersedes the older link.
    if ([...this.#rooms.values()].findLast(entry => entry.threadId === room.threadId) !== room) return null;
    const blocked = this.#blocked.get(room.threadId);
    return { roomId: room.roomId, threadId: room.threadId, ownerName: room.ownerName, requireApproval: room.requireApproval,
      desktopUploads: room.desktopUploads === true,
      inviteLifetime: room.inviteLifetime, inviteExpiresAt: room.inviteExpiresAt, admissionScope: room.admissionScope,
      members: room.members.filter(member => member.expiresAt > now && !blocked?.has(member.hash)) };
  }
  getRestartAuthorization(input, origin) {
    const room = this.#source(input, origin);
    if (!room || !token(input.sessionId)) return null;
    const saved = this.hostRestartAuthorization(room.roomId, origin);
    return saved?.members.some(member => member.hash === hash(input.sessionId)) ? saved : null;
  }
  originalInviteHash(roomId, origin) {
    const room = this.#rooms.get(roomId);
    return room?.origin === origin && room.intranetOnly && room.admissionScope ? room.inviteHash : null;
  }
  markRestarted(roomId, expiresAt, inviteToken) {
    const room = this.#rooms.get(roomId);
    if (!room?.fromCheckpoint) throw invalidStore();
    const activeHash = hash(inviteToken);
    if (activeHash !== room.inviteHash) room.restartInviteHash = activeHash;
    delete room.fromCheckpoint;
    delete room.endedAt; delete room.recoveryExpiresAt; delete room.endReason;
    room.state = 'online'; room.expiresAt = expiresAt;
    this.#publish();
  }
  updateRoom(roomId, patch = {}) {
    // Apply a confirmed lease extension before sweeping the old deadline.
    const room = this.#rooms.get(roomId);
    if (!room || this.#closed) return;
    if (typeof patch.title === 'string') room.title = patch.title.slice(0, 300);
    if (typeof patch.requireApproval === 'boolean') room.requireApproval = patch.requireApproval;
    if (typeof patch.desktopUploads === 'boolean') room.desktopUploads = patch.desktopUploads;
    if (Number.isSafeInteger(patch.expiresAt) && room.state !== 'revoked') room.expiresAt = patch.expiresAt;
    if (patch.state === 'revoked') {
      this.#end(room, recoverableReasons.has(patch.endReason) ? patch.endReason : 'revoked');
    } else if (room.state !== 'revoked' && ['online', 'offline'].includes(patch.state)) room.state = patch.state;
    this.sweep();
    this.#publish();
  }
  #source(input, origin) {
    const room = this.#rooms.get(input?.roomId);
    return room && room.origin === origin && (matches(input.inviteToken, room.inviteHash) || matches(input.inviteToken, room.restartInviteHash)) ? room : null;
  }
  status(input, origin) {
    this.sweep();
    const room = this.#source(input, origin);
    const result = { type: 'recovery-status', status: 'unavailable' };
    if (!room || this.#disabledThreads.has(room.threadId)) return result;
    if (room.state !== 'revoked') return { ...result, status: room.state === 'online' ? 'active' : 'temporarily-offline' };
    if (recoverableReasons.has(room.endReason) && room.recoveryExpiresAt > this.now()) {
      return { ...result, status: 'recoverable', reason: room.endReason, recoveryExpiresAt: room.recoveryExpiresAt };
    }
    return result;
  }
  #view(request) {
    if (!request) return unavailable();
    return { type: 'recovery-request', requestId: request.requestId, status: request.status,
      expiresAt: Math.min(request.expiresAt, request.grantExpiresAt ?? request.expiresAt),
      ...(request.status === 'approved' ? { inviteUrl: request.inviteUrl } : {}) };
  }
  request(input, origin) {
    this.sweep();
    const fallback = unavailable(input?.requestId);
    const room = this.#source(input, origin);
    const name = displayName(input?.name);
    if (!room || !uuid(input?.requestId) || !token(input?.receiptToken) || !token(input?.visitorToken)
      || input.receiptToken === input.visitorToken || !name) return fallback;
    const previous = this.#requests.get(input.requestId);
    if (previous) {
      return previous.roomId === room.roomId && previous.origin === origin && previous.name === name
        && matches(input.receiptToken, previous.receiptHash) && matches(input.visitorToken, previous.visitorHash)
        ? this.#view(previous) : fallback;
    }
    if (this.status(input, origin).status !== 'recoverable' || this.#blocked.get(room.threadId)?.has(hash(input.visitorToken))) return fallback;
    if (this.#requests.size >= this.maxRequests || [...this.#requests.values()].filter(request => request.roomId === room.roomId).length >= this.maxPerRoom) {
      return { ...fallback, code: 'capacity-reached' };
    }
    if (room.requestTimes.length >= this.requestsPerMinute
      || [...this.#requests.values()].some(request => request.roomId === room.roomId && request.visitorHash === hash(input.visitorToken))) {
      return { ...fallback, code: 'rate-limited' };
    }
    const now = this.now();
    const request = {
      requestId: input.requestId, roomId: room.roomId, threadId: room.threadId, origin,
      receiptHash: hash(input.receiptToken), visitorHash: hash(input.visitorToken), name,
      createdAt: now, expiresAt: Math.min(now + DAY, room.recoveryExpiresAt), status: 'pending',
    };
    room.requestTimes.push(now);
    this.#requests.set(request.requestId, request);
    this.#publish();
    return this.#view(request);
  }
  watch(input, origin) {
    return this.watcher(input, origin)();
  }
  watcher(input, origin) {
    const requestId = input?.requestId;
    const receiptHash = token(input?.receiptToken) ? hash(input.receiptToken) : null;
    // A live subscription retains a proof hash, not the browser's raw receipt.
    return () => this.#watchedView(requestId, receiptHash, origin);
  }
  #watchedView(requestId, receiptHash, origin) {
    this.sweep();
    const request = this.#requests.get(requestId);
    return request && request.origin === origin && receiptHash
      && timingSafeEqual(Buffer.from(receiptHash), Buffer.from(request.receiptHash))
      ? this.#view(request) : unavailable(requestId);
  }
  list() {
    this.sweep();
    return [...this.#requests.values()].map(request => ({ requestId: request.requestId, roomId: request.roomId,
      threadId: request.threadId, title: this.#rooms.get(request.roomId)?.title ?? '共享会话', name: request.name,
      createdAt: request.createdAt, expiresAt: Math.min(request.expiresAt, request.grantExpiresAt ?? request.expiresAt), status: request.status }));
  }
  beginApproval(requestId) {
    this.sweep();
    const request = this.#requests.get(requestId), source = request && this.#rooms.get(request.roomId);
    if (!request || !['pending', 'failed'].includes(request.status) || !source
      || this.#blocked.get(request.threadId)?.has(request.visitorHash) || this.#disabledThreads.has(request.threadId)) return null;
    request.status = 'processing';
    this.#publish();
    return Object.freeze({ requestId, roomId: source.roomId, threadId: source.threadId, title: source.title,
      name: request.name, visitorHash: request.visitorHash, createdAt: request.createdAt, expiresAt: request.expiresAt,
      ownerName: source.ownerName, requireApproval: source.requireApproval, desktopUploads: source.desktopUploads === true, inviteLifetime: source.inviteLifetime,
      intranetOnly: source.intranetOnly, origin: source.origin });
  }
  approvalCurrent(requestId) {
    this.sweep();
    return this.#requests.get(requestId)?.status === 'processing';
  }
  approve(requestId, target) {
    this.sweep();
    const request = this.#requests.get(requestId), room = target && this.#rooms.get(target.roomId);
    if (!request || request.status !== 'processing' || !room || room.state !== 'online'
      || room.threadId !== request.threadId || room.origin !== request.origin
      || !Number.isSafeInteger(target.expiresAt) || target.expiresAt <= this.now()) return false;
    let url;
    try { url = new URL(target.inviteUrl); } catch { return false; }
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.origin !== room.origin || url.username || url.password || url.pathname !== '/' || url.search
      || fragment.get('room') !== room.roomId || !this.#source({ roomId: room.roomId, inviteToken: fragment.get('invite') }, room.origin)
      || [...fragment.keys()].some(key => !['room', 'invite', 'scope'].includes(key) || fragment.getAll(key).length !== 1)
      || (fragment.has('scope') && !id(fragment.get('scope')))) return false;
    request.targetRoomId = room.roomId;
    request.grantExpiresAt = Math.min(request.expiresAt, target.expiresAt, room.expiresAt);
    request.participantId = randomUUID();
    request.grantConsumed = false;
    // Only the approved outcome retains the current invitation while its target
    // is valid. Old invite/receipt/visitor secrets are never retained in clear.
    request.inviteUrl = url.href;
    request.status = 'approved';
    this.#publish();
    return true;
  }
  fail(requestId) {
    this.sweep();
    const request = this.#requests.get(requestId);
    if (request?.status !== 'processing') return false;
    request.status = 'failed'; this.#publish(); return true;
  }
  reject(requestId) {
    this.sweep();
    const request = this.#requests.get(requestId);
    if (!request || !['pending', 'failed', 'processing'].includes(request.status)) return false;
    this.#block(request.threadId, request.visitorHash);
    this.#invalidate(request, 'rejected'); this.#publish(); return true;
  }
  #block(threadId, visitorHash) {
    let blocked = this.#blocked.get(threadId);
    if (!blocked) this.#blocked.set(threadId, blocked = new Set());
    if (blocked.size >= 256) this.#disabledThreads.add(threadId);
    else blocked.add(visitorHash);
  }
  revokeVisitor(threadId, visitorHash) {
    if (this.#closed || !id(threadId) || !token(visitorHash)) return;
    this.#block(threadId, visitorHash);
    for (const room of this.#rooms.values()) if (room.threadId === threadId && room.members) room.members = room.members.filter(member => member.hash !== visitorHash);
    for (const request of this.#requests.values()) if (request.threadId === threadId && request.visitorHash === visitorHash) this.#invalidate(request);
    this.#publish();
  }
  revokeThread(threadId) {
    if (this.#closed) return;
    for (const room of this.#rooms.values()) if (room.threadId === threadId) this.#end(room, 'revoked');
    for (const request of this.#requests.values()) if (request.threadId === threadId) this.#invalidate(request);
    this.#publish();
  }
  consumeGrant(roomId, visitorHash) {
    this.sweep();
    const room = this.#rooms.get(roomId);
    if (!room || room.state !== 'online' || room.expiresAt <= this.now() || this.#blocked.get(room.threadId)?.has(visitorHash)) return null;
    const request = [...this.#requests.values()].find(value => value.status === 'approved' && value.targetRoomId === roomId
      && value.visitorHash === visitorHash && !value.grantConsumed && value.grantExpiresAt > this.now());
    if (!request) return null;
    request.grantConsumed = true;
    this.#publish();
    return { name: request.name, participantId: request.participantId, requestId: request.requestId };
  }
  clear() {
    this.#rooms.clear(); this.#requests.clear(); this.#blocked.clear(); this.#disabledThreads.clear();
    this.#publish();
  }
  close({ preserve = false } = {}) {
    if (this.#closed) return;
    clearInterval(this.timer);
    if (preserve && this.#store) {
      for (const room of this.#rooms.values()) if (room.state !== 'revoked') this.#end(room, 'interrupted');
      for (const request of this.#requests.values()) if (request.status === 'processing') request.status = 'failed';
      this.sweep(); this.#publish();
      this.#rooms.clear(); this.#requests.clear(); this.#blocked.clear(); this.#disabledThreads.clear();
      this.#closed = true; this.emit('change');
    } else { this.clear(); this.#closed = true; }
  }
}
