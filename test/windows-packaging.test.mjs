import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WINDOWS, fileInventory, peArchitecture, windowsAssetName } from '../scripts/windows-distribution.mjs';

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
