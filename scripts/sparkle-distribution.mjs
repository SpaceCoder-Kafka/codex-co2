import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SPARKLE = Object.freeze({
  version: '2.10.0',
  url: 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz',
  sha256: 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c',
  licenseSHA256: '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe',
  frameworkSHA256: 'be0a8c2c818549983ede816cb60b3924ddc66095975d9285dd4ee230e53f3563',
  account: 'local.codexco2.updates',
});
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const validPublicKey = value => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;

export async function releaseConfiguration(root, env = process.env) {
  const release = JSON.parse(await fs.readFile(path.join(root, 'macos/release.json'), 'utf8'));
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d*$/.test(release.build)
      || !Number.isSafeInteger(Number(release.build)) || !['preview', 'stable'].includes(release.channel)
      || release.repository !== 'SpaceCoder-Kafka/codex-co2'
      || release.feedURL !== 'https://raw.githubusercontent.com/SpaceCoder-Kafka/codex-co2/updates/appcast.xml') throw new Error('Invalid release metadata');
  const testing = env.CO2_BUILD_UPDATE_TESTING === '1';
  const publicKey = env.CO2_UPDATE_PUBLIC_KEY ?? release.publicKey;
  if (!testing && !validPublicKey(publicKey)) throw new Error('Set up an update signing key with npm run updates:key, or provide CO2_UPDATE_PUBLIC_KEY. Test bundles require explicit CO2_BUILD_UPDATE_TESTING=1 and cannot be distributed.');
  if (publicKey != null && !validPublicKey(publicKey)) throw new Error('Invalid Ed25519 public key');
  const feedURL = env.CO2_UPDATE_FEED_URL ?? release.feedURL;
  if (feedURL !== release.feedURL) {
    let parsed; try { parsed = new URL(feedURL); } catch { throw new Error('Invalid test update feed URL'); }
    if (!testing || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.hash || !parsed.port) throw new Error('Custom update feeds are restricted to explicit loopback tests');
  }
  return { ...release, version, publicKey, feedURL, testing };
}

// Test keys never enter the source checkout, the bundle, or a user Keychain.
export async function createTestSigningKey(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  const pair = generateKeyPairSync('ed25519');
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const keyFile = path.join(directory, 'update-test-key.txt');
  await fs.writeFile(keyFile, Buffer.from(privateJwk.d, 'base64url').toString('base64') + '\n', { mode: 0o600 });
  return { publicKey: Buffer.from(privateJwk.x, 'base64url').toString('base64'), keyFile };
}

// Keep framework symlinks intact, but never follow them while inventorying.
// Each link must be relative, stay within this framework, and resolve there.
export async function frameworkInventory(directory) {
  const root = await fs.realpath(directory), entries = {};
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolute), resolved = path.resolve(dir, target);
        if (path.isAbsolute(target) || !resolved.startsWith(root + path.sep) || !(await fs.realpath(absolute)).startsWith(root + path.sep)) throw new Error(`Framework symlink escapes its root: ${name}`);
        entries[name] = { type: 'link', target };
      } else if (entry.isDirectory()) { await visit(absolute, name); }
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        entries[name] = { type: 'file', sha256: digest(await fs.readFile(absolute)), executable: Boolean(stat.mode & 0o111) };
      } else throw new Error(`Unsupported framework entry: ${name}`);
    }
  }
  await visit(root); return entries;
}

export async function sparkleDistribution(cache) {
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const archive = path.join(cache, `Sparkle-${SPARKLE.version}.tar.xz`);
  try { await fs.access(archive); }
  catch {
    const temp = archive + '.download';
    try {
      execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--max-time', '180', '--silent', '--show-error', '--output', temp, SPARKLE.url], { stdio: 'inherit' });
      if (digest(await fs.readFile(temp)) !== SPARKLE.sha256) throw new Error('Official Sparkle archive checksum mismatch');
      await fs.rename(temp, archive);
    } finally { await fs.rm(temp, { force: true }); }
  }
  if (digest(await fs.readFile(archive)) !== SPARKLE.sha256) throw new Error('Official Sparkle archive checksum mismatch');
  // Re-extract the verified archive rather than trusting an editable cache.
  const distribution = path.join(cache, `Sparkle-${SPARKLE.version}`);
  await fs.rm(distribution, { recursive: true, force: true }); await fs.mkdir(distribution);
  execFileSync('/usr/bin/tar', ['-xf', archive, '-C', distribution], { stdio: 'pipe' });
  const framework = path.join(distribution, 'Sparkle.framework');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', framework], { stdio: 'pipe' });
  const files = await frameworkInventory(framework);
  if (digest(JSON.stringify(files)) !== SPARKLE.frameworkSHA256) throw new Error('Official Sparkle framework inventory mismatch');
  return { distribution, framework, files };
}

export function updateTag({ version, build, channel }) { return channel === 'preview' ? `v${version}-preview.${build}` : `v${version}`; }
export function updateAssetName({ version, build, channel }) { return `Codex-Co2-${version}-build${build}-arm64${channel === 'preview' ? '-preview' : ''}.dmg`; }
export const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function appcastXML({ release, minimumMacOS, size, signature, previousItems = [], retireBuilds = [], date = new Date() }) {
  if (!/^[1-9]\d*$/.test(release.build) || !/^\d+\.\d+\.\d+$/.test(release.version)
      || !/^\d+(?:\.\d+){1,2}$/.test(minimumMacOS) || !Number.isSafeInteger(size) || size < 1
      || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid signed update metadata');
  if (!Array.isArray(retireBuilds) || retireBuilds.some(build => typeof build !== 'string' || !/^[1-9]\d*$/.test(build))
      || new Set(retireBuilds).size !== retireBuilds.length) throw new Error('Retired builds must be distinct positive build numbers');
  const previousBuilds = new Set();
  // Validate every previous build before pruning. Retirement must never make
  // a lower build eligible or bypass verification of the previous signed feed.
  for (const item of previousItems) {
    const build = item.match(/<sparkle:version>([1-9]\d*)<\/sparkle:version>/)?.[1];
    if (!build || BigInt(build) >= BigInt(release.build)) throw new Error('Release build must increase globally across all channels and versions');
    previousBuilds.add(build);
  }
  if (retireBuilds.some(build => !previousBuilds.has(build))) throw new Error('Cannot retire a build absent from the previous appcast');
  const retainedItems = previousItems.filter(item => !retireBuilds.includes(item.match(/<sparkle:version>([1-9]\d*)<\/sparkle:version>/)[1]));
  const repository = 'https://github.com/SpaceCoder-Kafka/codex-co2';
  const tag = updateTag(release), asset = updateAssetName(release);
  const item = `    <item>\n      <title>Codex Co² ${xmlEscape(release.version)} (Build ${release.build})</title>\n      <link>${repository}/releases/tag/${tag}</link>\n      <pubDate>${date.toUTCString()}</pubDate>\n      <sparkle:version>${release.build}</sparkle:version>\n      <sparkle:shortVersionString>${release.version}</sparkle:shortVersionString>\n${release.channel === 'preview' ? '      <sparkle:channel>preview</sparkle:channel>\n' : ''}      <sparkle:minimumSystemVersion>${minimumMacOS}</sparkle:minimumSystemVersion>\n      <enclosure url="${repository}/releases/download/${tag}/${asset}" sparkle:edSignature="${signature}" length="${size}" type="application/octet-stream" />\n    </item>`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n  <channel>\n    <title>Codex Co² updates</title>\n    <link>${repository}</link>\n    <description>Real-time collaboration for Codex</description>\n${[item, ...retainedItems].join('\n')}\n  </channel>\n</rss>\n`;
}

export function previousAppcastItems(xml) {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)
      || !xml.includes('xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"')) throw new Error('Unsupported previous appcast');
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map(match => match[0]);
  if (!items.length || items.length !== (xml.match(/<item(?:\s|>)/g) ?? []).length) throw new Error('Previous appcast must contain complete update items');
  return items;
}
