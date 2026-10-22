import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MessageAuthors } from '../lib/message-authors.mjs';
import { createMessageAuthorHistory, openMessageAuthorHistory } from '../lib/message-author-history.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/co2-author-history-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'message-authors.json') };
}
function evidence() {
  const authors = new MessageAuthors('分享者');
  authors.observe([], new Map());
  authors.observe([{ id: 'item', role: 'user', text: '不可写入文件的正文' }], new Map([['item', 'turn']]), 'item');
  return authors.checkpoint();
}

test('author history persists only per-thread evidence and defensive copies, independently of admissions', async t => {
  const { file } = await fixture(t), history = await openMessageAuthorHistory(file);
  const saved = evidence();
  history.remember('one', { ...saved, token: 'never-save-token', text: 'never-save-body' });
  saved.entries[0][1].hostAuthor.name = 'Changed by caller';
  history.get('one').entries[0][1].hostAuthor.name = 'Changed by reader';
  assert.equal(history.get('one').entries[0][1].hostAuthor.name, '分享者');
  assert.equal(history.get('two'), undefined);
  await history.flush();
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const json = await fs.readFile(file, 'utf8');
  for (const secret of ['不可写入文件的正文', 'never-save-token', 'never-save-body']) assert.ok(!json.includes(secret));
  const restored = await openMessageAuthorHistory(file);
  assert.deepEqual(restored.get('one'), history.get('one'));
  assert.equal(restored.get('two'), undefined);
});

test('author history bounds retained threads and reports write failures without losing current in-memory evidence', async () => {
  let reject = true;
  const history = createMessageAuthorHistory({ persist: async () => { if (reject) throw new Error('Synthetic disk failure'); } });
  const saved = evidence();
  for (let i = 0; i < 51; i++) history.remember(`thread-${i}`, saved);
  await history.flush(); assert.equal(history.failed, true);
  assert.equal(history.get('thread-0'), undefined);
  assert.deepEqual(history.get('thread-50'), saved);
  reject = false; history.remember('thread-50', saved); await history.flush();
  assert.equal(history.failed, false);
});

test('author history refuses symlinks, public files, oversized files and incompatible or malformed evidence', async t => {
  const { dir, file } = await fixture(t), target = path.join(dir, 'target');
  await fs.writeFile(target, '{}', { mode: 0o600 }); await fs.symlink(target, file);
  await assert.rejects(openMessageAuthorHistory(file), { code: 'ELOOP' });
  await fs.unlink(file); await fs.writeFile(file, '{}', { mode: 0o644 });
  await assert.rejects(openMessageAuthorHistory(file), /私有文件/);
  await fs.chmod(file, 0o600); await fs.truncate(file, 16 * 1024 * 1024 + 1);
  await assert.rejects(openMessageAuthorHistory(file), /私有文件/);
  const saved = evidence();
  const invalid = [
    { version: 2, entries: [] },
    { version: 1, entries: [{ threadId: 'one', evidence: { ...saved, sequence: -1 } }] },
    { version: 1, entries: [{ threadId: 'one', evidence: { ...saved, entries: [['item', { ...saved.entries[0][1], digest: 'plaintext' }]] } }] },
    { version: 1, entries: [{ threadId: 'one', evidence: saved }, { threadId: 'one', evidence: saved }] },
  ];
  for (const data of invalid) {
    await fs.writeFile(file, JSON.stringify(data));
    await assert.rejects(openMessageAuthorHistory(file), /格式不兼容/);
  }
});
