import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeLanSettings, openLanSettings } from '../lib/lan-settings.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/co2-lan-settings-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.coop'); await fs.mkdir(dir, { mode: 0o700 });
  return { root, file: path.join(dir, 'lan-sharing.json') };
}

test('LAN settings require a boolean mode and a canonical private address without extra capabilities', () => {
  assert.deepEqual(normalizeLanSettings({ intranetOnly: true, lanAddress: null }), { intranetOnly: true, lanAddress: null });
  for (const invalid of [null, [], {}, { intranetOnly: 'true', lanAddress: null },
    { intranetOnly: false, lanAddress: '192.168.1.2' }, { intranetOnly: true, lanAddress: '0.0.0.0' },
    { intranetOnly: true, lanAddress: 'https://internal.example' }, { intranetOnly: true, lanAddress: '192.168.001.2' },
    { intranetOnly: true, lanAddress: '192.168.1.2', registrationSecret: 'not-a-setting' }]) {
    assert.throws(() => normalizeLanSettings(invalid));
  }
});

test('private LAN intent persists across reopen, sequential writes and caller mutation', async t => {
  const { file } = await fixture(t), settings = await openLanSettings(file);
  assert.deepEqual(settings.get(), { intranetOnly: false, lanAddress: null });
  const value = { intranetOnly: true, lanAddress: '192.168.1.2' };
  const first = settings.set(value); value.intranetOnly = false;
  const second = settings.set({ intranetOnly: true, lanAddress: null });
  await Promise.all([first, second]); await settings.flush();
  const reopened = await openLanSettings(file);
  assert.deepEqual(reopened.get(), { intranetOnly: true, lanAddress: null }, 'missing address retains private intent instead of enabling public fallback');
  const copy = reopened.get(); copy.intranetOnly = false;
  assert.equal(reopened.get().intranetOnly, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, intranetOnly: true, lanAddress: null });
});

test('settings never follow a symlink on open or replace, and do not alter its target', async t => {
  const { root, file } = await fixture(t), other = path.join(root, 'unrelated-synthetic-file');
  await fs.writeFile(other, 'Synthetic private bytes', { mode: 0o600 });
  const settings = await openLanSettings(file);
  await fs.symlink(other, file);
  await assert.rejects(openLanSettings(file));
  await assert.rejects(settings.set({ intranetOnly: true, lanAddress: '10.0.0.2' }));
  assert.equal(await fs.readFile(other, 'utf8'), 'Synthetic private bytes');
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
});

test('malformed, oversized and publicly readable settings fail closed and cannot be overwritten silently', async t => {
  const { file } = await fixture(t), settings = await openLanSettings(file);
  for (const value of ['not-json', ' '.repeat(4097), JSON.stringify({ version: 2, intranetOnly: false, lanAddress: null }),
    JSON.stringify({ version: 1, intranetOnly: false, lanAddress: null, unknown: true })]) {
    await fs.writeFile(file, value, { mode: 0o600 });
    await assert.rejects(openLanSettings(file));
    await assert.rejects(settings.set({ intranetOnly: false, lanAddress: null }));
    assert.equal(await fs.readFile(file, 'utf8'), value);
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, intranetOnly: true, lanAddress: null }));
  await fs.chmod(file, 0o644);
  await assert.rejects(openLanSettings(file), /私有/);
  await assert.rejects(settings.set({ intranetOnly: false, lanAddress: null }), /私有/);
  await fs.chmod(file, 0o600);
  await settings.set({ intranetOnly: true, lanAddress: '172.16.0.2' });
  assert.equal((await openLanSettings(file)).get().lanAddress, '172.16.0.2', 'rejected write does not poison the next explicit save');
});
