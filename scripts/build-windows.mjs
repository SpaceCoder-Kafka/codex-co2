#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicSource } from './public-source.mjs';
import { npmNotices } from './third-party-notices.mjs';
import { WINDOWS, fileInventory, peArchitecture, sha256, windowsAssetName } from './windows-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.CO2_BUILD_DIST ?? path.join(root, 'dist/windows'));
const cache = path.join(root, '.coop/build-cache/windows');
const app = path.join(dist, 'CodexCo2');
const resources = path.join(app, 'resources');
const service = path.join(resources, 'service'), runtime = path.join(resources, 'runtime'), licenses = path.join(resources, 'Licenses');
const dotnet = process.env.CO2_BUILD_DOTNET ?? 'dotnet';
const nsis = process.env.CO2_BUILD_NSIS ?? 'makensis';
const python = process.env.CO2_BUILD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const env = { ...process.env, DOTNET_CLI_HOME: path.join(cache, 'dotnet-home'), DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', NUGET_XMLDOC_MODE: 'skip' };
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, env, stdio: 'inherit', ...options });
const text = (file, args) => execFileSync(file, args, { cwd: root, env, encoding: 'utf8' }).trim();
await fs.mkdir(cache, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') await fs.chmod(path.join(root, '.coop'), 0o700);
if (text(dotnet, ['--version']) !== WINDOWS.dotnetSDK) throw new Error(`Use the pinned .NET SDK ${WINDOWS.dotnetSDK}`);
if (!/\bv?3\.13(?:\b|\.)/.test(text(nsis, ['-VERSION']))) throw new Error('Use pinned NSIS 3.13');
if (!path.isAbsolute(process.env.npm_execpath ?? '')) throw new Error('Build through npm run build:windows so the npm CLI is explicit');
const source = await publicSource(root);
const release = { ...JSON.parse(await fs.readFile(path.join(root, 'macos/release.json'), 'utf8')),
  version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version };
const installer = path.join(dist, windowsAssetName(release));
const portable = path.join(dist, windowsAssetName(release, 'portable.zip'));

async function download(url, destination, expected) {
  let bytes = await fs.readFile(destination).catch(() => null);
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Official dependency download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 512 * 1024 * 1024) throw new Error('Official dependency is unexpectedly large');
    if (expected && sha256(bytes) !== expected) throw new Error('Official dependency checksum mismatch');
    await fs.writeFile(destination, bytes, { mode: 0o600 });
  }
  if (expected && sha256(bytes) !== expected) throw new Error('Cached official dependency checksum mismatch');
  return bytes;
}

// Build only locked source and dependencies. No installed application's files,
// user authentication, Desktop history or arbitrary local node_modules enter.
const tests = (await fs.readdir(path.join(root, 'test'))).filter(name => process.platform === 'win32'
  ? ['app-control.test.mjs', 'windows-packaging.test.mjs'].includes(name) : name.endsWith('.test.mjs')).sort();
run(process.execPath, ['--test', ...tests.map(name => path.join(root, 'test', name))]);
// Never trust a persistent extracted NuGet directory: its DLLs/notices could be
// edited independently of the locked .nupkg. Force signed package download and
// fresh extraction for every distribution build, including runtime packs.
const packages = await fs.mkdtemp(path.join(cache, 'nuget-verified-'));
try {
const properties = [`-p:BaseIntermediateOutputPath=${path.join(cache, 'obj')}${path.sep}`,
  `-p:BaseOutputPath=${path.join(cache, 'bin')}${path.sep}`];
run(dotnet, ['restore', path.join(root, 'windows/CodexCo2.csproj'), '--locked-mode', '--no-cache', '--force', '--configfile', path.join(root, 'windows/NuGet.config'), '--packages', packages, ...properties]);
await fs.rm(app, { recursive: true, force: true }); await fs.mkdir(app, { recursive: true });
run(dotnet, ['publish', path.join(root, 'windows/CodexCo2.csproj'), '--no-restore', '--configuration', 'Release', '--runtime', WINDOWS.runtime,
  '--self-contained', 'true', '--output', app, `-p:Version=${release.version}`, `-p:FileVersion=${release.version}.${release.build}`, ...properties]);
for (const directory of [service, runtime, licenses]) await fs.mkdir(directory, { recursive: true });

const nodeArchiveName = `node-v${WINDOWS.nodeVersion}-win-x64.zip`;
const sums = await download(`https://nodejs.org/dist/v${WINDOWS.nodeVersion}/SHASUMS256.txt`, path.join(cache, `node-${WINDOWS.nodeVersion}-SHASUMS256.txt`));
const nodeSHA256 = sums.toString('utf8').split('\n').find(line => line.endsWith(`  ${nodeArchiveName}`))?.split(' ')[0];
if (!/^[a-f0-9]{64}$/.test(nodeSHA256 ?? '')) throw new Error('Official Windows Node checksum unavailable');
const nodeArchive = path.join(cache, nodeArchiveName);
await download(`https://nodejs.org/dist/v${WINDOWS.nodeVersion}/${nodeArchiveName}`, nodeArchive, nodeSHA256);
const nodeExtract = path.join(cache, 'node-official');
await fs.rm(nodeExtract, { recursive: true, force: true }); await fs.mkdir(nodeExtract);
run(python, ['-m', 'zipfile', '-e', nodeArchive, nodeExtract]);
const nodeDirectory = path.join(nodeExtract, `node-v${WINDOWS.nodeVersion}-win-x64`);
await fs.copyFile(path.join(nodeDirectory, 'node.exe'), path.join(runtime, 'node.exe'));
await fs.copyFile(path.join(nodeDirectory, 'LICENSE'), path.join(licenses, 'Node-LICENSE'));

const cloudflaredRelease = JSON.parse(await download(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${WINDOWS.cloudflaredVersion}`,
  path.join(cache, `cloudflared-${WINDOWS.cloudflaredVersion}-release.json`)));
const cloudflaredName = 'cloudflared-windows-amd64.exe';
const asset = cloudflaredRelease.assets?.find(item => item.name === cloudflaredName);
const cloudflaredSHA256 = asset?.digest?.replace(/^sha256:/, '');
if (!/^[a-f0-9]{64}$/.test(cloudflaredSHA256 ?? '')) throw new Error('Official Windows cloudflared checksum unavailable');
const cloudflared = path.join(cache, `${WINDOWS.cloudflaredVersion}-${cloudflaredName}`);
await download(`https://github.com/cloudflare/cloudflared/releases/download/${WINDOWS.cloudflaredVersion}/${cloudflaredName}`, cloudflared, cloudflaredSHA256);
await fs.copyFile(cloudflared, path.join(runtime, 'cloudflared.exe'));
await fs.writeFile(path.join(licenses, 'cloudflared-LICENSE'), await download(`https://raw.githubusercontent.com/cloudflare/cloudflared/${WINDOWS.cloudflaredVersion}/LICENSE`, path.join(cache, `cloudflared-${WINDOWS.cloudflaredVersion}-LICENSE`)));
run(python, [path.join(root, 'scripts/collect-cloudflared-notices.py'), cloudflared, path.join(cache, 'go-license-modules'), path.join(licenses, 'cloudflared-modules')]);

for (const [name, bytes] of source.contents) {
  if (!['lib', 'owner', 'public'].includes(name.split('/')[0])) continue;
  const target = path.join(service, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
}
await fs.mkdir(path.join(service, 'bin'));
await fs.copyFile(path.join(root, 'bin/desktop-service.mjs'), path.join(service, 'bin/desktop-service.mjs'));
await fs.copyFile(path.join(root, 'package.json'), path.join(service, 'package.json'));
await fs.copyFile(path.join(root, 'macos/AppIcon.png'), path.join(service, 'owner/app-icon.png'));
const dependencies = await fs.mkdtemp(path.join(cache, 'dependencies-'));
try {
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(root, name), path.join(dependencies, name));
  run(process.execPath, [process.env.npm_execpath, 'ci', '--prefix', dependencies, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  const notices = await npmNotices(root, dependencies);
  if (notices !== await fs.readFile(path.join(root, 'third-party/npm-NOTICES.txt'), 'utf8')) throw new Error('Review and regenerate locked npm notices');
  await fs.rm(path.join(dependencies, 'node_modules/.bin'), { recursive: true, force: true });
  await fs.cp(path.join(dependencies, 'node_modules'), path.join(service, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(licenses, 'npm-NOTICES.txt'), notices);
} finally { await fs.rm(dependencies, { recursive: true, force: true }); }
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md']) await fs.copyFile(path.join(root, name), path.join(licenses, name));
await fs.copyFile(path.join(root, 'windows/NSIS-LICENSE.txt'), path.join(licenses, 'NSIS-LICENSE.txt'));

// NuGet signature validation and the checked-in lock protect the WebView2 SDK.
// Runtime packs are version-pinned; retain their exact package hashes/notices.
const nuget = {};
for (const [id, version] of [['microsoft.web.webview2', WINDOWS.webView2SDK], ['microsoft.netcore.app.runtime.win-x64', WINDOWS.dotnetRuntime], ['microsoft.windowsdesktop.app.runtime.win-x64', WINDOWS.dotnetRuntime]]) {
  const directory = path.join(packages, id, version), target = path.join(licenses, id);
  const names = await fs.readdir(directory); await fs.mkdir(target, { recursive: true });
  const copied = names.filter(name => /^(license|third[-_ ]?party|notice)/i.test(name));
  if (!copied.length) throw new Error(`Missing official .NET/WebView2 license: ${id}`);
  for (const name of copied) if ((await fs.stat(path.join(directory, name))).isFile()) await fs.copyFile(path.join(directory, name), path.join(target, name));
  const sha512 = createHash('sha512').update(await fs.readFile(path.join(directory, `${id}.${version}.nupkg`))).digest('base64');
  if (sha512 !== WINDOWS.nugetArchiveSHA512[id]) throw new Error(`Official NuGet archive checksum mismatch: ${id}`);
  nuget[id] = { version, sha512 };
}
for (const file of ['CodexCo2.exe', 'resources/runtime/node.exe', 'resources/runtime/cloudflared.exe', 'WebView2Loader.dll'])
  if (peArchitecture(await fs.readFile(path.join(app, file))) !== 'x64') throw new Error(`Expected x64 native executable: ${file}`);
await fs.writeFile(path.join(app, 'PREVIEW.txt'), `Codex Co² ${release.version} (Build ${release.build}) — Windows x64 preview.\nWindows 10 version 1809 (build 17763) or newer. Unsigned.\nRequires Microsoft Edge WebView2 Runtime and an already running compatible official Codex Desktop.\nNo Codex backend, credentials or conversations are included. Windows native acceptance remains pending.\nUpdates: download a new installer from ${'https://github.com/SpaceCoder-Kafka/codex-co2/releases'}; exit Co² before installing.\n`);
await fs.writeFile(path.join(resources, 'manifest.json'), JSON.stringify({ name: 'Codex Co²', version: release.version, build: release.build, channel: release.channel,
  platform: 'win32', architecture: 'x64', minimumWindowsBuild: WINDOWS.minimumBuild, signed: false, runtimeMode: 'desktop-attach',
  updater: { automatic: false }, webView2: { sdk: WINDOWS.webView2SDK, runtimeBundled: false },
  versions: { node: WINDOWS.nodeVersion, cloudflared: WINDOWS.cloudflaredVersion, dotnet: WINDOWS.dotnetRuntime },
  dependencies: { nodeArchiveSHA256: nodeSHA256, cloudflaredSHA256, nuget },
  source: { sha256: source.sha256, files: source.files }, files: await fileInventory(app) }, null, 2) + '\n');
run(process.execPath, [path.join(root, 'scripts/check-windows-bundle.mjs'), app, root]);
const nsisDefine = process.platform === 'win32' ? '/D' : '-D';
const uninstallList = path.join(cache, 'uninstall-files.nsh');
const installedFiles = Object.keys(await fileInventory(app));
const nsisPath = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"').replaceAll('/', '\\');
const directories = new Set();
for (const file of installedFiles) { let dir = path.posix.dirname(file); while (dir !== '.') { directories.add(dir); dir = path.posix.dirname(dir); } }
await fs.writeFile(uninstallList, installedFiles.map(name => `Delete "$INSTDIR\\${nsisPath(name)}"`).join('\n') + '\n'
  + [...directories].sort((a, b) => b.length - a.length).map(name => `RMDir "$INSTDIR\\${nsisPath(name)}"`).join('\n') + '\n');
run(nsis, [`${nsisDefine}APP_DIR=${app}`, `${nsisDefine}OUTPUT_FILE=${installer}`, `${nsisDefine}APP_VERSION=${release.version}`,
  `${nsisDefine}UNINSTALL_LIST=${uninstallList}`, path.join(root, 'windows/installer.nsi')]);
run(python, ['-c', 'from pathlib import Path; import sys,zipfile; root=Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,str(Path(root.name)/p.relative_to(root))) for p in sorted(root.rglob("*")) if p.is_file()]; z.close()', app, portable]);
if ((await publicSource(root)).sha256 !== source.sha256) throw new Error('Source changed during build; do not distribute these outputs');
for (const artifact of [installer, portable]) {
  await fs.writeFile(artifact + '.sha256', `${sha256(await fs.readFile(artifact))}  ${path.basename(artifact)}\n`);
  await fs.writeFile(artifact + '.source.json', JSON.stringify({ sourceSHA256: source.sha256, files: source.files }, null, 2) + '\n');
}
console.log(`Built ${installer}\nBuilt ${portable}\nSource SHA-256: ${source.sha256}\nWindows native Desktop and clean-machine acceptance remain unverified.`);
} finally { await fs.rm(packages, { recursive: true, force: true }); }
