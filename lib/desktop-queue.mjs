import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { attachmentInput, trustedAttachments } from './guest-uploads.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const imageMimeTypes = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp']]);
const base64Length = bytes => 4 * Math.ceil(bytes / 3);
const error = (code, outcome, message) => Object.assign(new Error(message), { code, outcome, safeMessage: message });
const unavailable = () => error('DESKTOP_QUEUE_UNAVAILABLE', 'notSubmitted', '无法启动 Codex 消息提交接口，消息尚未提交。');
const unknown = () => error('DESKTOP_QUEUE_UNKNOWN', 'unknown', '消息可能已进入 Codex 队列，但未收到可靠确认。请在 Codex 中核实，不要重复发送。');
const closedError = () => error('DESKTOP_QUEUE_CLOSED', 'notSubmitted', '消息提交连接已关闭，消息尚未提交。');
const revoked = () => error('SUBMISSION_REVOKED', 'notSubmitted', '本次消息提交授权已失效，消息尚未提交。');

function hasFileDescription(text) {
  // Desktop skips its annotation envelope when finding the first request delimiter.
  const annotations = '\n# Response annotations:\n';
  if (text.startsWith(annotations)) {
    const openTag = '\n<response-annotations>\n', endTag = '\n</response-annotations>\n';
    const start = text.indexOf(openTag, annotations.length);
    const end = start < 0 ? -1 : text.indexOf(endTag, start + openTag.length);
    if (end >= 0) text = text.slice(end + endTag.length);
  }
  const delimiter = text.search(/## My request(?: for Codex)?:/);
  if (delimiter < 0) return false;
  const preamble = text.slice(0, delimiter);
  for (const [heading, row] of [
    ['# Files mentioned by the user:', /^##\s+.+: \s*(?:[/\\]|[a-z]:[/\\])/i],
    ['# Files pasted by the user:', /^##\s+"(?:[^"\\]|\\.)*"\s*: \s*(?:[/\\]|[a-z]:[/\\])/i],
  ]) {
    const start = preamble.indexOf(heading);
    if (start >= 0 && row.test(preamble.slice(start + heading.length).trimStart().split('\n', 1)[0])) return true;
  }
  return false;
}

function containsDesktopFileContext(text) {
  if (hasFileDescription(text)) return true;
  // Native queue restoration unwraps Desktop's multi-user sender envelope
  // before recovering file metadata. Inspect the same text for that case.
  const sender = /^\[from: [^\]\r\n]+\](?:\r?\n|$)/.exec(text);
  if (sender && hasFileDescription(text.slice(sender[0].length))) return true;
  const start = text.lastIndexOf('<codex_multi_user_message>'), endTag = '</codex_multi_user_message>';
  const end = start < 0 ? -1 : text.indexOf(endTag, start);
  if (end < 0) return false;
  const envelope = text.slice(start, end);
  if (!['account_user_id', 'name', 'email', 'profile_picture_url'].every(tag =>
    new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>', 'i').test(envelope))) return false;
  const body = /<body>([\s\S]*?)<\/body>/i.exec(envelope)?.[1];
  if (body === undefined) return false;
  const decoded = body.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
  return hasFileDescription(text.slice(0, start) + decoded + text.slice(end + endTag.length));
}

export function normalizeDesktopQueueInput(input, attachments = []) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 128 ||
      !trustedAttachments(attachments) || attachments.includes(undefined) || new Set(attachments).size !== attachments.length) throw unavailable();
  if (attachments.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_BYTES) throw unavailable();
  const expected = attachments.length ? attachmentInput('', attachments) : null;
  if (expected && (input.length !== expected.length || typeof input[0]?.text !== 'string' ||
      !input[0].text.startsWith(expected[0].text) || input[0].text.length - expected[0].text.length > 8000)) throw unavailable();
  const result = Array.from(input, (item, index) => {
    if (expected && index > 0) {
      const image = expected[index];
      // The native protocol may echo the default image detail as null.
      if (item?.type !== 'localImage' || item.path !== image.path || item.detail != null ||
          Object.keys(item).some(key => !['type', 'path', 'detail'].includes(key))) throw unavailable();
      return image;
    }
    if (item?.type !== 'text' || typeof item.text !== 'string' ||
        Object.keys(item).some(key => !['type', 'text', 'text_elements'].includes(key)) ||
        (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length))) throw unavailable();
    return { type: 'text', text: item.text, text_elements: [] };
  });
  if (!result.some(item => item.type === 'text' && item.text.trim()) || Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES) throw unavailable();
  if (!expected && containsDesktopFileContext(result.map(part => part.text).join('\n'))) {
    throw error('DESKTOP_QUEUE_FILE_CONTEXT', 'notSubmitted', '文字中包含 Codex 会识别为附件的文件描述。请通过附件按钮选择文件，或移除文件描述后再发送。');
  }
  return result;
}

// Native localImage serialization may convert GIFs to PNG or resize large
// images. Serialize verified originals so both the agent and receipt keep them.
function queueRequest(entry, images) {
  for (const file of entry.attachments) if (!file.image) file.verify();
  const { threadId, clientUserMessageId, input } = entry;
  if (!images.length) return JSON.stringify({ id: 2, method: 'thread/queue/add', params: { threadId, clientUserMessageId, input } }) + '\n';
  const parts = ['{"id":2,"method":"thread/queue/add","params":{"threadId":', JSON.stringify(threadId),
    ',"clientUserMessageId":', JSON.stringify(clientUserMessageId), ',"input":['];
  for (const [index, item] of input.entries()) {
    if (index) parts.push(',');
    if (item.type === 'text') { parts.push(JSON.stringify(item)); continue; }
    const file = images[index - 1], mime = imageMimeTypes.get(path.extname(file.path).toLowerCase());
    if (!mime) throw unavailable();
    parts.push('{"type":"image","url":"data:' + mime + ';base64,', file, '"}');
  }
  parts.push(']}}\n');
  // One wire buffer and at most one source file. Encoding the whole request
  // with JSON.stringify would keep additional full-size base64 strings alive.
  const length = parts.reduce((size, part) => size + (typeof part === 'string' ? Buffer.byteLength(part) : base64Length(part.size)), 0);
  const wire = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const part of parts) {
    if (typeof part === 'string') { offset += wire.write(part, offset); continue; }
    const bytes = part.readImageBytes();
    if (!Buffer.isBuffer(bytes) || bytes.length !== part.size) throw unavailable();
    for (let pos = 0; pos < bytes.length; pos += 48 * 1024) {
      offset += wire.write(bytes.toString('base64', pos, Math.min(pos + 48 * 1024, bytes.length)), offset, 'ascii');
    }
  }
  if (offset !== length) throw unavailable();
  return wire;
}

// A receipt can confirm only the specific bytes authorized at each position.
function echoesImage(part, file) {
  const mime = file && imageMimeTypes.get(path.extname(file.path).toLowerCase());
  if (!mime || typeof part.url !== 'string' || part.detail != null ||
      Object.keys(part).some(key => !['type', 'url', 'detail'].includes(key))) return false;
  const prefix = 'data:' + mime + ';base64,', url = part.url;
  if (!url.startsWith(prefix) || url.length !== prefix.length + base64Length(file.size)) return false;
  const hash = createHash('sha256');
  let size = 0;
  for (let offset = prefix.length; offset < url.length; offset += 65536) {
    const encoded = url.slice(offset, offset + 65536), bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || offset + encoded.length < url.length && encoded.endsWith('=')) return false;
    size += bytes.length; hash.update(bytes);
  }
  return size === file.size && hash.digest('hex') === file.sha256;
}

function receiptMatches(input, entry, images) {
  if (!Array.isArray(input) || input.length !== entry.input.length) return false;
  const echoed = input.map((part, index) => {
    if (entry.input[index].type !== 'localImage') return part;
    if (part?.type !== 'image' || !echoesImage(part, images[index - 1])) throw unknown();
    return entry.input[index];
  });
  return JSON.stringify(normalizeDesktopQueueInput(echoed, entry.attachments)) === JSON.stringify(entry.input);
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
    entry.settled = true; entry.input = undefined; entry.attachments = undefined; entry.canDispatch = undefined; entry.reject(reason);
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
      let done = false, stopping = false, phase = 'initialize', bytes = 0, stopTimer, killTimer, deadline;
      let partial = Buffer.alloc(0), lineBytes = 0;
      const images = entry.attachments.filter(file => file.image);
      const receiptBytes = images.reduce((limit, file) => limit + base64Length(file.size), MAX_OUTPUT_BYTES);
      let workerDone;
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
        // An async approval callback cannot authorize a synchronous dispatch.
        const authorized = () => {
          try {
            const decision = entry.canDispatch?.();
            if (decision && typeof decision.then === 'function') Promise.resolve(decision).catch(() => {});
            return decision === true;
          } catch { return false; }
        };
        const allowed = authorized();
        if (closed || entry.settled) return abort(closedError());
        if (!allowed) return abort(revoked());
        let wire;
        try { wire = queueRequest(entry, images); }
        catch { return abort(error('ATTACHMENT_INVALID', 'notSubmitted', '附件已失效或发生变化，消息尚未提交。')); }
        // A lease can expire while the host verifies and encodes larger files.
        if (entry.attachments.length && !authorized()) return abort(revoked());
        if (closed || entry.settled) return abort(closedError());
        phase = 'queue'; entry.sent = true;
        try { child.stdin.write(wire); } catch { abort(); }
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
          if (!UUID.test(queued?.id ?? '') || queued.clientUserMessageId !== entry.clientUserMessageId ||
              !receiptMatches(queued.input, entry, images)) return abort(unknown());
          entry.settled = true; entry.input = undefined; entry.attachments = undefined; entry.canDispatch = undefined; phase = 'accepted';
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
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        const limit = phase === 'queue' ? receiptBytes : MAX_OUTPUT_BYTES;
        if (bytes > limit) return abort();
        // Search only new bytes. A large image receipt can span
        // thousands of pipe reads, including reads that split a UTF-8 character.
        for (let start = 0; !entry.settled && start < data.length;) {
          const end = data.indexOf(10, start), piece = data.subarray(start, end < 0 ? data.length : end);
          if (end < 0 || lineBytes) {
            const needed = lineBytes + piece.length;
            if (needed > partial.length) {
              const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(4096, needed, partial.length * 2)));
              partial.copy(grown, 0, 0, lineBytes); partial = grown;
            }
            piece.copy(partial, lineBytes); lineBytes = needed;
          }
          if (end < 0) break;
          const line = lineBytes ? partial.toString('utf8', 0, lineBytes) : piece.toString('utf8');
          partial = Buffer.alloc(0); lineBytes = 0; start = end + 1;
          if (line.trim()) try { receive(JSON.parse(line)); } catch { abort(); }
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
    submit({ threadId, input, attachments = [], clientUserMessageId, canDispatch } = {}) {
      if (closed) return Promise.reject(closedError());
      let normalized;
      try {
        if (typeof threadId !== 'string' || typeof clientUserMessageId !== 'string' ||
            !UUID.test(threadId) || !UUID.test(clientUserMessageId)) throw unavailable();
        normalized = normalizeDesktopQueueInput(input, attachments);
        attachments = [...attachments];
      } catch (e) { return Promise.reject(e); }
      const digest = createHash('sha256').update(JSON.stringify([threadId, normalized, attachments.map(a => a.path)])).digest('hex');
      let entry = entries.get(clientUserMessageId);
      if (entry && entry.digest !== digest) return Promise.reject(error('DESKTOP_QUEUE_DUPLICATE_ID', 'notSubmitted', '消息标识已用于其他内容，未重复提交。'));
      if (!entry) {
        entry = { threadId, input: normalized, attachments, clientUserMessageId, canDispatch, digest, sent: false, settled: false };
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
