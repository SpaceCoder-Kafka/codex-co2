import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MACOS_ARCHITECTURES, MACOS_MINIMUM_VERSION, compareMacOSVersions, inspectMacOSBinary, requireMacOSCompatibility } from './sparkle-distribution.mjs';

// The upstream Darwin release targets macOS 15. Build the same reviewed source
// with an explicit deployment target instead of editing a binary's metadata or
// retaining an older cloudflared release. Checksums were verified against the
// official source archive and https://go.dev/dl/?mode=json on 2026-10-26.
export const CLOUDFLARED_MACOS = Object.freeze({
  version: '2026.10.1',
  minimumMacOS: '14.0',
  recipeVersion: 1,
  source: Object.freeze({
    url: 'https://codeload.github.com/cloudflare/cloudflared/tar.gz/refs/tags/2026.10.1',
    sha256: '929cfb5efa22d4e4a4c8134a1cfd9acbf1c051cf5c097ba4327b32be5b469c3f',
    commit: '8e090e5bfa7a53e824fb2d7eb276f8ab08337b80',
    commitDate: '2026-10-15T16:15:28Z',
  }),
  go: Object.freeze({
    version: '1.27.3',
    archives: Object.freeze({
      arm64: Object.freeze({ filename: 'go1.27.3.darwin-arm64.tar.gz', sha256: 'dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2' }),
      x86_64: Object.freeze({ filename: 'go1.27.3.darwin-amd64.tar.gz', sha256: 'b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750' }),
    }),
  }),
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// This validates the recipe and provenance, not an unsigned hash against a
// subsequently signed binary. The caller verifies slice hashes before lipo and
// records the final signed runtime in its normal bundle inventory.
export function validateCloudflaredMacOSProvenance(provenance) {
  const config = CLOUDFLARED_MACOS;
  const fail = () => { throw new Error('Invalid macOS cloudflared source-build provenance'); };
  if (!exactKeys(provenance, ['kind', 'version', 'minimumMacOS', 'recipeVersion', 'source', 'toolchain', 'builds'])
      || provenance.kind !== 'source-build' || provenance.version !== config.version
      || provenance.minimumMacOS !== config.minimumMacOS || provenance.recipeVersion !== config.recipeVersion
      || !exactKeys(provenance.source, Object.keys(config.source))
      || Object.entries(config.source).some(([key, value]) => provenance.source[key] !== value)) fail();
  const toolchain = provenance.toolchain;
  if (!exactKeys(toolchain, ['goVersion', 'hostArchitecture', 'archiveSHA256', 'sdkVersion', 'clangVersion'])
      || toolchain.goVersion !== `go${config.go.version}`
      || !MACOS_ARCHITECTURES.includes(toolchain.hostArchitecture)
      || toolchain.archiveSHA256 !== config.go.archives[toolchain.hostArchitecture].sha256
      || !/^\d+(?:\.\d+){1,2}$/.test(toolchain.sdkVersion)
      || compareMacOSVersions(toolchain.sdkVersion, config.minimumMacOS) < 0
      || typeof toolchain.clangVersion !== 'string' || !/^Apple clang version [^\r\n]{1,200}$/.test(toolchain.clangVersion)) fail();
  if (!exactKeys(provenance.builds, MACOS_ARCHITECTURES)) fail();
  for (const architecture of MACOS_ARCHITECTURES) {
    const build = provenance.builds[architecture];
    if (!exactKeys(build, ['sha256', 'minimumMacOS', 'buildInfoSHA256'])
        || !checksum(build.sha256) || !checksum(build.buildInfoSHA256)
        || build.minimumMacOS !== config.minimumMacOS) fail();
  }
  return true;
}

// Do not inherit Go configuration, credentials, proxy overrides or arbitrary
// compiler flags from the developer's shell. All mutable Go state is isolated.
export function cloudflaredMacOSBuildEnvironment({ cacheDir, architecture, sdkPath }) {
  if (!MACOS_ARCHITECTURES.includes(architecture) || !path.isAbsolute(cacheDir) || !path.isAbsolute(sdkPath)) {
    throw new Error('Invalid macOS cloudflared build environment');
  }
  const cflags = `-O2 -g -mmacosx-version-min=${CLOUDFLARED_MACOS.minimumMacOS} -Werror=unguarded-availability-new`;
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C',
    TMPDIR: path.join(cacheDir, 'tmp'),
    GOENV: 'off', GOAUTH: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GO111MODULE: 'on',
    GOPATH: path.join(cacheDir, 'gopath'), GOCACHE: path.join(cacheDir, 'gocache'), GOMODCACHE: path.join(cacheDir, 'gomodcache'),
    GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOPRIVATE: '', GONOSUMDB: '', GONOPROXY: '', GOVCS: '*:off',
    GOFLAGS: '', GOEXPERIMENT: '', GODEBUG: '', GOFIPS140: 'off', GOMAXPROCS: '4',
    GOOS: 'darwin', GOARCH: architecture === 'x86_64' ? 'amd64' : 'arm64', GOAMD64: 'v1', GOARM64: 'v8.0',
    CGO_ENABLED: '1', CC: '/usr/bin/clang', CXX: '/usr/bin/clang++', SDKROOT: sdkPath,
    MACOSX_DEPLOYMENT_TARGET: CLOUDFLARED_MACOS.minimumMacOS,
    CGO_CFLAGS: cflags, CGO_CXXFLAGS: cflags, CGO_CPPFLAGS: '',
    CGO_LDFLAGS: `-mmacosx-version-min=${CLOUDFLARED_MACOS.minimumMacOS}`,
    SOURCE_DATE_EPOCH: String(Date.parse(CLOUDFLARED_MACOS.source.commitDate) / 1000),
  };
}

async function verifiedDownload(url, destination, expected) {
  try { await fs.access(destination); }
  catch {
    const temporary = destination + '.download';
    try {
      execFileSync('/usr/bin/curl', ['--disable', '--fail', '--location', '--silent', '--show-error',
        '--connect-timeout', '15', '--max-time', '180', '--retry', '2', '--retry-max-time', '240',
        '--output', temporary, url], { stdio: 'inherit', timeout: 260_000 });
      if (sha256(await fs.readFile(temporary)) !== expected) throw new Error(`Official artifact checksum mismatch: ${path.basename(destination)}`);
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  if (sha256(await fs.readFile(destination)) !== expected) throw new Error(`Cached official artifact checksum mismatch: ${path.basename(destination)}`);
}

export async function buildCloudflaredMacOS({ cacheDir }) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('macOS cloudflared builds require an Apple Silicon or Intel Mac');
  if (MACOS_MINIMUM_VERSION !== CLOUDFLARED_MACOS.minimumMacOS) throw new Error('Review the cloudflared recipe before changing the macOS deployment target');
  cacheDir = path.resolve(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 }); await fs.chmod(cacheDir, 0o700);
  const hostArchitecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const config = CLOUDFLARED_MACOS, archive = config.go.archives[hostArchitecture];
  const sourceArchive = path.join(cacheDir, `cloudflared-${config.version}-source.tar.gz`);
  const goArchive = path.join(cacheDir, archive.filename);
  await verifiedDownload(config.source.url, sourceArchive, config.source.sha256);
  await verifiedDownload(`https://go.dev/dl/${archive.filename}`, goArchive, archive.sha256);
  // Re-extract verified inputs every time; a mutable extracted cache is not an
  // authenticated source/toolchain. Module contents are checked by Go below.
  for (const name of ['source', 'toolchain']) {
    await fs.rm(path.join(cacheDir, name), { recursive: true, force: true });
    await fs.mkdir(path.join(cacheDir, name), { mode: 0o700 });
  }
  for (const name of ['gopath', 'gocache', 'gomodcache', 'tmp', ...MACOS_ARCHITECTURES]) await fs.mkdir(path.join(cacheDir, name), { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/tar', ['-xzf', sourceArchive, '-C', path.join(cacheDir, 'source')]);
  execFileSync('/usr/bin/tar', ['-xzf', goArchive, '-C', path.join(cacheDir, 'toolchain')]);
  const sourceDirectory = path.join(cacheDir, 'source', `cloudflared-${config.version}`);
  const go = path.join(cacheDir, 'toolchain/go/bin/go');
  const sdkPath = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const sdkVersion = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { encoding: 'utf8' }).trim();
  const clangVersion = execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  const toolchain = { goVersion: `go${config.go.version}`, hostArchitecture, archiveSHA256: archive.sha256, sdkVersion, clangVersion };
  const architectures = {}, builds = {};
  for (const architecture of MACOS_ARCHITECTURES) {
    const env = cloudflaredMacOSBuildEnvironment({ cacheDir, architecture, sdkPath });
    const options = { cwd: sourceDirectory, env, timeout: 900_000 };
    const actualGo = execFileSync(go, ['version'], { ...options, encoding: 'utf8' }).trim();
    if (actualGo !== `go version go${config.go.version} darwin/${hostArchitecture === 'x86_64' ? 'amd64' : hostArchitecture}`) throw new Error('Pinned Go toolchain version mismatch');
    execFileSync(go, ['mod', 'verify'], { ...options, stdio: 'inherit' });
    const binary = path.join(cacheDir, architecture, 'cloudflared');
    await fs.rm(binary, { force: true });
    const linkFlags = `-X main.Version=${config.version} -X main.BuildTime=${config.source.commitDate}`
      + ' -X github.com/cloudflare/cloudflared/cmd/cloudflared/updater.BuiltForPackageManager=codex-co2'
      + ` -linkmode=external -macos=${config.minimumMacOS}`;
    execFileSync(go, ['build', '-p=4', '-mod=readonly', '-trimpath', '-buildvcs=false', `-ldflags=${linkFlags}`,
      '-o', binary, './cmd/cloudflared'], { ...options, stdio: 'inherit' });
    execFileSync(go, ['mod', 'verify'], { ...options, stdio: 'inherit' });
    const inspection = inspectMacOSBinary(binary, { architectures: [architecture] });
    requireMacOSCompatibility(inspection, config.minimumMacOS, `cloudflared ${architecture}`);
    if (compareMacOSVersions(inspection.slices[architecture].minimumMacOS, config.minimumMacOS) !== 0) throw new Error('cloudflared deployment target differs from the reviewed recipe');
    const buildInfo = execFileSync(go, ['version', '-m', binary], { ...options, encoding: 'utf8' }).split('\n').slice(1).join('\n');
    if (!buildInfo.includes('\tbuild\tCGO_ENABLED=1') || !buildInfo.includes('\tbuild\t-trimpath=true')
        || buildInfo.includes(cacheDir)) throw new Error('Unexpected cloudflared Go build information');
    const binarySHA256 = sha256(await fs.readFile(binary));
    builds[architecture] = { sha256: binarySHA256, minimumMacOS: config.minimumMacOS, buildInfoSHA256: sha256(buildInfo) };
    architectures[architecture] = { binary, sha256: binarySHA256, inspection };
    // Running the foreign slice through Rosetta would not prove Intel support.
    if (architecture === hostArchitecture) {
      const version = execFileSync(binary, ['version'], { ...options, encoding: 'utf8' }).trim();
      if (version !== `cloudflared version ${config.version} (built ${config.source.commitDate})`) throw new Error('Built cloudflared version mismatch');
    }
  }
  const provenance = { kind: 'source-build', version: config.version, minimumMacOS: config.minimumMacOS,
    recipeVersion: config.recipeVersion, source: { ...config.source }, toolchain, builds };
  validateCloudflaredMacOSProvenance(provenance);
  await fs.writeFile(path.join(cacheDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { mode: 0o600 });
  return { sourceArchive, sourceDirectory, licensePath: path.join(sourceDirectory, 'LICENSE'), architectures, provenance };
}
