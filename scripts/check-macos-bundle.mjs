#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { publicSource } from './public-source.mjs';
import { SPARKLE, digest, frameworkInventory, validPublicKey } from './sparkle-distribution.mjs';
const app = path.resolve(process.argv[2] ?? 'dist/Codex Co².app');
const resources = path.join(app, 'Contents/Resources');
const manifest = JSON.parse(await fs.readFile(path.join(resources, 'manifest.json'), 'utf8'));
if (manifest.runtimeMode !== 'desktop-attach') throw new Error('Expected a Desktop attachment package');
if (!['preview', 'stable'].includes(manifest.channel) || manifest.notarized !== false) throw new Error('Expected an unnotarized Co² bundle');
if (!manifest.updater || manifest.updater.version !== SPARKLE.version || manifest.updater.archiveSHA256 !== SPARKLE.sha256
    || !validPublicKey(manifest.updater.publicKey) || manifest.distributable !== !manifest.updater.testing
    || digest(JSON.stringify(manifest.updater.framework)) !== SPARKLE.frameworkSHA256) throw new Error('Invalid updater distribution metadata');
if (!manifest.updater.testing && manifest.updater.feedURL !== 'https://raw.githubusercontent.com/SpaceCoder-Kafka/codex-co2/updates/appcast.xml') throw new Error('Unexpected production update feed');
const frameworks = path.join(app, 'Contents/Frameworks');
if ((await fs.readdir(frameworks)).join(',') !== 'Sparkle.framework') throw new Error('Unexpected bundled framework');
const sparkle = path.join(frameworks, 'Sparkle.framework');
if (JSON.stringify(await frameworkInventory(sparkle)) !== JSON.stringify(manifest.updater.framework)) throw new Error('Sparkle framework file/link inventory mismatch');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', sparkle], { stdio: 'pipe' });
const sparkleVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(sparkle, 'Resources/Info.plist')], { encoding: 'utf8' }).trim();
if (sparkleVersion !== SPARKLE.version) throw new Error('Sparkle framework version mismatch');
const runtimeFiles = (await fs.readdir(path.join(resources, 'runtime'))).sort();
if (runtimeFiles.join(',') !== 'cloudflared,node') throw new Error('Desktop attachment package must contain only Node and cloudflared runtimes');
if (Object.keys(manifest.versions).sort().join(',') !== 'cloudflared,node') throw new Error('Unexpected bundled runtime versions');
const hash = data => createHash('sha256').update(data).digest('hex');
const files = [];
async function visit(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle contains a symlink: ${relative}`);
    if (/(^|\/)(\.coop|auth\.json|server\.json|host-service\.json|sessions|desktop-profile|relay-registration\.json)(\/|$)/.test(relative)) throw new Error(`Private runtime data in bundle: ${relative}`);
    if (entry.isDirectory()) await visit(path.join(dir, entry.name), relative);
    else files.push(relative);
  }
}
await visit(resources);
for (const relative of files.filter(name => name !== 'manifest.json')) {
  if (manifest.files[relative] !== hash(await fs.readFile(path.join(resources, relative)))) throw new Error(`Bundle checksum mismatch: ${relative}`);
}
if (Object.keys(manifest.files).length !== files.length - 1) throw new Error('Manifest file set mismatch');
if (!manifest.source?.files || hash(JSON.stringify(manifest.source.files)) !== manifest.source.sha256) throw new Error('Invalid source inventory');
for (const relative of files.filter(name => /^service\/(lib|owner|public)\//.test(name))) {
  const sourceName = relative === 'service/owner/app-icon.png' ? 'macos/AppIcon.png' : relative.slice('service/'.length);
  if (manifest.source.files[sourceName] !== manifest.files[relative]) throw new Error(`Unreviewed service source: ${relative}`);
}
for (const name of ['LICENSE', 'npm-NOTICES.txt', 'Node-LICENSE', 'cloudflared-LICENSE', 'Sparkle-LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md', 'cloudflared-modules/Go-LICENSE', 'cloudflared-modules/index.json']) {
  if (!(await fs.stat(path.join(resources, 'Licenses', name))).size) throw new Error(`Missing license text: ${name}`);
}
const goNotices = JSON.parse(await fs.readFile(path.join(resources, 'Licenses/cloudflared-modules/index.json'), 'utf8'));
const vendor = goNotices.files;
if (!goNotices.modules.length || !Object.keys(vendor).length) throw new Error('No vendor notices recorded');
for (const [name, digest] of Object.entries(vendor)) {
  if (manifest.files[`Licenses/cloudflared-modules/${name}`] !== digest) throw new Error('Vendor notice checksum mismatch');
}
if (process.argv[3] && (await publicSource(path.resolve(process.argv[3]))).sha256 !== manifest.source.sha256) throw new Error('Bundle does not match this public source checkout');
const minimum = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (minimum !== manifest.minimumMacOS) throw new Error('Minimum macOS does not match the bundle manifest');
for (const [key, expected] of Object.entries({ CFBundleShortVersionString: manifest.version, CFBundleVersion: manifest.build })) {
  const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!expected || actual !== expected) throw new Error(`Application version does not match the bundle manifest: ${key}`);
}
for (const [key, expected] of Object.entries({ Co2UpdateChannel: manifest.channel, Co2UpdateTesting: String(manifest.updater.testing),
  SUFeedURL: manifest.updater.feedURL, SUPublicEDKey: manifest.updater.publicKey,
  SUEnableAutomaticChecks: 'true', SUScheduledCheckInterval: '86400', SUAutomaticallyUpdate: 'false', SUAllowsAutomaticUpdates: 'false',
  SUVerifyUpdateBeforeExtraction: 'true', SURequireSignedFeed: 'true', SUSendProfileInfo: 'false' })) {
  const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (actual !== expected) throw new Error(`Updater configuration mismatch: ${key}`);
}
const iconFile = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (iconFile !== 'AppIcon.icns') throw new Error('Application icon is not configured');
const icon = await fs.readFile(path.join(resources, iconFile));
if (icon.toString('ascii', 0, 4) !== 'icns' || icon.readUInt32BE(4) !== icon.length) throw new Error('Invalid application icon');
const temporaryHome = await fs.mkdtemp('/tmp/co2-bundle-check-');
try {
  await fs.mkdir(path.join(temporaryHome, '.coop'), { mode: 0o700 });
  const env = { HOME: temporaryHome, CODEX_HOME: path.join(temporaryHome, '.coop'), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  for (const [name, expected] of Object.entries({ node: `v${manifest.versions.node}`, cloudflared: `cloudflared version ${manifest.versions.cloudflared} ` })) {
    const binary = path.join(resources, 'runtime', name);
    const actual = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
    if (!actual.startsWith(expected)) throw new Error(`Version mismatch: ${name}`);
    const linked = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
    if (linked.some(line => !/^\s+\/(usr\/lib|System\/Library)\//.test(line))) throw new Error(`External dependency: ${name}`);
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
} finally { await fs.rm(temporaryHome, { recursive: true, force: true }); }
console.log(JSON.stringify({ verified: true, runtimeMode: manifest.runtimeMode, architecture: manifest.architecture, minimumMacOS: minimum, versions: manifest.versions, resourceFiles: files.length,
  updaterVersion: manifest.updater.version, distributable: manifest.distributable,
  sourceSHA256: manifest.source.sha256, goModuleNotices: Object.keys(vendor).length, privateRuntimeFiles: 0, systemOnlyPATH: true, notarized: false, note: 'Host still has development tools installed; this is not clean-Mac acceptance.' }));
