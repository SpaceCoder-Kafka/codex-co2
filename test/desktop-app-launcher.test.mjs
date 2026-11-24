import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopAppLauncher } from '../lib/desktop-app-launcher.mjs';

const resourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('queue wake requests background delivery while opening the bridge stays interactive', async () => {
  const calls = [];
  const launcher = await createDesktopAppLauncher({ runtimeDir: '/synthetic/runtime', resourceRoot,
    executables: { cliPath: '/synthetic/official/codex', nodePath: '/synthetic/official/node' },
    execute: async (file, args) => { calls.push({ file, args }); } });
  const threadId = '00000000-0000-4000-8000-000000000001';
  await launcher.wakeThread(threadId);
  await launcher.openBridge();
  assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-g', `codex://threads/wake/${threadId}`] });
  assert.equal(calls[1].file, '/usr/bin/open');
  assert.equal(calls[1].args.length, 1);
  assert.ok(calls[1].args[0].startsWith(launcher.link + '?path='));
});

test('bootstrap installs only bundled local source and uses official URLs without starting a model', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-launcher-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const calls = [], urls = [];
  let installed;
  const execute = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'list') return { stdout: JSON.stringify({ installed: installed ? [installed] : [] }) };
    assert.equal(args[1], 'marketplace');
    return { stdout: JSON.stringify({ marketplaceName: launcher.pluginId.split('@')[1], installedRoot: args[3] }) };
  };
  const marketplace = path.join(runtimeDir, 'desktop-app-plugin');
  const plugin = path.join(marketplace, 'plugins/co2-desktop-bridge');
  const openUrl = async url => {
    urls.push(url);
    if (new URL(url).searchParams.get('marketplacePath') !== path.join(marketplace, '.agents/plugins/marketplace.json')) return;
    installed = { pluginId: launcher.pluginId, version: launcher.version, installed: true, enabled: true,
      source: { source: 'local', path: plugin }, marketplaceSource: { sourceType: 'local', source: marketplace } };
  };
  const launcher = await createDesktopAppLauncher({ runtimeDir, resourceRoot,
    executables: { cliPath: '/synthetic/official/codex', nodePath: '/synthetic/official/node' }, execute, openUrl });
  await Promise.all([launcher.launch(), launcher.launch()]);
  assert.deepEqual(calls.map(c => c.args[1]), ['list', 'marketplace', 'list']);
  assert.ok(calls.every(c => c.file === '/synthetic/official/codex' && c.args[0] === 'plugin'));
  assert.equal(calls.some(c => c.args.includes('exec') || c.args.includes('thread/start')), false);
  assert.equal(new URL(urls[0]).pathname, '/co2-desktop-bridge');
  assert.ok(urls.slice(1).every(value => {
    const url = new URL(value);
    return url.protocol === 'codex:' && url.hostname === 'plugins'
      && url.pathname === `/${encodeURIComponent(launcher.pluginId)}/app/start_bridge`
      && /^\/\?nonce=[a-f0-9-]{36}$/.test(url.searchParams.get('path'));
  }));
  assert.equal(new Set(urls).size, 3);
  assert.equal(new URL(launcher.link).search, '');
  const manifestPath = path.join(runtimeDir, 'desktop-app-plugin/plugins/co2-desktop-bridge/.mcp.json');
  const servers = JSON.parse(await fs.readFile(manifestPath, 'utf8')).mcpServers;
  assert.equal(Object.keys(servers).length, 1);
  assert.match(Object.keys(servers)[0], /^co2_desktop_bridge_[a-f0-9]{12}$/);
  const mcp = Object.values(servers)[0];
  assert.equal(mcp.command, '/synthetic/official/node');
  assert.deepEqual(mcp.env, { CO2_BRIDGE_RUNTIME_DIR: runtimeDir });
  assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(path.join(runtimeDir, 'desktop-app-plugin/plugins/co2-desktop-bridge/server.mjs')),
    await fs.readFile(path.join(resourceRoot, 'plugins/co2-desktop-bridge/server.mjs')));
  await launcher.launch(); // A one-click reconnect can reuse generated files.
  const restarted = await createDesktopAppLauncher({ runtimeDir, resourceRoot,
    executables: { cliPath: '/synthetic/official/codex', nodePath: '/synthetic/official/node' }, execute,
    openUrl });
  await restarted.launch(); // A new Co² process can reuse the same runtime.
  assert.deepEqual(calls.map(c => c.args[1]), ['list', 'marketplace', 'list', 'list', 'list']);
  assert.equal(new Set(urls).size, 5); // Each retry reaches an already-open App.
  await launcher.wakeThread('00000000-0000-4000-8000-000000000001');
  assert.equal(urls.at(-1), 'codex://threads/wake/00000000-0000-4000-8000-000000000001');
  await assert.rejects(launcher.wakeThread('../other-command'));
  installed.enabled = false;
  const urlCount = urls.length;
  await assert.rejects(restarted.launch(), /已停用/);
  assert.equal(calls.at(-1).args[1], 'list');
  assert.equal(urls.length, urlCount);
  installed.enabled = true;
  installed.version = 'old';
  await restarted.launch();
  assert.deepEqual(calls.slice(-3).map(c => c.args[1]), ['list', 'marketplace', 'list']);
  installed = undefined; // User uninstalled the plugin between manager launches.
  assert.equal(await restarted.isInstalled(), false);
  await restarted.launch();
  assert.equal(new URL(urls.at(-2)).searchParams.get('marketplacePath'), path.join(marketplace, '.agents/plugins/marketplace.json'));
  assert.equal(await restarted.isInstalled(), true);
});

test('different Co² runtimes cannot shadow each other in the native MCP catalog and manifest upgrades change cache versions', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-launcher-identities-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const executables = { cliPath: '/synthetic/official/codex', nodePath: '/synthetic/official/node' };
  const first = await createDesktopAppLauncher({ runtimeDir: path.join(base, 'first'), resourceRoot, executables });
  const second = await createDesktopAppLauncher({ runtimeDir: path.join(base, 'second'), resourceRoot, executables });
  await first.prepare(); await second.prepare();
  const manifest = async name => JSON.parse(await fs.readFile(path.join(base, name,
    'desktop-app-plugin/plugins/co2-desktop-bridge/.mcp.json'), 'utf8')).mcpServers;
  const firstServers = await manifest('first');
  const secondServers = await manifest('second');
  const merged = { ...firstServers, ...secondServers };
  assert.equal(Object.keys(merged).length, 2);
  assert.deepEqual(new Set(Object.values(merged).map(server => server.env.CO2_BRIDGE_RUNTIME_DIR)),
    new Set([path.join(base, 'first'), path.join(base, 'second')]));
  const movedRuntime = await createDesktopAppLauncher({ runtimeDir: path.join(base, 'first'), resourceRoot,
    executables: { ...executables, nodePath: '/synthetic/updated-official/node' } });
  assert.equal(movedRuntime.pluginId, first.pluginId);
  assert.notEqual(movedRuntime.version, first.version);
  await movedRuntime.prepare();
  assert.deepEqual(Object.keys(await manifest('first')), Object.keys(firstServers));
  const repeat = await createDesktopAppLauncher({ runtimeDir: path.join(base, 'first'), resourceRoot,
    executables: { ...executables, nodePath: '/synthetic/updated-official/node' } });
  assert.equal(repeat.version, movedRuntime.version);
});

test('an uncertain plugin install never opens the bridge or reports launch success', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-launcher-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  let opened = false;
  const launcher = await createDesktopAppLauncher({ runtimeDir, resourceRoot,
    executables: { cliPath: '/synthetic/codex', nodePath: '/synthetic/node' },
    execute: async (_file, args) => ({ stdout: args[1] === 'list' ? '{"installed":[]}' : '{"pluginId":"wrong","version":"wrong"}' }),
    openUrl: async () => { opened = true; } });
  await assert.rejects(launcher.launch(), /无法注册/);
  assert.equal(opened, false);
});

test('an unconfirmed native install leaves the running Desktop alone and keeps the bridge closed', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-install-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const urls = [], commands = [];
  const launcher = await createDesktopAppLauncher({ runtimeDir, resourceRoot, installWaitMs: 0,
    executables: { cliPath: '/synthetic/codex', nodePath: '/synthetic/node' },
    execute: async (_file, args) => {
      commands.push(args.slice(0, 2));
      return { stdout: JSON.stringify(args[1] === 'list' ? { installed: [] }
        : { marketplaceName: launcher.pluginId.split('@')[1], installedRoot: args[3] }) };
    }, openUrl: async url => urls.push(new URL(url)) });
  await assert.rejects(launcher.launch(), /确认安装或更新/);
  assert.deepEqual(commands, [['plugin', 'list'], ['plugin', 'marketplace'], ['plugin', 'list']]);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, '/co2-desktop-bridge');
  assert.equal(urls[0].searchParams.get('marketplacePath'), path.join(runtimeDir, 'desktop-app-plugin/.agents/plugins/marketplace.json'));
});
