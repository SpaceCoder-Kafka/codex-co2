import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { loadWebAssets } from './web-assets.mjs';
import { displayName } from './display-name.mjs';
import { privateIPv4, validLanHostname, lanRequestAllowed, lanEntryHostname } from './lan-network.mjs';
import { serveLanEntry, serveLanEntryProbe } from './lan-entry.mjs';
import { uploadMessage, uploadIds } from './guest-uploads.mjs';
import { importAssetPath, importClaimPath, importTicketPattern, importManifestFromGuestView, importSnapshotFromGuestView, importWindowChunks } from './import-handoff.mjs';
import { IMAGE_CHUNK_BYTES, MAX_IMAGE_BYTES } from './thread-images.mjs';
import { MAX_FILE_BYTES } from './thread-files.mjs';

const markdownPath = createRequire(import.meta.url).resolve('markdown-it/browser');

const DAY = 24 * 60 * 60 * 1000;
const expired = (room, now = Date.now()) => room.expiresAt <= now || (room.inviteExpiresAt != null && room.inviteExpiresAt <= now);
const MAX_BUFFER = 1024 * 1024;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const digest = value => createHash('sha256').update(value).digest();
const matches = (value, hash) => token(value) && timingSafeEqual(digest(value), hash);
const matchesInvitation = (value, room) => matches(value, room.inviteHash)
  || Boolean(room.originalInviteHash && matches(value, room.originalInviteHash));
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

function finishImportAsset(transfer, status) {
  const active = transfer?.active;
  if (!active) return;
  transfer.active = null;
  clearTimeout(active.timeout);
  if (status !== 200) active.control('import-asset-cancel');
  const response = active.response;
  if (response.destroyed || response.writableEnded) return;
  if (status === 200) {
    transfer.assets.delete(active.id);
    response.end();
  }
  else if (response.headersSent) response.destroy(); // A truncated original must never look complete.
  else response.writeHead(status).end();
}

function receiveImportAsset(transfer, payload) {
  const active = transfer.active;
  const { id, kind, index, response } = active;
  if (payload[kind + 'Id'] !== id || (kind === 'file' && payload.representation !== 'original'))
    return finishImportAsset(transfer, 502);
  if (payload.type === kind + '-unavailable') return finishImportAsset(transfer, 404);
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  const { data, total } = payload;
  if (payload.type !== kind + '-chunk' || payload.index !== index || !Number.isInteger(total)
    || total < 1 || total > Math.ceil(limit / IMAGE_CHUNK_BYTES) || (index > 0 && total !== active.total)
    || typeof data !== 'string' || data.length > 4 * Math.ceil(IMAGE_CHUNK_BYTES / 3)) return finishImportAsset(transfer, 502);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || (index < total - 1 && bytes.length !== IMAGE_CHUNK_BYTES)
    || (!bytes.length && (total !== 1 || kind !== 'file')) || index * IMAGE_CHUNK_BYTES + bytes.length > limit)
    return finishImportAsset(transfer, 502);
  // The host waits at each window boundary. Reject excessive buffering even if a sender ignores this.
  if (response.writableLength + bytes.length > MAX_BUFFER) return finishImportAsset(transfer, 503);
  if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  response.write(bytes);
  if (index + 1 === total) return finishImportAsset(transfer, 200);
  active.index++;
  active.total = total;
  active.timeout.refresh();
  if (active.index % importWindowChunks === 0) {
    const acknowledge = () => { if (transfer.active === active) active.control('import-asset-ack', { index }); };
    if (response.writableNeedDrain) response.once('drain', acknowledge);
    else acknowledge();
  }
}

function clearGuestImports(guest) {
  clearOffer(guest);
  if (guest.importTransfer) {
    finishImportAsset(guest.importTransfer, 410);
    clearTimeout(guest.importTransfer.timeout);
    guest.importTransfer = null;
  }
}

function clearOffer(guest, status = 410) {
  const offer = guest?.importOffer;
  if (!offer) return;
  guest.importOffer = null;
  clearTimeout(offer.timeout);
  if (offer.response && !offer.response.writableEnded && !offer.response.destroyed) offer.response.writeHead(status).end();
}

function createImportManifest(guest, payload) {
  const manifest = importManifestFromGuestView(payload);
  const assets = new Map();
  for (const message of manifest.messages) {
    for (const ref of message.attachments ?? []) {
      if (!ref.unavailable && !ref.remoteUrl && ['image', 'file'].includes(ref.kind) && importTicketPattern.test(ref.id))
        assets.set(ref.id, ref.kind);
    }
  }
  if (!assets.size) return manifest;
  const transferToken = randomBytes(32).toString('hex');
  const lifetime = 5 * 60 * 1000;
  const transfer = { verifier: digest(transferToken), origin: guest.importOffer.origin, expires: Date.now() + lifetime, assets };
  transfer.timeout = setTimeout(() => { if (guest.importTransfer === transfer) clearGuestImports(guest); }, lifetime).unref();
  guest.importTransfer = transfer;
  return { ...manifest, transferToken };
}

/** Single-process feasibility relay. It retains room authorization, never transcripts. */
export async function startRelay({ host = '127.0.0.1', port = 0, registrationSecret, publicDir, allowedOrigins, lanAddress, lanHostname, lanListenPort = 0, recovery, resumeLanRoom,
  createHttpServer = http.createServer }) {
  if (!token(registrationSecret)) throw new Error('registrationSecret must be a 32-byte base64url secret');
  if (!Number.isInteger(lanListenPort) || (lanListenPort !== 0 && (lanListenPort < 1024 || lanListenPort > 65535))
    || (lanListenPort !== 0 && !lanAddress)) throw new Error('Invalid fixed LAN listener port');
  if (lanAddress !== undefined && (!privateIPv4(lanAddress) || host !== '127.0.0.1' || allowedOrigins !== undefined)) {
    throw new Error('LAN relay requires a private IPv4 address, a loopback host listener and a fixed guest origin');
  }
  if (lanHostname != null && (!lanAddress || !validLanHostname(lanHostname))) throw new Error('Invalid LAN guest hostname');
  const registrationHash = digest(registrationSecret);
  registrationSecret = undefined;
  const origins = new Set();
  let inviteOrigin, guestOrigin, entryOrigin, lanPort;
  const probeId = lanAddress && randomUUID();
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
    if (lanHostname) origins.add(guestOrigin);
  };
  if (allowedOrigins !== undefined) setAllowedOrigins(allowedOrigins);
  const setLanHostname = (name, entry = null) => {
    if (!lanAddress || (name != null && !validLanHostname(name))) throw new Error('Invalid LAN guest hostname');
    if (entry != null && entry !== lanEntryHostname(name, lanAddress)) throw new Error('Invalid LAN entry hostname');
    lanHostname = name;
    guestOrigin = `http://${name ?? lanAddress}:${lanPort}`;
    entryOrigin = entry ? `http://${entry}:${lanPort}` : null;
    setAllowedOrigins([inviteOrigin]);
  };
  const rooms = new Map();
  const tombstones = new Map();
  const restarting = new Map();
  const clients = new Set();
  const recoveryClients = new Set();
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/guest.js': ['guest.js', 'text/javascript; charset=utf-8'], '/images.js': ['images.js', 'text/javascript; charset=utf-8'], '/notifications.js': ['notifications.js', 'text/javascript; charset=utf-8'], '/notification-worker.js': ['notification-worker.js', 'text/javascript; charset=utf-8'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/vendor/markdown-it.min.js': [markdownPath, 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  if (publicDir) Object.assign(files, await loadWebAssets(publicDir));
  files['/invite-recovery.js'] = ['invite-recovery.js', 'text/javascript; charset=utf-8'];
  let server, lanServer;
  const loopbackRequest = req => ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && req.headers.host === `127.0.0.1:${server.address()?.port}`;
  const claimGuestImport = (req, res) => {
    const origin = req.headers.origin;
    const bearer = /^Co2Import ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
    if (req.method !== 'POST' || !origins.has(origin) || !bearer) return res.writeHead(403).end();
    const verifier = digest(bearer[1]);
    for (const room of rooms.values()) {
      if (expired(room) || room.host?.readyState !== WebSocket.OPEN) continue;
      for (const [guestId, guest] of room.guests) {
        if (!guest.admitted || guest.ws.readyState !== WebSocket.OPEN) continue;
        if (req.url === importAssetPath) {
          const transfer = guest.importTransfer;
          if (!transfer || transfer.origin !== origin || transfer.expires <= Date.now()
            || !timingSafeEqual(transfer.verifier, verifier)) continue;
          const id = req.headers['x-co2-asset'];
          const kind = transfer.assets.get(id);
          if (!kind) return res.writeHead(404).end();
          if (transfer.active) return res.writeHead(409).end();
          const requestId = randomUUID(), host = room.host;
          const active = { requestId, id, kind, index: 0, response: res,
            control: (type, fields) => send(host, { type, guestId, importRequestId: requestId, ...fields }),
            timeout: setTimeout(() => finishImportAsset(transfer, 504), 20_000).unref() };
          transfer.active = active;
          res.once('close', () => { if (transfer.active === active) finishImportAsset(transfer, 410); });
          const payload = kind === 'file' ? { type: 'file-request', fileId: id, representation: 'original' }
            : { type: 'image-request', imageId: id };
          if (!send(host, { type: 'guest-message', guestId, importRequestId: requestId, payload }))
            finishImportAsset(transfer, 410);
          return;
        }
        const offer = guest.importOffer;
        if (!offer || offer.response
          || offer.origin !== origin || offer.expires <= Date.now() || !timingSafeEqual(offer.verifier, verifier)) continue;
        offer.response = res;
        if (req.headers['x-co2-import-version'] === '2') offer.requestId = randomUUID();
        offer.timeout = setTimeout(() => clearOffer(guest, 504), 9000);
        offer.timeout.unref();
        res.once('close', () => { if (guest.importOffer === offer) clearOffer(guest); });
        if (!send(room.host, { type: 'guest-message', guestId, ...(offer.requestId ? { importRequestId: offer.requestId } : {}),
          payload: { type: 'snapshot-request' } })) clearOffer(guest);
        else send(guest.ws, { type: 'import-claimed', ticket: bearer[1] });
        return;
      }
    }
    res.writeHead(410).end();
  };
  const handleRequest = async (req, res, lan = false) => {
    const origin = lan && 'http://' + req.headers.host;
    const entry = lan && entryOrigin && origin === entryOrigin;
    if (lanAddress && (lan ? !lanRequestAllowed(req, { address: lanAddress, port: lanPort, hostname: lanHostname, allowEntry: Boolean(entry) })
      : !loopbackRequest(req) || req.url !== '/health')) { res.writeHead(403).end(); return; }
    if (entry && req.url !== '/health') return serveLanEntry(req, res, { entryOrigin, canonicalOrigin: guestOrigin, probeId });
    if (req.url === '/lan-entry-check') {
      if (entryOrigin && origin === guestOrigin) return serveLanEntryProbe(req, res, { entryOrigin, probeId });
      res.writeHead(404).end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', req.url === '/vendor/rich-render.js' ? 'cross-origin' : 'same-origin');
    const websocketSources = lan ? `ws://${req.headers.host}` : [...origins].map(origin => origin.replace(/^http/, 'ws')).join(' ');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self' ${websocketSources}; img-src 'self' data: blob: https: http:; frame-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    if (req.url === '/rich-render.html') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    if (req.url === importClaimPath || req.url === importAssetPath) {
      if (lan && req.headers.origin !== origin) return res.writeHead(403).end();
      return claimGuestImport(req, res);
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
      return;
    }
    const file = Object.hasOwn(files, req.url) ? files[req.url] : null;
    if (!file || !publicDir) { res.writeHead(404); res.end(); return; }
    try {
      const contents = await fs.readFile(req.url === '/vendor/markdown-it.min.js' ? markdownPath : path.isAbsolute(file[0]) ? file[0] : path.join(publicDir, file[0]));
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
      ? !guest || !lanRequestAllowed(req, { address: lanAddress, port: lanPort, hostname: lanHostname }) || req.headers.origin !== `http://${req.headers.host}`
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
    clearGuestImports(guest);
    room.guests.delete(guestId);
    if (room.host) send(room.host, { type: 'guest-left', guestId });
  };
  const closeGuests = (room, type) => {
    for (const guest of room.guests.values()) { clearGuestImports(guest); finish(guest.ws, type); }
    room.guests.clear();
  };
  const destroyRoom = (roomId, room, type) => {
    closeGuests(room, type);
    if (room.host) finish(room.host, type);
    room.host = null;
    rooms.delete(roomId);
    tombstones.set(roomId, room.expiresAt);
  };

  const recoveryConnection = (ws, origin, browserOrigin) => {
    if (recoveryClients.size >= 64) { finish(ws, 'capacity-reached', 1013); return; }
    recoveryClients.add(ws);
    let readResult = null, previousResult = '', windowStart = Date.now(), count = 0, authenticated = false;
    const timer = setTimeout(() => finish(ws, 'authentication-timeout'), 10_000);
    timer.unref();
    // Recovery grants stay bound to the numeric listener. An approved link
    // goes back to the same trusted browser origin that opened this socket.
    const forBrowser = result => {
      if (origin === browserOrigin || !result.inviteUrl) return result;
      const url = new URL(result.inviteUrl);
      if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search) throw new Error('Invalid recovery invitation origin');
      return { ...result, inviteUrl: browserOrigin + '/' + url.hash };
    };
    const publish = () => {
      if (!readResult || ws.readyState !== WebSocket.OPEN) return;
      try {
        const result = forBrowser(readResult()), serialized = JSON.stringify(result);
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
        if (result.status === 'unavailable' && !recovery.persistenceError && active && !expired(active) && matchesInvitation(message.inviteToken, active)) {
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
      result = forBrowser(result);
      previousResult = result.type === 'recovery-request' ? JSON.stringify(result) : '';
      send(ws, result);
      } catch { finish(ws, 'recovery-unavailable', 1011); }
    });
  };

  wsServer.on('connection', (ws, isGuest, isRecovery, browserOrigin) => {
    if (clients.size >= 256) { ws.close(1013, 'Capacity reached'); return; }
    clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    const origin = lanAddress ? inviteOrigin : browserOrigin;
    if (isRecovery) {
      ws.once('close', () => clients.delete(ws));
      recoveryConnection(ws, origin, browserOrigin);
      return;
    }
    let authenticated = false, joining = false;
    let room;
    let roomId;
    let guestId;
    let guest;
    let windowStart = Date.now();
    let count = 0;
    let uploadWindow = Date.now(), uploadCount = 0;
    const authTimer = setTimeout(() => finish(ws, 'authentication-timeout'), 10_000);
    authTimer.unref();
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(ws);
      if (!room) return;
      if (isGuest) forgetGuest(room, guestId, guest);
      else if (room.host === ws) { room.host = null; closeGuests(room, 'offline'); }
    });
    ws.on('message', async (bytes, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (binary) { finish(ws, 'invalid-message'); return; }
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { finish(ws, 'invalid-message'); return; }
      if (!record(message)) { finish(ws, 'invalid-message'); return; }
      if (!authenticated) {
        if (isGuest) {
          if (!exact(message, ['type', 'roomId', 'inviteToken', 'name'], ['sessionId']) || message.type !== 'join'
            || !displayName(message.name)) { finish(ws, 'join-rejected'); return; }
          if (joining) { finish(ws, 'invalid-message'); return; }
          if (lanAddress && resumeLanRoom && (!rooms.has(message.roomId) || restarting.has(message.roomId))) {
            joining = true;
            let restored = false;
            try {
              if (recovery?.getRestartAuthorization(message, origin)) {
                let attempt = restarting.get(message.roomId);
                if (!attempt) {
                  attempt = Promise.resolve(resumeLanRoom(message, origin)).finally(() => restarting.delete(message.roomId));
                  restarting.set(message.roomId, attempt);
                }
                restored = await attempt;
              }
            } catch { /* Leave the manual recovery path available. */ }
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!restored) { finish(ws, 'join-rejected'); return; }
          }
          const candidate = rooms.get(message.roomId);
          if (!candidate || !candidate.host || expired(candidate) || !matchesInvitation(message.inviteToken, candidate)
            || candidate.guests.size >= 32) { finish(ws, 'join-rejected'); return; }
          room = candidate;
          roomId = message.roomId;
          guestId = randomUUID();
          const resumeHash = token(message.sessionId) ? createHash('sha256').update(message.sessionId).digest('base64url') : null;
          const sibling = resumeHash && [...room.guests.values()].find(other => other.resumeHash === resumeHash);
          guest = { ws, name: displayName(message.name), resumeHash, admitted: false, requests: new Set(),
            proposalBudget: sibling?.proposalBudget ?? { times: [] } };
          room.guests.set(guestId, guest);
          authenticated = true;
          clearTimeout(authTimer);
          send(ws, { type: 'pending', guestId, heartbeat: true });
          send(room.host, { type: 'join-request', guestId, name: guest.name,
            ...(resumeHash ? { resumeHash } : {}) });
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
          // Older hosts generated random invites. Keep their verifier alongside
          // the restored host's reproducible link for this exact room and origin.
          if (lanAddress && !previous) {
            const original = recovery?.originalInviteHash?.(roomId, inviteOrigin);
            if (original) room.originalInviteHash = Buffer.from(original, 'base64url');
          }
          room.host = ws;
          rooms.set(roomId, room);
          authenticated = true;
          clearTimeout(authTimer);
          send(ws, { type: 'registered', roomId, expiresAt: room.expiresAt, renewalSupported: true,
            capabilities: ['file-original', 'activity-details', 'guest-upload', 'join-review'],
            ...(lanAddress ? { inviteExpiresAt: room.inviteExpiresAt } : {}) });
        }
        return;
      }
      if (expired(room)) { destroyRoom(roomId, room, 'expired'); return; }
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
      if (isGuest && message.type === 'upload-chunk') {
        if (Date.now() - uploadWindow >= 60_000) { uploadWindow = Date.now(); uploadCount = 0; }
        if (++uploadCount > 2400) { finish(ws, 'rate-limited'); return; }
      } else if (++count > (isGuest ? 120 : 12_000)) { finish(ws, 'rate-limited'); return; }
      // Application heartbeat for browser clients, including pending admission.
      // No transcript, execution capability or authorization is granted by it.
      if (isGuest && message.type === 'ping' && exact(message, ['type'])) { send(ws, { type: 'pong' }); return; }
      if (isGuest) {
        if (!guest.admitted || !room.host || room.guests.get(guestId) !== guest) { finish(ws, 'not-admitted'); return; }
        if (message.type === 'import-offer' && exact(message, ['type', 'ticket']) && typeof message.ticket === 'string'
          && importTicketPattern.test(message.ticket)) {
          clearGuestImports(guest);
          guest.importOffer = { verifier: digest(message.ticket), origin: browserOrigin, expires: Date.now() + 120000 };
        } else if (message.type === 'snapshot-request' && exact(message, ['type'])) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'image-request' && exact(message, ['type', 'imageId'])
          && typeof message.imageId === 'string' && /^[a-f0-9]{64}$/.test(message.imageId)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'file-request' && exact(message, ['type', 'fileId'], ['representation'])
          && (message.representation === undefined || message.representation === 'original')
          && typeof message.fileId === 'string' && /^[a-f0-9]{64}$/.test(message.fileId)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'activity-request' && exact(message, ['type', 'activityId'])
          && typeof message.activityId === 'string' && /^[a-f0-9]{64}$/.test(message.activityId)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (uploadMessage(message)) {
          send(room.host, { type: 'guest-message', guestId, payload: message });
        } else if (message.type === 'proposal' && exact(message, ['type', 'requestId', 'text'], ['attachmentIds']) && uuid(message.requestId)
          && typeof message.text === 'string' && message.text.length <= 8000
          && (message.attachmentIds === undefined || uploadIds(message.attachmentIds))
          && (message.text.trim() || message.attachmentIds?.length)) {
          if (guest.requests.has(message.requestId)) { send(ws, { type: 'duplicate', requestId: message.requestId }); return; }
          const now = Date.now();
          const budget = guest.proposalBudget;
          budget.times = budget.times.filter(time => now - time < 60_000);
          if (budget.times.length >= 20 || guest.requests.size >= 256) { finish(ws, 'rate-limited'); return; }
          budget.times.push(now);
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
      } else if (message.type === 'join-review' && exact(message, ['type', 'guestId'])) {
        const selected = room.guests.get(message.guestId);
        if (selected && !selected.admitted) send(selected.ws, { type: 'pending', guestId: message.guestId, approvalRequired: true });
      } else if (['admit', 'deny'].includes(message.type) && exact(message, ['type', 'guestId'])) {
        const selected = room.guests.get(message.guestId);
        if (!selected) return;
        if (message.type === 'admit') { selected.admitted = true; send(selected.ws, { type: 'admitted', guestId: message.guestId }); }
        else { clearGuestImports(selected); room.guests.delete(message.guestId); finish(selected.ws, 'denied'); }
      } else if (message.type === 'deliver' && exact(message, ['type', 'payload'], ['guestId', 'importRequestId']) && record(message.payload)
        && (message.importRequestId === undefined || (uuid(message.importRequestId) && typeof message.guestId === 'string'))
        && (message.guestId === undefined || typeof message.guestId === 'string')) {
        const targets = message.guestId === undefined ? room.guests.values() : [room.guests.get(message.guestId)];
        for (const selected of targets) if (selected?.admitted) {
          const offer = selected.importOffer;
          if (message.importRequestId) {
            if (selected.ws.readyState !== WebSocket.OPEN) { clearGuestImports(selected); continue; }
            const transfer = selected.importTransfer;
            if (transfer?.active?.requestId === message.importRequestId) {
              if (!origins.has(transfer.origin) || transfer.expires <= Date.now()) clearGuestImports(selected);
              else receiveImportAsset(transfer, message.payload);
              continue;
            }
            if (message.importRequestId !== offer?.requestId) continue;
          } else send(selected.ws, { type: 'data', payload: message.payload });
          // Only the host's reply addressed to this still-admitted guest can
          // fulfil its one-time claim. No relay-side transcript is retained.
          const response = offer?.response;
          if (response && message.guestId && message.payload.type === 'snapshot') {
            // The guest may refresh its page while the native helper is claiming.
            // A modern host tags the native reply; its regular page snapshot cannot satisfy it.
            if (offer.requestId && !message.importRequestId && message.payload.importVersion === 2) continue;
            if (!origins.has(offer.origin) || offer.expires <= Date.now()) { clearOffer(selected); continue; }
            try {
              const body = JSON.stringify(message.importRequestId ? createImportManifest(selected, message.payload)
                : importSnapshotFromGuestView(message.payload)); // Older hosts send an untagged v1 snapshot.
              response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
            } catch { response.writeHead(422).end(); }
            clearOffer(selected);
          }
        }
      } else if (message.type === 'revoke' && exact(message, ['type'], recovery ? ['guestId', 'reason'] : ['guestId'])
        && (message.guestId === undefined || typeof message.guestId === 'string')
        && (message.reason === undefined || (message.guestId === undefined && ['expired', 'interrupted', 'paused'].includes(message.reason)))) {
        if (message.guestId === undefined) destroyRoom(roomId, room, message.reason ?? 'revoked');
        else {
          const selected = room.guests.get(message.guestId);
          if (selected) { clearGuestImports(selected); room.guests.delete(message.guestId); finish(selected.ws, 'revoked'); }
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
      setLanHostname(lanHostname);
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
    server, url, port: actualPort, inviteOrigin, get guestOrigin() { return guestOrigin ?? inviteOrigin; }, get entryOrigin() { return entryOrigin; }, lanServer, setAllowedOrigins, setLanHostname,
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
