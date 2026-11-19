import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeImportAttachments } from '../lib/import-attachments.mjs';
import { createContentMarkdown } from '../lib/markdown-parser.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64');
const file = (id, name = '报告.csv', rest = {}) => ({ id, name, kind: 'file', ...rest });
const image = (id, name, rest = {}) => ({ id, name, kind: 'image', ...rest });

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-import (附件) '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function urls(text) {
  const result = [];
  function visit(tokens) {
    for (const t of tokens) {
      if (t.type === 'link_open' || t.type === 'image') result.push(t.attrGet(t.type === 'image' ? 'src' : 'href'));
      else if (t.children) visit(t.children);
    }
  }
  visit(createContentMarkdown().parse(text, {}));
  return result;
}

test('recipient saves files privately, reuses one copy per id, and reports missing originals in the affected messages', async t => {
  const dir = await workspace(t);
  const one = file('one', '../.codex/config.toml'), two = file('two', '../.codex/config.toml');
  const missing = file('not-available', 'old.ppt', { unavailable: true });
  const many = file('wire-failed', 'recording.mp4');
  const badImage = image('bad-image', 'photo.png');
  const picture = image('photo', 'CON');
  const remote = image('web', 'Web', { remoteUrl: 'https://example.invalid/view?q=1' });
  const messages = [
    { role: 'user', text: '', attachments: [one, two, picture] },
    { role: 'assistant', text: '附件', attachments: [one, many, missing, badImage, remote] },
    { role: 'user', text: '', attachments: [many] },
    { role: 'user', text: '', attachments: [{ ...remote, index: 0, syntax: 'image' }] },
  ];
  const seen = [];
  const result = await materializeImportAttachments({ messages }, dir, async ref => {
    seen.push(ref.id);
    if (ref === many) throw new Error('sensitive download failure');
    return ref === picture ? png : Buffer.from(ref.id);
  });
  assert.deepEqual(seen, ['one', 'two', 'photo', 'wire-failed', 'bad-image']);
  assert.equal(result.summary.saved, 3); assert.equal(result.summary.missing, 3); assert.equal(result.summary.remote, 1);
  assert.deepEqual(result.summary.missingFiles.map(item => item.message), [2, 2, 2, 3]);
  assert.match(result.messages[1].text, /recording\.mp4.*未保存/);
  assert.match(result.messages[1].text, /old\.ppt.*未保存/);
  assert.match(result.messages[2].text, /recording\.mp4.*未保存/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive download failure/);
  const [first, second, nativeImage] = urls(result.messages[0].text).map(decodeURIComponent);
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join(dir, 'attachments'));
  assert.match(nativeImage, /CON\.png$/);
  for (const [target, bytes] of [[first, Buffer.from('one')], [second, Buffer.from('two')], [nativeImage, png]]) {
    assert.deepEqual(await fs.readFile(target), bytes);
    if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }
  assert.equal(decodeURIComponent(urls(result.messages[1].text)[0]), first);
  assert.deepEqual(urls(result.messages[1].text).slice(1), [remote.remoteUrl]);
  assert.deepEqual(urls(result.messages[3].text), [remote.remoteUrl]);
  assert.equal((await fs.readdir(path.join(dir, 'attachments'))).length, 3);
});

test('only bound Markdown tokens change, including repeated targets, nested images and reference-style links', async t => {
  const dir = await workspace(t);
  const source = [
    '`[demo](/host/results.csv)` and $[formula](/host/results.csv)$',
    '[public](https://example.invalid) [kept](/host/results.csv) [bound](/host/results.csv "title")',
    '[![pic](/host/photo.png)](/host/results.csv)',
    '[first][report] and [second][report]',
    '![external](https://example.invalid/image.png)',
    '~~~md\n[code](/host/results.csv)\n~~~',
    '[report]: /host/table.csv',
  ].join('\n\n');
  const refs = [
    file('a', 'report.csv', { syntax: 'link', index: 2 }),
    file('b', 'other.csv', { syntax: 'link', index: 3 }),
    image('c', '图', { syntax: 'image', index: 0 }),
    file('d', 'table.csv', { syntax: 'link', index: 5 }),
    image('web', 'external', { syntax: 'image', index: 1, remoteUrl: 'https://example.invalid/image.png' }),
  ];
  const inputs = [];
  const { messages, summary } = await materializeImportAttachments({ messages: [{ role: 'assistant', text: source, attachments: refs }] },
    dir, async ref => { inputs.push(ref.id); return ref.kind === 'image' ? png : Buffer.from(ref.id); });
  assert.deepEqual(inputs, ['a', 'b', 'c', 'd']); assert.equal(summary.saved, 4);
  const output = messages[0].text;
  assert.match(output, /\[kept\]\(\/host\/results.csv\)/);
  assert.match(output, /\[bound\]\([^\n]+001-report.csv "title"\)/);
  assert.match(output, /\[!\[pic\]\([^\n]+003-[^\n]+\.png\)\]\([^\n]+002-other.csv\)/);
  assert.match(output, /\[first\]\[report\] and \[second\]\([^\n]+004-table.csv\)/);
  assert.ok(output.includes('[report]: /host/table.csv'));
  assert.ok(output.includes('`[demo](/host/results.csv)` and $[formula](/host/results.csv)$'));
  assert.ok(output.includes('~~~md\n[code](/host/results.csv)\n~~~'));
  assert.ok(output.includes('![external](https://example.invalid/image.png)'));
});

test('recipient bounds individual sizes and attachment count while retaining attachment-only turns', async t => {
  const dir = await workspace(t);
  const entries = Array.from({ length: 130 }, (_, i) => file(String(i), 'file.txt'));
  const calls = [];
  const { summary, messages } = await materializeImportAttachments({ messages: entries.map(attachment =>
    ({ role: 'user', text: '', attachments: [attachment] })) }, dir, async ref => {
    calls.push(ref);
    return ref === entries[0] ? Buffer.alloc(32 * 1024 * 1024 + 1) : Buffer.alloc(0);
  });
  assert.equal(calls.length, 128); assert.equal(summary.missing, 3); assert.equal(summary.saved, 127);
  assert.deepEqual(summary.missingFiles.map(f => f.message), [1, 129, 130]);
  assert.equal(messages.length, 130);
  assert.match(messages.at(-1).text, /file\.txt.*超过本次导入配额/);
});
