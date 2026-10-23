import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanPublicFile, publicSource } from '../scripts/public-source.mjs';
import { npmNotices } from '../scripts/third-party-notices.mjs';

test('public scan rejects private paths and credentials without exposing values', () => {
  for (const name of ['.coop/state.json', 'dist/app.txt', '.env.local', 'secret.pem', 'capture.har', 'installer.exe', 'app.msi', 'debug.pdb', 'dependency.nupkg']) {
    assert.throws(() => scanPublicFile(name, Buffer.from('synthetic')), /Private export path/);
  }
  const samples = [
    ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' '),
    'ghp_' + 'x'.repeat(40),
    ['https:', '', 'user:password@example.invalid'].join('/'),
    ['', 'Users', 'synthetic', 'private'].join('/'),
    ['C:', 'Users', 'synthetic', 'private'].join('\\'),
    ['codex-co2', 'doc'].join('-'),
  ];
  for (const value of samples) {
    assert.throws(() => scanPublicFile('README.md', Buffer.from(value)), error => !error.message.includes(value) && /Public scan:/.test(error.message));
  }
  scanPublicFile('LICENSE', Buffer.from('Synthetic project license'));
});

test('public inventory binds content and rejects path escapes and parent symlinks', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-export-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  const list = path.join(root, 'scripts/public-files.json');
  await fs.writeFile(list, JSON.stringify(['scripts/public-files.json', 'hello.txt']));
  await fs.writeFile(path.join(root, 'hello.txt'), 'first');
  const first = await publicSource(root);
  await fs.writeFile(path.join(root, 'hello.txt'), 'second');
  assert.notEqual((await publicSource(root)).sha256, first.sha256);
  await fs.writeFile(list, JSON.stringify(['scripts/public-files.json', '../outside']));
  await assert.rejects(publicSource(root), /Unsafe export path/);
  await fs.mkdir(path.join(root, 'real'));
  await fs.writeFile(path.join(root, 'real/file'), 'synthetic');
  await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
  await fs.writeFile(list, JSON.stringify(['scripts/public-files.json', 'link/file']));
  await assert.rejects(publicSource(root), /Non-regular public file/);
});

test('license collection binds versions and preserves complete notices', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-license-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'node_modules/example'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0', license: 'MIT', resolved: 'https://example.invalid/synthetic', integrity: 'synthetic' } } }));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', license: 'MIT' }));
  await fs.writeFile(path.join(dir, 'LICENSE'), 'Full synthetic license text');
  await fs.writeFile(path.join(dir, 'NOTICE'), 'Full synthetic copyright notice');
  const notices = await npmNotices(root);
  assert.match(notices, /Full synthetic license text/); assert.match(notices, /Full synthetic copyright notice/);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'example', version: '2.0.0', license: 'MIT' }));
  await assert.rejects(npmNotices(root), /Lockfile metadata mismatch/);
});

test('required integration entry rejects a version-matching launcher before starting suites', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-launcher-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'codex');
  await fs.writeFile(launcher, '#!/bin/sh\necho codex-cli 0.163.0\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-integration.mjs', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, CODEX_COOP_CLI: launcher },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native Codex executable/);
  assert.doesNotMatch(result.stdout, /TAP version/);
});
