import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { assertPrivateFile, assertProtectedPath, ensurePrivateDirectory, platformBridgePath,
  WINDOWS_DESKTOP_PIPE, connectWindowsDesktop, writePrivateFile } from '../lib/platform.mjs';
import { desktopIpcPath } from '../lib/desktop-ipc.mjs';

const run = promisify(execFile);

test('private-file checks use synthetic regular files, enforce size and reject aliases', async t => {
  // Explicit creation security keeps this synthetic fixture owned by the
  // current SID even when a Windows CI runner has an elevated default owner.
  const root = process.platform === 'win32' ? path.join(os.tmpdir(), 'co2-platform-' + randomUUID()) : await fs.mkdtemp(path.join(os.tmpdir(), 'co2-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await ensurePrivateDirectory(root);
  const file = path.join(root, 'synthetic.json');
  await writePrivateFile(file, '{}');
  await assert.rejects(writePrivateFile(file, 'replacement'), /EEXIST|creation failed/);
  assert.equal(await fs.readFile(file, 'utf8'), '{}', 'private creation never overwrites an existing file');
  await assertPrivateFile(file, undefined, { maxBytes: 2 });
  await assert.rejects(assertPrivateFile(file, undefined, { maxBytes: 1 }), /私有文件/);
  await assert.rejects(assertPrivateFile(root), /私有文件/);
  await assertProtectedPath(root, { directory: true, privateAccess: true });
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias.json'); await fs.symlink(file, alias);
    await assert.rejects(assertPrivateFile(alias), /私有文件/);
    await assert.rejects(assertProtectedPath(alias), /Unsafe/);
    await fs.chmod(file, 0o644);
    await assert.rejects(assertPrivateFile(file), /私有文件/);
    // The read-only index check preserves the existing POSIX write-protection
    // policy; it does not tighten permissions on Desktop-owned files.
    await assertProtectedPath(file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  }
});

test('Windows bridge and endpoint selection fail closed without a packaged absolute helper', async () => {
  assert.throws(() => platformBridgePath({}), /unavailable/);
  assert.throws(() => platformBridgePath({ CO2_PLATFORM_BRIDGE: 'CodexCo2.exe' }), /unavailable/);
  assert.equal(WINDOWS_DESKTOP_PIPE, '\\\\.\\pipe\\codex-ipc');
  if (process.platform === 'win32') assert.equal(desktopIpcPath(), WINDOWS_DESKTOP_PIPE);
  await assert.rejects(connectWindowsDesktop('\\\\remote-host\\pipe\\codex-ipc'), /Unsupported/);
  await assert.rejects(connectWindowsDesktop('\\\\.\\pipe\\another-app'), /Unsupported/);
});

test('Windows native ACL and authenticated connected pipe use disposable synthetic objects', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  // CI builds the actual native shell and explicitly supplies its path. Missing
  // bridge support is a failure on Windows, never a silently skipped integration.
  const { stdout } = await run(platformBridgePath(), ['--co2-platform', 'security-self-test'], {
    windowsHide: true, timeout: 20000, maxBuffer: 16384,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true, privateAcl: true, broadAclRejected: true,
    connectedServerUserVerified: true, binaryPipeRoundtrip: true });
});
