import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_SELECTED = 256;
const DESCRIPTOR = 'desktop-app-bridge.json';
const failure = (code, message = code) => Object.assign(new Error(message), { code });

async function assertCanonicalDirectory(directory, { allowMissing = false } = {}) {
  let existing = directory;
  while (true) {
    const info = await fs.lstat(existing).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(existing) !== existing) throw failure('unsafe_runtime_directory');
      if (existing === directory && process.getuid && info.uid !== process.getuid()) throw failure('unsafe_runtime_directory');
      return;
    }
    if (!allowMissing || path.dirname(existing) === existing) throw failure('unsafe_runtime_directory');
    existing = path.dirname(existing);
  }
}

function threadId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) throw failure('invalid_thread_id');
  return value;
}

function readOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('invalid_read_options');
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'cursor' && typeof value === 'string' && value.length <= 8192) result[key] = value;
    else if (key === 'turnLimit' && Number.isInteger(value) && value >= 1 && value <= 10) result[key] = value;
    else if (['includeTurns', 'includeOutputs'].includes(key) && typeof value === 'boolean') result[key] = value;
    else if (key === 'maxOutputCharsPerItem' && Number.isInteger(value) && value >= 0 && value <= 20000) result[key] = value;
    else throw failure('invalid_read_options');
  }
  return result;
}

/** A local manager owns selection. The Desktop child can only service selected reads. */
export function createDesktopAppBridge({ runtimeDir }) {
  if (!path.isAbsolute(runtimeDir ?? '')) throw failure('invalid_runtime_directory');
  runtimeDir = path.resolve(runtimeDir);
  const eventEmitter = new EventEmitter();
  const selected = new Set();
  const pending = new Map();
  const descriptorPath = path.join(runtimeDir, DESCRIPTOR);
  let generation = randomUUID();
  let token = randomBytes(32).toString('hex');
  let active = null;
  let candidate = null;
  let closed = false;
  let closingPromise;
  let port;
  let writeQueue = Promise.resolve();

  const server = http.createServer((req, res) => {
    const supplied = req.headers.authorization;
    const expected = `Bearer ${token}`;
    const tokenMatches = typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    const localPeer = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    if (closed || !localPeer || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin != null
      || req.method !== 'POST' || req.url !== '/bridge/connect' || !tokenMatches
      || req.headers['x-co2-generation'] !== generation || req.headers['content-type'] !== 'application/x-ndjson') {
      res.writeHead(403).end();
      return;
    }
    if (active || candidate) { res.writeHead(409).end(); return; }
    const connection = { req, res, generation, input: Buffer.alloc(0), lastSeen: Date.now(), authenticated: false };
    candidate = connection;
    const timeout = setTimeout(() => disconnect(connection, 'handshake_timeout'), 5000);
    timeout.unref();
    const onClose = () => { clearTimeout(timeout); disconnect(connection, 'desktop_bridge_disconnected'); };
    req.on('error', onClose);
    res.on('error', onClose);
    res.on('close', onClose);
    req.on('end', onClose);
    req.on('data', chunk => {
      if (connection !== active && connection !== candidate) return;
      connection.input = Buffer.concat([connection.input, chunk]);
      while (true) {
        const end = connection.input.indexOf(10);
        if (end < 0) {
          if (connection.input.length > MAX_FRAME) disconnect(connection, 'frame_too_large');
          return;
        }
        if (end > MAX_FRAME) { disconnect(connection, 'frame_too_large'); return; }
        const frame = connection.input.subarray(0, end);
        connection.input = connection.input.subarray(end + 1);
        let message;
        try { message = JSON.parse(frame.toString('utf8')); } catch { disconnect(connection, 'invalid_frame'); return; }
        connection.lastSeen = Date.now();
        if (!connection.authenticated) {
          if (message?.type !== 'hello' || message.protocol !== 1 || message.generation !== generation
            || typeof message.sourceThreadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(message.sourceThreadId)) {
            disconnect(connection, 'invalid_handshake'); return;
          }
          clearTimeout(timeout);
          connection.authenticated = true;
          connection.sourceThreadId = message.sourceThreadId;
          active = connection;
          candidate = null;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
          write(connection, { type: 'ready', protocol: 1, generation });
          for (const id of selected) write(connection, { type: 'select', threadId: id });
          eventEmitter.emit('connected');
        } else if (message?.type === 'heartbeat') {
          // Liveness only; no activity or conversation data is recorded.
        } else if (message?.type === 'reply' && typeof message.id === 'string' && pending.has(message.id)) {
          const operation = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(operation.timeout);
          if (message.error) operation.reject(failure(message.error.code === 'DESKTOP_APP_RESPONSE_TOO_LARGE' ? message.error.code : 'desktop_read_failed'));
          else if (message.result?.schemaVersion !== 1 || message.result?.thread?.id !== operation.threadId
            || message.result?.thread?.hostId !== 'local') operation.reject(failure('desktop_thread_mismatch'));
          else operation.resolve(message.result);
        } else {
          disconnect(connection, 'unexpected_bridge_message'); return;
        }
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const heartbeat = setInterval(() => {
    if (active && Date.now() - active.lastSeen > 35000) disconnect(active, 'desktop_bridge_timeout');
  }, 10000);
  heartbeat.unref();

  function write(connection, message) {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`);
    if (frame.length > MAX_FRAME || connection.res.writableLength + frame.length > MAX_FRAME * 2) {
      disconnect(connection, 'bridge_backpressure'); return false;
    }
    if (connection.res.destroyed) return false;
    connection.res.write(frame);
    return true;
  }

  function disconnect(connection, code) {
    if (connection !== active && connection !== candidate) return;
    const wasActive = connection === active;
    if (wasActive) active = null;
    if (connection === candidate) candidate = null;
    connection.req.destroy();
    connection.res.destroy();
    if (wasActive) {
      for (const operation of pending.values()) {
        clearTimeout(operation.timeout);
        operation.reject(failure(code));
      }
      pending.clear();
      eventEmitter.emit('disconnected', { code });
    }
  }

  async function saveDescriptor() {
    await assertCanonicalDirectory(runtimeDir);
    await fs.chmod(runtimeDir, 0o700);
    const existing = await fs.lstat(descriptorPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink()
      || (process.getuid && existing.uid !== process.getuid()))) throw failure('unsafe_bridge_descriptor');
    const temporary = path.join(runtimeDir, `.desktop-app-bridge-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ protocol: 1, port, token, generation })); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, descriptorPath); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }

  const ready = (async () => {
    await assertCanonicalDirectory(runtimeDir, { allowMissing: true });
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(runtimeDir);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    port = server.address().port;
    await saveDescriptor();
  })().catch(error => { server.close(); clearInterval(heartbeat); throw error; });

  return {
    ready,
    eventEmitter,
    on: eventEmitter.on.bind(eventEmitter),
    off: eventEmitter.off.bind(eventEmitter),
    once: eventEmitter.once.bind(eventEmitter),
    get connected() { return active != null; },
    get sourceThreadId() { return active?.sourceThreadId ?? null; },
    waitConnected({ timeoutMs = 30000, signal } = {}) {
      return new Promise((resolve, reject) => {
        let timeout;
        const finish = (error) => {
          clearTimeout(timeout);
          eventEmitter.off('connected', connected);
          eventEmitter.off('closed', stopped);
          signal?.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const connected = () => finish();
        const stopped = () => finish(failure('desktop_bridge_closed'));
        const aborted = () => finish(signal.reason ?? failure('aborted'));
        if (signal?.aborted) return aborted();
        if (closed) return stopped();
        if (active) return connected();
        eventEmitter.once('connected', connected);
        eventEmitter.once('closed', stopped);
        signal?.addEventListener('abort', aborted, { once: true });
        timeout = setTimeout(() => finish(failure('desktop_bridge_connect_timeout')), timeoutMs);
      });
    },
    selectThread(id) {
      if (closed) throw failure('desktop_bridge_closed');
      threadId(id);
      if (!selected.has(id) && selected.size >= MAX_SELECTED) throw failure('too_many_selected_threads');
      selected.add(id);
      if (active) write(active, { type: 'select', threadId: id });
    },
    async readPage(id, options) {
      threadId(id);
      const safeOptions = readOptions(options);
      if (!selected.has(id)) throw failure('thread_not_selected');
      if (!active || closed) throw failure('desktop_bridge_disconnected');
      if (pending.size >= MAX_PENDING) throw failure('too_many_pending_reads');
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timeout = setTimeout(() => { pending.delete(requestId); reject(failure('desktop_read_timeout')); }, 15000);
        pending.set(requestId, { resolve, reject, timeout, threadId: id });
        if (!write(active, { type: 'read_page', id: requestId, threadId: id, options: safeOptions })) {
          clearTimeout(timeout); pending.delete(requestId); reject(failure('desktop_bridge_disconnected'));
        }
      });
    },
    reconnect() {
      writeQueue = writeQueue.catch(() => {}).then(async () => {
        await ready;
        if (closed) throw failure('desktop_bridge_closed');
        if (active) disconnect(active, 'desktop_bridge_reconnecting');
        if (candidate) disconnect(candidate, 'desktop_bridge_reconnecting');
        generation = randomUUID();
        token = randomBytes(32).toString('hex');
        await saveDescriptor();
      });
      return writeQueue;
    },
    close() {
      if (closingPromise) return closingPromise;
      closed = true;
      closingPromise = Promise.resolve().then(async () => {
        await ready.catch(() => {});
        await writeQueue.catch(() => {});
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        try {
          await assertCanonicalDirectory(runtimeDir);
          const handle = await fs.open(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > 4096 || (process.getuid && info.uid !== process.getuid())) return;
            const value = JSON.parse(await handle.readFile('utf8'));
            if (value.generation === generation) await fs.unlink(descriptorPath);
          } finally { await handle.close(); }
        } catch (error) {
          if (!['ENOENT', 'ELOOP', 'unsafe_runtime_directory'].includes(error.code)) throw error;
        }
      });
      clearInterval(heartbeat);
      if (active) disconnect(active, 'desktop_bridge_closed');
      if (candidate) disconnect(candidate, 'desktop_bridge_closed');
      eventEmitter.emit('closed');
      return closingPromise;
    },
  };
}
