import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openShareHistory } from '../lib/share-history.mjs';

test('share history persists only bounded metadata, deduplicates and survives restart without old invitations', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-history-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json'), history = await openShareHistory(file);
  for (let i = 0; i < 55; i++) history.remember({ threadId: `thread-${i}`, title: 'Synthetic title', ownerName: 'A', requireApproval: true,
    lastSharedAt: i, inviteToken: 'NEVER-SAVE', text: 'NEVER-SAVE', inviteUrl: 'NEVER-SAVE', guests: ['NEVER-SAVE'] });
  history.remember({ threadId: 'thread-54', title: 'Renamed', ownerName: 'A', requireApproval: false, lastSharedAt: 99 });
  await history.flush(); assert.equal(history.failed, false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const raw = await fs.readFile(file, 'utf8'); assert.ok(!raw.includes('NEVER-SAVE'));
  assert.deepEqual(Object.keys(JSON.parse(raw).entries[0]).sort(), ['lastSharedAt', 'ownerName', 'requireApproval', 'threadId', 'title']);
  const restored = await openShareHistory(file); assert.equal(restored.list().length, 50);
  assert.equal(restored.list()[0].title, 'Renamed'); assert.equal(restored.list()[0].requireApproval, false);
  const entries = restored.list(); entries[0].title = 'Do not mutate'; assert.equal(restored.list()[0].title, 'Renamed');
});

test('history refuses symlinks, public permissions and incompatible data; write failure does not lose in-memory metadata', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-history-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target'); await fs.writeFile(target, '{}', { mode: 0o600 });
  const link = path.join(dir, 'link'); await fs.symlink(target, link);
  await assert.rejects(openShareHistory(link));
  await fs.chmod(target, 0o644); await assert.rejects(openShareHistory(target), /私有/);
  await fs.chmod(target, 0o600); await assert.rejects(openShareHistory(target), /格式/);
  const history = await openShareHistory(path.join(dir, 'missing-parent', 'history'));
  history.remember({ threadId: 'synthetic', title: 'Synthetic', ownerName: 'A', requireApproval: true, lastSharedAt: 1 });
  await history.flush(); assert.equal(history.failed, true); assert.equal(history.list().length, 1);
});
