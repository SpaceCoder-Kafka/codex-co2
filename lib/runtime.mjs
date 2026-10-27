import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from './rpc.mjs';
import { assertPrivateFile, ensurePrivateDirectory, windowsProcessIdentity, writePrivateFile } from './platform.mjs';

export const CODEX_VERSION = '0.163.0';
const hash = value => createHash('sha256').update(value).digest('hex');
export function paths(root, { runtimeDir: explicitRuntimeDir, shortSocket = false } = {}) {
  root = path.resolve(root);
  const runtimeDir = explicitRuntimeDir ? path.resolve(explicitRuntimeDir) : path.join(root, '.coop');
  const codexHome = path.join(runtimeDir, 'home');
  return {
    root, runtimeDir, codexHome,
    workspace: path.join(runtimeDir, 'workspace'),
    socketPath: shortSocket ? path.join(runtimeDir, 'rpc.sock') : path.join(codexHome, 'app-server-control', 'app-server-control.sock'),
    stateFile: path.join(runtimeDir, 'server.json'),
    logFile: path.join(runtimeDir, 'server.log'),
    eventsFile: path.join(runtimeDir, 'observations.ndjson'),
    baselineFile: path.join(runtimeDir, 'identity-baseline.json'),
  };
}
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writePrivateFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
}
export function binaryVersion(binary) {
  return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function resolveCli(explicit) {
  const requested = explicit ?? process.env.CODEX_COOP_CLI;
  if (requested && !path.isAbsolute(requested)) throw new Error('CODEX_COOP_CLI / --cli must be an absolute path');
  const triple = process.platform === 'win32' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc` : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const candidates = [requested,
    path.join(os.homedir(), '.codex', 'packages', 'app-server-daemon', 'releases', `${CODEX_VERSION}-${triple}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    'codex'];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const version = binaryVersion(candidate);
      if (version !== `codex-cli ${CODEX_VERSION}`) throw new Error(`Expected ${CODEX_VERSION}, got ${version}`);
      let absolute = candidate;
      if (!path.isAbsolute(candidate)) {
        absolute = process.platform === 'win32'
          ? execFileSync('where.exe', [candidate], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
          : execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', candidate], { encoding: 'utf8' }).trim();
      }
      return { cliPath: absolute, version };
    } catch (error) { if (candidate === candidates[0] && candidates[0]) throw error; }
  }
  throw new Error(`Codex ${CODEX_VERSION} not found. Set CODEX_COOP_CLI to an existing exact-version binary; no automatic upgrade.`);
}
export async function prepare(p) {
  // macOS sockaddr_un has a small path limit. Fail before launching anything.
  if (Buffer.byteLength(p.socketPath) > 103) throw new Error('Unix socket path exceeds 103 bytes. Use a shorter project path.');
  for (const dir of [p.runtimeDir, p.codexHome, p.workspace]) {
    await ensurePrivateDirectory(dir);
  }
  try {
    await fs.writeFile(path.join(p.codexHome, 'config.toml'),
      'cli_auth_credentials_store = "file"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
export function isolatedEnv(p) {
  // Deliberately do not inherit OPENAI_API_KEY, provider overrides, auth socket or parent Codex variables.
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return { ...env, CODEX_HOME: p.codexHome };
}
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const identity = process.platform === 'win32' ? windowsProcessIdentity(pid) : execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return identity ? { fingerprint: hash(identity), identity } : null;
  } catch { return null; }
}
export function ownsProcess(state, p) {
  const current = state && processIdentity(state.pid);
  return Boolean(current && current.fingerprint === state.processFingerprint && current.identity.includes(`unix://${p.socketPath}`));
}
export async function socketOpen(socketPath) {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function retireStaleSocket(socketPath) {
  const stat = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return;
  if ((!stat.isSocket() && !stat.isSymbolicLink()) || stat.uid !== process.getuid()) throw new Error('Test socket path is not an owned socket; refusing to replace it.');
  const errorCode = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); reject(new Error('A listener occupies the test socket; refusing to take over.')); });
    socket.once('error', error => resolve(error.code));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Cannot determine socket ownership/readiness.')); });
  });
  if (errorCode === 'ENOENT' && !stat.isSymbolicLink()) return;
  if (!['ECONNREFUSED', 'ENOENT'].includes(errorCode)) throw new Error(`Cannot retire test socket: ${errorCode}`);
  const current = await fs.lstat(socketPath);
  if (current.ino !== stat.ino || current.dev !== stat.dev || current.ctimeMs !== stat.ctimeMs) throw new Error('Socket changed during startup; refusing to replace it.');
  await fs.unlink(socketPath); // For a stale daemon link, remove only the link, never its target.
}
// Recovery uses an exclusive claim file so concurrent launchers cannot both
// remove a dead owner's lease. An interrupted recovery claim is deliberately
// ambiguous and requires inspection; it never authorizes removal of a live PID.
async function openLifecycleLease(file, { recoverStale = false } = {}) {
  const create = () => fs.open(file, 'wx', 0o600);
  try { return await create(); }
  catch (error) { if (error.code !== 'EEXIST' || !recoverStale || process.platform === 'win32') throw error; }
  const claimFile = `${file}.recovering`;
  const claim = await fs.open(claimFile, 'wx', 0o600);
  try {
    await claim.writeFile(JSON.stringify({ pid: process.pid, ...processIdentity(process.pid) }));
    await claim.sync();
    const old = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await old.stat();
      await assertPrivateFile(file, stat, { maxBytes: 16384 });
      const raw = await old.readFile('utf8');
      let record; try { record = JSON.parse(raw); } catch { throw new Error('Unrecognized service lease'); }
      // Old lifecycle locks contained only a PID. They are recoverable only
      // when the kernel confirms that PID does not exist.
      if (Number.isSafeInteger(record)) record = { pid: record };
      if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1) throw new Error('Unrecognized service lease');
      let dead = false;
      try { process.kill(record.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') dead = true; else throw new Error('Cannot verify service lease owner'); }
      if (!dead) {
        const current = processIdentity(record.pid);
        if (!current || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint)
          || current.fingerprint === record.fingerprint) throw new Error('Service operation locked by a live or unidentified process');
      }
      const current = await fs.lstat(file);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('Service lease changed during recovery');
      await fs.unlink(file);
    } finally { await old.close(); }
    // An ordinary concurrent launcher may win this atomic create. Never
    // remove its new lease; the caller then safely reports EEXIST.
    return await create();
  } finally { await claim.close(); await fs.unlink(claimFile); }
}
async function releaseLifecycleLease(file, handle) {
  const owned = await handle.stat(); await handle.close();
  const current = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (current && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(file);
}
export async function withLock(p, action, { runtimeOnly = false, recoverStale = false } = {}) {
  if (runtimeOnly) {
    await ensurePrivateDirectory(p.runtimeDir);
  } else await prepare(p);
  const lock = path.join(p.runtimeDir, 'lifecycle.lock');
  let handle;
  try { handle = await openLifecycleLease(lock, { recoverStale }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Lifecycle operation locked. If no other command is running, inspect and remove ${lock}.`);
  }
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error('Lifecycle command interrupted'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, ...processIdentity(process.pid) }));
    await handle.sync();
    controller.signal.throwIfAborted();
    return await action(controller.signal);
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
    await releaseLifecycleLease(lock, handle);
  }
}
export async function start(p, cliPath) {
  if (process.platform === 'win32') throw new Error('Windows production support attaches to the existing official Desktop; isolated Unix backend startup is unsupported');
  return withLock(p, async signal => {
    const previous = await readJson(p.stateFile);
    assertCurrentLocation(previous, p);
    if (ownsProcess(previous, p)) {
      if (!await socketOpen(p.socketPath)) throw new Error('Owned backend exists but its socket is unavailable. Inspect server.log; do not spawn a second backend.');
      return { ...previous, alreadyRunning: true };
    }
    if (await socketOpen(p.socketPath)) throw new Error('An unowned listener occupies the test socket; refusing to take over.');
    await retireStaleSocket(p.socketPath);
    const log = await fs.open(p.logFile, 'a', 0o600);
    let child;
    const cancelChild = () => child?.kill('SIGTERM');
    signal.addEventListener('abort', cancelChild);
    try {
      signal.throwIfAborted();
      child = spawn(cliPath, ['app-server', '--listen', `unix://${p.socketPath}`], {
        cwd: p.workspace, env: isolatedEnv(p), detached: true, stdio: ['ignore', log.fd, log.fd],
      });
      let spawnError;
      child.on('error', error => { spawnError = error; });
      for (let i = 0; i < 100; i++) {
        signal.throwIfAborted();
        if (spawnError) throw spawnError;
        if (child.exitCode != null || child.signalCode != null) throw new Error('Backend exited during startup; inspect .coop/server.log.');
        if (await socketOpen(p.socketPath)) break;
        if (i === 99) throw new Error('Backend did not listen within 10 seconds; inspect .coop/server.log.');
        await delay(100);
      }
      const client = await RpcClient.connect(p.socketPath);
      client.close();
      signal.throwIfAborted();
      const identity = processIdentity(child.pid);
      if (!identity) throw new Error('Unable to identify child process');
      const state = { pid: child.pid, cliPath, version: CODEX_VERSION, socketPath: p.socketPath, codexHome: p.codexHome,
        workspace: p.workspace, startedAt: new Date().toISOString(), processFingerprint: identity.fingerprint };
      await writeJson(p.stateFile, state);
      signal.throwIfAborted();
      child.unref();
      return state;
    } catch (error) {
      child?.kill('SIGTERM');
      if (child?.pid) {
        for (let i = 0; i < 30 && child.exitCode == null && child.signalCode == null; i++) await delay(100);
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }
      throw error;
    } finally { signal.removeEventListener('abort', cancelChild); await log.close(); }
  });
}
export async function stop(p) {
  return withLock(p, async () => {
    const state = await readJson(p.stateFile);
    if (!state) return { stopped: false, reason: 'No owned backend state' };
    assertCurrentLocation(state, p);
    if (!ownsProcess(state, p)) {
      if (await socketOpen(p.socketPath)) throw new Error('Socket is active but PID identity does not match; refusing to stop it.');
      await fs.unlink(p.stateFile);
      return { stopped: false, reason: 'Recorded backend no longer exists' };
    }
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 100 && ownsProcess(state, p); i++) await delay(100);
    if (ownsProcess(state, p)) throw new Error('Owned backend did not exit; no forced kill was sent.');
    await fs.unlink(p.stateFile);
    return { stopped: true, pid: state.pid };
  });
}
export function assertCurrentLocation(state, p) {
  if (state && (state.socketPath !== p.socketPath || state.codexHome !== p.codexHome || state.workspace !== p.workspace)) {
    throw new Error('Runtime location changed. Close the previous test Desktop and services, then run npm run migrate before starting or stopping here.');
  }
}

// An exclusive lease protects the launcher and sharing state from another helper.
// A crash leaves evidence for inspection; never unlink a live or ambiguous lease.
export async function acquireServiceLease(p, name, { runtimeOnly = false, recoverStale = false } = {}) {
  return withLock(p, async () => {
    const file = path.join(p.runtimeDir, `${name}.lock`);
    let handle;
    try { handle = await openLifecycleLease(file, { recoverStale }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`Service operation locked. Inspect ${file}; stop the recorded service before retrying. Remove the lock only after confirming it is stale.`);
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, ...processIdentity(process.pid) })); await handle.sync(); }
    catch (error) { await releaseLifecycleLease(file, handle); throw error; }
    let released = false;
    return async () => { if (!released) { released = true; await releaseLifecycleLease(file, handle); } };
  }, { runtimeOnly, recoverStale });
}
export async function accountIdentity(client, p) {
  const { account } = await client.request('account/read', { refreshToken: false });
  let workspaceId = account?.workspaceId ?? account?.accountId ?? null;
  // Read only THIS prototype's auth store. JWT is decoded for identity, never logged or used as verification.
  const auth = await readJson(path.join(p.codexHome, 'auth.json'));
  workspaceId ??= auth?.tokens?.account_id ?? null;
  if (!workspaceId && auth?.tokens?.id_token) {
    try {
      const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url'));
      workspaceId = claims['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
    } catch { /* identity field unavailable */ }
  }
  return { authenticated: account != null, type: account?.type ?? null,
    identityHash: account ? hash(JSON.stringify({ type: account.type, email: account.email ?? null })) : null,
    workspaceHash: workspaceId ? hash(workspaceId) : null };
}
export async function compareIdentity(p, identity) {
  let baseline = await readJson(p.baselineFile);
  if (!baseline && identity.authenticated) {
    baseline = identity;
    await writeJson(p.baselineFile, baseline);
  }
  return { baselineRecorded: baseline != null, unchanged: baseline ? JSON.stringify(baseline) === JSON.stringify(identity) : null };
}
