import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDFLARED_MACOS, cloudflaredMacOSBuildEnvironment, validateCloudflaredMacOSProvenance } from '../scripts/cloudflared-macos.mjs';

function provenance() {
  return {
    kind: 'source-build', version: CLOUDFLARED_MACOS.version, minimumMacOS: '14.0', recipeVersion: 1,
    source: { ...CLOUDFLARED_MACOS.source },
    toolchain: { goVersion: `go${CLOUDFLARED_MACOS.go.version}`, hostArchitecture: 'arm64',
      archiveSHA256: CLOUDFLARED_MACOS.go.archives.arm64.sha256, sdkVersion: '26.4', clangVersion: 'Apple clang version 17.0.0 (clang-1700.0.13.5)' },
    builds: Object.fromEntries(['arm64', 'x86_64'].map(architecture => [architecture,
      { sha256: 'a'.repeat(64), minimumMacOS: '14.0', buildInfoSHA256: 'b'.repeat(64) }])),
  };
}

test('cloudflared provenance pins source, toolchain and both macOS 14 slices', () => {
  assert.equal(validateCloudflaredMacOSProvenance(provenance()), true);
  for (const change of [
    p => { p.source.sha256 = 'a'.repeat(64); },
    p => { p.source.commit = 'a'.repeat(40); },
    p => { p.source.url = 'https://example.com/source.tar.gz'; },
    p => { p.toolchain.goVersion = 'go1.27.2'; },
    p => { p.toolchain.archiveSHA256 = 'c'.repeat(64); },
    p => { p.toolchain.hostArchitecture = 'x86_64'; },
    p => { p.recipeVersion = 0; },
    p => { p.minimumMacOS = '15.0'; },
    p => { p.builds.x86_64.minimumMacOS = '15.0'; },
    p => { p.builds.arm64.sha256 = '../arbitrary'; },
    p => { delete p.builds.x86_64; },
    p => { p.source.localPath = '/synthetic/private/source'; },
  ]) {
    const candidate = provenance(); change(candidate);
    assert.throws(() => validateCloudflaredMacOSProvenance(candidate), /provenance/);
  }
  const intel = provenance(); intel.toolchain.hostArchitecture = 'x86_64';
  intel.toolchain.archiveSHA256 = CLOUDFLARED_MACOS.go.archives.x86_64.sha256;
  assert.equal(validateCloudflaredMacOSProvenance(intel), true);
});

test('cloudflared build environment isolates Go state and credentials without inheriting shell flags', () => {
  const env = cloudflaredMacOSBuildEnvironment({ cacheDir: '/isolated/build', architecture: 'x86_64', sdkPath: '/Library/Developer/SDKs/MacOSX.sdk' });
  assert.equal(env.GOARCH, 'amd64');
  assert.equal(env.GOMODCACHE, '/isolated/build/gomodcache');
  assert.equal(env.GOCACHE, '/isolated/build/gocache');
  assert.equal(env.GOENV, 'off');
  assert.equal(env.GOAUTH, 'off');
  assert.equal(env.GOTOOLCHAIN, 'local');
  assert.equal(env.GOVCS, '*:off');
  assert.equal(env.GOSUMDB, 'sum.golang.org');
  assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '14.0');
  assert.match(env.CGO_CFLAGS, /-mmacosx-version-min=14\.0/);
  assert.match(env.CGO_CFLAGS, /-Werror=unguarded-availability-new/);
  for (const name of ['HOME', 'CODEX_HOME', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY']) assert.equal(Object.hasOwn(env, name), false);
  assert.throws(() => cloudflaredMacOSBuildEnvironment({ cacheDir: 'relative', architecture: 'arm64', sdkPath: '/sdk' }), /environment/);
  assert.throws(() => cloudflaredMacOSBuildEnvironment({ cacheDir: '/isolated', architecture: 'i386', sdkPath: '/sdk' }), /environment/);
});
