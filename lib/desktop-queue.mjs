import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const error = (code, outcome, message) => Object.assign(new Error(message), { code, outcome, safeMessage: message });
const unavailable = () => error('DESKTOP_QUEUE_UNAVAILABLE', 'notSubmitted', '无法启动 Codex 消息提交接口，消息尚未提交。');
const unknown = () => error('DESKTOP_QUEUE_UNKNOWN', 'unknown', '消息可能已进入 Codex 队列，但未收到可靠确认。请在 Codex 中核实，不要重复发送。');
const closedError = () => error('DESKTOP_QUEUE_CLOSED', 'notSubmitted', '消息提交连接已关闭，消息尚未提交。');
const revoked = () => error('SUBMISSION_REVOKED', 'notSubmitted', '本次消息提交授权已失效，消息尚未提交。');

function textInput(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 128) throw unavailable();
  const result = input.map(item => {
    if (!item || item.type !== 'text' || typeof item.text !== 'string' ||
        Object.keys(item).some(key => !['type', 'text', 'text_elements'].includes(key)) ||
        (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length))) throw unavailable();
    return { type: 'text', text: item.text, text_elements: [] };
  });
  if (!result.some(item => item.text.trim()) || Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES) throw unavailable();
  return result;
}

function workerEnvironment(environment) {
  const env = {};
  // Keep the user's normal Codex location, but do not pass credentials, injected
  // runtimes or remote/daemon routing overrides to this no-generation worker.
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'APPDATA',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) if (typeof environment[key] === 'string') env[key] = environment[key];
  env.PATH = process.platform === 'win32' ? path.join(environment.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin';
  env.CODEX_APP_SERVER_USE_LOCAL_DAEMON = '0';
  const block = 'http://127.0.0.1:1';
  Object.assign(env, { HTTP_PROXY: block, HTTPS_PROXY: block, ALL_PROXY: block,
    http_proxy: block, https_proxy: block, all_proxy: block, NO_PROXY: '', no_proxy: '' });
  return env;
}

// This writer uses the installed official CLI only to append one message to an
// existing thread's durable queue. It never starts/resumes a thread, generates a
// turn, or reads authentication, indexes or conversation files itself. Desktop
// remains the sole runtime that consumes the queue and executes its messages.
export function createDesktopQueue({ cliPath, wakeThread, spawnProcess = spawn, environment = process.env,
  timeoutMs = 10000, shutdownTimeoutMs = 1000, wakeTimeoutMs = 3000 } = {}) {
  if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath) || typeof wakeThread !== 'function' ||
      [timeoutMs, shutdownTimeoutMs, wakeTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1)) throw unavailable();
  const env = workerEnvironment(environment);
  const codexHome = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex');
  if (!path.isAbsolute(codexHome)) throw unavailable();
  const daemonSocket = path.join(codexHome, 'app-server-control', 'app-server-control.sock');
  const entries = new Map(), workers = new Set(), pendingWakes = new Map(), wakes = new Map();
  let closed = false, closing, serial = Promise.resolve(), wakeVersion = 0;

  async function checkDaemon() {
    try {
      // Only examine this endpoint; do not create directories or inspect config.
      await fs.lstat(daemonSocket);
      throw error('DESKTOP_QUEUE_DAEMON_UNSUPPORTED', 'notSubmitted', '检测到 Codex 常驻服务接口，当前提交方式无法安全使用，消息尚未提交。');
    } catch (e) { if (e.code !== 'ENOENT') throw e.code === 'DESKTOP_QUEUE_DAEMON_UNSUPPORTED' ? e : unavailable(); }
  }

  function attemptWake(threadId) {
    if (closed || !pendingWakes.has(threadId)) return Promise.resolve();
    if (wakes.has(threadId)) return wakes.get(threadId).promise;
    const version = pendingWakes.get(threadId), controller = new AbortController();
    let timer, finish;
    const bounded = new Promise(resolve => {
      finish = resolve;
      timer = setTimeout(() => { controller.abort(); resolve(false); }, wakeTimeoutMs);
      Promise.resolve().then(() => closed ? false : wakeThread(threadId, { signal: controller.signal }))
        .then(value => resolve(value !== false), () => resolve(false));
    });
    const promise = bounded.then(success => {
      if (!closed && success && pendingWakes.get(threadId) === version) pendingWakes.delete(threadId);
    }).finally(() => {
      clearTimeout(timer); wakes.delete(threadId);
      // A new accepted submission during an older wake needs its own wake.
      if (!closed && pendingWakes.has(threadId) && pendingWakes.get(threadId) !== version) void attemptWake(threadId);
    });
    wakes.set(threadId, { promise, cancel() { controller.abort(); finish(false); } });
    return promise;
  }

  function fail(entry, reason) {
    if (entry.settled) return;
    entry.settled = true; entry.input = undefined; entry.canDispatch = undefined; entry.reject(reason);
  }

  async function dispatch(entry) {
    if (entry.settled) return;
    if (closed) return fail(entry, closedError());
    try { await checkDaemon(); } catch (e) { return fail(entry, e); }
    if (closed || entry.settled) return fail(entry, closedError());
    let child;
    try {
      child = spawnProcess(cliPath, ['-c', 'cli_auth_credentials_store="ephemeral"',
        '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false',
        'app-server', '--listen', 'stdio://'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return fail(entry, unavailable()); }

    await new Promise(resolve => {
      let done = false, stopping = false, phase = 'initialize', bytes = 0, buffer = '', stopTimer, killTimer, deadline;
      let workerDone;
      const decoder = new StringDecoder('utf8');
      const worker = { stop, done: new Promise(r => { workerDone = r; }) };
      workers.add(worker);
      function finish() {
        if (done) return; done = true;
        clearTimeout(deadline); clearTimeout(stopTimer); clearTimeout(killTimer);
        workers.delete(worker); workerDone(); resolve();
      }
      function stop() {
        if (stopping || done) return; stopping = true;
        clearTimeout(deadline);
        try { child.stdin?.end(); } catch {}
        if (done) return;
        stopTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          if (done) return;
          killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            finish();
          }, shutdownTimeoutMs);
        }, shutdownTimeoutMs);
      }
      function abort(reason) { fail(entry, reason ?? (entry.sent ? unknown() : unavailable())); stop(); }
      function send(message) {
        try { child.stdin.write(JSON.stringify(message) + '\n'); }
        catch { abort(); }
      }
      async function initialized() {
        // Do not accidentally append through a second writer if a daemon has
        // appeared while the official worker was initializing.
        try { await checkDaemon(); } catch (e) { return abort(e); }
        if (closed || entry.settled) return abort(closedError());
        let allowed = false;
        try {
          const decision = entry.canDispatch?.();
          allowed = decision === true;
          // Admission is synchronous. A mistakenly async callback must neither
          // authorize dispatch nor leave a rejected promise unhandled.
          if (decision && typeof decision.then === 'function') Promise.resolve(decision).catch(() => {});
        } catch {}
        if (closed || entry.settled) return abort(closedError());
        if (!allowed) return abort(revoked());
        // Nothing asynchronous may intervene between admission and dispatch.
        phase = 'queue'; entry.sent = true;
        send({ id: 2, method: 'thread/queue/add', params: { threadId: entry.threadId,
          input: entry.input, clientUserMessageId: entry.clientUserMessageId } });
      }
      function receive(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return abort();
        if (message.id === 1 && phase === 'initialize') {
          if (message.error || !message.result || typeof message.result.userAgent !== 'string') return abort(unavailable());
          phase = 'admission'; send({ method: 'initialized', params: {} });
          if (!entry.settled) void initialized();
        } else if (message.id === 2 && phase === 'queue') {
          if (message.error) return abort([-32600, -32601, -32602].includes(message.error.code)
            ? error('DESKTOP_QUEUE_REJECTED', 'rejected', 'Codex 拒绝了消息提交请求，消息未获接收确认。') : unknown());
          const queued = message.result?.queuedSubmission;
          let echoed;
          try { echoed = textInput(queued?.input); } catch { return abort(unknown()); }
          if (!UUID.test(queued?.id ?? '') || queued.clientUserMessageId !== entry.clientUserMessageId ||
              JSON.stringify(echoed) !== JSON.stringify(entry.input)) return abort(unknown());
          entry.settled = true; entry.input = undefined; entry.canDispatch = undefined; phase = 'accepted';
          pendingWakes.set(entry.threadId, ++wakeVersion);
          entry.resolve({ id: queued.id, clientUserMessageId: entry.clientUserMessageId });
          stop();
          queueMicrotask(() => { if (!closed) void attemptWake(entry.threadId); });
        }
      }
      child.once('error', () => abort());
      child.once('exit', () => { if (!entry.settled) fail(entry, entry.sent ? unknown() : unavailable()); finish(); });
      child.once('close', () => { if (!entry.settled) fail(entry, entry.sent ? unknown() : unavailable()); finish(); });
      child.stdin?.on('error', () => abort());
      child.stdout?.on('error', () => abort());
      child.stdout?.on('data', chunk => {
        if (entry.settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return abort();
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        for (let newline; !entry.settled && (newline = buffer.indexOf('\n')) !== -1;) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try { receive(JSON.parse(line)); } catch { abort(); }
        }
      });
      deadline = setTimeout(() => abort(), timeoutMs);
      if (!child.stdin || !child.stdout) return abort(unavailable());
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'codex_co2_queue', title: 'Codex Co²', version: '1' }, capabilities: { experimentalApi: true },
      } });
    });
  }

  return {
    submit({ threadId, input, clientUserMessageId, canDispatch } = {}) {
      if (closed) return Promise.reject(closedError());
      let normalized;
      try {
        if (typeof threadId !== 'string' || typeof clientUserMessageId !== 'string' ||
            !UUID.test(threadId) || !UUID.test(clientUserMessageId)) throw unavailable();
        normalized = textInput(input);
      } catch (e) { return Promise.reject(e); }
      const digest = createHash('sha256').update(JSON.stringify([threadId, normalized])).digest('hex');
      let entry = entries.get(clientUserMessageId);
      if (entry && entry.digest !== digest) return Promise.reject(error('DESKTOP_QUEUE_DUPLICATE_ID', 'notSubmitted', '消息标识已用于其他内容，未重复提交。'));
      if (!entry) {
        entry = { threadId, input: normalized, clientUserMessageId, canDispatch, digest, sent: false, settled: false };
        entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        entries.set(clientUserMessageId, entry);
        serial = serial.then(() => dispatch(entry)).catch(() => fail(entry, entry.sent ? unknown() : unavailable()));
      }
      return entry.promise.then(result => ({ ...result, wakePending: pendingWakes.has(threadId) }));
    },
    async wakePending() {
      if (!closed) await Promise.all([...pendingWakes.keys()].map(attemptWake));
      return { pending: pendingWakes.size };
    },
    get pendingWakeCount() { return pendingWakes.size; },
    close() {
      if (closing) return closing;
      closed = true; pendingWakes.clear();
      for (const wake of wakes.values()) wake.cancel();
      for (const entry of entries.values()) if (!entry.settled) fail(entry, entry.sent ? unknown() : closedError());
      const owned = [...workers]; for (const worker of owned) worker.stop();
      closing = Promise.all(owned.map(worker => worker.done)).then(() => {});
      return closing;
    },
  };
}
