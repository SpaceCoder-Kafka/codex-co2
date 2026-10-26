#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { binaryVersion } from '../lib/runtime.mjs';
import { npmNotices } from './third-party-notices.mjs';
import { publicSource } from './public-source.mjs';
import { buildCloudflaredMacOS, CLOUDFLARED_MACOS } from './cloudflared-macos.mjs';
import { SPARKLE, MACOS_ARCHITECTURES, MACOS_MINIMUM_VERSION, createTestSigningKey, frameworkBinaryInspection, frameworkInventory, inspectMacOSBinary, releaseConfiguration, requireMacOSCompatibility, sparkleDistribution, updateAssetName, xmlEscape } from './sparkle-distribution.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await publicSource(root);
const release = await releaseConfiguration(root);
release.architecture = 'universal';
const appVersion = release.version, buildNumber = release.build;
const nodeVersion = '22.23.3', tunnelVersion = CLOUDFLARED_MACOS.version;
const minimumMacOS = MACOS_MINIMUM_VERSION;
const cache = path.join(root, '.coop/build-cache');
const universalCache = path.join(cache, 'universal');
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
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Build requires Apple Silicon or Intel macOS');
if (process.env.CO2_BUILD_CLOUDFLARED) throw new Error('macOS builds require the pinned cloudflared source recipe; arbitrary local binaries are not accepted');
// A pre-existing failure is still a failure in the app being shipped. Stop
// before modifying build outputs if any local regression test fails.
const tests = (await fs.readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort();
run(process.execPath, ['--test', ...tests.map(name => path.join(root, 'test', name))]);
run(process.env.CO2_BUILD_PYTHON ?? 'python3', ['-m', 'unittest', 'discover', '-s', path.join(root, 'test'), '-p', 'test_cloudflared_notices.py']);
await fs.mkdir(cache, { recursive: true, mode: 0o700 }); await fs.chmod(path.join(root, '.coop'), 0o700);
await fs.mkdir(universalCache, { recursive: true, mode: 0o700 });
await fs.mkdir(dist, { recursive: true });
const sparkle = await sparkleDistribution(cache);
if (release.testing && !release.publicKey) {
  const key = await createTestSigningKey(path.join(cache, 'update-testing'));
  release.publicKey = key.publicKey;
  console.log('Building a NON-DISTRIBUTABLE synthetic updater bundle; temporary signing seed remains in the ignored build cache.');
}
const sums = path.join(cache, `node-${nodeVersion}-SHASUMS256.txt`);
await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, sums);
const tunnelBuild = await buildCloudflaredMacOS({ cacheDir: path.join(cache, 'cloudflared-macos14') });
const runtimeSources = {}, nodeArchiveSHA256 = {};
for (const architecture of MACOS_ARCHITECTURES) {
  const nodeArchitecture = architecture === 'x86_64' ? 'x64' : architecture;
  const archiveName = `node-v${nodeVersion}-darwin-${nodeArchitecture}.tar.gz`;
  const archive = path.join(cache, archiveName);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archive);
  const expected = (await fs.readFile(sums, 'utf8')).split('\n').find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || sha(await fs.readFile(archive)) !== expected) throw new Error(`Official Node archive checksum mismatch (${architecture})`);
  nodeArchiveSHA256[architecture] = expected;
  const extracted = path.join(universalCache, architecture);
  await fs.rm(extracted, { recursive: true, force: true }); await fs.mkdir(extracted, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
  const nodeDirectory = path.join(extracted, `node-v${nodeVersion}-darwin-${nodeArchitecture}`);
  const cloudflared = tunnelBuild.architectures[architecture];
  if (sha(await fs.readFile(cloudflared.binary)) !== cloudflared.sha256) throw new Error(`Source-built cloudflared checksum mismatch (${architecture})`);
  runtimeSources[architecture] = { nodeDirectory, node: path.join(nodeDirectory, 'bin/node'), cloudflared: cloudflared.binary };
  for (const name of ['node', 'cloudflared']) requireMacOSCompatibility(inspectMacOSBinary(runtimeSources[architecture][name], { architectures: [architecture] }), minimumMacOS, name);
}
const nodeDir = runtimeSources.arm64.nodeDirectory;
if (!(await fs.readFile(path.join(nodeDir, 'LICENSE'))).equals(await fs.readFile(path.join(runtimeSources.x86_64.nodeDirectory, 'LICENSE')))) throw new Error('Node licenses differ between official architecture archives');
const licenses = {
  'cloudflared-LICENSE': `https://github.com/cloudflare/cloudflared/blob/${CLOUDFLARED_MACOS.source.commit}/LICENSE`,
};
const tunnelSource = tunnelBuild.sourceArchive;
const cloudflaredSourceSHA256 = sha(await fs.readFile(tunnelSource));
if (cloudflaredSourceSHA256 !== CLOUDFLARED_MACOS.source.sha256) throw new Error('Cloudflared source archive changed after build');
await fs.rm(app, { recursive: true, force: true });
await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
await fs.mkdir(runtime, { recursive: true }); await fs.mkdir(service, { recursive: true });
await fs.mkdir(path.join(resources, 'Licenses'));
const frameworks = path.join(app, 'Contents/Frameworks'); await fs.mkdir(frameworks);
await fs.cp(sparkle.framework, path.join(frameworks, 'Sparkle.framework'), { recursive: true, verbatimSymlinks: true });
if (JSON.stringify(await frameworkInventory(path.join(frameworks, 'Sparkle.framework'))) !== JSON.stringify(sparkle.files)) throw new Error('Sparkle framework changed while copying');
const sparkleLicense = await fs.readFile(path.join(sparkle.distribution, 'LICENSE'));
if (!sparkleLicense.equals(await fs.readFile(path.join(root, 'third-party/Sparkle-LICENSE.txt')))) throw new Error('Reviewed Sparkle license does not match the official distribution');
await fs.writeFile(path.join(resources, 'Licenses/Sparkle-LICENSE.txt'), sparkleLicense);
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
await fs.copyFile(path.join(root, 'macos/AppIcon.png'), path.join(service, 'owner/app-icon.png'));
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
await fs.copyFile(tunnelBuild.licensePath, path.join(resources, 'Licenses/cloudflared-LICENSE'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md']) await fs.copyFile(path.join(root, name), path.join(resources, 'Licenses', name));
const noticeRoot = path.join(resources, 'Licenses/cloudflared-modules'), noticeFiles = {}, noticeModules = new Map(), noticeArchitectures = {};
for (const architecture of MACOS_ARCHITECTURES) {
  const destination = path.join(noticeRoot, architecture);
  run(process.env.CO2_BUILD_PYTHON ?? 'python3', [path.join(root, 'scripts/collect-cloudflared-notices.py'), runtimeSources[architecture].cloudflared, path.join(cache, 'go-license-modules'), destination]);
  const indexBytes = await fs.readFile(path.join(destination, 'index.json'));
  const index = JSON.parse(indexBytes);
  noticeArchitectures[architecture] = { goVersion: index.goVersion, indexSHA256: sha(indexBytes) };
  noticeFiles[`${architecture}/index.json`] = sha(indexBytes);
  for (const [name, checksum] of Object.entries(index.files)) noticeFiles[`${architecture}/${name}`] = checksum;
  for (const module of index.modules) {
    const key = JSON.stringify([module.module, module.version, module.sum]);
    const previous = noticeModules.get(key);
    const notices = Object.fromEntries(Object.entries(module.notices).map(([name, checksum]) => [`${architecture}/${name}`, checksum]));
    noticeModules.set(key, { ...module, notices: { ...previous?.notices, ...notices } });
  }
}
await fs.copyFile(path.join(noticeRoot, 'arm64/Go-LICENSE'), path.join(noticeRoot, 'Go-LICENSE'));
noticeFiles['Go-LICENSE'] = sha(await fs.readFile(path.join(noticeRoot, 'Go-LICENSE')));
await fs.writeFile(path.join(noticeRoot, 'index.json'), JSON.stringify({ architectures: noticeArchitectures, modules: [...noticeModules.values()], files: noticeFiles }, null, 2) + '\n');
const nativeBinaries = {};
for (const name of ['node', 'cloudflared']) {
  const target = path.join(runtime, name);
  if (name === 'cloudflared') for (const architecture of MACOS_ARCHITECTURES) {
    if (sha(await fs.readFile(runtimeSources[architecture][name])) !== tunnelBuild.architectures[architecture].sha256) throw new Error(`Source-built cloudflared changed before packaging (${architecture})`);
  }
  run('/usr/bin/lipo', ['-create', ...MACOS_ARCHITECTURES.map(architecture => runtimeSources[architecture][name]), '-output', target]);
  await fs.chmod(target, 0o755);
  const inspection = inspectMacOSBinary(target); nativeBinaries[`runtime/${name}`] = requireMacOSCompatibility(inspection, minimumMacOS, name);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', target]);
}
if (binaryVersion(path.join(runtime, 'node')) !== `v${nodeVersion}` || !binaryVersion(path.join(runtime, 'cloudflared')).startsWith(`cloudflared version ${tunnelVersion} `)) throw new Error('Bundled Universal runtime version mismatch');
const frameworkBinaries = await frameworkBinaryInspection(path.join(frameworks, 'Sparkle.framework'));
for (const [name, inspection] of Object.entries(frameworkBinaries)) requireMacOSCompatibility(inspection, minimumMacOS, `Sparkle/${name}`);
const executable = path.join(app, 'Contents/MacOS/CodexCo2');
const appSlices = [];
for (const architecture of MACOS_ARCHITECTURES) {
  const slice = path.join(universalCache, architecture, 'CodexCo2'); appSlices.push(slice);
  run('/usr/bin/swiftc', ['-O', '-target', `${architecture}-apple-macos${minimumMacOS}`, '-framework', 'AppKit', '-framework', 'WebKit',
  '-F', frameworks, '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks',
  path.join(root, 'macos/App.swift'), path.join(root, 'macos/Updater.swift'), '-o', slice]);
}
run('/usr/bin/lipo', ['-create', ...appSlices, '-output', executable]);
nativeBinaries.executable = requireMacOSCompatibility(inspectMacOSBinary(executable, { embeddedSparkle: true }), minimumMacOS, 'CodexCo2');
await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.codexco2.manager</string>
<key>CFBundleName</key><string>Codex Co²</string><key>CFBundleDisplayName</key><string>Codex Co²</string>
<key>CFBundleExecutable</key><string>CodexCo2</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundleShortVersionString</key><string>${appVersion}</string><key>CFBundleVersion</key><string>${buildNumber}</string>
<key>Co2UpdateChannel</key><string>${release.channel}</string><key>Co2UpdateTesting</key><${release.testing}/>
<key>SUFeedURL</key><string>${xmlEscape(release.feedURL)}</string><key>SUPublicEDKey</key><string>${release.publicKey}</string>
<key>SUEnableAutomaticChecks</key><true/><key>SUScheduledCheckInterval</key><integer>86400</integer>
<key>SUAutomaticallyUpdate</key><false/><key>SUAllowsAutomaticUpdates</key><false/>
<key>SUVerifyUpdateBeforeExtraction</key><true/><key>SURequireSignedFeed</key><true/><key>SUSendProfileInfo</key><false/>
<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
await fs.writeFile(path.join(resources, 'PREVIEW.txt'), `Codex Co² — Universal experimental preview for Apple Silicon and Intel. Requires macOS ${minimumMacOS} or later.\nAd-hoc signed; NOT notarized. Requires official Codex Desktop installed separately and already running.\nNo credentials or conversation data are included. This package only attaches to the existing Desktop; no Codex backend is bundled. Isolated experiments remain available from source.\n`);
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
await fs.writeFile(path.join(resources, 'manifest.json'), JSON.stringify({ name: 'Codex Co²', version: appVersion, build: buildNumber, architecture: 'universal', architectures: MACOS_ARCHITECTURES, nativeBinaries, frameworkBinaries, notarized: false,
  channel: release.channel, distributable: !release.testing,
  updater: { version: SPARKLE.version, archiveSHA256: SPARKLE.sha256, feedURL: release.feedURL, publicKey: release.publicKey,
    testing: release.testing, framework: sparkle.files },
  source: { sha256: source.sha256, files: source.files }, cloudflaredSourceSHA256,
  runtimeMode: 'desktop-attach', minimumMacOS, versions: { node: nodeVersion, cloudflared: tunnelVersion }, nodeArchiveSHA256, cloudflaredBuild: tunnelBuild.provenance,
  licenses, files }, null, 2) + '\n');
run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const stage = path.join(universalCache, 'dmg-stage'); await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage);
await fs.cp(app, path.join(stage, 'Codex Co².app'), { recursive: true, verbatimSymlinks: true });
await fs.symlink('/Applications', path.join(stage, 'Applications'));
await fs.copyFile(path.join(resources, 'PREVIEW.txt'), path.join(stage, 'PREVIEW.txt'));
await fs.copyFile(path.join(root, 'macos/INSTALL.html'), path.join(stage, '安装说明.html'));
await fs.copyFile(path.join(root, 'macos/Open-Privacy-Security.inetloc'), path.join(stage, '打开隐私与安全性.inetloc'));
const artwork = path.join(universalCache, 'dmg-artwork');
const artworkTool = path.join(universalCache, 'render-installer-artwork');
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
const dmg = path.join(dist, updateAssetName(release));
await fs.rm(dmg, { force: true });
run(python, [path.join(root, 'scripts/package-macos.py'), stage, artwork, dmg, `Codex Co² ${appVersion} (${buildNumber})`]);
await fs.writeFile(dmg + '.sha256', `${sha(await fs.readFile(dmg))}  ${path.basename(dmg)}\n`);
const finalSource = await publicSource(root);
if (finalSource.sha256 !== source.sha256) throw new Error('Source changed during build; do not distribute these outputs');
await fs.writeFile(dmg + '.source.json', JSON.stringify({ sourceSHA256: source.sha256, files: source.files }, null, 2) + '\n');
await fs.writeFile(path.join(dist, 'RELEASE_NOTES.md'), `# Codex Co² ${appVersion} (${buildNumber}) — Preview\n\nIndependent experimental project. Universal (Apple Silicon and Intel); macOS ${minimumMacOS}+. Requires an already running, compatible official Codex Desktop.\n\nAd-hoc signed; not Apple-notarized. No E2EE. Guest messages use the host conversation's existing tools, permissions and allowance. Native tool approvals remain in Desktop.\n\nAssets: ${path.basename(dmg)}, its .sha256 checksum and .source.json source inventory. App licenses are in Contents/Resources/Licenses/.\n\nSource SHA-256: ${source.sha256}\nPublic source commit: associate this source digest with the reviewed public commit before publishing.\n\nAutomated bundle/synthetic checks do not establish native UI acceptance. Final-package native Desktop, tool approvals, Intel and Apple Silicon real machines, real mobile devices, and clean-Mac browser download/install remain unverified.\n`);
console.log(`Built ${app}\nBuilt ${dmg}\nSource SHA-256: ${source.sha256}`);
