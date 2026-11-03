import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmNotices } from '../scripts/third-party-notices.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-license-supplement-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'node_modules', name); await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, 'third-party'));
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const mapping = JSON.parse(await fs.readFile(path.join(projectRoot, 'third-party/npm-license-supplements.json'), 'utf8'));
  const expected = lock.packages['node_modules/' + name], supplement = mapping[`${name}@${expected.version}`];
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { ['node_modules/' + name]: expected } }));
  await fs.writeFile(path.join(root, 'third-party/npm-license-supplements.json'), JSON.stringify(mapping));
  await fs.copyFile(path.join(projectRoot, 'node_modules', name, 'package.json'), path.join(dir, 'package.json'));
  await fs.copyFile(path.join(projectRoot, supplement.file), path.join(root, supplement.file));
  if (supplement.codeFile) await fs.copyFile(path.join(projectRoot, 'node_modules', name, supplement.codeFile), path.join(dir, supplement.codeFile));
  return { root, dir, supplement, mapping };
}

test('license supplements bind exact package metadata, lockfile integrity and reviewed text', async t => {
  const { root, dir, supplement } = await fixture(t, 'binary');
  const text = await npmNotices(root);
  assert.match(text, /binary@0\.3\.0/);
  assert.match(text, /Published license metadata: "MIT"/);
  assert.match(text, /does not supply a full license file or a copyright year/);
  assert.match(text, /SPDX MIT license template \(not an upstream copyright notice\)/);
  assert.match(text, /Source SHA-256: [a-f0-9]{64}/);
  assert.equal(text.includes('\r'), false);
  const original = await fs.readFile(path.join(dir, 'package.json'));
  const changed = JSON.parse(original); changed.author = 'Unreviewed replacement';
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(changed));
  await assert.rejects(npmNotices(root), /Supplemental license metadata mismatch/);
  await fs.writeFile(path.join(dir, 'package.json'), original);
  await fs.appendFile(path.join(root, supplement.file), '\nUnreviewed license change\n');
  await assert.rejects(npmNotices(root), /Reviewed supplemental license changed/);
});

test('buffers upstream declaration also binds the identical original source, not a fork copyright', async t => {
  const { root, dir, supplement } = await fixture(t, 'buffers');
  const text = await npmNotices(root);
  assert.match(text, /not declared in published package metadata; see supplement/);
  assert.match(text, /Original author James Halliday's upstream commit 1b745ee35d33eb166e15ef1866073a07c6d7de87 declares MIT\/X11/);
  assert.match(text, /No later fork copyright is substituted/);
  await fs.appendFile(path.join(dir, supplement.codeFile), '\n// unreviewed fork changes\n');
  await assert.rejects(npmNotices(root), /Supplemental upstream source mismatch/);
});

test('new versions and unreviewed fallback mappings still fail closed', async t => {
  const { root, dir, mapping } = await fixture(t, 'chainsaw');
  mapping['unreviewed@1.0.0'] = mapping['chainsaw@0.1.0'];
  await fs.writeFile(path.join(root, 'third-party/npm-license-supplements.json'), JSON.stringify(mapping));
  await assert.rejects(npmNotices(root), /Unreviewed supplemental license version/);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); pkg.version = '0.1.1';
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/chainsaw': { version: '0.1.1', license: pkg.license } } }));
  await assert.rejects(npmNotices(root), /No license text found/);
});
