import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { claimReceiverImport, importManifestFromGuestView, validateImportManifest } from '../lib/import-handoff.mjs';
import { structuredImageBindings } from '../lib/thread-images.mjs';

const id = n => n.toString(16).padStart(64, '0');
const file = { id: id(1), name: '预算.xlsx' };
const image = { id: id(2), name: '图.png' };
const remote = { id: id(3), name: '外链', index: 0, url: 'https://example.org/photo.jpg' };
const snapshot = (items, capabilities = ['file-original']) => ({ type: 'snapshot', status: 'idle', title: '分享', capabilities, items });

test('structured image positions survive a different order in user Markdown', () => {
  const imagePath = process.platform === 'win32' ? 'C:/demo/' : '/demo/';
  const content = ['one.png', 'two.png'].map(name => ({ type: 'localImage', path: imagePath + name }));
  const text = '![unbound](./different.png) ![two](' + content[1].path + ') ![]()';
  assert.deepEqual(structuredImageBindings(text, content), [{ sourceIndex: 1, index: 1 }, { sourceIndex: 0, index: 2 }]);
});

test('manifest keeps only visible dialogue and its attachment capabilities, preferring original bytes over duplicate previews', () => {
  const view = snapshot([
    { role: 'user', text: '![]()', files: [{ ...file, previewImageId: image.id, sourcePath: '/hidden' }], images: [{ ...image, index: 0 }] },
    { role: 'assistant', text: '![外链](https://example.org/photo.jpg)', images: [remote], execution: 'private' },
    { role: 'activity', text: 'private', files: [file] },
  ]);
  const projected = importManifestFromGuestView(view);
  assert.deepEqual(projected.messages, [
    { role: 'user', text: '![]()', attachments: [{ ...file, kind: 'file', syntax: 'image', index: 0 }] },
    { role: 'assistant', text: view.items[1].text, attachments: [{ id: remote.id, name: remote.name, kind: 'image', syntax: 'image', index: 0, remoteUrl: remote.url }] },
  ]);
  const fallback = importManifestFromGuestView(snapshot([{ role: 'user', text: '', images: [image], files: [{ ...file, previewImageId: image.id }, { id: id(4), name: 'report.pdf' }] }], []));
  assert.deepEqual(fallback.messages[0].attachments, [{ ...image, kind: 'image' }, { id: id(4), name: 'report.pdf', kind: 'file', unavailable: true }]);
});

test('manifest uses visible guest window, keeps Markdown positions and rejects malformed capabilities', () => {
  const items = Array.from({ length: 500 }, () => ({ role: 'user', text: 'hi' }));
  items.unshift({ role: 'user', text: 'excluded', files: [file] });
  items.push({ role: 'activity', text: 'working' });
  const doc = importManifestFromGuestView(snapshot(items, ['activity-details']));
  assert.equal(doc.truncated, true);
  assert.equal(doc.messages.length, 499);
  assert.ok(doc.messages.every(m => m.text === 'hi' && !m.attachments.length));
  const positioned = importManifestFromGuestView(snapshot([{ role: 'assistant', text: '[图](/image.png)', images: [{ ...image, linkIndex: 3 }] }]));
  assert.deepEqual(positioned.messages[0].attachments[0], { ...image, kind: 'image', syntax: 'link', index: 3 });
  const authenticated = new URL('https://example.org/');
  authenticated.username = 'synthetic';
  for (const extra of [{ id: '../private' }, { remoteUrl: 'file:///example.png' }, { remoteUrl: authenticated.href }, { syntax: 'link', index: -1 }]) {
    const bad = structuredClone(positioned);
    Object.assign(bad.messages[0].attachments[0], extra);
    assert.throws(() => validateImportManifest(bad));
  }
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, uri: 'codex-co2://import?' + new URLSearchParams({ origin, ticket: id(100) }) };
}

test('receiver downloads only declared originals from the confirmed origin using a separate transfer token', async t => {
  const view = importManifestFromGuestView(snapshot([{ role: 'user', text: '', files: [file], images: [remote] }]));
  const transferToken = id(101);
  const bytes = Buffer.from([0, 255, 2, 123]);
  const requests = [];
  const { uri, origin } = await serve(t, (req, res) => {
    requests.push([req.method, req.url, req.headers]);
    if (req.url === '/guest-import/claim') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...view, transferToken }));
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(bytes);
  });
  const { snapshot: claimed, fetchAsset } = await claimReceiverImport(uri);
  assert.deepEqual(claimed, view);
  await assert.rejects(fetchAsset({ id: remote.id, kind: 'image' }));
  await assert.rejects(fetchAsset({ id: id(22), kind: 'file' }));
  await assert.rejects(fetchAsset({ id: file.id, kind: 'image' }));
  assert.deepEqual(await fetchAsset({ id: file.id, kind: 'file' }), bytes);
  assert.deepEqual(requests.map(([method, url, h]) => [method, url, h.origin, h.authorization, h['x-co2-asset'], h.cookie]), [
    ['POST', '/guest-import/claim', origin, 'Co2Import ' + id(100), undefined, undefined],
    ['POST', '/guest-import/asset', origin, 'Co2Import ' + transferToken, file.id, undefined],
  ]);
  assert.equal(requests[0][2]['x-co2-import-version'], '2');
});

test('legacy hosts supply text without attachment permission and an asset redirect is never followed', async t => {
  const old = { version: 1, title: '旧版', truncated: true, messages: [{ role: 'user', text: 'hi' }] };
  let response = old;
  const paths = [];
  const { uri } = await serve(t, (req, res) => {
    paths.push(req.url);
    if (req.url === '/guest-import/claim') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(response));
    }
    res.writeHead(302, { Location: '/external' }).end();
  });
  assert.deepEqual(await claimReceiverImport(uri), { snapshot: old });
  response = importManifestFromGuestView(snapshot([{ role: 'user', text: '', files: [file] }]));
  await assert.rejects(claimReceiverImport(uri), /凭据/);
  response.transferToken = id(21);
  const { fetchAsset } = await claimReceiverImport(uri);
  await assert.rejects(fetchAsset({ ...file, kind: 'file' }), /原件/);
  assert.equal(paths.includes('/external'), false);
});
