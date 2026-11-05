import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NODE_MACOS, deriveNodeMacOS, probeNodeMacOS, validateNodeMacOSDerivation, macOSExecutionMode, runtimeVersionMacOS, MACOS_RUNTIME_CHECK_TIMEOUTS } from '../scripts/node-macos.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function receipt(architecture = 'arm64') {
  return { kind: 'official-node-stripped', recipeVersion: 1, version: NODE_MACOS.version, architecture,
    archiveSHA256: 'a'.repeat(64), inputSHA256: 'b'.repeat(64),
    strip: { arguments: ['-S', '-x'], toolSHA256: 'c'.repeat(64), xcodeVersion: 'Xcode 26.4\nBuild version 17E192' },
    strippedSHA256: 'd'.repeat(64), finalSHA256: 'e'.repeat(64),
    execution: { mode: 'native', node: NODE_MACOS.version, arch: architecture === 'x86_64' ? 'x64' : 'arm64', sqlite: true, crypto: true, vm: true } };
}

test('Node derivation receipts pin the controlled recipe, target, archive and final bytes', () => {
  for (const architecture of ['arm64', 'x86_64']) {
    assert.equal(validateNodeMacOSDerivation(receipt(architecture), { architecture, archiveSHA256: 'a'.repeat(64), finalSHA256: 'e'.repeat(64) }), true);
    assert.throws(() => validateNodeMacOSDerivation(receipt(architecture), { finalSHA256: 'f'.repeat(64) }), /provenance/);
    assert.throws(() => validateNodeMacOSDerivation(receipt(architecture), { architecture: architecture === 'arm64' ? 'x86_64' : 'arm64' }), /provenance/);
  }
  for (const mutate of [
    r => { r.version = '24.0.0'; }, r => { r.recipeVersion = 0; }, r => { r.inputSHA256 = ''; },
    r => { r.strip.arguments = ['-s']; }, r => { r.strip.toolSHA256 = ''; }, r => { r.strip.xcodeVersion = '/private/tool'; },
    r => { r.execution.sqlite = false; }, r => { r.execution.arch = 'x64'; }, r => { r.execution.crypto = false; },
    r => { r.execution.vm = false; }, r => { r.execution.mode = 'arbitrary'; }, r => { r.privatePath = '/synthetic/secret'; },
  ]) { const r = receipt(); mutate(r); assert.throws(() => validateNodeMacOSDerivation(r), /provenance/); }
  assert.equal(validateNodeMacOSDerivation({ ...receipt(), execution: { mode: 'not-executable' } }), true);
  assert.throws(() => validateNodeMacOSDerivation({ ...receipt(), execution: { mode: 'not-executable', sqlite: true } }), /provenance/);
});

test('macOS build rejects ambiguous or unsupported target arguments before modifying outputs', () => {
  for (const args of [['--arch', 'universal'], ['--arch', 'x64'], ['--arch', '../arm64'], ['--arch'], ['--unexpected']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-macos.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--arch|Unknown option|argument missing/);
  }
});

test('native Node capability probe uses an isolated HOME and exercises real SQLite, crypto and VM', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(MACOS_RUNTIME_CHECK_TIMEOUTS.native, 5000);
  assert.equal(MACOS_RUNTIME_CHECK_TIMEOUTS.rosetta, 30000);
  const before = await fs.stat(process.execPath);
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=/nonexistent/co2-packaging-probe.js';
  try { assert.equal(runtimeVersionMacOS(process.execPath, process.arch === 'x64' ? 'x86_64' : 'arm64'), 'v'+process.versions.node); }
  finally { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; }
  const after = await fs.stat(process.execPath);
  assert.equal(after.ctimeMs, before.ctimeMs); assert.equal(after.mode, before.mode);
  const observed = await probeNodeMacOS(process.execPath, process.arch === 'x64' ? 'x86_64' : 'arm64');
  assert.equal(observed.node, process.versions.node);
  assert.equal(observed.mode, macOSExecutionMode(process.arch === 'x64' ? 'x86_64' : 'arm64'));
  assert.equal(observed.sqlite, true); assert.equal(observed.crypto, true); assert.equal(observed.vm, true);
});

test('native derivation only mutates a fresh fixture copy and seals the transformed bytes', { skip: process.platform !== 'darwin' }, async t => {
  await fs.mkdir(path.join(root, '.coop'), { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, '.coop/node-derivation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64', source = path.join(directory, 'fixture'), destination = path.join(directory, 'derived');
  const c = path.join(directory, 'fixture.c'), observed = receipt(architecture).execution;
  delete observed.mode;
  // A synthetic Mach-O tests the strip/sign/receipt pipeline. It never claims
  // to validate Node itself; the independent capability probe above does that.
  await fs.writeFile(c, `#include <stdio.h>\nstatic int fixture_symbol=42;\nint main(void){puts(${JSON.stringify(JSON.stringify(observed))});return fixture_symbol==42?0:1;}\n`);
  execFileSync('/usr/bin/clang', ['-g', '-target', `${architecture}-apple-macos14.0`, c, '-o', source]);
  const before = hash(await fs.readFile(source));
  const result = await deriveNodeMacOS({ source, destination, architecture, archiveSHA256: 'a'.repeat(64) });
  assert.equal(result.inputSHA256, before); assert.equal(hash(await fs.readFile(source)), before);
  assert.equal(result.finalSHA256, hash(await fs.readFile(destination)));
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', destination]);
  await assert.rejects(deriveNodeMacOS({ source, destination, architecture, archiveSHA256: 'a'.repeat(64) }), /EEXIST/);
  await assert.rejects(deriveNodeMacOS({ source, destination: source, architecture, archiveSHA256: 'a'.repeat(64) }), /inputs/);
  const link = path.join(directory, 'source-link'); await fs.symlink(source, link);
  await assert.rejects(deriveNodeMacOS({ source: link, destination: path.join(directory, 'invalid'), architecture, archiveSHA256: 'a'.repeat(64) }), /regular file/);
  await fs.appendFile(destination, 'synthetic tamper');
  const tampered = hash(await fs.readFile(destination));
  assert.throws(() => validateNodeMacOSDerivation(result, { finalSHA256: tampered }), /provenance/);
});
