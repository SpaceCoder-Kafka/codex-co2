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
  const add = (title, time, archived = 0) => {
    const id = randomUUID(); db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, title, time, '/synthetic/project', archived, 'PRIVATE-BODY', 'PRIVATE-BODY', '/never/read/body.jsonl'); return id;
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
