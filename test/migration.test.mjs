import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { paths, prepare, writeJson, readJson, start, stop, acquireServiceLease } from '../lib/runtime.mjs';
import { migrateRuntime } from '../lib/migration.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/co2-migrate-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = paths(path.join(root, 'new')), old = paths(path.join(root, 'old'));
  await prepare(p);
  const state = { pid: 2147483647, socketPath: old.socketPath, codexHome: old.codexHome, workspace: old.workspace };
  await writeJson(p.stateFile, state);
  await fs.writeFile(path.join(p.runtimeDir, 'Open-Test-Desktop.command'), 'old-launcher');
  return { p, old, state };
}

test('start and stop refuse relocated state without overwriting it or spawning a backend', async t => {
  const { p, state } = await fixture(t);
  await assert.rejects(start(p, '/nonexistent'), /npm run migrate/);
  await assert.rejects(stop(p), /npm run migrate/);
  assert.deepEqual(await readJson(p.stateFile), state);
});

test('migration archives private control records and preserves home, history, profile and SSH markers byte for byte', async t => {
  const { p, old, state } = await fixture(t);
  const files = ['home/auth.json', 'home/state_5.sqlite', 'home/sessions/old.jsonl', 'desktop-profile/Preferences',
    'workspace/example.txt', 'ssh/cleanup.json', 'identity-baseline.json', 'observations.ndjson'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(p.runtimeDir, file)), { recursive: true });
    await fs.writeFile(path.join(p.runtimeDir, file), `synthetic-only ${file} ${old.root}`);
  }
  const before = await Promise.all(files.map(file => fs.readFile(path.join(p.runtimeDir, file))));
  const result = await migrateRuntime(p);
  assert.equal(result.migrated, true);
  assert.equal(result.from, old.root);
  assert.equal(await fs.readlink(old.runtimeDir), p.runtimeDir);
  assert.equal(await fs.readFile(path.join(old.codexHome, 'sessions/old.jsonl'), 'utf8'), `synthetic-only home/sessions/old.jsonl ${old.root}`);
  assert.deepEqual(await readJson(path.join(result.archive, 'server.json')), state);
  assert.equal(await fs.readFile(path.join(result.archive, 'Open-Test-Desktop.command'), 'utf8'), 'old-launcher');
  assert.equal((await fs.stat(result.archive)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(result.archive, 'server.json'))).mode & 0o777, 0o600);
  assert.equal(await readJson(p.stateFile), null);
  await assert.rejects(fs.stat(path.join(p.runtimeDir, 'Open-Test-Desktop.command')), { code: 'ENOENT' });
  const after = await Promise.all(files.map(file => fs.readFile(path.join(p.runtimeDir, file))));
  assert.deepEqual(after, before);
  assert.equal((await migrateRuntime(p)).migrated, false);
});

test('migration refuses live recorded processes, separate old storage and an occupied new socket', async t => {
  const { p, old, state } = await fixture(t);
  await writeJson(path.join(p.runtimeDir, 'desktop-bridge-process.json'), { pid: process.pid });
  await assert.rejects(migrateRuntime(p), /still exists/);
  await fs.unlink(path.join(p.runtimeDir, 'desktop-bridge-process.json'));
  await fs.mkdir(old.runtimeDir, { recursive: true });
  await assert.rejects(migrateRuntime(p), /previous .coop directory still exists/);
  await fs.rm(old.root, { recursive: true });
  await fs.mkdir(path.dirname(p.socketPath), { recursive: true });
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(p.socketPath, resolve));
  try { await assert.rejects(migrateRuntime(p), /socket is active/); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(await readJson(p.stateFile), state);
  assert.deepEqual((await fs.readdir(p.runtimeDir)).filter(name => name === 'migrations'), []);
});

test('service lease prevents a second helper and prevents migration until released', async t => {
  const { p } = await fixture(t);
  const release = await acquireServiceLease(p, 'sharing');
  try {
    await assert.rejects(acquireServiceLease(p, 'sharing'), /locked/);
    await assert.rejects(migrateRuntime(p), /sharing.lock/);
  } finally { await release(); }
  const releaseAgain = await acquireServiceLease(p, 'sharing');
  await releaseAgain();
  assert.equal((await migrateRuntime(p)).migrated, true);
});
