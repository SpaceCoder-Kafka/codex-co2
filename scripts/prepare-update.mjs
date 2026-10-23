#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SPARKLE, appcastXML, digest, previousAppcastItems, sparkleDistribution, updateAssetName, validPublicKey } from './sparkle-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (['--initial', '--testing'].includes(key)) options[key.slice(2)] = true;
  else if (['--app', '--dmg', '--output', '--previous-feed', '--key-file'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
  else throw new Error('Usage: npm run updates:prepare -- --app <app> --dmg <dmg> --output <appcast.xml> (--initial | --previous-feed <signed-appcast.xml>) [--key-file <private-seed-file>] [--testing]');
}
if (!options.app || !options.dmg || !options.output || Boolean(options.initial) === Boolean(options['previous-feed'])) throw new Error('Provide app, dmg, output, and exactly one of --initial or --previous-feed');
if (process.platform !== 'darwin') throw new Error('Preparing a Sparkle update requires macOS');
const app = path.resolve(options.app), dmg = path.resolve(options.dmg), output = path.resolve(options.output);
if (!output.endsWith('.xml') || output === path.resolve(options['previous-feed'] ?? '') || output === dmg || output.startsWith(app + path.sep)) throw new Error('Write the new appcast to a separate .xml file outside the app and previous feed');
const manifest = JSON.parse(await fs.readFile(path.join(app, 'Contents/Resources/manifest.json'), 'utf8'));
if (!manifest.updater || Boolean(manifest.updater.testing) !== Boolean(options.testing) || manifest.updater.testing && manifest.distributable !== false) throw new Error('Bundle/update testing mode mismatch; synthetic keys cannot produce a distributable update');
const release = { version: manifest.version, build: manifest.build, channel: manifest.channel };
if (path.basename(dmg) !== updateAssetName(release)) throw new Error('DMG name does not match the bundle release metadata');
execFileSync(process.execPath, [path.join(root, 'scripts/check-macos-bundle.mjs'), app, root], { stdio: 'inherit' });
const checksum = await fs.readFile(dmg + '.sha256', 'utf8'), source = JSON.parse(await fs.readFile(dmg + '.source.json', 'utf8'));
if (checksum !== `${digest(await fs.readFile(dmg))}  ${path.basename(dmg)}\n` || source.sourceSHA256 !== manifest.source.sha256 || JSON.stringify(source.files) !== JSON.stringify(manifest.source.files)) throw new Error('DMG checksum/source inventory mismatch');

// Confirm that this DMG contains the exact verified application, not merely a
// different archive placed next to the expected source/checksum sidecars.
const cache = path.join(root, '.coop/build-cache'); await fs.mkdir(cache, { recursive: true, mode: 0o700 }); await fs.chmod(path.join(root, '.coop'), 0o700);
const mount = await fs.mkdtemp(path.join(cache, 'update-image-'));
let mounted = false;
try {
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'pipe' });
  mounted = true;
  const packedApp = path.join(mount, 'Codex Co².app');
  const packedManifest = await fs.readFile(path.join(packedApp, 'Contents/Resources/manifest.json'));
  if (!packedManifest.equals(await fs.readFile(path.join(app, 'Contents/Resources/manifest.json')))) throw new Error('DMG contains a different bundle manifest');
  execFileSync(process.execPath, [path.join(root, 'scripts/check-macos-bundle.mjs'), packedApp, root], { stdio: 'inherit' });
  if (digest(await fs.readFile(path.join(packedApp, 'Contents/MacOS/CodexCo2'))) !== digest(await fs.readFile(path.join(app, 'Contents/MacOS/CodexCo2')))) throw new Error('DMG contains a different application executable');
} finally {
  // Never recursively remove a mountpoint. If detach fails, preserve the
  // mount and report the error so a maintainer can safely unmount it.
  if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
  await fs.rmdir(mount);
}
const { distribution } = await sparkleDistribution(cache), sign = path.join(distribution, 'bin/sign_update');
let signingPublicKey, keyArgs;
if (options['key-file']) {
  const keyFile = path.resolve(options['key-file']);
  const seed = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64');
  if (seed.length !== 32) throw new Error('Only the current 32-byte Ed25519 seed format is supported; use the dedicated Keychain account for legacy keys');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  signingPublicKey = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
  keyArgs = ['--ed-key-file', keyFile];
} else {
  if (options.testing) throw new Error('Synthetic signing must use an explicit temporary --key-file, never Keychain');
  signingPublicKey = execFileSync(path.join(distribution, 'bin/generate_keys'), ['--account', SPARKLE.account, '-p'], { encoding: 'utf8' }).trim();
  keyArgs = ['--account', SPARKLE.account];
}
if (!validPublicKey(signingPublicKey) || signingPublicKey !== manifest.updater.publicKey) throw new Error('Signing key does not match the public key embedded in this application');
let previousItems = [];
if (options['previous-feed']) {
  const previous = path.resolve(options['previous-feed']);
  previousItems = previousAppcastItems(await fs.readFile(previous, 'utf8'));
  execFileSync('/usr/bin/xmllint', ['--nonet', '--noout', previous], { stdio: 'pipe' });
  execFileSync(sign, [...keyArgs, '--verify', previous], { stdio: 'pipe' });
}
const signature = execFileSync(sign, [...keyArgs, '-p', dmg], { encoding: 'utf8' }).trim();
await fs.mkdir(path.dirname(output), { recursive: true });
if (await fs.stat(output).catch(() => null)) throw new Error('Refusing to overwrite an existing appcast; choose a new output file');
const xml = appcastXML({ release, minimumMacOS: manifest.minimumMacOS, size: (await fs.stat(dmg)).size, signature, previousItems });
await fs.writeFile(output, xml, { flag: 'wx' });
try {
  execFileSync(sign, [...keyArgs, output], { stdio: 'pipe' });
  execFileSync(sign, [...keyArgs, '--verify', output], { stdio: 'pipe' });
  execFileSync('/usr/bin/xmllint', ['--nonet', '--noout', output], { stdio: 'pipe' });
} catch (error) { await fs.rm(output, { force: true }); throw error; }
console.log(JSON.stringify({ prepared: output, distributable: !options.testing, version: release.version, build: release.build,
  channel: release.channel, sourceSHA256: manifest.source.sha256, published: false,
  next: 'After separately publishing the matching release assets, publish this signed feed unchanged on the repository updates branch. Coordinate the Homebrew cask auto_updates stanza.' }));
