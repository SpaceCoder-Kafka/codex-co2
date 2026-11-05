import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export const BROWSER_BUILD_DEPENDENCIES = Object.freeze(['dompurify', 'exceljs', 'fflate', 'highlight.js', 'katex', 'mermaid', 'papaparse', 'pdfjs-dist']);
const runtimeRoots = ['markdown-it', 'ws'];
// Reviewed published runtime files, bound to exact locked package versions.
// Keep the Node import/require exports and the separately served Markdown
// browser entry. No source trees, type declarations, maps or CLI shims ship.
const runtimeProfiles = Object.freeze({
  'ws': { version: '8.22.0', files: ['LICENSE', 'package.json', 'browser.js', 'index.js', 'wrapper.mjs', ...['buffer-util', 'constants', 'event-target', 'extension', 'limiter', 'permessage-deflate', 'receiver', 'sender', 'stream', 'subprotocol', 'validation', 'websocket-server', 'websocket'].map(name => `lib/${name}.js`)] },
  'markdown-it': { version: '15.0.3', files: ['LICENSE', 'package.json', 'dist/markdown-it.mjs', 'dist/markdown-it.cjs.js', 'dist/browser/markdown-it.umd.min.js', 'dist/browser/markdown-it.esm.min.mjs'] },
  'argparse': { version: '3.0.3', files: ['LICENSE', 'package.json', ...['_colorize', 'argparse', 'difflib', 'sub', 'textwrap'].map(name => `lib/${name}.js`)] },
  'entities': { version: '8.1.0', files: ['LICENSE', 'package.json', ...['decode-codepoint', 'decode', 'encode', 'escape', 'index', 'generated/decode-data-html', 'generated/decode-data-xml', 'generated/encode-html', 'internal/bin-trie-flags', 'internal/decode-shared'].map(name => `dist/${name}.js`)] },
  'linkify-it': { version: '6.1.0', files: ['LICENSE', 'package.json', 'build/index.cjs.js', 'build/index.mjs'] },
  'mdurl': { version: '2.1.0', files: ['LICENSE', 'package.json', 'index.mjs', 'build/index.cjs.js', ...['decode', 'encode', 'format', 'parse'].map(name => `lib/${name}.mjs`)] },
  'punycode.js': { version: '2.3.1', files: ['LICENSE-MIT.txt', 'package.json', 'punycode.js', 'punycode.es6.js'] },
  'uc.micro': { version: '3.0.0', files: ['LICENSE.txt', 'package.json', 'build/index.cjs.js', 'build/index.mjs'] },
});
const runtimeSources = Object.freeze({
  'ws': { license: 'MIT', integrity: 'sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==' },
  'markdown-it': { license: 'MIT', integrity: 'sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==' },
  'argparse': { license: 'PSF-2.0', integrity: 'sha512-Sn98ftV3KfsO8xfLPHG6oT8y+b0yvbrLgZjgPDXsharNY15tTAjqIsIju4S32nl6/iEUNNE4v+yL2Zhm8ooP3w==' },
  'entities': { license: 'BSD-2-Clause', integrity: 'sha512-kxL7msIffSuh9aaFAMD7rxAIuTRMAHMeBtgHW2yUdWw732ZNh4MehkF2gdjvtdmikkaIP9bFDDJOPlsvm7avrA==' },
  'linkify-it': { license: 'MIT', integrity: 'sha512-wJ/TwpSDTLepCrQoYWYIExIKg5Zchex2Nn5yk2mFnB+6PtdkHtyLx742md9csRjjOnGkKIS/RrbY7l8D6gT9Vw==' },
  'mdurl': { license: 'MIT', integrity: 'sha512-1+HBaOx0zi/dQWht8rNv9MYf9qqpqL/kxI0hXImU6Y547zM6Sni8BQibt7ifgMcYtQg41ao3Ivd6cnSM86inpg==' },
  'punycode.js': { license: 'MIT', integrity: 'sha512-uxFIHU0YlHYhDQtV4R9J6a52SLx28BCjT+4ieh7IGbgwVJWO+km431c4yRlREUAsAmt/uMjQUyQHNEPf0M39CA==' },
  'uc.micro': { license: 'MIT', integrity: 'sha512-U3PppEkleoTnIfi8BozMx3yju3qc/L6SwqWo2Sw+54PX+PX0q9I+r1Um5HCmqD7n9VDX5/v3vQH/AjA6deDdtw==' },
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function resolveLocked(lock, from, name) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Unsupported dependency name: ' + name);
  let directory = from;
  while (true) {
    if (path.posix.basename(directory) !== 'node_modules') {
      const candidate = (directory ? directory + '/' : '') + 'node_modules/' + name;
      if (Object.hasOwn(lock.packages, candidate)) return candidate;
    }
    if (!directory) return null;
    directory = path.posix.dirname(directory); if (directory === '.') directory = '';
  }
}

function lockedClosure(lock, roots, { optionalPeers = true } = {}) {
  if (!lock?.packages || typeof lock.packages !== 'object') throw new Error('Missing locked packages');
  const seen = new Set(), pending = roots.map(name => {
    const relative = resolveLocked(lock, '', name);
    if (!relative) throw new Error('Missing locked dependency: ' + name);
    return relative;
  });
  while (pending.length) {
    const relative = pending.pop(), pkg = lock.packages[relative];
    if (seen.has(relative) || pkg.optional) continue;
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..') || pkg.link) throw new Error('Unsupported locked package path');
    seen.add(relative);
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {
      if (!optionalPeers && pkg.peerDependenciesMeta?.[name]?.optional && !Object.hasOwn(pkg.dependencies ?? {}, name)) continue;
      const target = resolveLocked(lock, relative, name);
      if (!target && Object.hasOwn(pkg.dependencies ?? {}, name)) throw new Error('Missing locked dependency: ' + name);
      if (target) pending.push(target);
    }
  }
  return [...seen].sort().map(name => [name, lock.packages[name]]);
}

// Notices cover both code compiled into browser assets and code copied into
// the service. A devDependency flag does not mean browser code is unshipped.
export function distributionDependencyEntries(lock) {
  const root = lock?.packages?.[''];
  if (!root) return Object.entries(lock.packages ?? {}).filter(([name, pkg]) => name && !pkg.optional).sort(([a], [b]) => a.localeCompare(b, 'en'));
  if (Object.keys(root.devDependencies ?? {}).some(name => name !== 'esbuild' && !BROWSER_BUILD_DEPENDENCIES.includes(name))) throw new Error('Unreviewed browser-build dependency root');
  const roots = [...Object.keys(root.dependencies ?? {}), ...BROWSER_BUILD_DEPENDENCIES.filter(name => Object.hasOwn(root.devDependencies ?? {}, name))];
  return lockedClosure(lock, roots).sort(([a], [b]) => a.localeCompare(b, 'en'));
}

export function productionDependencyPlan(lock) {
  if (JSON.stringify(Object.keys(lock?.packages?.['']?.dependencies ?? {}).sort()) !== JSON.stringify(runtimeRoots)) throw new Error('Unreviewed service dependency roots');
  const entries = lockedClosure(lock, runtimeRoots, { optionalPeers: false });
  if (JSON.stringify(entries.map(([relative]) => relative.slice('node_modules/'.length)).sort()) !== JSON.stringify(Object.keys(runtimeProfiles).sort())) throw new Error('Unreviewed service dependency closure');
  return entries.map(([relative, expected]) => {
    const name = relative.slice('node_modules/'.length), profile = runtimeProfiles[name];
    if (expected.version !== profile.version || expected.integrity !== runtimeSources[name].integrity || expected.license !== runtimeSources[name].license || expected.link || !/^https:\/\//.test(expected.resolved ?? '')) throw new Error('Unreviewed runtime dependency version or source: ' + name);
    return { name, relative, expected, files: [...profile.files].sort() };
  });
}

async function regularWithin(root, relative) {
  let current = root;
  for (const [index, component] of relative.split('/').entries()) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < relative.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe dependency file: ' + relative);
  }
  if (await fs.realpath(current) !== current) throw new Error('Linked dependency file: ' + relative);
  return current;
}

async function readLock(sourceRoot) {
  const bytes = await fs.readFile(path.join(sourceRoot, 'package-lock.json'));
  return { lock: JSON.parse(bytes), lockSHA256: digest(bytes) };
}

export async function copyProductionDependencies({ sourceRoot, installedRoot = sourceRoot, destination }) {
  const { lock, lockSHA256 } = await readLock(sourceRoot), plan = productionDependencyPlan(lock);
  const installed = await fs.realpath(path.resolve(installedRoot)), target = path.resolve(destination);
  const modules = path.join(installed, 'node_modules');
  if (target === modules || target.startsWith(modules + path.sep)) throw new Error('Dependency output must be outside the installed node_modules');
  const receipt = { version: 1, lockSHA256, packages: {}, files: {} };
  // Refuse pre-existing paths; never merge extra dependencies into a package.
  await fs.mkdir(target);
  try {
    for (const item of plan) {
      const packageFile = await regularWithin(installed, item.relative + '/package.json');
      const metadata = await fs.readFile(packageFile), pkg = JSON.parse(metadata);
      if (pkg.name !== item.name || pkg.version !== item.expected.version || pkg.license !== item.expected.license) throw new Error('Runtime lockfile metadata mismatch: ' + item.name);
      receipt.packages[item.name] = { version: pkg.version, integrity: item.expected.integrity, packageSHA256: digest(metadata) };
      for (const relative of item.files) {
        const source = await regularWithin(installed, item.relative + '/' + relative), bytes = await fs.readFile(source), name = item.name + '/' + relative;
        const output = path.join(target, name); await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, bytes, { flag: 'wx', mode: 0o644 }); receipt.files[name] = { sha256: digest(bytes) };
      }
    }
    await checkProductionDependencies({ sourceRoot, nodeModules: target, receipt });
    return receipt;
  } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
}

export async function checkProductionDependencies({ sourceRoot = projectRoot, expectedLockSHA256, nodeModules, receipt }) {
  // An independently extracted internal bundle can bind the lock digest from
  // its preserved public-source receipt without consulting a mutable checkout.
  // Exact versions, archive integrities, licenses and file paths remain pinned
  // by this reviewed profile in both verification modes.
  let plan, lockSHA256;
  if (expectedLockSHA256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedLockSHA256)) throw new Error('Invalid expected runtime lock digest');
    lockSHA256 = expectedLockSHA256;
    plan = Object.entries(runtimeProfiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, profile]) => ({ name, files: [...profile.files].sort(), expected: { version: profile.version, ...runtimeSources[name] } }));
  } else {
    const input = await readLock(sourceRoot); lockSHA256 = input.lockSHA256; plan = productionDependencyPlan(input.lock);
  }
  if (receipt?.version !== 1 || receipt.lockSHA256 !== lockSHA256) throw new Error('Runtime dependency receipt does not match the lockfile');
  const expected = plan.flatMap(item => item.files.map(name => item.name + '/' + name)).sort();
  if (JSON.stringify(Object.keys(receipt.files ?? {}).sort()) !== JSON.stringify(expected) || JSON.stringify(Object.keys(receipt.packages ?? {}).sort()) !== JSON.stringify(plan.map(item => item.name).sort())) throw new Error('Runtime dependency receipt inventory mismatch');
  const directory = path.resolve(nodeModules), stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Unsafe runtime node_modules');
  const actual = [];
  const expectedDirectories = new Set();
  for (const name of expected) { let directory = path.posix.dirname(name); while (directory !== '.') { expectedDirectories.add(directory); directory = path.posix.dirname(directory); } }
  async function visit(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked runtime dependency: ' + name);
      if (entry.isDirectory()) { if (!expectedDirectories.has(name)) throw new Error('Runtime dependency directory inventory mismatch: ' + name); await visit(file, name + '/'); }
      else if (entry.isFile()) actual.push(name);
      else throw new Error('Unsupported runtime dependency object: ' + name);
    }
  }
  await visit(directory);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error('Runtime dependency file inventory mismatch');
  for (const name of expected) if (JSON.stringify(Object.keys(receipt.files[name] ?? {})) !== JSON.stringify(['sha256']) || digest(await fs.readFile(await regularWithin(directory, name))) !== receipt.files[name].sha256) throw new Error('Runtime dependency digest mismatch: ' + name);
  for (const item of plan) {
    const metadata = await fs.readFile(await regularWithin(directory, item.name + '/package.json')), pkg = JSON.parse(metadata), entry = receipt.packages[item.name];
    if (pkg.name !== item.name || pkg.version !== item.expected.version || pkg.license !== item.expected.license || entry.version !== pkg.version || entry.integrity !== item.expected.integrity || entry.packageSHA256 !== digest(metadata)) throw new Error('Runtime dependency metadata mismatch: ' + item.name);
  }
  return { packages: plan.length, files: expected.length };
}

export const assertProductionDependencies = checkProductionDependencies;

// npm creates executable shims at every dependency nesting level. They are
// build-time entry points; the packaged service resolves library modules.
export async function removeDependencyBins(nodeModules) {
  const root = path.resolve(nodeModules);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.basename(root) !== 'node_modules') throw new Error('Expected a regular node_modules directory');
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (path.basename(directory) === 'node_modules' && entry.name === '.bin') {
        await fs.rm(file, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        // Do not follow package links. Any links outside .bin remain for the
        // bundle inventory to reject rather than broadening this cleanup.
        const current = await fs.lstat(file);
        if (current.isDirectory() && !current.isSymbolicLink()) await visit(file);
      }
    }
  }
  await visit(root);
}
