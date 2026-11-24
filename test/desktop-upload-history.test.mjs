import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { attachmentInput, GuestUploads } from '../lib/guest-uploads.mjs';
import { createDesktopUploadHistory } from '../lib/desktop-upload-history.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co2-upload-history-')), runtimeDir = path.join(root, '.coop');
  const store = new GuestUploads(runtimeDir, randomUUID());
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ids = ['report.pdf', '示例图片.png'].map(name => {
    const uploadId = randomUUID(), bytes = name.endsWith('png') ? Buffer.from('89504e470d0a1a0a', 'hex') : Buffer.from('%PDF-synthetic');
    store.receive('guest', { type: 'upload-start', uploadId, name, size: bytes.length });
    store.receive('guest', { type: 'upload-chunk', uploadId, index: 0, data: bytes.toString('base64') });
    store.receive('guest', { type: 'upload-finish', uploadId });
    return uploadId;
  });
  const refs = store.claim('guest', ids), thread = randomUUID();
  const text = attachmentInput('synthetic private user question', refs)[0].text;
  const parts = refs.map(ref => ({ type: 'localFile', path: ref.path }));
  const records = path.join(runtimeDir, 'desktop-upload-history'), reopen = () => createDesktopUploadHistory(runtimeDir);
  return { root, runtimeDir, refs, thread, text, parts, records, reopen, store, history: reopen() };
}

test('exact thread and full canonical message restore only registered upload handles across restarts', t => {
  const { refs, thread, text, parts, records, reopen, history, runtimeDir } = fixture(t);
  assert.deepEqual(history.filesFor(thread, text), []);
  history.remember(thread, text, refs);
  history.remember(thread, text, refs);
  const [key] = fs.readdirSync(records); assert.match(key, /^[0-9a-f]{64}$/);
  const file = path.join(records, key), serialized = fs.readFileSync(file, 'utf8');
  for (const secret of [thread, 'synthetic private user question', runtimeDir]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(JSON.parse(serialized).paths, refs.map(ref => path.relative(path.join(runtimeDir, 'guest-uploads'), ref.path).split(path.sep).join('/')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(records).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const restored = reopen();
  assert.deepEqual(restored.filesFor(thread, text), parts);
  assert.deepEqual(restored.filesFor(randomUUID(), text), []);
  assert.deepEqual(restored.filesFor(thread, text + ' '), []);
  assert.deepEqual(restored.filesFor(thread, text.normalize('NFKC') + 'x'), []);
  assert.deepEqual(restored.filesFor(thread, refs[0].path), []);
  assert.deepEqual(restored.filesFor(thread, { type: 'mention', path: refs[0].path }), []);
  restored.filesFor(thread, text)[0].path = 'a caller cannot mutate the cached paths';
  const open = t.mock.method(fs, 'openSync');
  assert.deepEqual(restored.filesFor(thread, text), parts);
  assert.deepEqual(restored.filesFor(thread, text + ' '), []);
  assert.equal(open.mock.callCount(), 0);
});

test('definitively unsubmitted records are removed from live and restarted history', t => {
  const { refs, thread, text, history, reopen } = fixture(t);
  const discard = history.remember(thread, text, refs);
  discard();
  assert.deepEqual(history.filesFor(thread, text), []);
  assert.deepEqual(reopen().filesFor(thread, text), []);
});

test('new records require canonical text, live trusted handles from this runtime and at most eight different uploads', t => {
  const { refs, thread, text, records, store, history } = fixture(t);
  const other = fixture(t);
  for (const invalid of [[], null, Array(1), [...refs, refs[0]], Array(9).fill(refs[0]), refs.map(r => ({ ...r }))]) {
    assert.throws(() => history.remember(thread, text, invalid));
  }
  assert.throws(() => history.remember(thread, 'plain text', refs));
  assert.throws(() => history.remember(thread, text, refs.slice().reverse()));
  assert.throws(() => history.remember(thread, text + 'x'.repeat(8001), refs));
  assert.throws(() => history.remember(thread, other.text, other.refs));
  store.release(refs);
  assert.throws(() => history.remember(thread, text, refs));
  assert.equal(fs.existsSync(records), false);
});

test('a corrupt, copied, oversized or out-of-scope record grants no files', t => {
  const { refs, thread, text, records, reopen, history } = fixture(t);
  history.remember(thread, text, refs);
  const [key] = fs.readdirSync(records), file = path.join(records, key), serialized = fs.readFileSync(file, 'utf8');
  const otherThread = randomUUID(), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  fs.writeFileSync(path.join(records, hash([otherThread, text])), serialized, { mode: 0o600 });
  assert.deepEqual(reopen().filesFor(otherThread, text), []);
  for (const paths of [['../../elsewhere'], [refs[0].path], [randomUUID() + '/' + randomUUID() + '/..'],
    ['wrong/format'], [], Array(9).fill('invalid')]) {
    fs.writeFileSync(file, JSON.stringify({ hash: hash([key, paths]), paths }));
    assert.deepEqual(reopen().filesFor(thread, text), []);
  }
  for (const contents of ['{', ' '.repeat(8193), serialized.replace('report.pdf', 'report.doc')]) {
    fs.writeFileSync(file, contents);
    assert.deepEqual(reopen().filesFor(thread, text), []);
    assert.throws(() => reopen().remember(thread, text, refs));
  }
});

test('linked history files, upload files and directories are rejected at registration and restoration', { skip: process.platform === 'win32' }, t => {
  for (const part of ['history record', 'history directory', 'upload file', 'upload directory', 'room directory', 'uploads directory', 'runtime']) {
    const { root, refs, runtimeDir, thread, text, records, reopen, history } = fixture(t);
    history.remember(thread, text, refs);
    const uploadDir = path.dirname(refs[0].path), roomDir = path.dirname(uploadDir);
    const original = { 'history record': path.join(records, fs.readdirSync(records)[0]), 'history directory': records,
      'upload file': refs[0].path, 'upload directory': uploadDir, 'room directory': roomDir, 'uploads directory': path.dirname(roomDir), runtime: runtimeDir }[part];
    const moved = path.join(root, 'moved');
    fs.renameSync(original, moved); fs.symlinkSync(moved, original);
    assert.deepEqual(reopen().filesFor(thread, text), []);
    assert.throws(() => reopen().remember(thread, text, refs));
  }
});
