import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const WINDOWS = Object.freeze({ architecture: 'x64', runtime: 'win-x64', minimumBuild: 17763,
  nodeVersion: '22.23.3', cloudflaredVersion: '2026.10.1',
  cloudflaredSHA256: '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
  dotnetSDK: '8.0.426', dotnetRuntime: '8.0.32', webView2SDK: '1.0.3537.50',
  nugetArchiveSHA512: Object.freeze({
    'microsoft.web.webview2': 'QWnduPtmvtQjH07KtLRQgyYa857P1/cyM8stgy052d53P6WoN4mngtL0bGhs+0DyivdYVirm0GOfaRSM7bcc6w==',
    'microsoft.netcore.app.runtime.win-x64': 'I7aVEenFvsRc2xeTBu3iyy2SG9PmA+XQjIXt3SrdL+G+QP7dt/QJlTnqW13kMSSLPv8q/h+cxaGIEHP6ExUwDg==',
    'microsoft.windowsdesktop.app.runtime.win-x64': 'uvjRYtXc8PFhIRyjfqs2zo99jqtaaLrKw5yyFUZpNQm+O3M9YsyRe6o9cFTsRZDHtKqzY4CE+V+JQvfOF6cDgA=='
  }) });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function windowsAssetName({ version, build, channel }, suffix = 'setup.exe') {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d*$/.test(build) || !['preview', 'stable'].includes(channel)
      || !['setup.exe', 'portable.zip'].includes(suffix)) throw new Error('Invalid Windows release metadata');
  return `Codex-Co2-${version}-build${build}-windows-x64${channel === 'preview' ? '-preview' : ''}-${suffix}`;
}
export function peArchitecture(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a Windows PE executable');
  const offset = bytes.readUInt32LE(60);
  if (offset < 64 || offset + 24 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid Windows PE header');
  const machine = bytes.readUInt16LE(offset + 4);
  return machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : machine === 0xaa64 ? 'arm64' : 'unknown';
}
export async function fileInventory(directory, prefix = '') {
  const inventory = {};
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Windows distribution contains a symlink: ${relative}`);
    if (/(^|\/)(\.coop|auth\.json|server\.json|host-service\.json|sessions|desktop-profile|relay-registration\.json)(\/|$)/i.test(relative)
        || /\.(jsonl|sqlite|db|key|pem|pfx|p12)$/i.test(relative)) throw new Error(`Private file in Windows distribution: ${relative}`);
    if (entry.isDirectory()) Object.assign(inventory, await fileInventory(absolute, relative));
    else if (entry.isFile()) inventory[relative] = sha256(await fs.readFile(absolute));
    else throw new Error(`Unexpected Windows distribution entry: ${relative}`);
  }
  return inventory;
}
