import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { materializeImportAttachments } from './import-attachments.mjs';
import { validateImportManifest, validateImportSnapshot } from './import-handoff.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './platform.mjs';

const run = promisify(execFile);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const marker = '<EXTERNAL SESSION IMPORTED>';
const fragmentStart = '【Co² 自动生成的导入说明】这段可见历史从助手回复开始。';
const safeError = safeMessage => Object.assign(new Error(safeMessage), { safeMessage });
const unavailable = () => safeError('找不到兼容的官方 Codex Desktop。请先安装或更新 Codex Desktop，并在本机打开过一次。');

async function bundledExecutable() {
  if (process.platform === 'darwin') {
    const apps = process.env.CO2_RECEIVER_DESKTOP_APP ? [process.env.CO2_RECEIVER_DESKTOP_APP]
      : ['/Applications/ChatGPT.app', '/Applications/Codex.app'];
    for (const app of apps) {
      if (!path.isAbsolute(app)) continue;
      const file = path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
      if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
    }
  }
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // Select the installed, current-user Store package. Never execute a CLI from PATH or from the link.
    const command = "$p=Get-AppxPackage -Name OpenAI.Codex | Where-Object {$_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0'} | Select-Object -First 1; if($p){[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write($p.InstallLocation)}";
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 10000, maxBuffer: 16384 }).catch(() => ({ stdout: '' }));
    const installed = stdout.trim();
    if (path.isAbsolute(installed)) {
      for (const sub of ['app/resources/codex.exe', 'resources/codex.exe']) {
        const file = path.join(installed, sub);
        if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
      }
    }
  }
  throw unavailable();
}

function checkHistory(thread, threadId, expected) {
  if (thread?.id !== threadId || !Array.isArray(thread.turns)) return false;
  const visible = [];
  for (const turn of thread.turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') visible.push({ role: 'user', text: (item.content ?? []).map(c => c.text).join('\n') });
      if (item.type === 'agentMessage') visible.push({ role: 'assistant', text: item.text });
    }
  }
  // Codex may add one terminal import marker. A literal marker in the source is still compared.
  if (visible.length === expected.length + 1 && visible.at(-1)?.role === 'assistant' && visible.at(-1).text === marker) visible.pop();
  return visible.length === expected.length && visible.every((m, i) => m.role === expected[i].role && m.text === expected[i].text);
}

function workerEnvironment(staging, codexHome) {
  // The importer resolves ~/.claude/projects relative to this private HOME. Only the official
  // worker maintains the recipient's Codex store; Co² never reads its credentials or rollouts.
  const block = 'http://127.0.0.1:1';
  const env = { HOME: staging, USERPROFILE: staging, CODEX_HOME: codexHome, LANG: 'en_US.UTF-8',
    TMPDIR: staging, TEMP: staging, TMP: staging, HTTP_PROXY: block, HTTPS_PROXY: block, ALL_PROXY: block,
    http_proxy: block, https_proxy: block, all_proxy: block, NO_PROXY: '', no_proxy: '' };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key];
    env.PATH = path.join(process.env.SystemRoot, 'System32');
  } else env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

async function runImport(executable, { staging, codexHome, workspace, source, title, messages, markSubmitted }) {
  const child = spawn(executable, ['-c', 'cli_auth_credentials_store="ephemeral"',
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false',
    '-c', 'check_for_update_on_startup=false', 'app-server', '--listen', 'stdio://'], {
    env: workerEnvironment(staging, codexHome), cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => {}); // A spawn failure also closes stdio and delivers close.
  child.stdin.on('error', () => {}); // EPIPE is surfaced as an incomplete protocol below.
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const expired = setTimeout(() => child.kill('SIGKILL'), 45000);
  let importId, completion, threadId, submitted = false;
  try {
    send(1, 'initialize', { clientInfo: { name: 'codex_co2_import', title: 'Codex Co²', version: '1' }, capabilities: { experimentalApi: true } });
    for await (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result && !submitted) {
        send(undefined, 'initialized', {});
        submitted = true;
        markSubmitted();
        send(2, 'externalAgentConfig/import', { migrationItems: [{ itemType: 'SESSIONS', description: title,
          cwd: null, details: { sessions: [{ path: source, cwd: workspace, title }] } }] });
      } else if (msg.id === 2 && msg.result) importId = msg.result.importId;
      else if (msg.method === 'externalAgentConfig/import/completed') completion = msg.params;
      else if (msg.id === 3 && msg.result) {
        if (checkHistory(msg.result.thread, threadId, messages)) return { threadId };
        throw safeError('Codex 已创建会话，但读回的历史与导入内容不一致。请在本机 Codex 检查。');
      } else if (msg.error && [1, 2, 3].includes(msg.id)) {
        if (msg.error.code === -32601 && msg.id === 2) throw unavailable();
        throw safeError(threadId ? 'Codex 已创建会话，但无法核实导入结果。请在本机 Codex 检查。' : '本机 Codex 未能导入这段历史，请检查本机版本和可用空间。');
      }
      if (importId && completion?.importId === importId && !threadId) {
        const result = completion.itemTypeResults?.find(item => item.itemType === 'SESSIONS');
        const entry = result?.successes?.[0];
        // An import result authorizes reading exactly its freshly generated local source.
        // Windows canonical paths may carry the extended-length namespace prefix.
        const sameSource = typeof entry?.source === 'string' &&
          path.relative(path.toNamespacedPath(source), path.toNamespacedPath(entry.source)) === '';
        if (result?.failures?.length !== 0 || result?.successes?.length !== 1 || !sameSource || !uuid.test(entry?.target ?? '')) {
          throw safeError('本机 Codex 未能导入这段历史，请检查本机版本和可用空间。');
        }
        threadId = entry.target;
        send(3, 'thread/read', { threadId, includeTurns: true });
      }
    }
    throw submitted ? safeError('导入进程已结束，无法确认结果。请先在 Codex 检查是否已生成会话。') : unavailable();
  } finally {
    clearTimeout(expired);
    lines.close();
    child.stdin.end();
    const stop = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await done; } finally { clearTimeout(stop); }
  }
}

export async function importReceiverSnapshot({ snapshot, runtimeDir, fetchAsset }, local = {}) {
  const data = snapshot?.version === 2 ? validateImportManifest(snapshot) : validateImportSnapshot(snapshot);
  const executable = local.executable ?? await bundledExecutable();
  const codexHome = local.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(runtimeDir) || !path.isAbsolute(codexHome) || !(await fs.stat(codexHome).catch(() => null))?.isDirectory()) throw unavailable();
  await ensurePrivateDirectory(runtimeDir);
  const staging = await fs.mkdtemp(path.join(runtimeDir, 'receive-'));
  let workspace;
  let workerMayHaveCommitted = false;
  try {
    await ensurePrivateDirectory(staging);
    const dir = path.join(staging, '.claude', 'projects', 'shared');
    const projects = path.join(runtimeDir, 'imported-projects');
    await ensurePrivateDirectory(dir);
    await ensurePrivateDirectory(projects);
    // Reserve the directory exclusively before it can become a recursive
    // cleanup target. A pre-existing project must never be adopted or removed.
    const destination = path.join(projects, randomUUID());
    await fs.mkdir(destination, { mode: 0o700 });
    workspace = destination;
    await ensurePrivateDirectory(workspace);
    const { messages, summary } = data.version === 2
      ? await materializeImportAttachments(data, workspace, fetchAsset)
      : { messages: [...data.messages] };
    // The official importer skips assistant records until its first user record opens a turn.
    if (messages[0].role === 'assistant') messages.unshift({ role: 'user', text: fragmentStart });
    const first = Date.now() - messages.length;
    const source = path.join(dir, randomUUID() + '.jsonl');
    const rows = messages.map(({ role, text }, i) => JSON.stringify({ type: role, cwd: workspace,
      timestamp: new Date(first + i).toISOString(), message: { role, content: [{ type: 'text', text }] } }));
    const title = (data.title.trim() || 'Co² 共享会话').slice(0, 160) + (data.truncated ? '（可见片段）' : '');
    rows.push(JSON.stringify({ type: 'custom-title', customTitle: title }));
    await writePrivateFile(source, rows.join('\n') + '\n');
    const result = await runImport(executable, { staging, codexHome, workspace, source: await fs.realpath(source), title, messages,
      markSubmitted: () => { workerMayHaveCommitted = true; } });
    return summary ? { ...result, attachments: summary } : result;
  } finally {
    const cleanup = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
    await Promise.all([fs.rm(staging, cleanup), workspace && !workerMayHaveCommitted && fs.rm(workspace, cleanup)]);
  }
}
