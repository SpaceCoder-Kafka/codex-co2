import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createThreadCatalog } from '../lib/thread-catalog.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-catalog-'));
  const indexPath = path.join(dir, 'synthetic.sqlite');
  const db = new DatabaseSync(indexPath);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,updated_at INTEGER,cwd TEXT,archived INTEGER,preview TEXT,first_user_message TEXT,rollout_path TEXT)');
  t.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const insert = db.prepare('INSERT INTO threads(id,title,updated_at,cwd,archived,preview,first_user_message,rollout_path) VALUES(?,?,?,?,?,?,?,?)');
  const add = (title, time, archived = 0, cwd = '/synthetic/project') => {
    const id = randomUUID();
    insert.run(id, title, time, cwd, archived, 'PRIVATE-BODY', 'PRIVATE-BODY', '/never/read/body.jsonl');
    return id;
  };
  return { dir, indexPath, db, add, catalog: createThreadCatalog({ indexPath }) };
}

test('catalog paginates all metadata, searches bound literal text, and never returns bodies or writes the index', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++) f.add(`Chat ${i}`, i);
  const archived = f.add('Archived', 1000, 1), special = f.add("Literal ' OR 1=1 --", 1001);
  const hash = async () => createHash('sha256').update(await fs.readFile(f.indexPath)).digest('hex');
  const before = await hash(), ids = new Set(); let cursor = 0;
  do {
    const page = await f.catalog.list({ cursor }); assert.equal(page.total, 206);
    for (const row of page.threads) { ids.add(row.id); assert.deepEqual(Object.keys(row), ['id', 'name', 'updatedAt', 'cwd']); }
    assert.ok(!JSON.stringify(page).includes('PRIVATE-BODY')); assert.ok(!JSON.stringify(page).includes('body.jsonl'));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(ids.size, 206); assert.ok(!ids.has(archived));
  assert.equal(await f.catalog.contains(archived), false); assert.equal(await f.catalog.contains(special), true);
  assert.deepEqual((await f.catalog.list({ search: "' OR 1=1 --" })).threads.map(t => t.id), [special]);
  assert.equal((await f.catalog.list({ search: 'missing' })).total, 0);
  assert.equal(await hash(), before);
  await assert.rejects(f.catalog.list({ cursor: -1 }), /无效/);
  f.db.exec('ALTER TABLE threads ADD COLUMN name TEXT');
  f.db.prepare('UPDATE threads SET name=? WHERE id=?').run('Renamed daily chat', special);
  assert.equal((await f.catalog.list({ search: 'Renamed daily' })).threads[0].name, 'Renamed daily chat');
});

test('refresh sees committed WAL metadata; missing/incompatible/symlinked indexes fail closed', async t => {
  const f = await fixture(t); f.db.exec('PRAGMA journal_mode=WAL');
  const id = f.add('New daily chat', 1);
  assert.equal((await f.catalog.list()).threads[0].id, id);
  f.add('Newer chat', 2); assert.equal((await f.catalog.list()).total, 2);
  const link = path.join(f.dir, 'alias.sqlite'); await fs.symlink(f.indexPath, link);
  await assert.rejects(createThreadCatalog({ indexPath: link }).list(), /只读/);
  await assert.rejects(createThreadCatalog({ indexPath: path.join(f.dir, 'missing.sqlite') }).list(), /只读/);
  f.db.exec('DROP TABLE threads'); await assert.rejects(f.catalog.list(), /只读/);
  assert.equal((await fs.readdir(f.dir)).includes('missing.sqlite'), false);
});

test('blank titles are hidden before search, count and pagination on indexes without a name column', async t => {
  const f = await fixture(t);
  const visible = Array.from({ length: 100 }, (_, i) => f.add(`Chat ${i}`, i));
  const literal = f.add('未命名会话', 100);
  visible.push(literal);
  const hidden = [null, '', ' ', '\t\r\n', '\u3000'].map((title, i) => f.add(title, 101 + i));

  for (const search of ['', '/synthetic/project']) {
    const first = await f.catalog.list({ search });
    assert.equal(first.total, visible.length);
    assert.equal(first.threads.length, 100);
    assert.equal(first.nextCursor, 100);
    const last = await f.catalog.list({ search, cursor: first.nextCursor });
    assert.equal(last.total, visible.length);
    assert.equal(last.nextCursor, null);
    assert.deepEqual([...first.threads, ...last.threads].map(row => row.id), visible.toReversed());
  }
  assert.deepEqual((await f.catalog.list({ search: '未命名会话' })).threads.map(row => row.id), [literal]);
  for (const id of hidden) assert.equal(await f.catalog.contains(id), true);

  f.db.prepare('UPDATE threads SET title=? WHERE id=?').run('Now named', hidden[0]);
  const refreshed = await f.catalog.list({ search: '/synthetic/project' });
  assert.equal(refreshed.total, visible.length + 1);
  assert.equal(refreshed.threads[0].id, hidden[0]);
});

test('catalog picks a nonblank display name or falls back to a nonblank original title', async t => {
  const f = await fixture(t);
  f.db.exec('ALTER TABLE threads ADD COLUMN name TEXT');
  const original = f.add('Original title', 1);
  const renamed = f.add(null, 2);
  const blank = f.add('\n\t', 3);
  const setName = f.db.prepare('UPDATE threads SET name=? WHERE id=?');
  setName.run('\t\u3000', original);
  setName.run('  Display name  ', renamed);
  setName.run('\u3000 ', blank);
  const page = await f.catalog.list();
  assert.equal(page.total, 2);
  assert.deepEqual(page.threads.map(({ id, name }) => [id, name]), [[renamed, '  Display name  '], [original, 'Original title']]);
  assert.deepEqual((await f.catalog.list({ search: 'Original' })).threads.map(row => row.id), [original]);
  assert.deepEqual((await f.catalog.list({ search: 'Display' })).threads.map(row => row.id), [renamed]);
});

test('spawned children are hidden at every depth while existing sharing IDs remain valid', async t => {
  const f = await fixture(t);
  f.db.exec('CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL,child_thread_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
  const root = f.add('Pipeline', 1), child = f.add('Worker', 2);
  const workerProject = '/synthetic/workers-only';
  const grandchild = f.add('Nested worker', 3, 0, workerProject);
  const orphan = f.add('Worker of a missing thread', 4, 0, workerProject);
  const edge = f.db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)');
  edge.run(root, child, 'active');
  edge.run(child, grandchild, 'closed');
  edge.run(randomUUID(), orphan, 'closed');

  for (const search of ['', '/synthetic/project']) {
    const page = await f.catalog.list({ search });
    assert.equal(page.total, 1);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.threads.map(row => row.id), [root]);
  }
  for (const search of ['Worker', workerProject]) {
    const page = await f.catalog.list({ search });
    assert.equal(page.total, 0);
    assert.deepEqual(page.threads, []);
  }
  for (const id of [root, child, grandchild, orphan]) assert.equal(await f.catalog.contains(id), true);
});
