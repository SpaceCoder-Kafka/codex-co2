#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { binaryVersion } from '../lib/runtime.mjs';
import { npmNotices } from './third-party-notices.mjs';
import { publicSource } from './public-source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await publicSource(root);
const appVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('Application version must have three numeric components');
const buildNumber = '16';
const nodeVersion = '22.23.3', tunnelVersion = '2026.10.1';
const cache = path.join(root, '.coop/build-cache');
const dist = path.resolve(process.env.CO2_BUILD_DIST ?? path.join(root, 'dist'));
const app = path.join(dist, 'Codex Co².app');
const resources = path.join(app, 'Contents/Resources');
const runtime = path.join(resources, 'runtime');
const service = path.join(resources, 'service');
const run = (binary, args) => execFileSync(binary, args, { stdio: 'inherit' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function download(url, file) {
  try { await fs.access(file); return; } catch {}
  const temp = file + '.download';
  run('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--max-time', '180', '--silent', '--show-error', '--output', temp, url]);
  await fs.rename(temp, file);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build requires Apple Silicon macOS');
// A pre-existing failure is still a failure in the app being shipped. Stop
// before modifying build outputs if any local regression test fails.
const tests = (await fs.readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort();
run(process.execPath, ['--test', ...tests.map(name => path.join(root, 'test', name))]);
run(process.env.CO2_BUILD_PYTHON ?? 'python3', ['-m', 'unittest', 'discover', '-s', path.join(root, 'test'), '-p', 'test_cloudflared_notices.py']);
await fs.mkdir(cache, { recursive: true, mode: 0o700 }); await fs.chmod(path.join(root, '.coop'), 0o700);
await fs.mkdir(dist, { recursive: true });
const archiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const archive = path.join(cache, archiveName);
const sums = path.join(cache, `node-${nodeVersion}-SHASUMS256.txt`);
await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archive);
await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, sums);
const expected = (await fs.readFile(sums, 'utf8')).split('\n').find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0];
if (!expected || sha(await fs.readFile(archive)) !== expected) throw new Error('Official Node archive checksum mismatch');
run('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
const nodeDir = path.join(cache, `node-v${nodeVersion}-darwin-arm64`);
let cloudflared = process.env.CO2_BUILD_CLOUDFLARED;
let cloudflaredArchiveSHA256;
if (!cloudflared) {
  const metadata = path.join(cache, `cloudflared-${tunnelVersion}-release.json`);
  await download(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${tunnelVersion}`, metadata);
  const release = JSON.parse(await fs.readFile(metadata, 'utf8'));
  const name = 'cloudflared-darwin-arm64.tgz';
  const asset = release.assets?.find(item => item.name === name);
  cloudflaredArchiveSHA256 = asset?.digest?.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(cloudflaredArchiveSHA256 ?? '')) throw new Error('Official cloudflared release checksum is unavailable');
  const archive = path.join(cache, `${tunnelVersion}-${name}`);
  await download(`https://github.com/cloudflare/cloudflared/releases/download/${tunnelVersion}/${name}`, archive);
  if (sha(await fs.readFile(archive)) !== cloudflaredArchiveSHA256) throw new Error('Official cloudflared archive checksum mismatch');
  const extracted = path.join(cache, 'cloudflared-official'); await fs.mkdir(extracted, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
  cloudflared = path.join(extracted, 'cloudflared');
}
if (!path.isAbsolute(cloudflared) || !binaryVersion(cloudflared).startsWith(`cloudflared version ${tunnelVersion} `)) throw new Error(`Supply cloudflared ${tunnelVersion} with CO2_BUILD_CLOUDFLARED`);
const licenses = {
  'cloudflared-LICENSE': `https://raw.githubusercontent.com/cloudflare/cloudflared/${tunnelVersion}/LICENSE`,
};
for (const [name, url] of Object.entries(licenses)) await download(url, path.join(cache, `${tunnelVersion}-${name}`));
const tunnelSource = path.join(cache, `cloudflared-${tunnelVersion}-source.tar.gz`);
await download(`https://codeload.github.com/cloudflare/cloudflared/tar.gz/refs/tags/${tunnelVersion}`, tunnelSource);
const cloudflaredSourceSHA256 = sha(await fs.readFile(tunnelSource));
await fs.rm(app, { recursive: true, force: true });
await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
await fs.mkdir(runtime, { recursive: true }); await fs.mkdir(service, { recursive: true });
await fs.mkdir(path.join(resources, 'Licenses'));
const iconset = path.join(cache, 'AppIcon.iconset');
await fs.rm(iconset, { recursive: true, force: true });
await fs.mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = String(size * scale);
    run('/usr/bin/sips', ['-z', pixels, pixels, path.join(root, 'macos/AppIcon.png'), '--out',
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
}
run('/usr/bin/iconutil', ['--convert', 'icns', '--output', path.join(resources, 'AppIcon.icns'), iconset]);
for (const [name, bytes] of source.contents) {
  if (!['lib', 'owner', 'public'].includes(name.split('/')[0])) continue;
  const target = path.join(service, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
}
// Install only locked production dependencies in a fresh directory. Never
// copy the developer's node_modules (which may contain extra files or links).
const dependencies = await fs.mkdtemp(path.join(cache, 'production-'));
try {
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(root, name), path.join(dependencies, name));
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dependencies, stdio: 'inherit' });
  const notices = await npmNotices(root, dependencies);
  if (notices !== await fs.readFile(path.join(root, 'third-party/npm-NOTICES.txt'), 'utf8')) throw new Error('Review and regenerate third-party npm notices');
  await fs.rm(path.join(dependencies, 'node_modules/.bin'), { recursive: true, force: true });
  await fs.cp(path.join(dependencies, 'node_modules'), path.join(service, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(resources, 'Licenses/npm-NOTICES.txt'), notices);
} finally { await fs.rm(dependencies, { recursive: true, force: true }); }
await fs.mkdir(path.join(service, 'bin'));
await fs.copyFile(path.join(root, 'bin/desktop-service.mjs'), path.join(service, 'bin/desktop-service.mjs'));
await fs.copyFile(path.join(root, 'package.json'), path.join(service, 'package.json'));
await fs.copyFile(path.join(nodeDir, 'LICENSE'), path.join(resources, 'Licenses/Node-LICENSE'));
for (const name of Object.keys(licenses)) await fs.copyFile(path.join(cache, `${tunnelVersion}-${name}`), path.join(resources, 'Licenses', name));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md']) await fs.copyFile(path.join(root, name), path.join(resources, 'Licenses', name));
run(process.env.CO2_BUILD_PYTHON ?? 'python3', [path.join(root, 'scripts/collect-cloudflared-notices.py'), cloudflared, path.join(cache, 'go-license-modules'), path.join(resources, 'Licenses/cloudflared-modules')]);
const binaries = { node: path.join(nodeDir, 'bin/node'), cloudflared };
let minimumMacOS = '13.0';
const compareVersion = (a, b) => { const av = a.split('.').map(Number), bv = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const delta = (av[i] ?? 0) - (bv[i] ?? 0); if (delta) return delta; } return 0; };
for (const [name, source] of Object.entries(binaries)) {
  const target = path.join(runtime, name); await fs.copyFile(source, target); await fs.chmod(target, 0o755);
  const linked = execFileSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
  if (linked.some(line => !/^\s+\/(usr\/lib|System\/Library)\//.test(line))) throw new Error(`${name} has non-system dylib dependencies`);
  if (!execFileSync('/usr/bin/file', [target], { encoding: 'utf8' }).includes('arm64')) throw new Error(`${name} is not an Apple Silicon binary`);
  const loadCommands = execFileSync('/usr/bin/otool', ['-l', target], { encoding: 'utf8' });
  const min = loadCommands.match(/\bminos\s+([\d.]+)/)?.[1] ?? loadCommands.match(/LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+([\d.]+)/)?.[1];
  if (!min) throw new Error(`Cannot determine minimum macOS for ${name}`);
  if (compareVersion(min, minimumMacOS) > 0) minimumMacOS = min;
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', target]);
}
const executable = path.join(app, 'Contents/MacOS/CodexCo2');
run('/usr/bin/swiftc', ['-O', '-target', `arm64-apple-macos${minimumMacOS}`, '-framework', 'AppKit', '-framework', 'WebKit', path.join(root, 'macos/App.swift'), '-o', executable]);
await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.codexco2.manager</string>
<key>CFBundleName</key><string>Codex Co²</string><key>CFBundleDisplayName</key><string>Codex Co²</string>
<key>CFBundleExecutable</key><string>CodexCo2</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundleShortVersionString</key><string>${appVersion}</string><key>CFBundleVersion</key><string>${buildNumber}</string>
<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
await fs.writeFile(path.join(resources, 'PREVIEW.txt'), `Codex Co² — Apple Silicon experimental preview. Requires macOS ${minimumMacOS} or later.\nAd-hoc signed; NOT notarized. Requires official Codex Desktop installed separately and already running.\nNo credentials or conversation data are included. This package only attaches to the existing Desktop; no Codex backend is bundled. Isolated experiments remain available from source.\n`);
const files = {};
async function inventory(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected bundle symlink: ${relative}`);
    if (entry.isDirectory()) await inventory(absolute, relative);
    else files[relative] = sha(await fs.readFile(absolute));
  }
}
await inventory(resources);
await fs.writeFile(path.join(resources, 'manifest.json'), JSON.stringify({ name: 'Codex Co²', version: appVersion, build: buildNumber, architecture: 'arm64', notarized: false,
  channel: 'preview', source: { sha256: source.sha256, files: source.files }, cloudflaredSourceSHA256,
  runtimeMode: 'desktop-attach', minimumMacOS, versions: { node: nodeVersion, cloudflared: tunnelVersion }, nodeArchiveSHA256: expected, cloudflaredArchiveSHA256,
  licenses, files }, null, 2) + '\n');
run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const stage = path.join(cache, 'dmg-stage'); await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage);
await fs.cp(app, path.join(stage, 'Codex Co².app'), { recursive: true });
await fs.symlink('/Applications', path.join(stage, 'Applications'));
await fs.copyFile(path.join(resources, 'PREVIEW.txt'), path.join(stage, 'PREVIEW.txt'));
await fs.copyFile(path.join(root, 'macos/INSTALL.html'), path.join(stage, '安装说明.html'));
await fs.copyFile(path.join(root, 'macos/Open-Privacy-Security.inetloc'), path.join(stage, '打开隐私与安全性.inetloc'));
const artwork = path.join(cache, 'dmg-artwork');
const artworkTool = path.join(cache, 'render-installer-artwork');
run('/usr/bin/swiftc', ['-O', '-framework', 'AppKit', path.join(root, 'macos/InstallerArtwork.swift'), '-o', artworkTool]);
run(artworkTool, [stage, artwork]);
run('/usr/bin/tiffutil', ['-cathidpicheck', path.join(artwork, 'background.png'), path.join(artwork, 'background@2x.png'), '-out', path.join(artwork, 'background.tiff')]);
const toolHome = path.join(cache, 'dmg-tools');
const python = path.join(toolHome, 'bin/python3');
try { await fs.access(python); }
catch { run(process.env.CO2_BUILD_PYTHON ?? 'python3', ['-m', 'venv', toolHome]); }
const requirements = path.join(root, 'scripts/requirements-macos.txt');
const requirementsHash = sha(await fs.readFile(requirements));
const toolStamp = path.join(toolHome, 'requirements.sha256');
if (await fs.readFile(toolStamp, 'utf8').catch(() => '') !== requirementsHash) {
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--only-binary=:all:', '-r', requirements]);
  await fs.writeFile(toolStamp, requirementsHash);
}
const dmg = path.join(dist, `Codex-Co2-${appVersion}-build${buildNumber}-arm64-preview.dmg`);
await fs.rm(dmg, { force: true });
run(python, [path.join(root, 'scripts/package-macos.py'), stage, artwork, dmg, `Codex Co² ${appVersion} (${buildNumber})`]);
await fs.writeFile(dmg + '.sha256', `${sha(await fs.readFile(dmg))}  ${path.basename(dmg)}\n`);
const finalSource = await publicSource(root);
if (finalSource.sha256 !== source.sha256) throw new Error('Source changed during build; do not distribute these outputs');
await fs.writeFile(dmg + '.source.json', JSON.stringify({ sourceSHA256: source.sha256, files: source.files }, null, 2) + '\n');
await fs.writeFile(path.join(dist, 'RELEASE_NOTES.md'), `# Codex Co² ${appVersion} (${buildNumber}) — Preview\n\nIndependent experimental project. Apple Silicon; macOS ${minimumMacOS}+. Requires an already running, compatible official Codex Desktop.\n\nAd-hoc signed; not Apple-notarized. No E2EE. Guest messages use the host conversation's existing tools, permissions and allowance. Native tool approvals remain in Desktop.\n\nAssets: ${path.basename(dmg)}, its .sha256 checksum and .source.json source inventory. App licenses are in Contents/Resources/Licenses/.\n\nSource SHA-256: ${source.sha256}\nPublic source commit: pending initial public commit; associate this digest before publishing.\n\nAutomated bundle/synthetic checks do not establish native UI acceptance. Final-package native Desktop, tool approvals, real mobile devices, and clean-Mac browser download/install remain unverified. Enable private vulnerability reporting and configure the real repository/release URL before publication.\n`);
console.log(`Built ${app}\nBuilt ${dmg}\nSource SHA-256: ${source.sha256}`);
