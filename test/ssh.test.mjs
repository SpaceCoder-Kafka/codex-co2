import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareSsh, installSsh, removeSsh } from '../lib/ssh.mjs';

const exec = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-coop-ssh-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project with ' quote");
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, 'scripts', 'ssh-entry.sh'), path.join(root, 'scripts', 'ssh-entry.sh'));
  const cliPath = path.join(root, 'fake-codex');
  await fs.writeFile(cliPath, '#!/bin/sh\nif [ "$1" = --version ]; then printf "codex-cli 0.163.0\\n"; exit; fi\nprintf "%s\\n" "$CODEX_HOME" "$CODEX_SSH_SKIP_APP_SERVER_BOOT" "$@"\n', { mode: 0o700 });
  const options = { root, runtimeDir: path.join(root, 'runtime'), codexHome: path.join(root, 'private codex'), cliPath, sshDir: path.join(temp, 'user-ssh'), user: 'test-user', host: '127.0.0.1', port: 2222 };
  return { root, options, assets: await prepareSsh(options) };
}

// Mirrors the relevant nested login-shell behavior observed in Desktop's PS().
// The profile-free shim must preserve CODEX_HOME and install path across both shells.
function desktopCommand(payload) {
  const body = 'CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD; exec "$SHELL" -l -i -c \'CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME; exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"\'';
  return `sh -c ${quote(body)} sh ${quote(`PATH="\${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; ${payload}`)}`;
}

test('generates isolated keys and config, without changing SSH settings', async (t) => {
  const { options, assets } = await fixture(t);
  await assert.rejects(fs.stat(options.sshDir), { code: 'ENOENT' });
  assert.notEqual(await fs.readFile(assets.keys.a.publicPath, 'utf8'), await fs.readFile(assets.keys.b.publicPath, 'utf8'));
  assert.equal((await fs.stat(assets.keys.a.privatePath)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(assets.configBPath, 'utf8'), /Host codex-coop-b/);
  assert.match(await fs.readFile(assets.configBPath, 'utf8'), /IdentityFile "~\/\.ssh\/codex-coop-[a-f0-9]+-b"/);
  const oldKey = await fs.readFile(assets.keys.a.privatePath);
  await prepareSsh(options);
  assert.deepEqual(await fs.readFile(assets.keys.a.privatePath), oldKey, 'repeat setup must not rotate identities');
  const result = await exec('/usr/bin/ssh', ['-G', '-F', assets.configAPath, assets.aliasA]);
  assert.match(result.stdout, /^port 2222$/m);
  assert.match(result.stdout, /^identitiesonly yes$/m);
});

test('actual Desktop-style shell nesting preserves runtime and selects only proxy', async (t) => {
  const { options, assets } = await fixture(t);
  const run = (command) => exec(assets.entryPath, [], { env: { ...process.env, CODEX_HOME: '/wrong-home', CODEX_INSTALL_DIR: '/wrong-bin', SHELL: '/does-not-exist', SSH_ORIGINAL_COMMAND: desktopCommand(command) } });
  assert.equal((await run('codex --version')).stdout.trim(), 'codex-cli 0.163.0');
  const proxy = (await run('exec codex app-server proxy')).stdout.trim().split('\n');
  assert.deepEqual(proxy, [options.codexHome, 'true', 'app-server', 'proxy', '--sock', assets.socketPath]);
  assert.equal((await run('if [ "${CODEX_SSH_SKIP_APP_SERVER_BOOT:-}" = true ]; then printf skipped; else exit 99; fi')).stdout, 'skipped');
  await assert.rejects(run('codex app-server --listen unix://'), (error) => error.code === 64 && /only supports/.test(error.stderr));
  await assert.rejects(run(`pkill -9 -U "$(id -u)" -f 'codex.* app-server.* --listen'`), (error) => error.code === 64 && /Remote pkill is disabled/.test(error.stderr) && error.stdout === '');
  assert.deepEqual((await run('exec codex app-server proxy')).stdout.trim().split('\n'), proxy, 'blocked restart must leave the proxy adapter usable');
  await assert.rejects(exec(assets.entryPath, [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: '' } }), (error) => error.code === 64);
});

test('install and removal preserve unrelated SSH content and are idempotent', async (t) => {
  const { options, assets } = await fixture(t);
  await fs.mkdir(options.sshDir);
  const configPath = path.join(options.sshDir, 'config');
  const keysPath = path.join(options.sshDir, 'authorized_keys');
  const config = 'Host existing\n  HostName unrelated.local\nHost *\n  User wrong-default-user\n  Port 2223';
  const keys = 'ssh-ed25519 AAAATEST unrelated-key\n';
  await fs.writeFile(configPath, config);
  await fs.writeFile(keysPath, keys);
  await installSsh(options);
  const installedConfig = await fs.readFile(configPath, 'utf8');
  const installedKeys = await fs.readFile(keysPath, 'utf8');
  assert.equal(installedKeys.split('\n').filter((line) => line.startsWith('command=')).length, 2);
  assert.ok(installedKeys.includes('no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty'));
  const expanded = await exec('/usr/bin/ssh', ['-G', '-F', configPath, assets.aliasA]);
  assert.match(expanded.stdout, /^user test-user$/m);
  assert.match(expanded.stdout, /^port 2222$/m);
  await installSsh(options);
  assert.equal(await fs.readFile(configPath, 'utf8'), installedConfig);
  assert.equal(await fs.readFile(keysPath, 'utf8'), installedKeys);
  assert.equal((await removeSsh(options)).removed, true);
  assert.equal(await fs.readFile(configPath, 'utf8'), config);
  assert.equal(await fs.readFile(keysPath, 'utf8'), keys);
  assert.equal((await removeSsh(options)).removed, false);
  await fs.access(assets.keys.b.privatePath);
});

test('refuses conflicting aliases, damaged blocks and unfamiliar key deletion', async (t) => {
  const { options } = await fixture(t);
  await fs.mkdir(options.sshDir);
  const configPath = path.join(options.sshDir, 'config');
  const keysPath = path.join(options.sshDir, 'authorized_keys');
  await fs.writeFile(configPath, 'Host codex-coop-a\n  HostName another-machine\n');
  await assert.rejects(installSsh(options), /already exists/);
  await fs.writeFile(configPath, '');
  await installSsh(options);
  await fs.appendFile(configPath, '# user addition\n');
  const keyText = await fs.readFile(keysPath, 'utf8');
  await fs.writeFile(keysPath, keyText.replace('# END', 'ssh-ed25519 AAAAOTHER unrelated-key\n# END'));
  await assert.rejects(removeSsh(options), /unfamiliar key/);
  assert.ok((await fs.readFile(configPath, 'utf8')).includes('# BEGIN'), 'validate before changing either file');
  await fs.writeFile(keysPath, keyText.replace(/# END[^\n]*\n/, ''));
  await assert.rejects(removeSsh(options), /Malformed/);
});
