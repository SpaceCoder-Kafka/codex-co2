import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appcastXML, compareMacOSVersions, createTestSigningKey, frameworkBinaryInspection, frameworkInventory, inspectMacOSBinary, MACOS_MINIMUM_VERSION, previousAppcastItems, releaseConfiguration, requireMacOSCompatibility, updateAssetName } from '../scripts/sparkle-distribution.mjs';

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

test('Universal releases use one compatible update archive while historical ARM entries retain their original URL', () => {
  const historical = appcastXML({ release: { version: '0.3.3', build: '17', channel: 'preview' }, minimumMacOS: '15.0', size: 100, signature });
  const release = { version: '0.3.4', build: '18', channel: 'preview', architecture: 'universal' };
  assert.equal(updateAssetName(release), 'Codex-Co2-0.3.4-build18-universal-preview.dmg');
  const feed = appcastXML({ release, minimumMacOS: '15.0', size: 200, signature, previousItems: previousAppcastItems(historical) });
  const items = previousAppcastItems(feed);
  assert.match(items[0], /build18-universal-preview\.dmg/);
  assert.match(items[1], /build17-arm64-preview\.dmg/);
  assert.throws(() => updateAssetName({ ...release, architecture: '../../invalid' }), /architecture/);
});

test('macOS 14 updates preserve the original minimum of historical releases', () => {
  const historical = appcastXML({ release: { version: '0.3.3', build: '18', channel: 'preview', architecture: 'universal' }, minimumMacOS: '15.0', size: 100, signature });
  const release = { version: '0.3.3', build: '19', channel: 'preview', architecture: 'universal' };
  const items = previousAppcastItems(appcastXML({ release, minimumMacOS: MACOS_MINIMUM_VERSION, size: 200, signature, previousItems: previousAppcastItems(historical) }));
  assert.match(items[0], /<sparkle:minimumSystemVersion>14\.0<\/sparkle:minimumSystemVersion>/);
  assert.match(items[1], /<sparkle:minimumSystemVersion>15\.0<\/sparkle:minimumSystemVersion>/);
  assert.match(items[0], /build19-universal-preview\.dmg/);
});

function inspectionTool({ architectures = 'arm64 x86_64', minimums = { arm64: '13.0', x86_64: '15.0' }, library = '/usr/lib/libSystem.B.dylib' } = {}) {
  return (binary, args) => {
    if (binary.endsWith('/lipo')) return architectures + '\n';
    if (args.includes('-L')) return `fixture (architecture ${args[1]}):\n\t${library} (compatibility version 1.0.0, current version 1.0.0)\n`;
    return `Load command 1\n cmd LC_BUILD_VERSION\n minos ${minimums[args[1]]}\n`;
  };
}

test('native inspection requires both slices and evaluates dependencies and deployment targets per architecture', () => {
  const result = inspectMacOSBinary('/synthetic/app', { execute: inspectionTool() });
  assert.equal(result.slices.arm64.minimumMacOS, '13.0');
  assert.equal(result.slices.x86_64.minimumMacOS, '15.0');
  assert.ok(compareMacOSVersions(result.slices.x86_64.minimumMacOS, result.slices.arm64.minimumMacOS) > 0);
  assert.throws(() => inspectMacOSBinary('/synthetic/app', { execute: inspectionTool({ architectures: 'arm64' }) }), /architectures/);
  assert.throws(() => inspectMacOSBinary('/synthetic/app', { execute: inspectionTool({ library: '/opt/homebrew/lib/developer.dylib' }) }), /Non-system/);
  assert.throws(() => inspectMacOSBinary('/synthetic/app', { execute: inspectionTool({ library: '@rpath/Unexpected.framework/Unexpected' }), embeddedSparkle: true }), /Non-system/);
  assert.doesNotThrow(() => inspectMacOSBinary('/synthetic/app', { execute: inspectionTool({ library: '@rpath/Sparkle.framework/Versions/B/Sparkle' }), embeddedSparkle: true }));
});

test('macOS 14 compatibility rejects a raised dependency floor even when the host slice is compatible', () => {
  const inspect = minimums => inspectMacOSBinary('/synthetic/runtime', { execute: inspectionTool({ minimums }) });
  assert.doesNotThrow(() => requireMacOSCompatibility(inspect({ arm64: '11.0', x86_64: '14.0' })));
  assert.throws(() => requireMacOSCompatibility(inspect({ arm64: '14.0', x86_64: '15.0' })), /x86_64.*requires macOS 15\.0; target is 14\.0/);
  assert.throws(() => requireMacOSCompatibility(inspect({ arm64: '14.1', x86_64: '14.0' })), /arm64.*requires macOS 14\.1/);
  assert.throws(() => requireMacOSCompatibility({ architectures: ['arm64', 'x86_64'], slices: { arm64: { minimumMacOS: '14.0' } } }), /Missing minimum macOS.*x86_64/);
});

test('bundle checker cannot accept a macOS 14 claim through the legacy ARM-only provenance path', () => temporary(async directory => {
  const resources = path.join(directory, 'Contents/Resources'); await fs.mkdir(resources, { recursive: true });
  for (const extra of [{ architecture: 'arm64' }, { architecture: 'arm64', cloudflaredBuild: {} }, { architecture: 'universal' }]) {
    await fs.writeFile(path.join(resources, 'manifest.json'), JSON.stringify({ runtimeMode: 'desktop-attach', minimumMacOS: '14.0', ...extra }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-macos-bundle.mjs', import.meta.url)), directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /macOS 14 requires a Universal bundle with controlled cloudflared build provenance/);
  }
}));

test('an external dependency present only in the Intel slice still rejects a Universal runtime', () => {
  const systemOnly = inspectionTool(), external = inspectionTool({ library: '/opt/local/lib/unbundled.dylib' });
  assert.throws(() => inspectMacOSBinary('/synthetic/universal-node', { execute: (binary, args) => {
    if (args.includes('-L') && args[1] === 'x86_64') return external(binary, args);
    return systemOnly(binary, args);
  } }), /Non-system dylib dependency.*x86_64/);
});

test('framework inspection includes nested Mach-O helpers and rejects a missing Intel helper slice', () => temporary(async directory => {
  const main = path.join(directory, 'Versions/B/Sparkle'), helper = path.join(directory, 'Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer');
  for (const file of [main, helper]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from('cafebabe00000000', 'hex')); }
  await fs.writeFile(path.join(directory, 'LICENSE'), 'synthetic license');
  await fs.symlink('Versions/B/Sparkle', path.join(directory, 'Sparkle'));
  const binaries = await frameworkBinaryInspection(directory, { execute: inspectionTool() });
  assert.deepEqual(Object.keys(binaries), ['Versions/B/Sparkle', 'Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer']);
  await assert.rejects(frameworkBinaryInspection(directory, { execute: (binary, args) => {
    if (binary.endsWith('/lipo') && args.at(-1) === helper) return 'arm64\n';
    return inspectionTool()(binary, args);
  } }), /architectures/);
}));
