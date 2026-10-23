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
import { openMessageAuthorHistory } from './message-author-history.mjs';
import { openLanSettings, normalizeLanSettings } from './lan-settings.mjs';
import { lanInterfaces, selectLanAddress } from './lan-network.mjs';
import { ensurePrivateDirectory } from './platform.mjs';

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
    super(); this.options = options; this.dependencies = { startRelay, startOwner, startDesktopBridge, startTunnel, checkHealth, start, attachDesktop, lanInterfaces, selectLanAddress, ...dependencies };
    this.abort = new AbortController(); this.cleanup = []; this.closed = false; this.status = { phase: 'starting', rooms: 0, pending: 0, public: false };
    this.connection = { state: 'not-started' };
    this.networkMode = { intranetOnly: false, lanAddress: null };
    this.networkConfigurable = options.mode === 'host' && options.attach === true && !options.relayUrl && !options.tunnelTokenFile && !options.origin && (!options.bind || options.bind === '127.0.0.1');
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
    this.networkConfigurable = o.mode === 'host' && o.attach === true && !o.relayUrl && !o.tunnelTokenFile && !o.origin && (!o.bind || o.bind === '127.0.0.1');
    if (o.attach && o.mode !== 'host') throw new Error('--attach requires host mode');
    if (o.intranetOnly && (o.mode !== 'host' || o.attach !== true)) throw new Error('--intranet-only requires host --attach');
    if (o.intranetOnly !== undefined && typeof o.intranetOnly !== 'boolean') throw new Error('--intranet-only must be boolean');
    if (o.intranetOnly && (!this.networkConfigurable || o.publicMode)) throw new Error('--intranet-only cannot be combined with --public, --relay, --origin, --bind or named tunnel options');
    if (o.lanAddress !== undefined && !o.intranetOnly) throw new Error('--lan-address requires --intranet-only');
    validateTunnelOptions({ tokenFile: o.tunnelTokenFile, origin: o.origin });
    if (o.tunnelTokenFile && (o.relayUrl || (!o.publicMode && !o.lazyPublic))) throw new Error('Named tunnel requires --public and cannot be combined with --relay');
    this.p = await runtimePaths(o.resourceRoot, o.runtimeDir);
    // Read only this helper's network preference before preparing any isolated
    // home. A persisted LAN restriction cannot create a second Codex runtime.
    await ensurePrivateDirectory(this.p.runtimeDir);
    this.cleanup.push(await acquireServiceLease(this.p, o.mode === 'relay' ? 'relay' : 'sharing', { runtimeOnly: true }));
    this.lanSettings = await openLanSettings(path.join(this.p.runtimeDir, 'lan-sharing.json'));
    this.cleanup.push(() => this.lanSettings.flush());
    const persistedNetwork = this.lanSettings.get();
    if (persistedNetwork.intranetOnly && (o.mode !== 'host' || o.attach !== true)) throw new Error('Saved LAN-only sharing requires host --attach');
    this.networkMode = this.networkConfigurable ? persistedNetwork : { intranetOnly: false, lanAddress: null };
    if (o.intranetOnly !== undefined) this.networkMode = normalizeLanSettings({ intranetOnly: o.intranetOnly, lanAddress: o.intranetOnly ? o.lanAddress ?? null : null });
    if (this.networkMode.intranetOnly && (o.mode !== 'host' || o.attach !== true)) throw new Error('Saved LAN-only sharing requires host --attach');
    if (!o.attach) await prepare(this.p);
    this.cleanup.push(() => this.closeNetwork());
    this.abort.signal.throwIfAborted();
    // Probe the existing Desktop before opening a relay or creating any runtime.
    if (o.attach) {
      this.attachment = await this.dependencies.attachDesktop({ endpoint: o.ipcPath, catalog: createThreadCatalog({ indexPath: o.indexPath }),
        ...(o.openThread ? { openThread: o.openThread } : {}) });
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
    // A saved LAN address may disappear between launches. Keep management
    // available for repair, while refusing to share or open a public fallback.
    if (!o.lazyPublic && !this.networkMode.intranetOnly) await this.ensureRelay();
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
      this.authorHistory = await openMessageAuthorHistory(path.join(this.p.runtimeDir, 'message-authors.json'));
      this.cleanup.push(() => this.authorHistory.flush());
      this.permissions = await openGuestPermissions(path.join(this.p.runtimeDir, 'guest-permissions.json'));
      this.cleanup.push(() => this.permissions.save());
      this.managerSettings = await openManagerSettings(path.join(this.p.runtimeDir, 'manager-settings.json'));
      this.cleanup.push(() => this.managerSettings.flush());
      this.owner = await this.dependencies.startOwner({ socketPath, relayUrl: this.relayUrl,
        ...(this.attachment ? { rpcFactory: this.attachment.rpcFactory, listThreads: this.attachment.listThreads,
          selectThread: (id, options) => this.attachment.selectThread(id, options), attached: true } : {}),
        ensureRelay: () => this.ensureRelay(), registrationSecret: this.registrationSecret,
        getNetwork: () => this.getNetwork(), setNetwork: value => this.setNetwork(value),
        getInviteOrigin: () => this.inviteOrigin,
        history: this.history, authorHistory: this.authorHistory, managerSettings: this.managerSettings, permissions: this.permissions, connection: this.connection,
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
        encryption: 'HTTPS/WSS in public mode; LAN mode uses unencrypted HTTP/WS. Not end-to-end encrypted.' };
    }
    this.abort.signal.throwIfAborted();
    const serviceFile = path.join(this.p.runtimeDir, `${o.mode}-service.json`);
    await writeJson(serviceFile, this.info); this.cleanup.push(() => fs.unlink(serviceFile));
    this.update({ phase: 'ready' }); return this.info;
  }
  ensureRelay({ replacement = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Sharing service is closed'));
    if (this.networkChanging) return Promise.reject(new Error('正在切换访问范围，请等待完成'));
    if (this.networkMode.intranetOnly && this.activeLanAddress) {
      try { this.dependencies.selectLanAddress(this.activeLanAddress); }
      catch (error) { return this.failLan(error).then(() => { throw error; }); }
    }
    if (this.rebuilding && !replacement) return this.rebuilding;
    return this.relayStarting ??= this.connectRelay().catch(async error => {
      this.relayStarting = null;
      if (this.networkMode.intranetOnly) await this.failLan(error);
      this.setConnection({ state: 'unavailable' }); this.update({ phase: 'ready', public: false }); throw error;
    });
  }
  getNetwork() {
    let interfaces = [];
    try { interfaces = this.dependencies.lanInterfaces(); } catch {}
    return { ...this.networkMode, interfaces, configurable: this.networkConfigurable };
  }
  setNetwork(value) {
    if (this.closed) return Promise.reject(new Error('共享服务已关闭'));
    if (!this.networkConfigurable) return Promise.reject(new Error('当前启动参数管理分享地址，无法在此切换'));
    if (this.networkChanging || this.rebuilding || this.connection.state === 'connecting') return Promise.reject(new Error('正在处理网络连接，请等待完成'));
    const desired = normalizeLanSettings(value), previous = this.networkMode;
    return this.networkChanging = (async () => {
      // As soon as LAN is requested, failures must remain private. Only a
      // successfully persisted explicit switch can enable public sharing.
      let selectionError;
      if (desired.intranetOnly) {
        try { desired.lanAddress = this.dependencies.selectLanAddress(desired.lanAddress ?? undefined); }
        catch (error) { selectionError = error; }
        this.networkMode = desired;
      }
      this.revokeAll();
      if (desired.intranetOnly) {
        // Persist the more restrictive mode first so a process exit or a
        // resource-close failure cannot restore public access on next launch.
        try { await this.lanSettings.set(desired); }
        catch (error) { await this.closeNetwork(); throw error; }
        await this.closeNetwork();
        if (selectionError) throw selectionError;
      } else {
        await this.closeNetwork();
        try { await this.lanSettings.set(desired); }
        catch (error) { this.networkMode = previous; throw error; }
      }
      this.networkMode = desired;
      this.setConnection({ state: 'not-started' });
      this.update({ phase: 'ready', public: false });
    })().catch(error => {
      this.setConnection({ state: 'unavailable', message: error.message });
      this.update({ phase: 'ready', public: false }); throw error;
    }).finally(() => { this.networkChanging = null; });
  }
  async closeNetwork() {
    clearInterval(this.lanTimer); this.lanTimer = null;
    const monitor = this.monitor, tunnel = this.tunnel, relay = this.relay;
    this.monitor = null; this.tunnel = null; this.relay = null;
    this.relayStarting = null; this.relayUrl = null; this.inviteOrigin = null; this.activeLanAddress = null;
    let failure;
    for (const resource of [monitor, tunnel, relay]) {
      try { await resource?.close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  failLan(error) {
    return this.lanFailing ??= (async () => {
      this.revokeAll();
      try { await this.closeNetwork(); }
      finally {
        this.setConnection({ state: 'unavailable', message: error.message });
        this.update({ phase: 'ready', public: false });
      }
    })().finally(() => { this.lanFailing = null; });
  }
  async checkLanAddress() {
    if (this.closed || this.networkChanging || !this.networkMode.intranetOnly || !this.activeLanAddress) return;
    try { this.dependencies.selectLanAddress(this.activeLanAddress); }
    catch (error) { await this.failLan(error); throw error; }
    this.owner?.checkConnections?.();
  }
  async checkConnection() {
    if (this.closed) throw new Error('共享服务已关闭');
    if (this.networkChanging) throw new Error('正在切换访问范围，请等待完成');
    if (this.networkMode.intranetOnly) {
      if (this.activeLanAddress) await this.checkLanAddress(); else await this.ensureRelay();
      return;
    }
    if (this.monitor) await this.monitor.check();
    else await this.ensureRelay();
  }
  rebuildRelay() {
    return this.rebuilding ??= this.replaceRelay().finally(() => { this.rebuilding = null; });
  }
  async replaceRelay() {
    if (this.closed) throw new Error('共享服务已关闭');
    if (this.networkChanging) throw new Error('正在切换访问范围，请等待完成');
    if (this.networkMode.intranetOnly) {
      this.revokeAll(); await this.closeNetwork();
      return this.ensureRelay({ replacement: true });
    }
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
    this.setConnection({ state: 'online', checkedAt: Date.now(), failures: 0 });
  }
  async connectRelay() {
    const o = this.options, signal = this.abort.signal;
    signal.throwIfAborted();
    if (this.networkMode.intranetOnly) {
      this.setConnection({ state: 'connecting' });
      const address = this.dependencies.selectLanAddress(this.networkMode.lanAddress ?? undefined);
      this.relay = await this.dependencies.startRelay({ host: '127.0.0.1', port: 0, lanAddress: address,
        registrationSecret: this.registrationSecret, publicDir: path.join(o.resourceRoot, 'public') });
      signal.throwIfAborted();
      this.dependencies.selectLanAddress(address);
      this.activeLanAddress = address; this.relayUrl = this.relay.url; this.inviteOrigin = this.relay.inviteOrigin;
      if (!this.inviteOrigin) throw new Error('内网中继未提供访客地址');
      this.relay.setAllowedOrigins([this.inviteOrigin]);
      this.lanTimer = setInterval(() => { void this.checkLanAddress().catch(() => {}); }, o.lanCheckIntervalMs ?? 5000);
      this.lanTimer.unref?.();
      this.setConnection({ state: 'local' }); this.update({ phase: 'ready', public: false }); return this.relayUrl;
    }
    if (o.relayUrl) { this.relayUrl = o.relayUrl; this.inviteOrigin = new URL(o.relayUrl).origin; this.monitorPublic(this.relayUrl); this.update({ public: true }); return this.relayUrl; }
    if (!this.relay) {
      this.relay = await this.dependencies.startRelay({ host: o.bind ?? '127.0.0.1', port: o.port ?? 0,
        registrationSecret: this.registrationSecret, publicDir: path.join(o.resourceRoot, 'public') });
    }
    signal.throwIfAborted();
    if (!o.publicMode && !o.lazyPublic) {
      this.relayUrl = o.origin ? new URL(o.origin).origin : this.relay.url;
      this.inviteOrigin = this.relayUrl;
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
      this.tunnel = tunnel;
      tunnel.child?.once('exit', () => {
        if (!this.closed && this.tunnel === tunnel) {
          this.tunnel = null; void this.monitor?.close(); this.monitor = null;
          this.pauseSharing(); this.relayStarting = null;
          this.setConnection({ state: 'stopped' }); this.update({ public: false, phase: 'ready' });
        }
      });
      this.monitorPublic(tunnel.url);
      this.relayUrl = tunnel.url; this.inviteOrigin = tunnel.url; this.update({ phase: 'ready', public: true }); return this.relayUrl;
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
      await this.networkChanging?.catch(() => {});
      await this.lanFailing?.catch(() => {});
      await this.dispose(); this.update({ phase: 'stopped', rooms: 0, pending: 0, public: false });
    })();
  }
}
