import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { WINDOWS, fileInventory, peArchitecture, sha256, windowsAssetName } from '../scripts/windows-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotnet = process.env.CO2_BUILD_DOTNET ?? 'dotnet';
let dotnetAvailable = false;
try { dotnetAvailable = execFileSync(dotnet, ['--version'], { stdio: 'pipe', encoding: 'utf8' }).trim() === WINDOWS.dotnetSDK; } catch { }
const nsis = process.env.CO2_BUILD_NSIS ?? 'makensis';
let nsisAvailable = false;
try { nsisAvailable = /\bv?3\.13(?:\b|\.)/.test(execFileSync(nsis, ['-VERSION'], { stdio: 'pipe', encoding: 'utf8' })); } catch { }

test('Windows release names and PE inspection reject unsupported architectures and malformed headers', () => {
  const release = { version: '0.3.3', build: '18', channel: 'preview' };
  assert.equal(windowsAssetName(release), 'Codex-Co2-0.3.3-build18-windows-x64-preview-setup.exe');
  assert.equal(windowsAssetName({ ...release, channel: 'stable' }, 'portable.zip'), 'Codex-Co2-0.3.3-build18-windows-x64-portable.zip');
  for (const bad of [{ ...release, version: '../escape' }, { ...release, build: '0' }, { ...release, channel: 'other' }]) assert.throws(() => windowsAssetName(bad));
  assert.throws(() => windowsAssetName(release, '../escape.exe'));
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  assert.equal(peArchitecture(pe), 'x64');
  pe.writeUInt16LE(0xaa64, 68); assert.equal(peArchitecture(pe), 'arm64');
  pe.writeUInt32LE(127, 60); assert.throws(() => peArchitecture(pe));
  assert.throws(() => peArchitecture(Buffer.from('not an exe')));
});

test('Windows bundle inventory detects payload changes, private files and links', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-synthetic-windows-inventory-'));
  try {
    await fs.mkdir(path.join(dir, 'resources'));
    const file = path.join(dir, 'resources/example.txt'); await fs.writeFile(file, 'synthetic build resource');
    const initial = await fileInventory(dir);
    await fs.writeFile(file, 'changed build resource');
    assert.notDeepEqual(await fileInventory(dir), initial);
    await fs.writeFile(path.join(dir, 'auth.json'), 'synthetic file rejected by its name');
    await assert.rejects(fileInventory(dir), /Private file/);
    await fs.rm(path.join(dir, 'auth.json'));
    if (process.platform !== 'win32') {
      await fs.symlink(file, path.join(dir, 'linked.txt'));
      await assert.rejects(fileInventory(dir), /symlink/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Windows static bundle checks accept listed preview outputs but reject tampering and unlisted files', { skip: process.platform === 'win32' }, async t => {
  // Fake PE headers exercise the cross-platform static checker only. On
  // Windows the checker also executes real native binaries.
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-preview-bundle-'));
  t.after(() => fs.rm(app, { recursive: true, force: true }));
  const put = async (name, bytes) => { const file = path.join(app, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  for (const name of ['CodexCo2.exe', 'resources/runtime/node.exe', 'resources/runtime/cloudflared.exe', 'WebView2Loader.dll']) await put(name, pe);
  const sourceFiles = {};
  for (const name of ['lib/web-assets.mjs', 'public/images.js', 'public/rich-render.html']) {
    const bytes = 'synthetic source: ' + name; await put('resources/service/' + name, bytes); sourceFiles[name] = sha256(bytes);
  }
  const assets = {}, assetFiles = {};
  for (const name of ['vendor/previews.mjs', 'vendor/office.worker.mjs', 'vendor/xlsx.worker.mjs', 'vendor/rich-render.js', 'vendor/pdf.worker.mjs', 'rich-render.html']) {
    const bytes = name === 'rich-render.html' ? 'synthetic source: public/rich-render.html' : 'synthetic generated: ' + name;
    await put('resources/service/public/' + name, bytes); assets['/' + name] = name; assetFiles['/' + name] = sha256(bytes);
  }
  const assetManifest = { version: 1, sourceSHA256: 'a'.repeat(64), assets, files: assetFiles };
  const saveAssets = () => put('resources/service/public/vendor/asset-manifest.json', JSON.stringify(assetManifest)); await saveAssets();
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md', 'npm-NOTICES.txt', 'Node-LICENSE', 'cloudflared-LICENSE', 'NSIS-LICENSE.txt', 'cloudflared-modules/Go-LICENSE']) await put('resources/Licenses/' + name, 'synthetic notice');
  const nuget = {
    'microsoft.web.webview2': { version: WINDOWS.webView2SDK, notices: ['LICENSE.txt', 'NOTICE.txt'] },
    'microsoft.netcore.app.runtime.win-x64': { version: WINDOWS.dotnetRuntime, notices: ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'] },
    'microsoft.windowsdesktop.app.runtime.win-x64': { version: WINDOWS.dotnetRuntime, notices: ['LICENSE'] },
  };
  const nugetMetadata = {};
  for (const [name, entry] of Object.entries(nuget)) {
    nugetMetadata[name] = { version: entry.version, sha512: WINDOWS.nugetArchiveSHA512[name] };
    for (const notice of entry.notices) await put(`resources/Licenses/${name}/${notice}`, 'synthetic NuGet notice');
  }
  await put('resources/Licenses/cloudflared-modules/index.json', JSON.stringify({ modules: ['synthetic module'], files: { 'Go-LICENSE': sha256('synthetic notice') } }));
  const manifest = { platform: 'win32', architecture: 'x64', minimumWindowsBuild: WINDOWS.minimumBuild, runtimeMode: 'desktop-attach', signed: false,
    updater: { automatic: false }, webView2: { runtimeBundled: false, sdk: WINDOWS.webView2SDK },
    versions: { node: WINDOWS.nodeVersion, cloudflared: WINDOWS.cloudflaredVersion, dotnet: WINDOWS.dotnetRuntime },
    dependencies: { nodeArchiveSHA256: 'b'.repeat(64), cloudflaredSHA256: WINDOWS.cloudflaredSHA256, nuget: nugetMetadata },
    source: { files: sourceFiles, sha256: sha256(JSON.stringify(sourceFiles)) } };
  const saveBundle = async () => { manifest.files = await fileInventory(app); delete manifest.files['resources/manifest.json']; await put('resources/manifest.json', JSON.stringify(manifest)); };
  const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-windows-bundle.mjs'), app], { encoding: 'utf8', timeout: 10000 });
  await saveBundle(); const accepted = check(); assert.equal(accepted.status, 0, accepted.stderr);

  // Recompute the outer inventory to prove the generated-resource and raw
  // source checks still reject changes independently of the outer digests.
  await put('resources/service/public/vendor/previews.mjs', 'tampered'); await saveBundle();
  assert.match(check().stderr, /Preview resource digest mismatch/);
  await put('resources/service/public/vendor/previews.mjs', 'synthetic generated: vendor/previews.mjs');
  await put('resources/service/public/vendor/unlisted.mjs', 'not reviewed'); await saveBundle();
  assert.match(check().stderr, /Unreviewed Windows service source/);
  await fs.rm(path.join(app, 'resources/service/public/vendor/unlisted.mjs'));
  await put('resources/service/public/images.js', 'modified raw source'); await saveBundle();
  assert.match(check().stderr, /Unreviewed Windows service source/);
  await put('resources/service/public/images.js', 'synthetic source: public/images.js');
  delete assetManifest.assets['/vendor/xlsx.worker.mjs']; delete assetManifest.files['/vendor/xlsx.worker.mjs']; await saveAssets(); await saveBundle();
  assert.match(check().stderr, /Incomplete preview resource manifest/);
});

test('production Windows native bridge policies execute with synthetic URLs and message payloads', { skip: !dotnetAvailable, timeout: 120000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-synthetic-windows-policy-'));
  try {
    const env = { ...process.env, DOTNET_CLI_HOME: path.join(dir, 'dotnet-home'), DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
    execFileSync(dotnet, ['build', path.join(root, 'windows/PolicyTests/PolicyTests.csproj'), '--configuration', 'Release', '--output', path.join(dir, 'out'),
      `-p:BaseIntermediateOutputPath=${path.join(dir, 'obj')}${path.sep}`], { env, encoding: 'utf8', timeout: 90000, stdio: 'pipe' });
    const output = execFileSync(dotnet, [path.join(dir, 'out/PolicyTests.dll')], { env, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(output, 'Windows native policy synthetic tests passed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Windows installer compiler accepts a synthetic payload and exact uninstall list', { skip: !nsisAvailable, timeout: 30000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-synthetic-installer-'));
  try {
    const payload = path.join(dir, 'app with spaces'); await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, 'synthetic.txt'), 'synthetic release payload only');
    const uninstall = path.join(dir, 'uninstall.nsh'); await fs.writeFile(uninstall, 'Delete "$INSTDIR\\synthetic.txt"\n');
    const out = path.join(dir, 'synthetic-setup.exe'); const define = process.platform === 'win32' ? '/D' : '-D';
    execFileSync(nsis, [process.platform === 'win32' ? '/WX' : '-WX', `${define}APP_DIR=${payload}`, `${define}OUTPUT_FILE=${out}`, `${define}APP_VERSION=0.0.0`,
      `${define}UNINSTALL_LIST=${uninstall}`, path.join(root, 'windows/installer.nsi')], { encoding: 'utf8', timeout: 25000, stdio: 'pipe' });
    // NSIS uses a 32-bit bootstrap which explicitly gates to a 64-bit OS.
    assert.equal(peArchitecture(await fs.readFile(out)), 'x86');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
