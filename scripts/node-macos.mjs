import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inspectMacOSBinary, requireMacOSCompatibility, MACOS_MINIMUM_VERSION } from './sparkle-distribution.mjs';

export const NODE_MACOS = Object.freeze({ version: '22.23.3', recipeVersion: 1, stripArguments: Object.freeze(['-S', '-x']) });
// Cold Rosetta validation of a newly copied or metadata-changed executable can
// take about ten seconds. These budgets belong to packaging checks only; they
// do not change the product's runtime or Codex connection deadlines.
export const MACOS_RUNTIME_CHECK_TIMEOUTS = Object.freeze({ native: 5000, rosetta: 30000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const architectures = ['arm64', 'x86_64'];

export function validateNodeMacOSDerivation(receipt, { architecture, archiveSHA256, finalSHA256 } = {}) {
  const fail = () => { throw new Error('Invalid macOS Node derivation provenance'); };
  if (!exact(receipt, ['kind', 'recipeVersion', 'version', 'architecture', 'archiveSHA256', 'inputSHA256', 'strip', 'strippedSHA256', 'finalSHA256', 'execution'])
      || receipt.kind !== 'official-node-stripped' || receipt.recipeVersion !== NODE_MACOS.recipeVersion
      || receipt.version !== NODE_MACOS.version || !architectures.includes(receipt.architecture)
      || (architecture !== undefined && receipt.architecture !== architecture)
      || ![receipt.archiveSHA256, receipt.inputSHA256, receipt.strippedSHA256, receipt.finalSHA256].every(checksum)
      || (archiveSHA256 !== undefined && receipt.archiveSHA256 !== archiveSHA256)
      || (finalSHA256 !== undefined && receipt.finalSHA256 !== finalSHA256)) fail();
  const strip = receipt.strip;
  if (!exact(strip, ['arguments', 'toolSHA256', 'xcodeVersion'])
      || JSON.stringify(strip.arguments) !== JSON.stringify(NODE_MACOS.stripArguments)
      || !checksum(strip.toolSHA256) || typeof strip.xcodeVersion !== 'string'
      || !/^Xcode \d+(?:\.\d+){0,2}\nBuild version [a-zA-Z0-9]+$/.test(strip.xcodeVersion)) fail();
  const execution = receipt.execution;
  if (execution?.mode === 'not-executable') {
    if (!exact(execution, ['mode'])) fail();
  } else if (!exact(execution, ['mode', 'node', 'arch', 'sqlite', 'crypto', 'vm'])
      || !['native', 'rosetta'].includes(execution.mode) || execution.node !== NODE_MACOS.version
      || execution.arch !== (receipt.architecture === 'x86_64' ? 'x64' : 'arm64')
      || execution.sqlite !== true || execution.crypto !== true || execution.vm !== true) fail();
  return true;
}

export function nativeMacOSArchitecture() {
  if (process.platform === 'darwin') {
    const hardware = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 5000 });
    if (hardware.status === 0 && hardware.stdout.trim() === '1') return 'arm64';
  }
  return process.arch === 'x64' ? 'x86_64' : process.arch;
}

export function macOSExecutionMode(architecture) {
  if (!architectures.includes(architecture)) throw new Error('Invalid macOS runtime architecture');
  const host = nativeMacOSArchitecture();
  if (architecture === host) return 'native';
  if (host === 'arm64' && architecture === 'x86_64'
      && spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' }).status === 0) return 'rosetta';
  return 'not-executable';
}

export function runtimeVersionMacOS(binary, architecture, env) {
  const mode = macOSExecutionMode(architecture);
  if (mode === 'not-executable') throw new Error('Host cannot execute the target macOS runtime');
  return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: MACOS_RUNTIME_CHECK_TIMEOUTS[mode],
    stdio: ['ignore', 'pipe', 'pipe'], env: env ?? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C' } }).trim();
}

export async function probeNodeMacOS(binary, architecture) {
  const mode = macOSExecutionMode(architecture);
  if (mode === 'not-executable') return { mode };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-node-probe-'));
  try {
    await fs.chmod(temporary, 0o700);
    const program = `import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const db=new DatabaseSync(':memory:');
const sqlite=db.prepare('SELECT 42 AS value').get().value===42;db.close();
const crypto=createHash('sha256').update('co2-node-probe').digest('hex')==='baff823e8b634cd8044856be9fe340f8bd33acdf35d9698e20b702b3eca1a9b7';
console.log(JSON.stringify({node:process.versions.node,arch:process.arch,sqlite,crypto,vm:vm.runInNewContext('6*7')===42}));`;
    const output = execFileSync(binary, ['--input-type=module', '-e', program], {
      encoding: 'utf8', timeout: mode === 'rosetta' ? MACOS_RUNTIME_CHECK_TIMEOUTS.rosetta : 15_000,
      env: { HOME: temporary, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { mode, ...JSON.parse(output.trim()) };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

// The caller authenticates the official archive before extracting it. This
// recipe reads the extracted input and only mutates a fresh output copy.
export async function deriveNodeMacOS({ source, destination, architecture, archiveSHA256 }) {
  if (!architectures.includes(architecture) || !checksum(archiveSHA256)
      || !path.isAbsolute(source) || !path.isAbsolute(destination) || source === destination) throw new Error('Invalid macOS Node derivation inputs');
  const input = await fs.lstat(source);
  if (!input.isFile() || input.isSymbolicLink() || await fs.realpath(source) !== source) throw new Error('Node source must be an extracted regular file');
  const original = hash(await fs.readFile(source));
  requireMacOSCompatibility(inspectMacOSBinary(source, { architectures: [architecture] }), MACOS_MINIMUM_VERSION, 'Official Node');
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  try {
    await fs.chmod(destination, 0o755);
    const tool = execFileSync('/usr/bin/xcrun', ['--find', 'strip'], { encoding: 'utf8' }).trim();
    const strip = { arguments: [...NODE_MACOS.stripArguments], toolSHA256: hash(await fs.readFile(tool)),
      xcodeVersion: execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim() };
    execFileSync('/usr/bin/strip', [...NODE_MACOS.stripArguments, destination], { stdio: 'pipe' });
    const strippedSHA256 = hash(await fs.readFile(destination));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', destination], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', destination], { stdio: 'pipe' });
    const receipt = { kind: 'official-node-stripped', recipeVersion: NODE_MACOS.recipeVersion, version: NODE_MACOS.version,
      architecture, archiveSHA256, inputSHA256: original, strip, strippedSHA256,
      finalSHA256: hash(await fs.readFile(destination)), execution: await probeNodeMacOS(destination, architecture) };
    validateNodeMacOSDerivation(receipt);
    if (hash(await fs.readFile(source)) !== original) throw new Error('Official Node input changed while deriving runtime');
    requireMacOSCompatibility(inspectMacOSBinary(destination, { architectures: [architecture] }), MACOS_MINIMUM_VERSION, 'Derived Node');
    return receipt;
  } catch (error) { await fs.rm(destination, { force: true }); throw error; }
}
