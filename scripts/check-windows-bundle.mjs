#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { publicSource } from './public-source.mjs';
import { WINDOWS, fileInventory, peArchitecture, sha256 } from './windows-distribution.mjs';

const app = path.resolve(process.argv[2] ?? 'dist/windows/CodexCo2');
const resources = path.join(app, 'resources');
const manifest = JSON.parse(await fs.readFile(path.join(resources, 'manifest.json'), 'utf8'));
if (manifest.platform !== 'win32' || manifest.architecture !== 'x64' || manifest.minimumWindowsBuild !== WINDOWS.minimumBuild
    || manifest.runtimeMode !== 'desktop-attach' || manifest.signed !== false || manifest.updater?.automatic !== false
    || manifest.webView2?.runtimeBundled !== false || manifest.webView2?.sdk !== WINDOWS.webView2SDK
    || manifest.versions?.node !== WINDOWS.nodeVersion || manifest.versions?.cloudflared !== WINDOWS.cloudflaredVersion
    || manifest.versions?.dotnet !== WINDOWS.dotnetRuntime) throw new Error('Unexpected Windows distribution metadata');
if (!manifest.source?.files || sha256(JSON.stringify(manifest.source.files)) !== manifest.source.sha256) throw new Error('Invalid source inventory');
if (!/^[a-f0-9]{64}$/.test(manifest.dependencies?.nodeArchiveSHA256 ?? '') || !/^[a-f0-9]{64}$/.test(manifest.dependencies?.cloudflaredSHA256 ?? '')) throw new Error('Missing official dependency checksums');
const files = await fileInventory(app); delete files['resources/manifest.json'];
if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Windows bundle file set/digests differ from manifest');
for (const name of ['CodexCo2.exe', 'resources/runtime/node.exe', 'resources/runtime/cloudflared.exe', 'WebView2Loader.dll'])
  if (peArchitecture(await fs.readFile(path.join(app, name))) !== 'x64') throw new Error(`Wrong native architecture: ${name}`);
const runtime = (await fs.readdir(path.join(resources, 'runtime'))).sort();
if (runtime.join(',') !== 'cloudflared.exe,node.exe') throw new Error('Only the pinned Node/cloudflared runtimes may be bundled');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md', 'npm-NOTICES.txt', 'Node-LICENSE', 'cloudflared-LICENSE', 'NSIS-LICENSE.txt', 'cloudflared-modules/Go-LICENSE', 'cloudflared-modules/index.json'])
  if (!(await fs.stat(path.join(resources, 'Licenses', name))).size) throw new Error(`Missing Windows distribution notice: ${name}`);
const nugetVersions = { 'microsoft.web.webview2': WINDOWS.webView2SDK, 'microsoft.netcore.app.runtime.win-x64': WINDOWS.dotnetRuntime,
  'microsoft.windowsdesktop.app.runtime.win-x64': WINDOWS.dotnetRuntime };
const nugetNotices = { 'microsoft.web.webview2': ['LICENSE.txt', 'NOTICE.txt'], 'microsoft.netcore.app.runtime.win-x64': ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'],
  'microsoft.windowsdesktop.app.runtime.win-x64': ['LICENSE'] };
if (Object.keys(manifest.dependencies.nuget ?? {}).sort().join(',') !== Object.keys(nugetVersions).sort().join(',')) throw new Error('Unexpected NuGet runtime components');
for (const [name, value] of Object.entries(manifest.dependencies.nuget)) {
  if (value.version !== nugetVersions[name]) throw new Error(`Wrong NuGet runtime component version: ${name}`);
  if (value.sha512 !== WINDOWS.nugetArchiveSHA512[name] || !(await fs.readdir(path.join(resources, 'Licenses', name))).length) throw new Error(`Incomplete NuGet provenance/notices: ${name}`);
  for (const notice of nugetNotices[name]) {
    const relative = `resources/Licenses/${name}/${notice}`;
    if (!files[relative] || !(await fs.stat(path.join(app, relative))).size) throw new Error(`Missing full NuGet notice: ${name}/${notice}`);
  }
}
const goNotices = JSON.parse(await fs.readFile(path.join(resources, 'Licenses/cloudflared-modules/index.json'), 'utf8'));
if (!goNotices.modules?.length || !Object.keys(goNotices.files ?? {}).length) throw new Error('Missing embedded Go module notices');
for (const [name, digest] of Object.entries(goNotices.files))
  if (files[`resources/Licenses/cloudflared-modules/${name}`] !== digest) throw new Error(`Embedded Go notice digest mismatch: ${name}`);
for (const [relative, digest] of Object.entries(files).filter(([name]) => /^resources\/service\/(lib|owner|public)\//.test(name))) {
  const name = relative === 'resources/service/owner/app-icon.png' ? 'macos/AppIcon.png' : relative.slice('resources/service/'.length);
  if (manifest.source.files[name] !== digest) throw new Error(`Unreviewed Windows service source: ${name}`);
}
if (process.argv[3] && (await publicSource(path.resolve(process.argv[3]))).sha256 !== manifest.source.sha256) throw new Error('Bundle does not match public source');
let nativeChecks = false;
if (process.platform === 'win32') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-windows-bundle-'));
  try {
    const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'),
      TEMP: home, TMP: home, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.join(process.env.SystemRoot, 'System32'),
      CODEX_HOME: path.join(home, '.coop'), CO2_PLATFORM_BRIDGE: path.join(app, 'CodexCo2.exe') };
    const output = (name, args) => execFileSync(path.join(app, name), args, { env, encoding: 'utf8', timeout: 30000 }).trim();
    if (output('resources/runtime/node.exe', ['--version']) !== `v${WINDOWS.nodeVersion}`) throw new Error('Wrong Node version');
    if (!output('resources/runtime/cloudflared.exe', ['--version']).startsWith(`cloudflared version ${WINDOWS.cloudflaredVersion} `)) throw new Error('Wrong cloudflared version');
    const security = JSON.parse(output('CodexCo2.exe', ['--co2-platform', 'security-self-test']));
    if (!['ok', 'privateAcl', 'broadAclRejected', 'connectedServerUserVerified', 'binaryPipeRoundtrip'].every(key => security[key] === true)) throw new Error('Windows native security self-test failed');
    nativeChecks = true;
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ verified: true, platform: 'win32', architecture: 'x64', minimumWindowsBuild: manifest.minimumWindowsBuild,
  resourceFiles: Object.keys(files).length, sourceSHA256: manifest.source.sha256, nativeBinaryChecks: nativeChecks, signed: false,
  note: 'Bundle verification is not clean-Windows installation, WebView2 UI or official Desktop acceptance.' }));
