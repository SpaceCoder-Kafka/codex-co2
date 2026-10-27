import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { displayName } from './display-name.mjs';
import { privateIPv4, lanRequestAllowed } from './lan-network.mjs';

const markdownPath = createRequire(import.meta.url).resolve('markdown-it/browser');

const DAY = 24 * 60 * 60 * 1000;
const expired = (room, now = Date.now()) => room.expiresAt <= now || (room.inviteExpiresAt != null && room.inviteExpiresAt <= now);
const MAX_BUFFER = 1024 * 1024;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const digest = value => createHash('sha256').update(value).digest();
const matches = (value, hash) => token(value) && timingSafeEqual(digest(value), hash);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => record(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(message);
  if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
    ws.close(1013, 'Slow connection');
    return false;
  }
  ws.send(data);
  return true;
}

function finish(ws, type, code = 1008) {
  send(ws, { type });
  ws.close(code, type);
}

/** Single-process feasibility relay. It retains room authorization, never transcripts. */
export async function startRelay({ host = '127.0.0.1', port = 0, registrationSecret, publicDir, allowedOrigins, lanAddress, lanListenPort = 0, recovery,
  createHttpServer = http.createServer }) {
  if (!token(registrationSecret)) throw new Error('registrationSecret must be a 32-byte base64url secret');
  if (!Number.isInteger(lanListenPort) || (lanListenPort !== 0 && (lanListenPort < 1024 || lanListenPort > 65535))
    || (lanListenPort !== 0 && !lanAddress)) throw new Error('Invalid fixed LAN listener port');
  if (lanAddress !== undefined && (!privateIPv4(lanAddress) || host !== '127.0.0.1' || allowedOrigins !== undefined)) {
    throw new Error('LAN relay requires a private IPv4 address, a loopback host listener and a fixed guest origin');
  }
  const registrationHash = digest(registrationSecret);
  registrationSecret = undefined;
  const origins = new Set();
  let inviteOrigin, lanPort;
  const setAllowedOrigins = values => {
    if (!Array.isArray(values) || values.length > 16) throw new Error('Invalid allowedOrigins');
    if (lanAddress && (values.length !== 1 || values[0] !== inviteOrigin)) throw new Error('LAN guest origin is fixed to its private listener');
    const validated = [];
    for (const origin of values) {
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Invalid allowed origin');
      validated.push(origin);
    }
    origins.clear();
    for (const origin of validated) origins.add(origin);
  };
  if (allowedOrigins !== undefined) setAllowedOrigins(allowedOrigins);
  const rooms = new Map();
  const tombstones = new Map();
  const clients = new Set();
  const recoveryClients = new Set();
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/guest.js': ['guest.js', 'text/javascript; charset=utf-8'], '/images.js': ['images.js', 'text/javascript; charset=utf-8'], '/notifications.js': ['notifications.js', 'text/javascript; charset=utf-8'], '/notification-worker.js': ['notification-worker.js', 'text/javascript; charset=utf-8'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/vendor/markdown-it.min.js': [markdownPath, 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  files['/invite-recovery.js'] = ['invite-recovery.js', 'text/javascript; charset=utf-8'];
  let server, lanServer;
  const loopbackRequest = req => ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && req.headers.host === `127.0.0.1:${server.address()?.port}`;
  const handleRequest = async (req, res, lan = false) => {
    if (lanAddress && (lan ? !lanRequestAllowed(req, { address: lanAddress, port: lanPort })
      : !loopbackRequest(req) || req.url !== '/health')) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const websocketSources = [...origins].map(origin => origin.replace(/^http/, 'ws')).join(' ');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self' ${websocketSources}; img-src 'self' data: https: http:; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
      return;
    }
    const file = Object.hasOwn(files, req.url) ? files[req.url] : null;
    if (!file || !publicDir) { res.writeHead(404); res.end(); return; }
    try {
      const contents = await fs.readFile(req.url === '/vendor/markdown-it.min.js' ? markdownPath : path.join(publicDir, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch { res.writeHead(404); res.end(); }
  };
  server = createHttpServer((req, res) => { void handleRequest(req, res); });
  if (lanAddress) lanServer = createHttpServer((req, res) => { void handleRequest(req, res, true); });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const upgrade = (req, socket, head, lan = false) => {
    const isRecovery = req.url === '/recovery';
    const guest = req.url === '/guest' || isRecovery;
    const networkDenied = lanAddress && (lan
      ? !guest || !lanRequestAllowed(req, { address: lanAddress, port: lanPort })
      : guest || !loopbackRequest(req));
    if (networkDenied || (isRecovery && !recovery) || (!guest && req.url !== '/host') || (guest && !origins.has(req.headers.origin)) || (!guest && req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, guest, isRecovery, req.headers.origin));
  };
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
  lanServer?.on('upgrade', (req, socket, head) => upgrade(req, socket, head, true));

  const forgetGuest = (room, guestId, guest) => {
    if (room.guests.get(guestId) !== guest) return;
    room.guests.delete(guestId);
    if (room.host) send(room.host, { type: 'guest-left', guestId });
  };
  const closeGuests = (room, type) => {
    for (const guest of room.guests.values()) finish(guest.ws, type);
    room.guests.clear();
  };
  const destroyRoom = (roomId, room, type) => {
    closeGuests(room, type);
    if (room.host) finish(room.host, type);
    room.host = null;
    rooms.delete(roomId);
    tombstones.set(roomId, room.expiresAt);
  };

  const recoveryConnection = (ws, origin) => {
    if (recoveryClients.size >= 64) { finish(ws, 'capacity-reached', 1013); return; }
    recoveryClients.add(ws);
    let readResult = null, previousResult = '', windowStart = Date.now(), count = 0, authenticated = false;
    const timer = setTimeout(() => finish(ws, 'authentication-timeout'), 10_000);
    timer.unref();
    const publish = () => {
      if (!readResult || ws.readyState !== WebSocket.OPEN) return;
      try {
        const result = readResult(), serialized = JSON.stringify(result);
        if (serialized !== previousResult) { previousResult = serialized; send(ws, result); }
      } catch { finish(ws, 'recovery-unavailable', 1011); }
    };
    recovery.on('change', publish);
    ws.once('close', () => { clearTimeout(timer); recovery.off('change', publish); recoveryClients.delete(ws); });
    ws.on('message', (bytes, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (binary || bytes.length > 4096) { finish(ws, 'invalid-message'); return; }
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { finish(ws, 'invalid-message'); return; }
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
      if (++count > 60) { finish(ws, 'rate-limited'); return; }
      try {
      let result;
      if (message?.type === 'ping' && exact(message, ['type']) && authenticated) { send(ws, { type: 'pong' }); return; }
      // A new query replaces this connection's prior receipt subscription.
      readResult = null;
      if (message?.type === 'status' && exact(message, ['type', 'roomId', 'inviteToken'])
        && typeof message.roomId === 'string' && message.roomId.length <= 128 && token(message.inviteToken)) {
        result = recovery.status(message, origin);
        // Recovery bookkeeping is bounded independently of live collaboration.
        // A room omitted because that bookkeeping is full still uses normal
        // guest admission; the invitation proof must match before saying so.
        const active = rooms.get(message.roomId);
        if (result.status === 'unavailable' && !recovery.persistenceError && active && !expired(active) && matches(message.inviteToken, active.inviteHash)) {
          result = { type: 'recovery-status', status: active.host?.readyState === WebSocket.OPEN ? 'active' : 'temporarily-offline' };
        }
      } else if (message?.type === 'request' && exact(message, ['type', 'roomId', 'inviteToken', 'requestId', 'receiptToken', 'visitorToken', 'name'])
        && typeof message.roomId === 'string' && message.roomId.length <= 128 && token(message.inviteToken)
        && uuid(message.requestId) && token(message.receiptToken) && token(message.visitorToken) && displayName(message.name)) {
        result = recovery.request(message, origin);
        if (result.status !== 'unavailable') readResult = recovery.watcher(message, origin);
      } else if (message?.type === 'watch' && exact(message, ['type', 'requestId', 'receiptToken'])
        && uuid(message.requestId) && token(message.receiptToken)) {
        result = recovery.watch(message, origin);
        if (result.status !== 'unavailable') readResult = recovery.watcher(message, origin);
      } else { finish(ws, 'invalid-message'); return; }
      if (result.status !== 'unavailable') { authenticated = true; clearTimeout(timer); }
      previousResult = result.type === 'recovery-request' ? JSON.stringify(result) : '';
      send(ws, result);
      } catch { finish(ws, 'recovery-unavailable', 1011); }
    });
  };

  wsServer.on('connection', (ws, isGuest, isRecovery, origin) => {
    if (clients.size >= 256) { ws.close(1013, 'Capacity reached'); return; }
    clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    if (isRecovery) {
      ws.once('close', () => clients.delete(ws));
      recoveryConnection(ws, origin);
      return;
    }
    let authenticated = false;
    let room;
    let roomId;
    let guestId;
    let guest;
    let windowStart = Date.now();
    let count = 0;
    const authTimer = setTimeout(() => finish(ws, 'authentication-timeout'), 10_000);
    authTimer.unref();
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(ws);
      if (!room) return;
      if (isGuest) forgetGuest(room, guestId, guest);
      else if (room.host === ws) { room.host = null; closeGuests(room, 'offline'); }
    });
    ws.on('message', (bytes, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (binary) { finish(ws, 'invalid-message'); return; }
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { finish(ws, 'invalid-message'); return; }
      if (!record(message)) { finish(ws, 'invalid-message'); return; }
      if (!authenticated) {
        if (isGuest) {
          if (!exact(message, ['type', 'roomId', 'inviteToken', 'name'], ['sessionId']) || message.type !== 'join'
            || !displayName(message.name)) { finish(ws, 'join-rejected'); return; }
          const candidate = rooms.get(message.roomId);
          if (!candidate || !candidate.host || expired(candidate) || !matches(message.inviteToken, candidate.inviteHash)
            || candidate.guests.size >= 32) { finish(ws, 'join-rejected'); return; }
          room = candidate;
          roomId = message.roomId;
          guestId = randomUUID();
          guest = { ws, name: displayName(message.name), admitted: false, requests: new Set(), proposalTimes: [] };
          room.guests.set(guestId, guest);
          authenticated = true;
          clearTimeout(authTimer);
          send(ws, { type: 'pending', guestId, heartbeat: true });
          send(room.host, { type: 'join-request', guestId, name: guest.name,
            ...(token(message.sessionId) ? { resumeHash: createHash('sha256').update(message.sessionId).digest('base64url') } : {}) });
        } else {
          if (!exact(message, ['type', 'registrationSecret', 'roomId', 'hostToken', 'inviteToken', 'expiresAt'], lanAddress ? ['inviteExpiresAt'] : []) || message.type !== 'register'
            || !matches(message.registrationSecret, registrationHash) || !token(message.hostToken) || !token(message.inviteToken)
            || typeof message.roomId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(message.roomId)
            || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= Date.now() || message.expiresAt > Date.now() + DAY
            || (lanAddress && (!Object.hasOwn(message, 'inviteExpiresAt') || (message.inviteExpiresAt !== null
              && (!Number.isSafeInteger(message.inviteExpiresAt) || message.inviteExpiresAt <= Date.now()
                || message.inviteExpiresAt > Date.now() + 7 * DAY || message.expiresAt > message.inviteExpiresAt))))
            || tombstones.has(message.roomId)) { finish(ws, 'registration-rejected'); return; }
          const previous = rooms.get(message.roomId);
          if (previous && (previous.host || expired(previous) || !matches(message.hostToken, previous.hostHash)
            || !matches(message.inviteToken, previous.inviteHash)
            || (lanAddress && message.inviteExpiresAt !== previous.inviteExpiresAt)
            || (message.expiresAt !== previous.expiresAt && message.expiresAt !== previous.lastRenewal?.previousExpiresAt))) {
            finish(ws, 'registration-rejected'); return;
          }
          if (!previous && rooms.size + tombstones.size >= 128) { finish(ws, 'capacity-reached'); return; }
          roomId = message.roomId;
          room = previous || { hostHash: digest(message.hostToken), inviteHash: digest(message.inviteToken), expiresAt: message.expiresAt, ...(lanAddress ? { inviteExpiresAt: message.inviteExpiresAt } : {}), guests: new Map() };
          room.host = ws;
          rooms.set(roomId, room);
          authenticated = true;
          clearTimeout(authTimer);
          send(ws, { type: 'registered', roomId, expiresAt: room.expiresAt, renewalSupported: true,
            ...(lanAddress ? { inviteExpiresAt: room.inviteExpiresAt } : {}) });
        }
        return;
      }
      if (expired(room)) { destroyRoom(roomId, room, 'expired'); return; }
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
      if (++count > (isGuest ? 120 : 12_000)) { finish(ws, 'rate-limited'); return; }
      // Application heartbeat for browser clients, including pending admission.
      // No transcript, execution capability or authorization is granted by it.
      if (isGuest && message.type === 'ping' && exact(message, ['type'])) { send(ws, { type: 'pong' }); return; }
      if (isGuest) {
        if (!guest.admitted || !room.host || room.guests.get(guestId) !== guest) { finish(ws, 'not-admitted'); return; }
        if (message.type === 'snapshot-request' && exact(message, ['type'])) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'image-request' && exact(message, ['type', 'imageId'])
          && typeof message.imageId === 'string' && /^[a-f0-9]{64}$/.test(message.imageId)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'file-request' && exact(message, ['type', 'fileId'])
          && typeof message.fileId === 'string' && /^[a-f0-9]{64}$/.test(message.fileId)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'proposal' && exact(message, ['type', 'requestId', 'text']) && uuid(message.requestId)
          && typeof message.text === 'string' && message.text.trim() && message.text.length <= 8000) {
          if (guest.requests.has(message.requestId)) { send(ws, { type: 'duplicate', requestId: message.requestId }); return; }
          const now = Date.now();
          guest.proposalTimes = guest.proposalTimes.filter(time => now - time < 60_000);
          if (guest.proposalTimes.length >= 20 || guest.requests.size >= 256) { finish(ws, 'rate-limited'); return; }
          guest.proposalTimes.push(now);
          guest.requests.add(message.requestId);
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else finish(ws, 'invalid-message');
        return;
      }
      if (room.host !== ws || rooms.get(roomId) !== room) { finish(ws, 'not-authorized'); return; }
      if (message.type === 'renew') {
        if (!exact(message, ['type', 'requestId', 'previousExpiresAt', 'expiresAt']) || !uuid(message.requestId)
          || !Number.isSafeInteger(message.previousExpiresAt) || !Number.isSafeInteger(message.expiresAt)) {
          finish(ws, 'invalid-message'); return;
        }
        const previous = room.lastRenewal;
        if (previous?.requestId === message.requestId) {
          if (previous.previousExpiresAt !== message.previousExpiresAt || previous.expiresAt !== message.expiresAt) {
            finish(ws, 'invalid-message'); return;
          }
        } else {
          if (message.previousExpiresAt !== room.expiresAt || message.expiresAt <= room.expiresAt
            || message.expiresAt > Date.now() + DAY || (room.inviteExpiresAt != null && message.expiresAt > room.inviteExpiresAt)) { finish(ws, 'invalid-message'); return; }
          // Commit once before acknowledging. Retain only the latest transition
          // so a host that lost the ACK can reconcile its old lease on reconnect.
          room.lastRenewal = { requestId: message.requestId, previousExpiresAt: message.previousExpiresAt, expiresAt: message.expiresAt };
          room.expiresAt = message.expiresAt;
        }
        send(ws, { type: 'renewed', roomId, requestId: message.requestId, expiresAt: room.expiresAt });
      } else if (['admit', 'deny'].includes(message.type) && exact(message, ['type', 'guestId'])) {
        const selected = room.guests.get(message.guestId);
        if (!selected) return;
        if (message.type === 'admit') { selected.admitted = true; send(selected.ws, { type: 'admitted', guestId: message.guestId }); }
        else { room.guests.delete(message.guestId); finish(selected.ws, 'denied'); }
      } else if (message.type === 'deliver' && exact(message, ['type', 'payload'], ['guestId']) && record(message.payload)
        && (message.guestId === undefined || typeof message.guestId === 'string')) {
        const targets = message.guestId === undefined ? room.guests.values() : [room.guests.get(message.guestId)];
        for (const selected of targets) if (selected?.admitted) send(selected.ws, { type: 'data', payload: message.payload });
      } else if (message.type === 'revoke' && exact(message, ['type'], recovery ? ['guestId', 'reason'] : ['guestId'])
        && (message.guestId === undefined || typeof message.guestId === 'string')
        && (message.reason === undefined || (message.guestId === undefined && ['expired', 'interrupted', 'paused'].includes(message.reason)))) {
        if (message.guestId === undefined) destroyRoom(roomId, room, message.reason ?? 'revoked');
        else {
          const selected = room.guests.get(message.guestId);
          if (selected) { room.guests.delete(message.guestId); finish(selected.ws, 'revoked'); }
        }
      } else finish(ws, 'invalid-message');
    });
  });
  const maintenance = setInterval(() => {
    for (const [roomId, room] of rooms) if (expired(room)) destroyRoom(roomId, room, 'expired');
    for (const [roomId, expiry] of tombstones) if (expiry <= Date.now()) tombstones.delete(roomId);
  }, 1000);
  maintenance.unref();
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const listen = (listener, listenPort, address) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(listenPort, address, () => { listener.removeListener('error', reject); resolve(); });
  });
  const closeServer = listener => listener && new Promise(resolve => {
    listener.close(() => resolve()); listener.closeAllConnections?.();
  });
  try {
    await listen(server, port, host);
    if (lanServer) {
      await listen(lanServer, lanListenPort, lanAddress);
      lanPort = lanServer.address().port;
      inviteOrigin = `http://${lanAddress}:${lanPort}`;
      setAllowedOrigins([inviteOrigin]);
    }
  } catch (error) {
    clearInterval(maintenance); clearInterval(heartbeat);
    await Promise.all([closeServer(server), closeServer(lanServer)]);
    await new Promise(resolve => wsServer.close(resolve));
    throw error;
  }
  const actualPort = server.address().port;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}`;
  if (!lanAddress && allowedOrigins === undefined) origins.add(url);
  inviteOrigin ??= url;
  let closed = false;
  return {
    server, url, port: actualPort, inviteOrigin, lanServer, setAllowedOrigins,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      clearInterval(heartbeat);
      for (const ws of clients) ws.terminate();
      await new Promise(resolve => wsServer.close(resolve));
      await Promise.all([closeServer(server), closeServer(lanServer)]);
      rooms.clear(); tombstones.clear();
    },
  };
}
