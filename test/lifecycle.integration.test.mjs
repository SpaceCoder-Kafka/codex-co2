import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, prepare, start, stop, ownsProcess, readJson, resolveCli } from '../lib/runtime.mjs';
import { migrateRuntime } from '../lib/migration.mjs';
import { RpcClient } from '../lib/rpc.mjs';
import { startResponsesFixture } from './fixtures/responses-server.mjs';

const enabled = process.env.CODEX_COOP_INTEGRATION === '1';
let cli;
if (enabled) { try { cli = resolveCli().cliPath; } catch {} }
const skip = !enabled ? 'Run npm run test:integration' : !cli ? 'Requires exact Codex 0.163.0' : false;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error('Lifecycle readiness timeout');
}

test('renamed runtime preserves synthetic history; cold start, helper close and restart use one owned backend', { skip, timeout: 60000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/co2-life-'));
  let p = paths(path.join(root, 'old'));
  const fixture = await startResponsesFixture();
  let client;
  const children = [];
  t.after(async () => {
    client?.close();
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        await Promise.race([exited, delay(3000)]);
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }
    }
    await stop(p);
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await prepare(p);
  const authFile = path.join(p.codexHome, 'auth.json');
  const auth = JSON.stringify({ OPENAI_API_KEY: 'synthetic-only' });
  await fs.writeFile(authFile, auth, { mode: 0o600 });
  await fs.writeFile(path.join(p.codexHome, 'config.toml'), `model = "gpt-5.1-codex"
model_provider = "lifecycle_test"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[features]
shell_snapshot = false
[model_providers.lifecycle_test]
name = "Local lifecycle fixture"
base_url = "${fixture.origin}/v1"
wire_api = "responses"
env_key = "COOP_SYNTHETIC_KEY"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
  // The wrapper adds synthetic-only auth and a deny proxy; runtime isolation
  // itself continues to drop all inherited provider and Codex variables.
  const wrapper = path.join(root, 'test-cli');
  await fs.writeFile(wrapper, `#!/bin/sh\nexport COOP_SYNTHETIC_KEY=synthetic-only\nexport HTTP_PROXY=${quote(fixture.origin)} HTTPS_PROXY=${quote(fixture.origin)} ALL_PROXY=${quote(fixture.origin)} NO_PROXY=localhost,127.0.0.1\nexec ${quote(cli)} "$@"\n`, { mode: 0o700 });
  const first = await start(p, wrapper);
  assert.equal((await start(p, wrapper)).pid, first.pid);
  client = await RpcClient.connect(p.socketPath);
  const { thread } = await client.request('thread/start', { cwd: p.workspace, model: 'gpt-5.1-codex', modelProvider: 'lifecycle_test', sandbox: 'read-only', approvalPolicy: 'never' });
  const done = new Promise(resolve => client.on('notification', e => { if (e.method === 'turn/completed') resolve(e.params.turn); }));
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Synthetic lifecycle persistence check' }] });
  assert.equal((await done).status, 'completed');
  client.close(); client = null;
  assert.equal((await stop(p)).stopped, true);
  assert.equal((await stop(p)).stopped, false);
  const config = await fs.readFile(path.join(p.codexHome, 'config.toml'));
  // Simulate a renamed checkout carrying its stale control state and launcher.
  await fs.writeFile(p.stateFile, JSON.stringify(first));
  await fs.writeFile(path.join(p.runtimeDir, 'Open-Test-Desktop.command'), 'retired-launcher');
  const nextRoot = path.join(root, 'new');
  await fs.rename(p.root, nextRoot); p = paths(nextRoot);
  await assert.rejects(start(p, wrapper), /npm run migrate/);
  assert.equal((await migrateRuntime(p)).migrated, true);
  assert.equal(await fs.readFile(path.join(p.codexHome, 'auth.json'), 'utf8'), auth);
  assert.deepEqual(await fs.readFile(path.join(p.codexHome, 'config.toml')), config);
  const restarted = await start(p, wrapper);
  assert.notEqual(restarted.pid, first.pid);
  client = await RpcClient.connect(p.socketPath);
  const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(history.thread.turns.length, 1);
  assert.equal(fixture.requests.length, 1, 'migration/restart must never replay input');
  client.close(); client = null;

  // Run the actual CLI from a temporary checkout, never the user's .coop.
  await fs.mkdir(path.join(p.root, 'bin'));
  await fs.copyFile(new URL('../bin/share.mjs', import.meta.url), path.join(p.root, 'bin/share.mjs'));
  for (const name of ['lib', 'owner', 'public']) await fs.symlink(new URL(`../${name}`, import.meta.url).pathname, path.join(p.root, name));
  const serviceFile = path.join(p.runtimeDir, 'host-service.json');
  const launch = () => {
    const child = spawn(process.execPath, [path.join(p.root, 'bin/share.mjs'), 'host'], {
      env: { PATH: process.env.PATH, HOME: root, CODEX_COOP_CLI: wrapper }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.errors = ''; child.stderr.on('data', data => { child.errors += data; }); children.push(child); return child;
  };
  for (let cycle = 0; cycle < 2; cycle++) {
    const child = launch();
    const info = await until(async () => {
      if (child.exitCode != null) throw new Error(child.errors);
      return readJson(serviceFile);
    });
    assert.equal(info.pid, child.pid);
    const launcher = await fs.readFile(info.desktopLauncher, 'utf8');
    assert.ok(launcher.includes(p.codexHome));
    assert.ok(!launcher.includes(path.join(root, 'old')));
    assert.ok(ownsProcess(restarted, p));
    const duplicate = launch();
    const [code] = await once(duplicate, 'exit');
    assert.equal(code, 1);
    assert.match(duplicate.errors, /locked/);
    assert.equal(await fs.readFile(info.desktopLauncher, 'utf8'), launcher);
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    assert.equal(await readJson(serviceFile), null);
    await assert.rejects(fs.stat(info.desktopLauncher), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(p.runtimeDir, 'sharing.lock')), { code: 'ENOENT' });
    assert.ok(ownsProcess(restarted, p), 'helper exit preserves the owned real backend');
  }
  await stop(p);
  const cold = await start(p, wrapper);
  assert.notEqual(cold.pid, restarted.pid);
  client = await RpcClient.connect(p.socketPath);
  assert.equal((await client.request('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns.length, 1);
  assert.equal(fixture.requests.length, 1);
});
