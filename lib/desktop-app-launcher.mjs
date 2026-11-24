import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory, writePrivateFile } from './platform.mjs';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { safeMessage: message });

async function replacePrivateFile(file, content) {
  const before = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (before && (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || (before.mode & 0o077))) {
    throw fail('Co² 桥接安装目录权限不安全，请检查运行目录。');
  }
  if (before && (await fs.readFile(file)).equals(Buffer.from(content))) return;
  const temporary = path.join(path.dirname(file), `.bridge-${randomUUID()}.tmp`);
  await writePrivateFile(temporary, content);
  try {
    const current = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (Boolean(current) !== Boolean(before) || current && (current.ino !== before.ino || current.dev !== before.dev
      || current.mtimeMs !== before.mtimeMs || current.size !== before.size)) throw fail('Co² 桥接文件在安装时发生变化，请重新连接。');
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function installedDesktopExecutables(appPath = '/Applications/ChatGPT.app') {
  if (process.platform !== 'darwin' || !path.isAbsolute(appPath)) throw fail('此版本的自动桥接仅支持 macOS。');
  const root = await fs.realpath(appPath);
  const locate = async relative => {
    const file = await fs.realpath(path.join(root, relative));
    if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile()) throw fail('官方 Desktop 运行组件不可用。');
    return file;
  };
  return {
    cliPath: await locate('Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    nodePath: await locate('Contents/Resources/cua_node/bin/node'),
  };
}

// Installs only the reviewed bridge shipped with Co², using the official CLI's
// local marketplace commands. No registry, downloaded code or shell is involved.
export async function createDesktopAppLauncher({ runtimeDir, resourceRoot, appPath, execute = run, signal, installWaitMs = 30000,
  executables, openUrl = (url, { background = false } = {}) =>
    execute('/usr/bin/open', background ? ['-g', url] : [url], { timeout: 10000, maxBuffer: 16384 }) }) {
  const { cliPath, nodePath } = executables ?? await installedDesktopExecutables(appPath);
  if (![runtimeDir, resourceRoot, cliPath, nodePath].every(path.isAbsolute)) throw new Error('Absolute bridge paths required');
  const source = await fs.readFile(path.join(resourceRoot, 'plugins/co2-desktop-bridge/server.mjs'));
  const runtimeId = hash(runtimeDir).slice(0, 12);
  const marketplaceName = `codex-co2-local-${runtimeId}`;
  // Desktop merges MCP servers by name across installed marketplaces. Different
  // Co² runtimes must not hide one another's App entrypoint in that catalog.
  const serverName = `co2_desktop_bridge_${runtimeId}`;
  const mcpManifest = { mcpServers: { [serverName]: {
    command: nodePath, args: ['./server.mjs'], cwd: '.',
    env_vars: ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_TOOLS_CALLER_HOST_ID'],
    env: { CO2_BRIDGE_RUNTIME_DIR: runtimeDir }, startup_timeout_sec: 10, tool_timeout_sec: 30,
  } } };
  // Manifest changes must get a fresh plugin cache version, even when the
  // JavaScript bytes are unchanged (for example an official runtime relocation).
  const version = `0.1.0-${hash(Buffer.concat([source, Buffer.from(JSON.stringify(mcpManifest))])).slice(0, 12)}`;
  const pluginName = 'co2-desktop-bridge';
  const pluginId = `${pluginName}@${marketplaceName}`;
  const marketplace = path.join(runtimeDir, 'desktop-app-plugin');
  const plugin = path.join(marketplace, 'plugins', pluginName);
  const link = `codex://plugins/${encodeURIComponent(pluginId)}/app/start_bridge`;
  let installing;
  const json = value => JSON.stringify(value, null, 2) + '\n';
  async function prepare() {
    for (const directory of [runtimeDir, marketplace, path.join(marketplace, '.agents/plugins'), plugin, path.join(plugin, '.codex-plugin')]) {
      await ensurePrivateDirectory(directory);
    }
    await replacePrivateFile(path.join(plugin, 'server.mjs'), source);
    await replacePrivateFile(path.join(plugin, '.codex-plugin/plugin.json'), json({ name: pluginName, version,
      description: 'Connect the local Codex Co² manager to explicitly selected Desktop conversations.', mcpServers: './.mcp.json' }));
    await replacePrivateFile(path.join(plugin, '.mcp.json'), json(mcpManifest));
    await replacePrivateFile(path.join(marketplace, '.agents/plugins/marketplace.json'), json({ name: marketplaceName,
      interface: { displayName: 'Codex Co² Local Bridge' }, plugins: [{ name: pluginName,
        source: { source: 'local', path: `./plugins/${pluginName}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }));
  }
  const options = { timeout: 10000, maxBuffer: 65536, windowsHide: true, signal };
  async function installedVersion() {
    let current;
    try {
      const listing = await execute(cliPath, ['plugin', 'list', '--marketplace', marketplaceName, '--json'], options);
      current = JSON.parse(listing.stdout).installed.find(entry => entry.pluginId === pluginId && entry.installed === true);
    } catch { throw fail('无法查询 Co² 本地桥接插件，请检查 Codex 的插件管理。'); }
    if (current?.enabled === false) throw fail('Co² 桥接插件已停用。请在 Codex 的插件管理中启用后重新连接。');
    if (!current) return null;
    if (current.enabled !== true || current.source?.source !== 'local' || current.source.path !== plugin
      || current.marketplaceSource?.sourceType !== 'local' || current.marketplaceSource.source !== marketplace)
      throw fail('无法核实 Co² 桥接插件的本地来源。');
    return current.version;
  }
  async function install() {
    await prepare();
    if (await installedVersion() === version) return;
    // Desktop owns the install so its running plugin manager sees the change.
    // An external CLI installation can leave Desktop showing a stale detail page.
    try {
      const { stdout } = await execute(cliPath, ['plugin', 'marketplace', 'add', marketplace, '--json'], options);
      const result = JSON.parse(stdout);
      if (result.marketplaceName !== marketplaceName || result.installedRoot !== marketplace) throw new Error('Unexpected marketplace');
    } catch { throw fail('无法注册 Co² 本地桥接插件，请确认官方 Desktop 支持本地插件后重试。'); }
    const detail = new URL(`codex://plugins/${pluginName}`);
    detail.searchParams.set('marketplacePath', path.join(marketplace, '.agents/plugins/marketplace.json'));
    await openUrl(detail.href);
    const deadline = Date.now() + installWaitMs;
    while (true) {
      signal?.throwIfAborted();
      if (await installedVersion() === version) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail('请在 Codex 的桥接插件详情页确认安装或更新，然后回 Co² 点「重新连接 Codex」。');
      await delay(Math.min(2000, remaining), undefined, { signal });
    }
  }
  const ensureInstalled = () => installing ??= install().finally(() => { installing = null; });
  async function openBridge() {
    // Desktop reuses an already-open App. A fresh target updates its host
    // context, allowing that same page to request a new bridge connection.
    const target = `/?nonce=${randomUUID()}`;
    try { await openUrl(`${link}?path=${encodeURIComponent(target)}`); }
    catch { throw fail('无法打开 Co² 桥接入口，请在 Codex 中打开本地桥接插件。'); }
  }
  return {
    cliPath, pluginId, link, version, prepare, ensureInstalled, openBridge,
    isInstalled: async () => await installedVersion() === version,
    async launch() {
      await ensureInstalled();
      await openBridge();
    },
    async wakeThread(threadId) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId ?? '')) throw new Error('Invalid thread ID');
      await openUrl(`codex://threads/wake/${threadId}`, { background: true });
    },
  };
}
