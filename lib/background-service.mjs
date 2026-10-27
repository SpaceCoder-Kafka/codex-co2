import net from 'node:net';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validAppCommand } from './app-control.mjs';
import { acquireServiceLease, processIdentity, writeJson } from './runtime.mjs';
import { assertPrivateFile, ensurePrivateDirectory } from './platform.mjs';
import { readBackgroundSettings, writeBackgroundSettings } from './background-settings.mjs';
import { BackgroundChildren } from './background-children.mjs';

const MAX_LINE = 16384, MAX_OUTPUT = 1024 * 1024;
const credentialShape = value => value?.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 1
  && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
  && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token);
export const backgroundPaths = runtimeDir => ({ socket: path.join(runtimeDir, 'bg.sock'), credential: path.join(runtimeDir, 'background-control.json') });
const safeWrite = (socket, message) => {
  if (socket.destroyed || !socket.writable) return;
  const encoded = JSON.stringify(message) + '\n';
  if (socket.writableLength + Buffer.byteLength(encoded) > MAX_OUTPUT) { socket.destroy(); return; }
  socket.write(encoded);
};
async function privateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Background control directory is not private');
}
async function privateSocket(file) {
  const stat = await fs.lstat(file);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Background control socket is not private');
  return stat;
}
async function retireSocket(file) {
  const stat = await privateSocket(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return;
  await new Promise((resolve, reject) => {
    const socket = net.connect(file);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Background control endpoint is already active')); });
    socket.once('error', error => ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? resolve() : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Background control endpoint is ambiguous')); });
  });
  const current = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (current && current.dev === stat.dev && current.ino === stat.ino) await fs.unlink(file);
  else if (current) throw new Error('Background control endpoint changed');
}

// The daemon owns sharing independently of any management window. Only a
// same-user private control credential can access this small native protocol.
export class BackgroundService extends EventEmitter {
  constructor({ runtimeDir, serviceFactory, command, foreground = false, ownedTunnelPath, retryMs = 5000, firstClientMs = 15000 }) {
    super(); Object.assign(this, { runtimeDir, serviceFactory, command, foreground, retryMs, firstClientMs });
    this.clients = new Set(); this.sockets = new Set(); this.queue = Promise.resolve(); this.closed = false; this.enabled = true;
    this.paths = backgroundPaths(runtimeDir); this.resources = new Map();
    this.children = ownedTunnelPath ? new BackgroundChildren(runtimeDir, ownedTunnelPath) : null;
    this.lastStatus = { type: 'status', phase: 'starting', rooms: 0, pending: 0, public: false };
  }
  state() { return { type: 'background-state', enabled: this.enabled, running: !this.closed, background: this.enabled && !this.foreground }; }
  async start() {
    if (process.platform === 'win32') throw new Error('Background control is unavailable on this platform');
    if (Buffer.byteLength(this.paths.socket) > 103) throw new Error('Background socket path is too long');
    await ensurePrivateDirectory(this.runtimeDir);
    this.enabled = (await readBackgroundSettings(this.runtimeDir)).enabled;
    if (!this.enabled && !this.foreground) return false;
    this.release = await acquireServiceLease({ runtimeDir: this.runtimeDir }, 'background', { runtimeOnly: true, recoverStale: true });
    try {
      await this.children?.retire();
      this.childrenReconciled = true;
      await retireSocket(this.paths.socket);
      const identity = processIdentity(process.pid);
      if (!identity) throw new Error('Background process identity is unavailable');
      this.token = randomBytes(32).toString('base64url');
      // Never log this credential or the owner URL. Both stay on private disk
      // or pipes between the native manager and this daemon.
      await writeJson(this.paths.credential, { version: 1, pid: process.pid, fingerprint: identity.fingerprint, token: this.token });
      this.server = net.createServer(socket => this.accept(socket));
      this.server.listen(this.paths.socket);
      await once(this.server, 'listening'); await fs.chmod(this.paths.socket, 0o600);
      this.server.on('error', () => { void this.close().catch(() => {}); });
      if (this.foreground) this.firstClientTimer = setTimeout(() => { if (!this.clients.size) void this.close().catch(() => {}); }, this.firstClientMs);
      void this.startSharing();
      return true;
    } catch (error) { await this.close(); throw error; }
  }
  async startSharing() {
    if (this.closed || this.starting || this.service) return;
    this.starting = (async () => {
      let service;
      try {
        service = this.serviceFactory({ persistentLan: this.enabled && !this.foreground });
        this.service = service;
        service.on('status', status => {
          this.lastStatus = { type: 'status', ...status };
          if (status.phase === 'stopped' || ['stopped', 'not-started'].includes(status.connection?.state) || status.network?.intranetOnly) this.resources.clear();
          this.send(this.lastStatus);
        });
        service.on('resource', resource => {
          // The service has at most one current public tunnel. A superseded
          // PID must not accumulate or be replayed after ownership changes.
          if (resource.kind === 'tunnel') {
            try { this.children?.record(resource); }
            catch { void this.close().catch(() => {}); return; }
            this.resources.clear(); this.resources.set(resource.pid, { type: 'resource', ...resource });
          }
          this.send({ type: 'resource', ...resource });
        });
        const info = await service.start();
        if (this.closed || this.service !== service) return;
        this.ready = { type: 'ready', ownerUrl: info.ownerUrl };
        this.send(this.ready); this.send(this.lastStatus); this.send(this.state());
      } catch {
        try { await service?.close(); }
        catch {
          // A failed cleanup may still own a tunnel or listener. Starting a
          // replacement would lose that ownership. Stop this daemon without
          // awaiting its close from the startup promise it also waits on.
          this.ready = null;
          void this.close().catch(() => {});
          return;
        }
        if (this.service === service) this.service = null;
        this.ready = null; this.resources.clear();
        if (!this.closed) {
          this.lastStatus = { type: 'status', phase: 'waiting-desktop', rooms: 0, pending: 0, public: false };
          this.send(this.lastStatus);
          this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.startSharing(); }, this.retryMs);
        }
      }
    })().finally(() => { this.starting = null; });
    await this.starting;
  }
  send(message) { for (const client of this.clients) safeWrite(client, message); }
  accept(socket) {
    if (this.closed || this.serverConnections >= 16) { socket.destroy(); return; }
    this.serverConnections = (this.serverConnections ?? 0) + 1;
    this.sockets.add(socket);
    let buffer = '', authenticated = false, commands = 0;
    const timeout = setTimeout(() => socket.destroy(), 3000);
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout); this.serverConnections--; this.sockets.delete(socket);
      if (authenticated) {
        this.clients.delete(socket);
        if (!this.clients.size && (!this.enabled || this.foreground)) void this.close().catch(() => {});
      }
    });
    socket.on('data', bytes => {
      buffer += bytes;
      if (Buffer.byteLength(buffer) > MAX_LINE) { socket.destroy(); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (!request || Object.keys(request).sort().join(',') !== 'protocol,token,type' || request.type !== 'authenticate' || request.protocol !== 1
            || typeof request.token !== 'string' || Buffer.byteLength(request.token) !== Buffer.byteLength(this.token)
            || !timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token))) { socket.destroy(); return; }
          authenticated = true; clearTimeout(timeout); clearTimeout(this.firstClientTimer); this.clients.add(socket);
          safeWrite(socket, { type: 'authenticated', protocol: 1 });
          if (this.ready) safeWrite(socket, this.ready);
          safeWrite(socket, this.lastStatus); safeWrite(socket, this.state());
          for (const resource of this.resources.values()) safeWrite(socket, resource);
          continue;
        }
        if (++commands > 256 || !validAppCommand(request, { background: true })) { socket.destroy(); return; }
        this.queue = this.queue.then(() => this.receive(socket, request)).catch(() => safeWrite(socket, { type: 'error', id: request.id, message: '后台服务操作失败，请重试。' })).finally(() => { commands--; });
      }
    });
  }
  async receive(client, request) {
    if (this.closed || client.destroyed) return;
    if (request.type === 'shutdown') { await this.close(); return; }
    if (request.type === 'set-background') {
      if (!request.enabled) {
        // Disable on disk first; a crash or a failed snapshot erase must not
        // permit the next login to silently re-enable the background service.
        await writeBackgroundSettings(this.runtimeDir, false); this.enabled = false;
        try { await this.service?.setBackgroundEnabled?.(false); }
        finally {
          this.send(this.state());
          if (!this.clients.size) void this.close().catch(() => {});
        }
      } else {
        if (!this.ready || !this.service) throw new Error('Background service is not ready');
        // An explicit enable prepares persistent LAN recovery before native
        // handoff from a foreground-owned daemon to the managed LaunchAgent.
        await this.service?.setBackgroundEnabled?.(true);
        await writeBackgroundSettings(this.runtimeDir, true); this.enabled = true; this.send(this.state());
      }
      safeWrite(client, { type: 'result', command: request.type, id: request.id, ok: true, enabled: this.enabled });
      return;
    }
    if (!this.ready || !this.service) { safeWrite(client, { type: 'error', id: request.id, message: '本地服务正在恢复，请稍后重试。' }); return; }
    try { safeWrite(client, { type: 'result', command: request.type, id: request.id, ...await this.command(this.service, request.type) }); }
    catch (error) { safeWrite(client, { type: 'error', id: request.id, message: error.safeMessage ?? '操作未完成，请检查 Codex 和网络后重试。' }); }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.firstClientTimer);
    this.closing = (async () => {
      let failure;
      try { await this.service?.close(); await this.starting; } catch (error) { failure = error; }
      // Stop accepting managers before acknowledging shutdown. The native
      // updater treats `stopped` as proof that service and private leases are
      // gone, so no failure path may publish that acknowledgement.
      const server = this.server; this.server = null;
      const serverClosed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      try {
        if (!failure && this.childrenReconciled) this.children?.clear();
        if (this.release) await fs.unlink(this.paths.credential).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await this.release?.(); this.release = null;
      } catch (error) { failure ??= error; }
      if (!failure) this.send({ type: 'stopped' });
      else this.send({ type: 'error', message: '后台服务未能安全停止，请重试。' });
      for (const socket of this.sockets) {
        if (this.clients.has(socket)) socket.end(); else socket.destroy();
      }
      if (server) {
        // Authentication attempts must not hold shutdown open.
        const timeout = setTimeout(() => { for (const socket of this.sockets) socket.destroy(); }, 1000);
        try { await serverClosed; }
        finally { clearTimeout(timeout); }
      }
      this.emit('closed', failure);
      if (failure) throw failure;
    })();
    return this.closing;
  }
}

export async function connectBackground({ runtimeDir, input = process.stdin, output = process.stdout, timeoutMs = 5000 }) {
  if (process.platform === 'win32') throw new Error('Background control is unavailable on this platform');
  await privateDirectory(runtimeDir);
  const paths = backgroundPaths(runtimeDir);
  const handle = await fs.open(paths.credential, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credential;
  try {
    await assertPrivateFile(paths.credential, await handle.stat(), { maxBytes: 2048 });
    credential = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (!credentialShape(credential) || processIdentity(credential.pid)?.fingerprint !== credential.fingerprint) throw new Error('Background service identity changed');
  await privateSocket(paths.socket);
  const socket = net.connect(paths.socket);
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Background service connection timed out')); }, timeoutMs);
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
  });
  socket.write(JSON.stringify({ type: 'authenticate', protocol: 1, token: credential.token }) + '\n');
  return await new Promise((resolve, reject) => {
    let authenticated = false, buffer = '';
    const authTimer = setTimeout(() => { socket.destroy(); reject(new Error('Background service authentication timed out')); }, timeoutMs);
    const finish = error => {
      clearTimeout(authTimer); input.unpipe(socket); input.off('end', ended); input.off('error', failed); output.off('error', failed);
      socket.destroy(); error ? reject(error) : resolve();
    };
    const ended = () => socket.end();
    const failed = () => finish(new Error('Background control pipe closed'));
    input.once('end', ended); input.once('error', failed); output.once('error', failed);
    socket.setEncoding('utf8');
    socket.on('data', bytes => {
      buffer += bytes;
      if (Buffer.byteLength(buffer) > MAX_OUTPUT) { finish(new Error('Background control output exceeded limit')); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let message; try { message = JSON.parse(line); } catch { finish(new Error('Invalid background control output')); return; }
        if (!authenticated) {
          if (message.type !== 'authenticated' || message.protocol !== 1) { finish(new Error('Background authentication failed')); return; }
          authenticated = true; clearTimeout(authTimer); input.pipe(socket, { end: false });
          if (input.readableEnded) socket.end();
        } else {
          if (output.writableLength + Buffer.byteLength(line) > MAX_OUTPUT) { finish(new Error('Background control output is blocked')); return; }
          output.write(line + '\n');
        }
      }
    });
    socket.once('error', () => finish(new Error('Background control connection failed')));
    socket.once('close', () => finish(authenticated ? null : new Error('Background authentication failed')));
  });
}
