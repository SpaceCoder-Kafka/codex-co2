import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { appcastXML, createTestSigningKey, frameworkInventory, previousAppcastItems, releaseConfiguration, updateAssetName } from '../scripts/sparkle-distribution.mjs';

import { releaseNotes } from '../scripts/release-notes.mjs';

const repository = 'SpaceCoder-Kafka/codex-co2';
const feedURL = 'https://raw.githubusercontent.com/SpaceCoder-Kafka/codex-co2/updates/appcast.xml';
const signature = randomBytes(64).toString('base64');
async function temporary(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-update-distribution-'));
  try { return await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('release builds fail closed without a public signing key; test feed overrides require explicit loopback mode', () => temporary(async directory => {
  await fs.mkdir(path.join(directory, 'macos'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.3.3' }));
  const release = { build: '13', channel: 'preview', repository, feedURL, publicKey: null };
  await fs.writeFile(path.join(directory, 'macos/release.json'), JSON.stringify(release));
  await assert.rejects(releaseConfiguration(directory, {}), /signing key/);
  const publicKey = randomBytes(32).toString('base64');
  assert.equal((await releaseConfiguration(directory, { CO2_UPDATE_PUBLIC_KEY: publicKey })).testing, false);
  assert.equal((await releaseConfiguration(directory, { CO2_BUILD_UPDATE_TESTING: '1' })).testing, true);
  for (const url of ['https://example.invalid/feed.xml', 'http://localhost:1234/feed.xml', 'http://127.0.0.1/feed.xml', ['http:', '', 'user:pass@127.0.0.1:1234/feed.xml'].join('/')]) {
    await assert.rejects(releaseConfiguration(directory, { CO2_BUILD_UPDATE_TESTING: '1', CO2_UPDATE_FEED_URL: url }), /loopback/);
  }
  const local = 'http://127.0.0.1:1234/appcast.xml';
  assert.equal((await releaseConfiguration(directory, { CO2_BUILD_UPDATE_TESTING: '1', CO2_UPDATE_FEED_URL: local })).feedURL, local);
  await assert.rejects(releaseConfiguration(directory, { CO2_UPDATE_PUBLIC_KEY: publicKey, CO2_UPDATE_FEED_URL: local }), /loopback/);
  await fs.writeFile(path.join(directory, 'macos/release.json'), JSON.stringify({ ...release, build: '0' }));
  await assert.rejects(releaseConfiguration(directory, { CO2_BUILD_UPDATE_TESTING: '1' }), /metadata/);
}));

test('framework inventory preserves executable bits and links and rejects escapes or broken links', () => temporary(async directory => {
  const framework = path.join(directory, 'Sparkle.framework');
  await fs.mkdir(path.join(framework, 'Versions/B'), { recursive: true });
  await fs.writeFile(path.join(framework, 'Versions/B/Sparkle'), 'synthetic-framework', { mode: 0o755 });
  await fs.symlink('B', path.join(framework, 'Versions/Current'));
  await fs.symlink('Versions/Current/Sparkle', path.join(framework, 'Sparkle'));
  const entries = await frameworkInventory(framework);
  assert.equal(entries['Versions/B/Sparkle'].executable, true);
  assert.deepEqual(entries.Sparkle, { type: 'link', target: 'Versions/Current/Sparkle' });
  await fs.symlink('../outside', path.join(framework, 'escape'));
  await assert.rejects(frameworkInventory(framework), /escapes/);
  await fs.rm(path.join(framework, 'escape'));
  await fs.symlink('missing', path.join(framework, 'broken'));
  await assert.rejects(frameworkInventory(framework), /ENOENT/);
}));

test('synthetic keys are private temporary seeds and match the embedded Ed25519 public key', () => temporary(async directory => {
  const result = await createTestSigningKey(directory), seed = Buffer.from((await fs.readFile(result.keyFile, 'utf8')).trim(), 'base64');
  assert.equal(seed.length, 32);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.keyFile)).mode & 0o777, 0o600);
  const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]) });
  const derived = createPublicKey(privateKey), message = Buffer.from('synthetic-update');
  assert.equal(Buffer.from(derived.export({ format: 'jwk' }).x, 'base64url').toString('base64'), result.publicKey);
  assert.equal(verify(null, message, derived, sign(null, message, privateKey)), true);
}));

test('appcast preserves stable and preview entries while enforcing global build monotonicity', () => {
  const oldRelease = { version: '0.3.3', build: '13', channel: 'preview' };
  const old = appcastXML({ release: oldRelease, minimumMacOS: '15.0', size: 100, signature });
  const items = previousAppcastItems(old);
  assert.match(items[0], /<sparkle:channel>preview<\/sparkle:channel>/);
  const stable = { version: '0.3.4', build: '14', channel: 'stable' };
  const feed = appcastXML({ release: stable, minimumMacOS: '15.0', size: 150, signature, previousItems: items });
  assert.equal(previousAppcastItems(feed).length, 2);
  assert.doesNotMatch(previousAppcastItems(feed)[0], /<sparkle:channel>/);
  assert.match(feed, /releases\/download\/v0\.3\.4\/Codex-Co2-0\.3\.4-build14-arm64\.dmg/);
  assert.equal(updateAssetName(oldRelease), 'Codex-Co2-0.3.3-build13-arm64-preview.dmg');
  for (const build of ['1', '13']) assert.throws(() => appcastXML({ release: { ...stable, build }, minimumMacOS: '15.0', size: 150, signature, previousItems: items }), /globally/);
  assert.throws(() => previousAppcastItems(old.replace('<rss', '<!DOCTYPE rss><rss')), /Unsupported/);
  assert.throws(() => previousAppcastItems(old.replace('</item>', '')), /complete/);
  assert.throws(() => appcastXML({ release: stable, minimumMacOS: '15.0', size: 150, signature: 'invalid' }), /metadata/);
});

test('version normalization retires selected builds only after checking the entire previous build history', () => {
  const old = appcastXML({ release: { version: '0.3.3', build: '17', channel: 'preview' }, minimumMacOS: '15.0', size: 100, signature });
  const previousItems = previousAppcastItems(old);
  const release = { version: '0.1.0', build: '23', channel: 'stable', architecture: 'universal' };
  const options = { release, minimumMacOS: '14.0', size: 200, signature, previousItems };
  assert.equal(previousAppcastItems(appcastXML(options)).length, 2);
  const feed = appcastXML({ ...options, retireBuilds: ['17'] });
  assert.equal(previousAppcastItems(feed).length, 1);
  assert.match(feed, /<sparkle:version>23<\/sparkle:version>/);
  assert.match(feed, /<sparkle:shortVersionString>0\.1\.0<\/sparkle:shortVersionString>/);
  assert.match(feed, /releases\/download\/v0\.1\.0\/Codex-Co2-0\.1\.0-build23-arm64\.dmg/);
  assert.doesNotMatch(feed, /preview|build17|0\.3\.3/);
  for (const build of ['1', '17']) assert.throws(() => appcastXML({ ...options, release: { ...release, build }, retireBuilds: ['17'] }), /globally/);
  for (const retireBuilds of [['18'], ['17', '17'], ['0'], ['017'], [17], '17']) assert.throws(() => appcastXML({ ...options, retireBuilds }), /retire|Retired/);
  const next = appcastXML({ ...options, release: { ...release, version: '0.2.0', build: '24' }, previousItems: previousAppcastItems(feed) });
  assert.equal(previousAppcastItems(next).length, 2);
  assert.match(next, /releases\/tag\/v0\.2\.0/);
  const old12 = appcastXML({ release: { version: '0.3.3', build: '12', channel: 'preview' }, minimumMacOS: '15.0', size: 100, signature });
  const multiple = { ...options, previousItems: [...previousItems, ...previousAppcastItems(old12)] };
  assert.equal(previousAppcastItems(appcastXML({ ...multiple, retireBuilds: ['17', '12'] })).length, 1);
  assert.match(appcastXML({ ...multiple, retireBuilds: ['12'] }), /build17/);
});

test('update preparation rejects retirement without a previous signed feed or with invalid build arguments', () => {
  const prepare = fileURLToPath(new URL('../scripts/prepare-update.mjs', import.meta.url));
  for (const args of [['--initial', '--retire-build', '17'], ['--previous-feed', 'previous.xml', '--retire-build', '0'], ['--previous-feed', 'previous.xml', '--retire-build']]) {
    const result = spawnSync(process.execPath, [prepare, '--app', 'unused.app', '--dmg', 'unused.dmg', '--output', 'unused.xml', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verified previous feed|Usage:/);
  }
});

test('release notes select only the requested version and derive the preview label from its channel', () => temporary(async root => {
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), '# Changes\n\n## 0.2.0\n\nNew functionality.\n\n## 0.1.0\n\nOriginal baseline.\n');
  const release = { version: '0.1.0', build: '23', channel: 'stable' }, sourceSHA256 = 'a'.repeat(64);
  const stable = await releaseNotes({ root, release, sourceSHA256 });
  assert.match(stable, /^# Codex Co² 0\.1\.0\n/);
  assert.match(stable, /Original baseline/);
  assert.doesNotMatch(stable, /New functionality|Preview/);
  const preview = await releaseNotes({ root, release: { ...release, version: '0.2.0', channel: 'preview' }, sourceSHA256 });
  assert.match(preview, /^# Codex Co² 0\.2\.0 Preview\n/);
  assert.doesNotMatch(preview, /Original baseline/);
  await assert.rejects(releaseNotes({ root, release: { ...release, version: '0.2.1' }, sourceSHA256 }), /CHANGELOG entry/);
}));

