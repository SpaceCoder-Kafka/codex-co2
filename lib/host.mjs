import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { RpcClient } from './rpc.mjs';
import { ScopedThread } from './scoped-thread.mjs';
import { lookupFresh } from './network.mjs';
import { displayName } from './display-name.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { IMAGE_CHUNK_BYTES } from './thread-images.mjs';
import { GuestPermissions, recoveryHash } from './guest-permissions.mjs';
import { attentionFor } from './attention.mjs';
import { createManagerSettings } from './manager-settings.mjs';
import { createMessageAuthorHistory } from './message-author-history.mjs';

export const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (ws, data) => {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(data);
  if (ws.bufferedAmount + Buffer.byteLength(encoded) > 1024 * 1024) { ws.close(1013, 'Slow connection'); return false; }
  ws.send(encoded);
  return true;
};
function wsURL(origin, suffix) { const u = new URL(suffix, origin); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href; }
const HOUR = 3600000, RENEW_LEAD = 300000, RENEW_RETRY = 30000, RENEW_ACK_TIMEOUT = 10000;

// This is the trusted LOCAL owner controller. No browser guest can call it.
export class SharedRoom extends EventEmitter {
  constructor({ relayUrl, registrationSecret, socketPath, threadId, permissions, authorHistory, inheritAdmissions = false, ownerName = '分享者', requireApproval = false, ttlMs = HOUR, rpcFactory = RpcClient.connect, canRenew = () => true, onDiagnostic = () => {} }) {
    super();
    if (!displayName(ownerName)) throw new Error('请填写 1–40 个字符的显示名称');
    this.ownerName = displayName(ownerName);
    if (typeof requireApproval !== 'boolean') throw new Error('消息审批设置必须为布尔值');
    this.requireApproval = requireApproval;
    const url = new URL(relayUrl);
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Relay requires HTTPS (HTTP only for loopback development)');
    if (!/^[A-Za-z0-9_-]{43}$/.test(registrationSecret)) throw new Error('Missing relay registration credential');
    Object.assign(this, { relayUrl: url.origin, registrationSecret, socketPath, threadId, rpcFactory, canRenew, onDiagnostic, authorHistory });
    this.roomId = randomUUID(); this.hostToken = secret(); this.inviteToken = secret();
    this.expiresAt = Date.now() + Math.min(Math.max(ttlMs, 60000), 86400000);
    this.guests = new Map(); this.proposals = new Map(); this.state = 'connecting'; this.closed = false;
    this.startedAt = Date.now();
    this.permissions = permissions;
    this.admissionScope = permissions?.begin(threadId, inheritAdmissions);
    this.departedGuests = new Map();
    this.imageTransfers = new Set();
  }
  async start() {
    this.rpc = await this.rpcFactory(this.socketPath);
    this.onRpcEvent = message => {
      const p = message?.params;
      if (p?.threadId !== this.threadId || !['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta'].includes(message.method)) return;
      this.diagnostic('backend-event', { method: message.method, turnId: p.turnId ?? p.turn?.id, itemId: p.itemId ?? p.item?.id,
        itemType: p.item?.type, textBytes: typeof p.item?.text === 'string' ? Buffer.byteLength(p.item.text) : undefined,
        deltaBytes: typeof p.delta === 'string' ? Buffer.byteLength(p.delta) : undefined });
    };
    this.rpc.on('notification', this.onRpcEvent);
    this.thread = new ScopedThread({ rpc: this.rpc, threadId: this.threadId, ownerName: this.ownerName,
      authorEvidence: this.authorHistory?.get(this.threadId),
      onAuthorsChanged: evidence => this.authorHistory?.remember(this.threadId, evidence) });
    this.thread.on('snapshot', snapshot => {
      if (this.closed) return;
      // A lost native connection cannot leave an admitted room serving stale
      // history or accepting more proposals. Re-sharing requires a local gesture.
      if (snapshot.status === 'offline') {
        this.lastError = '本地 Codex 已断开，共享已停止；请重新分享会话';
        this.close(); return;
      }
      this.latestSnapshot = snapshot;
      this.diagnostic('snapshot', this.snapshotMetadata(snapshot));
      if (!this.snapshotTimer) this.snapshotTimer = setTimeout(() => { this.snapshotTimer = null; if (!this.closed) this.deliver(this.latestSnapshot); }, 100);
      if (snapshot.status === 'idle') this.approvalPending = false;
      if (this.displayTitle !== snapshot.title || this.displayStatus !== snapshot.status) {
        this.displayTitle = snapshot.title; this.displayStatus = snapshot.status; this.emit('change');
      }
    });
    this.thread.on('approval-pending', () => { this.approvalPending = true; this.emit('change'); });
    this.thread.on('approval-state', ({ pending }) => {
      if (!this.closed && this.approvalPending !== pending) { this.approvalPending = pending; this.emit('change'); }
    });
    this.thread.on('fault', () => { this.lastError = '会话读取失败，共享已停止；请检查本地 Codex'; this.close(); });
    try { await this.thread.start(); await this.connect(); }
    catch (error) { this.close(); throw error; }
    this.scheduleExpiry();
    return this;
  }
  scheduleExpiry() {
    clearTimeout(this.expiry); clearTimeout(this.renewalTimer);
    if (this.closed) return;
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) return this.close({ reason: 'expired' });
    this.expiry = setTimeout(() => this.scheduleExpiry(), remaining); this.expiry.unref();
    if (this.renewalSupported) this.scheduleRenewal(Math.max(0, remaining - RENEW_LEAD));
  }
  scheduleRenewal(wait) {
    clearTimeout(this.renewalTimer);
    this.renewalTimer = setTimeout(() => this.maybeRenew(), wait); this.renewalTimer.unref();
  }
  maybeRenew(now = Date.now()) {
    if (this.closed) return;
    if (now >= this.expiresAt) return this.close({ reason: 'expired' });
    if (!this.renewalSupported || now < this.expiresAt - RENEW_LEAD) return;
    const retryIn = this.pendingRenewal ? this.lastRenewalSentAt + RENEW_RETRY - now : 0;
    if (retryIn > 0) { this.scheduleRenewal(retryIn); return; }
    this.scheduleRenewal(RENEW_RETRY);
    this.checkConnection(now);
    if (this.closed || this.state !== 'online' || this.ws?.readyState !== WebSocket.OPEN
      || !this.thread?.snapshot || this.thread.snapshot.status === 'offline' || !this.canRenew()) return;
    // Keep one immutable target until acknowledged. A retry cannot slide the
    // deadline or extend it twice, even when an ACK or connection was lost.
    this.pendingRenewal ??= { requestId: randomUUID(), previousExpiresAt: this.expiresAt, expiresAt: this.expiresAt + HOUR };
    if (!send(this.ws, { type: 'renew', ...this.pendingRenewal })) return;
    this.lastRenewalSentAt = now;
    clearTimeout(this.renewalAckTimer);
    this.renewalAckTimer = setTimeout(() => {
      this.renewalAckTimer = null;
      if (!this.closed && this.pendingRenewal) this.diagnostic('renewal-timeout', {});
    }, RENEW_ACK_TIMEOUT);
    this.renewalAckTimer.unref();
  }
  confirmRenewal(message) {
    if (this.closed) return false;
    if (Date.now() >= this.expiresAt) { this.close({ reason: 'expired' }); return false; }
    const pending = this.pendingRenewal;
    if (!this.renewalSupported || !pending || message.roomId !== this.roomId || message.requestId !== pending.requestId
      || message.expiresAt !== pending.expiresAt || pending.previousExpiresAt !== this.expiresAt) return false;
    this.expiresAt = pending.expiresAt;
    this.pendingRenewal = null; this.lastRenewalSentAt = null;
    clearTimeout(this.renewalAckTimer);
    this.scheduleExpiry();
    // Only a currently admitted, still-authorized identity gets a longer
    // recovery grant. Offline or removed visitors keep their original deadline.
    for (const guest of this.guests.values()) {
      if (guest.status !== 'admitted' || !guest.resumeHash) continue;
      const grant = this.permissions?.get(this.admissionScope, guest.resumeHash);
      if (!grant) continue;
      this.permissions.allow(this.admissionScope, guest.resumeHash, grant, this.expiresAt);
      this.deliver({ type: 'visitor-recovery', scopeId: this.admissionScope, expiresAt: this.expiresAt, name: grant.name, resumed: true }, guest.id);
    }
    this.diagnostic('renewal-confirmed', { expiresAt: this.expiresAt });
    this.emit('change'); return true;
  }
  async connect() {
    if (this.closed) return;
    if (Date.now() >= this.expiresAt) return this.close({ reason: 'expired' });
    const ws = new WebSocket(wsURL(this.relayUrl, '/host'), { lookup: lookupFresh, perMessageDeflate: false, maxPayload: 65536, handshakeTimeout: 10000 });
    this.ws = ws;
    this.lastHeartbeat = Date.now();
    ws.on('ping', () => { if (this.ws === ws) this.lastHeartbeat = Date.now(); });
    clearInterval(this.heartbeatWatch);
    this.heartbeatWatch = setInterval(() => this.checkConnection(), 15000);
    this.heartbeatWatch.unref();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Relay registration timed out')); ws.terminate(); }, 12000);
      ws.once('open', () => {
        if (this.closed || Date.now() >= this.expiresAt) { this.close({ reason: 'expired' }); return; }
        send(ws, { type: 'register', registrationSecret: this.registrationSecret,
          roomId: this.roomId, hostToken: this.hostToken, inviteToken: this.inviteToken, expiresAt: this.expiresAt });
      });
      ws.on('message', bytes => {
        if (this.closed || this.ws !== ws) return;
        this.lastHeartbeat = Date.now();
        let message;
        try { message = JSON.parse(bytes); } catch { return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.type === 'registered') {
          clearTimeout(timeout);
          if (Date.now() >= this.expiresAt) { this.close({ reason: 'expired' }); reject(new Error('Sharing expired')); return; }
          const confirmsPending = message.renewalSupported === true && this.pendingRenewal && message.expiresAt === this.pendingRenewal.expiresAt;
          if (message.roomId !== this.roomId || !Number.isSafeInteger(message.expiresAt)
            || (message.expiresAt !== this.expiresAt && !confirmsPending)) {
            this.close(); reject(new Error('Relay returned an unexpected expiry')); return;
          }
          this.renewalSupported = message.renewalSupported === true;
          this.state = 'online'; this.retry = 0;
          if (confirmsPending) this.confirmRenewal({ ...message, requestId: this.pendingRenewal.requestId });
          if (!this.renewalSupported) { this.pendingRenewal = null; clearTimeout(this.renewalAckTimer); }
          this.scheduleExpiry(); this.emit('change'); resolve();
        }
        else if (message.type === 'renewed') this.confirmRenewal(message);
        else if (message.type === 'error') { clearTimeout(timeout); reject(new Error('Relay refused registration or message')); }
        else this.receive(message);
      });
      ws.on('error', () => { clearTimeout(timeout); reject(new Error('Relay connection failed')); });
      ws.on('close', () => { clearTimeout(timeout); reject(new Error('Relay disconnected')); if (this.ws === ws) this.disconnected(); });
    });
  }
  checkConnection(now = Date.now()) {
    if (!this.closed && now >= this.expiresAt) return this.close({ reason: 'expired' });
    // Timers resume after wake. Kill only a stale transport, retaining room ID,
    // invitation and the native thread; guests must prove their own prior approval again.
    if (!this.closed && this.ws && now - this.lastHeartbeat > 75000) this.ws.terminate();
  }
  disconnected() {
    if (this.closed) return;
    clearInterval(this.heartbeatWatch);
    clearTimeout(this.renewalTimer); clearTimeout(this.renewalAckTimer);
    this.state = 'offline';
    for (const guest of this.guests.values()) this.rememberDeparture(guest);
    this.guests.clear();
    for (const p of this.proposals.values()) {
      if (p.status === 'pending') { p.status = 'rejected'; p.text = ''; }
      else if (p.status === 'processing') p.status = 'unknown';
    }
    this.emit('change');
    clearTimeout(this.reconnect);
    if (Date.now() >= this.expiresAt) return this.close({ reason: 'expired' });
    this.reconnect = setTimeout(() => this.connect().catch(() => {}), Math.min(1000 * 2 ** (this.retry = (this.retry ?? 0) + 1), 15000));
    this.reconnect.unref();
  }
  receive(message) {
    if (this.closed || this.state !== 'online') return;
    if (Date.now() >= this.expiresAt) return this.close({ reason: 'expired' });
    if (message.type === 'join-request') {
      if (this.guests.size >= 20 || typeof message.guestId !== 'string' || !displayName(message.name)) return;
      const hash = recoveryHash(message.resumeHash) ? message.resumeHash : undefined;
      const grant = hash && this.permissions?.get(this.admissionScope, hash);
      if (grant) for (const guest of this.guests.values()) {
        if (guest.resumeHash === hash) this.removeGuest(guest.id, true, { forget: false });
      }
      this.guests.set(message.guestId, { id: message.guestId, participantId: grant?.participantId ?? randomUUID(),
        name: grant?.name ?? displayName(message.name), status: 'pending', ...(hash ? { resumeHash: hash } : {}) });
      if (grant) { this.admit(message.guestId, true, { resumed: true }); return; }
      this.emit('change'); return;
    }
    if (message.type === 'guest-left') { this.removeGuest(message.guestId, false, { forget: false }); return; }
    if (message.type !== 'guest-message') return;
    const guest = this.guests.get(message.guestId);
    if (!guest || guest.status !== 'admitted') return;
    const payload = message.payload;
    if (payload?.type === 'snapshot-request') return this.deliver(this.thread.snapshot, guest.id);
    if (payload?.type === 'image-request' && /^[a-f0-9]{64}$/.test(payload.imageId ?? '')
      && Object.keys(payload).every(k => ['type', 'imageId'].includes(k))) {
      void this.sendImage(guest, payload.imageId);
      return;
    }
    if (payload?.type === 'file-request' && /^[a-f0-9]{64}$/.test(payload.fileId ?? '')
      && Object.keys(payload).every(k => ['type', 'fileId'].includes(k))) {
      void this.sendPreview(guest, payload.fileId, 'file'); return;
    }
    if (payload?.type !== 'proposal' || !/^[0-9a-f-]{36}$/i.test(payload.requestId ?? '') || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 8000) return;
    if (Object.keys(payload).some(k => !['type', 'requestId', 'text'].includes(k))) return;
    const key = `${guest.id}:${payload.requestId}`;
    if (this.proposals.has(key)) return this.proposalStatus(this.proposals.get(key));
    const pendingBytes = [...this.proposals.values()].filter(p => ['pending', 'processing'].includes(p.status)).reduce((n, p) => n + Buffer.byteLength(p.text), 0);
    if (this.proposals.size >= 200 || pendingBytes + Buffer.byteLength(payload.text) > 65536) return this.deliver({ type: 'proposal-status', requestId: payload.requestId, status: 'rejected', message: '消息数量已达上限，请稍后再发或重新分享' }, guest.id);
    const proposal = { id: key, requestId: payload.requestId, executionId: randomUUID(), guestId: guest.id, author: { id: guest.participantId, name: guest.name, kind: 'guest' }, name: guest.name, text: payload.text, status: 'pending', createdAt: Date.now() };
    this.proposals.set(key, proposal);
    if (this.requireApproval) { this.proposalStatus(proposal); this.emit('change'); }
    else void this.decide(key, true).catch(() => {});
  }
  sendImage(guest, imageId) { return this.sendPreview(guest, imageId, 'image'); }
  async sendPreview(guest, id, type) {
    const identity = type === 'image' ? { imageId: id } : { fileId: id };
    const has = () => type === 'image' ? this.thread.hasImage(id) : this.thread.hasFile(id);
    const connection = this.ws;
    const allowed = () => !this.closed && this.state === 'online' && this.ws === connection
      && connection?.readyState === WebSocket.OPEN && Date.now() < this.expiresAt
      && this.guests.get(guest.id) === guest && guest.status === 'admitted' && has();
    if (!allowed() || this.imageTransfers.has(guest.id) || this.imageTransfers.size >= 4) {
      this.deliver({ type: `${type}-unavailable`, ...identity }, guest.id); return;
    }
    this.imageTransfers.add(guest.id);
    try {
      const { bytes, mime } = type === 'image' ? await this.thread.readImage(id) : await this.thread.readFile(id);
      const total = Math.max(1, Math.ceil(bytes.length / IMAGE_CHUNK_BYTES));
      for (let index = 0; index < total; index++) {
        const deadline = Date.now() + 3000;
        while (allowed() && connection.bufferedAmount > 128 * 1024) {
          if (Date.now() > deadline) throw new Error('Slow image connection');
          await delay(10);
        }
        if (!allowed()) return;
        if (!this.deliver({ type: `${type}-chunk`, ...identity, mime, index, total,
          data: bytes.subarray(index * IMAGE_CHUNK_BYTES, (index + 1) * IMAGE_CHUNK_BYTES).toString('base64') }, guest.id)) return;
        // Let revocation, snapshots and tool approval signals run between chunks.
        if (index + 1 < total) await delay(0);
      }
    } catch {
      if (allowed()) this.deliver({ type: `${type}-unavailable`, ...identity }, guest.id);
    } finally { this.imageTransfers.delete(guest.id); }
  }
  diagnostic(kind, fields) { try { this.onDiagnostic({ at: new Date().toISOString(), kind, roomId: this.roomId, threadId: this.threadId, ...fields }); } catch {} }
  snapshotMetadata(snapshot) { return { revision: snapshot.revision, status: snapshot.status,
    items: snapshot.items.map(item => ({ id: item.id, role: item.role, textBytes: Buffer.byteLength(item.text) })) }; }
  deliver(payload, guestId) {
    if (!payload) return;
    const sent = send(this.ws, { type: 'deliver', ...(guestId ? { guestId } : {}), payload });
    if (payload.type === 'snapshot') this.deliver({ type: 'message-policy', requireApproval: this.requireApproval }, guestId);
    if (payload.type === 'snapshot') this.diagnostic('relay-send', { ...this.snapshotMetadata(payload), sent,
      target: guestId ? 'single' : 'all', admittedGuests: [...this.guests.values()].filter(g => g.status === 'admitted').length });
    return sent;
  }
  proposalStatus(p) { this.deliver({ type: 'proposal-status', requestId: p.requestId, status: p.status }, p.guestId); }
  admit(id, allow, { resumed = false } = {}) {
    const g = this.guests.get(id); if (!g || g.status !== 'pending' || this.state !== 'online') throw new Error('加入请求已失效');
    g.status = allow ? 'admitted' : 'denied';
    if (g.resumeHash && !resumed) {
      if (allow) this.permissions?.allow(this.admissionScope, g.resumeHash, g, this.expiresAt);
      else this.permissions?.forget(this.admissionScope, g.resumeHash);
    }
    send(this.ws, { type: allow ? 'admit' : 'deny', guestId: id });
    if (allow) {
      const grant = g.resumeHash && this.permissions?.get(this.admissionScope, g.resumeHash);
      if (grant) this.deliver({ type: 'visitor-recovery', scopeId: this.admissionScope, expiresAt: grant.expiresAt, name: g.name, resumed }, id);
      this.deliver(this.thread.snapshot, id);
    }
    else this.guests.delete(id);
    this.emit('change');
  }
  setRequireApproval(requireApproval) {
    if (typeof requireApproval !== 'boolean') throw new Error('消息审批设置必须为布尔值');
    if (this.closed || this.state !== 'online') throw new Error('共享当前不可用');
    this.requireApproval = requireApproval;
    // Applies to new messages only. Pending proposals keep their explicit decisions.
    this.deliver({ type: 'message-policy', requireApproval }); this.emit('change');
  }
  async decide(id, allow) {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') throw new Error('建议已处理或已失效');
    if (!allow) { p.status = 'rejected'; p.text = ''; this.proposalStatus(p); this.emit('change'); return; }
    if (this.closed || this.state !== 'online' || this.guests.get(p.guestId)?.status !== 'admitted') throw new Error('访客已离线或被移除');
    p.status = 'processing'; this.proposalStatus(p); this.emit('change');
    try {
      // Authorized by the local message policy or an explicit owner decision.
      // Never forward guest RPC/options or answer native tool approvals.
      const result = await this.thread.submitApproved(p.text, p.executionId, { author: p.author, canDispatch: () => !this.closed && this.state === 'online' && this.guests.get(p.guestId)?.status === 'admitted' && p.status === 'processing' });
      p.status = 'accepted'; p.turnId = result?.turnId;
    } catch (error) { p.status = error.code === 'SUBMISSION_REVOKED' ? 'rejected' : 'unknown'; /* uncertain outcomes must not be retried automatically */ }
    p.text = '';
    this.proposalStatus(p); this.emit('change');
  }
  rememberDeparture(guest) {
    if (!guest?.resumeHash) return;
    this.departedGuests.set(guest.id, guest.resumeHash);
    if (this.departedGuests.size > 256) this.departedGuests.delete(this.departedGuests.keys().next().value);
  }
  guestHash(id) { return this.guests.get(id)?.resumeHash ?? this.departedGuests.get(id); }
  removeGuest(id, notifyRelay = true, { forget = true } = {}) {
    const guest = this.guests.get(id);
    const hash = this.guestHash(id);
    if (forget && hash) {
      this.permissions?.forget(this.admissionScope, hash);
      for (const current of this.guests.values()) {
        if (current.id !== id && current.resumeHash === hash) this.removeGuest(current.id, true, { forget: false });
      }
    }
    this.rememberDeparture(guest);
    if (notifyRelay) send(this.ws, { type: 'revoke', guestId: id }); this.guests.delete(id);
    for (const p of this.proposals.values()) if (p.guestId === id) {
      if (p.status === 'pending') { p.status = 'rejected'; p.text = ''; }
      else if (p.status === 'processing') p.status = 'unknown';
    }
    this.emit('change');
  }
  view() {
    return { roomId: this.roomId, threadId: this.threadId, ownerName: this.ownerName, requireApproval: this.requireApproval, title: this.thread?.snapshot?.title ?? '共享会话', state: this.state, endReason: this.endReason, startedAt: this.startedAt, expiresAt: this.expiresAt, renewalSupported: this.renewalSupported,
      inviteUrl: `${this.relayUrl}/#room=${this.roomId}&invite=${this.inviteToken}${this.admissionScope ? `&scope=${this.admissionScope}` : ''}`, guests: [...this.guests.values()],
      proposals: [...this.proposals.values()].filter(p => ['pending', 'processing'].includes(p.status)).concat([...this.proposals.values()].filter(p => !['pending', 'processing'].includes(p.status)).slice(-20)).map(({executionId, ...p}) => ({...p, text: ['pending','processing'].includes(p.status) ? p.text : ''})), approvalPending: Boolean(this.approvalPending), lastError: this.lastError ?? null };
  }
  close({ preserveAdmissions = false, reason } = {}) {
    if (this.closed) return; this.closed = true; this.state = 'revoked';
    this.endReason = reason;
    if (!preserveAdmissions) this.permissions?.revoke(this.admissionScope);
    else this.deliver({ type: 'share-paused' });
    clearTimeout(this.expiry); clearTimeout(this.reconnect); clearTimeout(this.snapshotTimer);
    clearTimeout(this.renewalTimer); clearTimeout(this.renewalAckTimer); this.pendingRenewal = null;
    clearInterval(this.heartbeatWatch);
    for (const p of this.proposals.values()) {
      if (p.status === 'pending') p.status = 'rejected';
      else if (p.status === 'processing') p.status = 'unknown';
      p.text = '';
    }
    this.approvalPending = false;
    send(this.ws, { type: 'revoke' }); this.ws?.close(); this.thread?.close();
    if (this.onRpcEvent) this.rpc?.off('notification', this.onRpcEvent);
    this.rpc?.close();
    for (const guest of this.guests.values()) this.rememberDeparture(guest);
    this.guests.clear(); this.emit('change');
  }
}

export async function startOwner({ socketPath, relayUrl, ensureRelay, registrationSecret, ownerDir, port = 0, rpcFactory = RpcClient.connect,
  listThreads, selectThread, attached = false, history, authorHistory = createMessageAuthorHistory(), managerSettings = createManagerSettings(), permissions = new GuestPermissions(), connection = { state: 'not-started' }, checkConnection, rebuildRelay, onDiagnostic, onState = () => {} }) {
  const ownerToken = secret(); const connections = new Set(); const rooms = new Map();
  const pendingThreads = new Set();
  let sharingGeneration = 0;
  let closed = false;
  let baseUrl;
  const types = { '/': ['index.html', 'text/html; charset=utf-8'], '/owner.js': ['owner.js', 'text/javascript; charset=utf-8'], '/owner.css': ['owner.css', 'text/css; charset=utf-8'],
    '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/locales.json': ['locales.json', 'application/json; charset=utf-8'] };
  const localHost = req => req.headers.host === `127.0.0.1:${server.address().port}` || req.headers.host === `localhost:${server.address().port}`;
  const server = http.createServer(async (req, res) => {
    if (!localHost(req)) { res.writeHead(403).end(); return; }
    const resource = types[req.url];
    if (req.method !== 'GET' || !resource) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': resource[1], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:${server.address().port} ws://localhost:${server.address().port}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
    try { res.end(await fs.readFile(path.join(ownerDir, resource[0]))); } catch { res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!localHost(req) || req.url !== '/owner' || req.headers.origin !== `http://${req.headers.host}`) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const state = () => {
    const current = { type: 'state', attached, connection, settings: managerSettings.get(), history: history?.list() ?? [], historyFailed: history?.failed ?? false, authorHistoryFailed: authorHistory.failed,
      rooms: [...rooms.values()].reverse().sort((a, b) => b.startedAt - a.startedAt).map(r => r.view()) };
    return { ...current, attention: attentionFor(current) };
  };
  const threadPage = async options => {
    const result = await listThreads(options);
    return Array.isArray(result) ? { threads: result, total: result.length, nextCursor: null } : result;
  };
  const broadcast = () => {
    const current = state();
    for (const ws of connections) send(ws, current);
    const active = current.rooms.filter(r => r.state !== 'revoked');
    onState({ rooms: active.length, attention: current.attention,
      pending: active.reduce((n, r) => n + r.guests.filter(g => g.status === 'pending').length + r.proposals.filter(p => p.status === 'pending').length, 0) });
  };
  wss.on('connection', ws => {
    let authenticated = false;
    const timer = setTimeout(() => ws.close(1008), 5000);
    ws.on('message', async bytes => {
      let m;
      try { m = JSON.parse(bytes); } catch { return ws.close(1008); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return ws.close(1008);
      if (!authenticated) {
        if (m.type !== 'auth' || !equal(m.token, ownerToken)) return ws.close(1008);
        authenticated = true; clearTimeout(timer); connections.add(ws); send(ws, state()); return;
      }
      try {
        if (m.type === 'set-share-limit') {
          await managerSettings.setShareLimit(m.shareLimit);
          broadcast(); send(ws, { type: 'settings-result', settings: managerSettings.get() });
        } else if (m.type === 'check-connection' && checkConnection) {
          await checkConnection(); send(ws, { type: 'connection-result' });
        } else if (m.type === 'rebuild-relay' && rebuildRelay) {
          await rebuildRelay(); send(ws, { type: 'connection-result', rebuilt: true });
        } else if (m.type === 'dismiss-room') {
          if (typeof m.roomId !== 'string' || !m.roomId || m.roomId.length > 128
            || Object.keys(m).some(key => !['type', 'roomId'].includes(key))) throw new Error('无效的共享标识');
          const room = rooms.get(m.roomId);
          if (room && !room.closed) throw new Error('共享尚未结束，无法移除');
          rooms.delete(m.roomId); broadcast();
        } else if (m.type === 'select-thread' && selectThread) {
          if (typeof m.threadId !== 'string' || m.threadId.length > 100) throw new Error('请填写有效的 Codex 会话 ID');
          await selectThread(m.threadId.trim());
          send(ws, { type: 'threads', attached, selectedThreadId: m.threadId.trim(), ...await threadPage() });
        } else if (m.type === 'threads' && listThreads) {
          const cursor = m.cursor ?? 0, search = m.search ?? '';
          if (!Number.isSafeInteger(cursor) || cursor < 0 || typeof search !== 'string' || search.length > 200) throw new Error('无效的会话列表查询');
          send(ws, { type: 'threads', attached, cursor, search, ...await threadPage({ cursor, search }) });
        } else if (m.type === 'threads') {
          const rpc = await rpcFactory(socketPath);
          try { const data = await rpc.request('thread/list', { limit: 50 }); send(ws, { type: 'threads', threads: data.data.map(t => ({ id: t.id, name: t.name || t.preview?.slice(0, 80) || '未命名会话' })) }); }
          finally { rpc.close(); }
        } else if (m.type === 'share' || m.type === 'reshare') {
          if (m.type === 'reshare') {
            if (pendingThreads.has(m.threadId)) throw new Error('此会话正在重新分享，请等待完成');
            const saved = history?.list().find(entry => entry.threadId === m.threadId);
            if (!saved) throw new Error('没有找到分享历史，请从会话列表重新选择');
            // Restoring history is a local gesture, not automatic reauthorization.
            for (const room of rooms.values()) if (!room.closed && room.threadId === saved.threadId) {
              if (room.state === 'online') throw new Error('会话仍在共享，请复制当前邀请');
              room.close({ preserveAdmissions: true });
            }
            m.ownerName = saved.ownerName; m.requireApproval = saved.requireApproval;
          }
          if (m.requireApproval !== undefined && typeof m.requireApproval !== 'boolean') throw new Error('消息审批设置必须为布尔值');
          if (!displayName(m.ownerName ?? '分享者')) throw new Error('请填写 1–40 个字符的显示名称');
          if (typeof m.threadId !== 'string') throw new Error('请选择尚未共享的会话');
          if (pendingThreads.has(m.threadId) || [...rooms.values()].some(r => !r.closed && r.threadId === m.threadId)) throw new Error('请选择尚未共享的会话');
          const { shareLimit } = managerSettings.get();
          const sharingCount = new Set([...pendingThreads, ...[...rooms.values()].filter(r => !r.closed).map(r => r.threadId)]).size;
          if (shareLimit !== null && sharingCount >= shareLimit) throw Object.assign(new Error('已达到同时共享上限（{limit} 条）'),
            { code: 'SHARE_LIMIT_REACHED', values: { limit: shareLimit } });
          pendingThreads.add(m.threadId);
          const generation = sharingGeneration;
          try {
          if (selectThread) await selectThread(m.threadId, { activate: true,
            canContinue: () => !closed && generation === sharingGeneration && ws.readyState === WebSocket.OPEN });
          else if (listThreads && !(await threadPage()).threads.some(t => t.id === m.threadId)) throw new Error('请选择列表中的会话');
          if (closed || generation !== sharingGeneration || ws.readyState !== WebSocket.OPEN) throw new Error('本次共享已取消，请重新操作');
          const activeRelay = ensureRelay ? await ensureRelay() : relayUrl;
          if (closed || generation !== sharingGeneration || ws.readyState !== WebSocket.OPEN) throw new Error('本次共享已取消，请重新操作');
          const room = new SharedRoom({ socketPath, threadId: m.threadId, permissions, authorHistory, inheritAdmissions: m.type === 'reshare', ownerName: m.ownerName, requireApproval: m.requireApproval, relayUrl: activeRelay, registrationSecret, rpcFactory, onDiagnostic,
            canRenew: () => !closed && ['online', 'local'].includes(connection.state) });
          let historyKey;
          const remember = () => {
            if (!room.historyStarted) return;
            const title = (room.thread?.snapshot?.title ?? '共享会话').slice(0, 300);
            const key = JSON.stringify([title, room.requireApproval]);
            if (key !== historyKey) {
              historyKey = key;
              history?.remember({ threadId: room.threadId, title, ownerName: room.ownerName,
                requireApproval: room.requireApproval, lastSharedAt: room.startedAt });
            }
          };
          room.on('change', () => { remember(); broadcast(); }); rooms.set(room.roomId, room);
          try { await room.start(); } catch (error) {
            rooms.delete(room.roomId);
            if (['DESKTOP_IPC_TIMEOUT', 'DESKTOP_NO_OWNER'].includes(error.code)) throw error;
            throw new Error('共享失败：请确认会话已有首轮记录，且公网中继可连接');
          }
          if (closed || generation !== sharingGeneration || ws.readyState !== WebSocket.OPEN || room.closed) {
            room.close(); throw new Error('本次共享已取消，请重新操作');
          }
          room.historyStarted = true; remember(); await history?.flush();
          if (closed || generation !== sharingGeneration || room.closed) throw new Error('本次共享已取消，请重新操作');
          broadcast();
          send(ws, { type: 'share-result', threadId: m.threadId, roomId: room.roomId, restored: m.type === 'reshare' });
          } finally { pendingThreads.delete(m.threadId); }
        } else {
          const room = rooms.get(m.roomId); if (!room) throw new Error('共享不存在');
          if (m.type === 'set-message-policy') room.setRequireApproval(m.requireApproval);
          else if (m.type === 'admit') room.admit(m.guestId, true);
          else if (m.type === 'deny') room.admit(m.guestId, false);
          else if (m.type === 'approve') await room.decide(m.proposalId, true);
          else if (m.type === 'reject') await room.decide(m.proposalId, false);
          else if (m.type === 'remove-guest') {
            const hash = room.guestHash(m.guestId);
            room.removeGuest(m.guestId);
            if (hash) for (const other of rooms.values()) {
              if (other !== room && other.admissionScope === room.admissionScope) {
                for (const guest of other.guests.values()) if (guest.resumeHash === hash) other.removeGuest(guest.id);
              }
            }
          }
          else if (m.type === 'revoke') room.close();
          else throw new Error('不支持的操作');
        }
      } catch (error) {
        if (['DESKTOP_IPC_TIMEOUT', 'DESKTOP_NO_OWNER'].includes(error.code)) {
          // Structural diagnostics only: no request params, text, titles or capabilities.
          try { onDiagnostic?.({ event: 'desktop-ipc-failure', operation: m.type, code: error.code,
            method: error.method ?? 'thread-owner-discovery', phase: error.phase ?? 'routing', elapsedMs: error.elapsedMs }); } catch {}
        }
        send(ws, { type: 'error', operation: m.type, message: error.message,
          ...(error.code === 'SHARE_LIMIT_REACHED' ? { code: error.code, values: error.values } : {}) });
      }
    });
    ws.on('error', () => {}); ws.on('close', () => { clearTimeout(timer); connections.delete(ws); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { url: `${baseUrl}/#owner=${ownerToken}`, baseUrl, rooms,
    setConnection(value) { connection = value; broadcast(); for (const room of rooms.values()) room.maybeRenew(); },
    checkConnections() { for (const room of rooms.values()) { room.checkConnection(); room.maybeRenew(); } },
    revokeAll() { sharingGeneration++; permissions.clear(); for (const room of rooms.values()) room.close(); broadcast(); },
    pauseAll() { sharingGeneration++; for (const room of rooms.values()) room.close({ preserveAdmissions: true, reason: 'paused' }); broadcast(); },
    async close() { closed = true; for (const room of rooms.values()) room.close({ preserveAdmissions: true }); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); } };
}
