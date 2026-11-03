import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readWebAssets } from '../lib/web-assets.mjs';
import { startRelay } from '../lib/relay.mjs';
import { removeDependencyBins } from '../scripts/production-dependencies.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
test('production dependency cleanup removes nested npm bins without following package links', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-dependency-bins-')); t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const modules = path.join(temporary, 'node_modules');
  const put = async (name, bytes) => { const file = path.join(temporary, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  await put('node_modules/.bin/root-command', 'root shim');
  await put('node_modules/mermaid/node_modules/.bin/nested-command', 'nested shim');
  await put('node_modules/mermaid/node_modules/katex/library.js', 'preserved package bytes');
  await put('node_modules/ordinary/.bin/package-content', 'not an npm bin directory');
  await put('external/node_modules/.bin/external-command', 'external shim');
  await fs.symlink(path.join(temporary, 'external'), path.join(modules, 'external-package'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(modules, 'linked-bin/node_modules'), { recursive: true });
  await fs.symlink(path.join(temporary, 'external/node_modules/.bin'), path.join(modules, 'linked-bin/node_modules/.bin'), process.platform === 'win32' ? 'junction' : 'dir');
  await removeDependencyBins(modules);
  for (const name of ['.bin', 'mermaid/node_modules/.bin', 'linked-bin/node_modules/.bin']) await assert.rejects(fs.lstat(path.join(modules, name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(modules, 'mermaid/node_modules/katex/library.js'), 'utf8'), 'preserved package bytes');
  assert.equal(await fs.readFile(path.join(modules, 'ordinary/.bin/package-content'), 'utf8'), 'not an npm bin directory');
  assert.equal(await fs.readFile(path.join(temporary, 'external/node_modules/.bin/external-command'), 'utf8'), 'external shim');
  assert.equal((await fs.lstat(path.join(modules, 'external-package'))).isSymbolicLink(), true);
  await assert.rejects(removeDependencyBins(path.join(modules, 'external-package')), /regular node_modules/);
});

test('packaged preview manifests allow only immutable explicit resources and reject tampering', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-web-assets-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'vendor/pdf-cmaps'), { recursive: true });
  const body = Buffer.from('synthetic-cmap'); await fs.writeFile(path.join(root, 'vendor/pdf-cmaps/test.bcmap'), body);
  const manifest = { version: 1, assets: { '/vendor/pdf-cmaps/test.bcmap': 'vendor/pdf-cmaps/test.bcmap' }, files: { '/vendor/pdf-cmaps/test.bcmap': hash(body) } };
  const save = () => fs.writeFile(path.join(root, 'vendor/asset-manifest.json'), JSON.stringify(manifest)); await save();
  assert.equal((await readWebAssets(root))['/vendor/pdf-cmaps/test.bcmap'][1], 'application/octet-stream');
  await fs.writeFile(path.join(root, 'vendor/pdf-cmaps/test.bcmap'), 'tampered'); await assert.rejects(readWebAssets(root), /digest/);
  manifest.assets['/vendor/extra.js'] = '../private'; await save(); await assert.rejects(readWebAssets(root));
});

test('relay serves exact preview resources and isolates diagram helper CSP and CORP', async t => {
  const relay = await startRelay({ registrationSecret: randomBytes(32).toString('base64url'), publicDir: new URL('../public', import.meta.url).pathname }); t.after(() => relay.close());
  const [main, helper, script, forbidden] = await Promise.all(['/', '/rich-render.html', '/vendor/rich-render.js', '/vendor/asset-manifest.json'].map(p => fetch(relay.url + p)));
  assert.match(main.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.ok(!main.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.match(helper.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  assert.match(helper.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(helper.headers.get('cross-origin-resource-policy'), 'same-origin'); assert.equal(script.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(forbidden.status, 404);
  assert.equal((await fetch(relay.url + '/vendor/previews.mjs?x=1')).status, 404);
  assert.equal((await fetch(relay.url + '/vendor/pdf-cmaps/LICENSE')).status, 404);
});
