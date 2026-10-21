import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, prepare, isolatedEnv, ownsProcess, compareIdentity, readJson, resolveCli } from '../lib/runtime.mjs';

test('dedicated home uses file credentials, preserves config, and inherits no provider secrets', async t => {
  const root = await fs.mkdtemp('/tmp/coop-runtime-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = paths(root);
  await prepare(p);
  const config = path.join(p.codexHome, 'config.toml');
  assert.match(await fs.readFile(config, 'utf8'), /cli_auth_credentials_store = "file"/);
  await fs.writeFile(config, 'existing = true\n');
  await prepare(p);
  assert.equal(await fs.readFile(config, 'utf8'), 'existing = true\n');
  const env = isolatedEnv(p);
  assert.equal(env.CODEX_HOME, p.codexHome);
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SSH_AUTH_SOCK', 'CODEX_AUTH_JSON']) assert.equal(key in env, false);
  assert.equal((await fs.stat(p.runtimeDir)).mode & 0o777, 0o700);
});

test('an unowned or reused PID cannot authorize stop', () => {
  assert.equal(ownsProcess({ pid: process.pid, processFingerprint: 'different-process' }, paths('/tmp/fake')), false);
  assert.equal(ownsProcess(null, paths('/tmp/fake')), false);
});

test('relative CLI overrides fail before spawn changes the working directory', () => {
  assert.throws(() => resolveCli('./codex'), /absolute path/);
});

test('account baseline waits for login and detects changes without replacing its evidence', async t => {
  const root = await fs.mkdtemp('/tmp/coop-identity-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = paths(root);
  await prepare(p);
  const empty = { authenticated: false, type: null, identityHash: null, workspaceHash: null };
  assert.equal((await compareIdentity(p, empty)).baselineRecorded, false);
  const first = { authenticated: true, type: 'chatgpt', identityHash: 'a', workspaceHash: 'workspace-a' };
  assert.equal((await compareIdentity(p, first)).unchanged, true);
  assert.equal((await compareIdentity(p, { ...first, workspaceHash: 'workspace-b' })).unchanged, false);
  assert.deepEqual(await readJson(p.baselineFile), first);
});

test('interrupt during backend handshake cleans the spawned child and lifecycle lock', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp('/tmp/coop-interrupt-');
  const p = paths(root);
  const backendFile = path.join(root, 'fake-backend.mjs');
  const readyFile = path.join(root, 'child-pid');
  const fakeCli = path.join(root, 'fake-cli');
  const runnerFile = path.join(root, 'runner.mjs');
  const runtimeUrl = new URL('../lib/runtime.mjs', import.meta.url).href;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(backendFile, `import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';\nconst socket=process.argv.at(-1).slice(7);fs.mkdirSync(path.dirname(socket),{recursive:true});const server=net.createServer(()=>{}); server.listen(socket,()=>fs.writeFileSync(${JSON.stringify(readyFile)},String(process.pid)));\n`);
  await fs.writeFile(fakeCli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(backendFile)} "$@"\n`, { mode: 0o700 });
  await fs.writeFile(runnerFile, `import {start,paths} from ${JSON.stringify(runtimeUrl)}; try { await start(paths(${JSON.stringify(root)}),${JSON.stringify(fakeCli)}); process.exitCode=3; } catch { process.exitCode=2; }\n`);
  const runner = spawn(process.execPath, [runnerFile], { stdio: 'ignore' });
  const exited = once(runner, 'exit');
  let childPid;
  t.after(async () => {
    // On readiness failure, let start() clean its detached child before resorting
    // to a forced stop of the test runner.
    if (runner.exitCode == null && runner.signalCode == null) {
      runner.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (runner.exitCode == null && runner.signalCode == null) runner.kill('SIGKILL');
    }
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await fs.rm(root, { recursive: true, force: true });
  });
  // Parallel suites also spawn Node/Codex processes; allow startup scheduling
  // time while still sending SIGINT only after the synthetic listener is ready.
  const readyDeadline = Date.now() + 8000;
  while (Date.now() < readyDeadline) {
    try { childPid = Number(await fs.readFile(readyFile, 'utf8')); break; } catch {}
    if (runner.exitCode != null || runner.signalCode != null) break;
    await delay(20);
  }
  assert.ok(childPid, 'synthetic child reached listen/handshake phase');
  runner.kill('SIGINT');
  const [code, signal] = await exited;
  assert.equal(signal, null, 'parent catches the signal and performs cleanup');
  assert.equal(code, 2);
  await assert.rejects(fs.stat(path.join(p.runtimeDir, 'lifecycle.lock')), { code: 'ENOENT' });
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  childPid = null;
});

test('startup retires only a dead socket alias and preserves its target', async t => {
  const root = await fs.mkdtemp('/tmp/coop-stale-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = paths(root);
  await prepare(p);
  await fs.mkdir(path.dirname(p.socketPath), { recursive: true });
  const target = path.join(root, 'missing-daemon-socket');
  await fs.symlink(target, p.socketPath);
  const { start } = await import('../lib/runtime.mjs');
  await assert.rejects(start(p, '/nonexistent-codex-test-binary'), /ENOENT/);
  await assert.rejects(fs.lstat(p.socketPath), { code: 'ENOENT' });
  assert.equal(await readJson(p.stateFile), null);
  await fs.writeFile(p.socketPath, 'unowned regular file');
  await assert.rejects(start(p, '/nonexistent-codex-test-binary'), /not an owned socket/);
  assert.equal(await fs.readFile(p.socketPath, 'utf8'), 'unowned regular file');
});
