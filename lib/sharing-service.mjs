import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, prepare, readJson, writeJson, resolveCli, start, acquireServiceLease, processIdentity } from './runtime.mjs';
import { startRelay } from './relay.mjs';
import { startOwner, secret } from './host.mjs';
import { startDesktopBridge } from './desktop-bridge.mjs';
import { startTunnel, validateTunnelOptions } from './tunnel.mjs';
import { checkHealth } from './network.mjs';
import { attachDesktop } from './desktop-ipc.mjs';
import { createThreadCatalog } from './thread-catalog.mjs';
import { PublicHealth } from './public-health.mjs';
import { openShareHistory } from './share-history.mjs';
import { openGuestPermissions } from './guest-permissions.mjs';
import { openManagerSettings } from './manager-settings.mjs';

export async function runtimePaths(resourceRoot, runtimeDir) {
  if (!runtimeDir) return paths(resourceRoot);
  if (!path.isAbsolute(runtimeDir) || path.basename(runtimeDir) !== '.coop') throw new Error('Runtime directory must be an absolute .coop directory');
  const canonical = await fs.realpath(runtimeDir).catch(error => { if (error.code !== 'ENOENT') throw error; return path.resolve(runtimeDir); });
  if (path.basename(canonical) !== '.coop') throw new Error('Runtime alias must resolve to a .coop directory');
  for (const name of ['home', 'desktop-profile', 'home/auth.json', 'home/config.toml', 'home/state_5.sqlite', 'home/sessions', 'home/archived_sessions']) {
    const stat = await fs.lstat(path.join(canonical, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) throw new Error('Runtime authentication, history and profile must not be symlinked to another home');
  }
  let p = paths(path.dirname(canonical), { runtimeDir: canonical, shortSocket: true });
  const state = await readJson(p.stateFile);
  if (typeof state?.codexHome === 'string') {
    const recordedRuntime = path.dirname(state.codexHome);
    if (await fs.realpath(recordedRuntime).catch(() => null) === canonical) p = paths(path.dirname(recordedRuntime), { runtimeDir: recordedRuntime, shortSocket: true });
  }
  // Preserve the exact socket convention of an explicitly selected existing home.
  if (state?.codexHome === p.codexHome && [p.socketPath, path.join(p.codexHome, 'app-server-control/app-server-control.sock')].includes(state.socketPath)) p.socketPath = state.socketPath;
  return p;
}

export class SharingService extends EventEmitter {
  constructor(options, dependencies = {}) {
    super(); this.options = options; this.dependencies = { startRelay, startOwner, startDesktopBridge, startTunnel, checkHealth, start, attachDesktop, ...dependencies };
    this.abort = new AbortController(); this.cleanup = []; this.closed = false; this.status = { phase: 'starting', rooms: 0, pending: 0, public: false };
    this.connection = { state: 'not-started' };
  }
  setConnection(connection) {
    this.connection = connection;
    this.owner?.setConnection?.(connection);
    this.update({ connection });
  }
  update(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }
  start() { return this.starting ??= this.initialize().catch(async error => { await this.dispose(); throw error; }); }
  async initialize() {
    const o = this.options;
    if (o.attach && o.mode !== 'host') throw new Error('--attach requires host mode');
    validateTunnelOptions({ tokenFile: o.tunnelTokenFile, origin: o.origin });
    if (o.tunnelTokenFile && (o.relayUrl || (!o.publicMode && !o.lazyPublic))) throw new Error('Named tunnel requires --public and cannot be combined with --relay');
    this.p = await runtimePaths(o.resourceRoot, o.runtimeDir);
    if (o.attach) {
      await fs.mkdir(this.p.runtimeDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.p.runtimeDir, 0o700);
    } else await prepare(this.p);
    this.cleanup.push(await acquireServiceLease(this.p, o.mode === 'relay' ? 'relay' : 'sharing', { runtimeOnly: Boolean(o.attach) }));
    this.abort.signal.throwIfAborted();
    // Probe the existing Desktop before opening a relay or creating any runtime.
    if (o.attach) {
      this.attachment = await this.dependencies.attachDesktop({ endpoint: o.ipcPath, catalog: createThreadCatalog({ indexPath: o.indexPath }) });
      this.cleanup.push(() => this.attachment.close());
      if (o.threadId) await this.attachment.selectThread(o.threadId);
    }
    const credentialFile = o.registrationFile ?? path.join(this.p.runtimeDir, 'relay-registration.json');
    let saved = await readJson(credentialFile);
    if (!saved && o.registrationFile) throw new Error('Registration file not found');
    if (!saved) { saved = { registrationSecret: secret() }; await writeJson(credentialFile, saved); }
    this.registrationSecret = saved.registrationSecret;
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.registrationSecret ?? '')) throw new Error('Invalid relay registration credential');
    this.relayUrl = o.relayUrl;
    if (!o.lazyPublic) await this.ensureRelay();
    this.abort.signal.throwIfAborted();
    if (o.mode === 'relay') {
      this.info = { pid: process.pid, mode: 'relay', relayUrl: this.relayUrl, credentialFile };
    } else {
      const cliPath = o.attach ? null : resolveCli(o.cliPath).cliPath; this.cliPath = cliPath;
      let socketPath = this.p.socketPath;
      if (o.mode === 'demo') {
        const { startDemo } = await import('./demo.mjs');
        this.demo = await startDemo(cliPath); this.cleanup.push(() => this.demo.close()); socketPath = this.demo.socketPath;
      } else if (!o.attach) await this.dependencies.start(this.p, cliPath);
      this.abort.signal.throwIfAborted();
      let diagnosticWrites = Promise.resolve();
      const onDiagnostic = event => { diagnosticWrites = diagnosticWrites.then(() => fs.appendFile(path.join(this.p.runtimeDir, 'sharing-observations.ndjson'), JSON.stringify(event) + '\n', { mode: 0o600 })).catch(() => {}); };
      this.cleanup.push(() => diagnosticWrites);
      this.history = await openShareHistory(path.join(this.p.runtimeDir, 'sharing-history.json'));
      this.cleanup.push(() => this.history.flush());
      this.permissions = await openGuestPermissions(path.join(this.p.runtimeDir, 'guest-permissions.json'));
      this.cleanup.push(() => this.permissions.save());
      this.managerSettings = await openManagerSettings(path.join(this.p.runtimeDir, 'manager-settings.json'));
      this.cleanup.push(() => this.managerSettings.flush());
      this.owner = await this.dependencies.startOwner({ socketPath, relayUrl: this.relayUrl,
        ...(this.attachment ? { rpcFactory: this.attachment.rpcFactory, listThreads: this.attachment.listThreads,
          selectThread: (id, options) => this.attachment.selectThread(id, options), attached: true } : {}),
        ensureRelay: o.lazyPublic ? () => this.ensureRelay() : undefined, registrationSecret: this.registrationSecret,
        history: this.history, managerSettings: this.managerSettings, permissions: this.permissions, connection: this.connection,
        checkConnection: () => this.checkConnection(), rebuildRelay: () => this.rebuildRelay(),
        ownerDir: path.join(o.resourceRoot, 'owner'), onDiagnostic, onState: state => this.update(state) });
      this.cleanup.push(() => this.owner.close());
      this.abort.signal.throwIfAborted();
      if (o.mode === 'host' && !o.attach && o.desktop !== false) {
        this.desktop = await this.dependencies.startDesktopBridge({ socketPath, codexHome: this.p.codexHome, runtimeDir: this.p.runtimeDir, appPath: o.appPath });
        this.cleanup.push(() => this.desktop.close());
      }
      this.info = { pid: process.pid, mode: o.mode, relayUrl: this.relayUrl ?? null, ownerUrl: this.owner.url,
        threadId: this.demo?.threadId ?? null, desktopLauncher: this.desktop?.launcher ?? null,
        attached: Boolean(o.attach),
        model: o.attach ? 'Existing Desktop runtime; no new backend or login' : o.mode === 'demo' ? 'Local synthetic fixture; no real model calls' : 'A isolated Codex account',
        encryption: 'HTTPS/WSS in public mode; relay can read content. Not end-to-end encrypted.' };
    }
    this.abort.signal.throwIfAborted();
    const serviceFile = path.join(this.p.runtimeDir, `${o.mode}-service.json`);
    await writeJson(serviceFile, this.info); this.cleanup.push(() => fs.unlink(serviceFile));
    this.update({ phase: 'ready' }); return this.info;
  }
  ensureRelay({ replacement = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Sharing service is closed'));
    if (this.rebuilding && !replacement) return this.rebuilding;
    return this.relayStarting ??= this.connectRelay().catch(error => { this.relayStarting = null; this.setConnection({ state: 'unavailable' }); this.update({ phase: 'ready', public: false }); throw error; });
  }
  async checkConnection() {
    if (this.closed) throw new Error('共享服务已关闭');
    if (this.monitor) await this.monitor.check();
    else await this.ensureRelay();
  }
  rebuildRelay() {
    return this.rebuilding ??= this.replaceRelay().finally(() => { this.rebuilding = null; });
  }
  async replaceRelay() {
    if (this.closed) throw new Error('共享服务已关闭');
    if (this.options.relayUrl) throw new Error('外部中继请检查连接，无法在此重建');
    if (this.connection.state === 'connecting') throw new Error('正在建立公网入口，请等待完成');
    this.setConnection({ state: 'connecting' });
    this.pauseSharing();
    const previous = this.tunnel; this.tunnel = null;
    await this.monitor?.close(); this.monitor = null;
    await previous?.close();
    this.relayStarting = null;
    return this.ensureRelay({ replacement: true });
  }
  monitorPublic(origin) {
    this.monitor = new PublicHealth({ origin, checkHealth: this.dependencies.checkHealth, signal: this.abort.signal,
      intervalMs: this.options.healthIntervalMs ?? 30000,
      onCheck: () => this.owner?.checkConnections?.(), onStatus: state => this.setConnection(state) }).start();
    const monitor = this.monitor; this.cleanup.push(() => monitor.close());
    this.setConnection({ state: 'online', checkedAt: Date.now(), failures: 0 });
  }
  async connectRelay() {
    const o = this.options, signal = this.abort.signal;
    signal.throwIfAborted();
    if (o.relayUrl) { this.relayUrl = o.relayUrl; this.monitorPublic(this.relayUrl); this.update({ public: true }); return this.relayUrl; }
    if (!this.relay) {
      this.relay = await this.dependencies.startRelay({ host: o.bind ?? '127.0.0.1', port: o.port ?? 0,
        registrationSecret: this.registrationSecret, publicDir: path.join(o.resourceRoot, 'public') });
      this.cleanup.push(() => this.relay.close());
    }
    signal.throwIfAborted();
    if (!o.publicMode && !o.lazyPublic) {
      this.relayUrl = o.origin ? new URL(o.origin).origin : this.relay.url;
      this.setConnection({ state: 'local' });
      this.relay.setAllowedOrigins([this.relayUrl]); return this.relayUrl;
    }
    this.update({ phase: 'connecting' });
    this.setConnection({ state: 'connecting' });
    const tunnel = await this.dependencies.startTunnel(this.relay.url, { binary: o.cloudflaredPath, signal,
      tokenFile: o.tunnelTokenFile, origin: o.origin, onSpawn: child => {
      const identity = processIdentity(child.pid);
      if (identity) this.emit('resource', { kind: 'tunnel', pid: child.pid, fingerprint: identity.fingerprint });
    } });
    try {
      this.relay.setAllowedOrigins([this.relay.url, tunnel.url]);
      let ready = false;
      // Bound elapsed time, including DNS/TLS attempts, rather than allowing
      // 120 five-second requests to strand the local share action for minutes.
      const readySignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      for (let i = 0; i < 120; i++) {
        readySignal.throwIfAborted();
        if ((await this.dependencies.checkHealth(tunnel.url, { signal: readySignal })).ok) { ready = true; break; }
        await delay(1000, undefined, { signal: readySignal });
      }
      if (!ready) throw new Error('公网连接尚未就绪，请稍后重试');
      signal.throwIfAborted();
      this.tunnel = tunnel; this.cleanup.push(() => tunnel.close());
      tunnel.child?.once('exit', () => {
        if (!this.closed && this.tunnel === tunnel) {
          this.tunnel = null; void this.monitor?.close(); this.monitor = null;
          this.pauseSharing(); this.relayStarting = null;
          this.setConnection({ state: 'stopped' }); this.update({ public: false, phase: 'ready' });
        }
      });
      this.monitorPublic(tunnel.url);
      this.relayUrl = tunnel.url; this.update({ phase: 'ready', public: true }); return this.relayUrl;
    } catch (error) { await tunnel.close(); throw error; }
  }
  revokeAll() { this.owner?.revokeAll(); }
  pauseSharing() {
    if (this.owner?.pauseAll) this.owner.pauseAll();
    else this.owner?.revokeAll();
  }
  async dispose() { for (const fn of this.cleanup.splice(0).reverse()) { try { await fn(); } catch {} } }
  close() {
    return this.closing ??= (async () => {
      this.closed = true; this.abort.abort(new Error('Sharing service closed'));
      this.pauseSharing();
      await this.starting?.catch(() => {});
      await this.relayStarting?.catch(() => {});
      await this.rebuilding?.catch(() => {});
      await this.dispose(); this.update({ phase: 'stopped', rooms: 0, pending: 0, public: false });
    })();
  }
}
