import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPARKLE, digest } from './sparkle-distribution.mjs';
import { distributionDependencyEntries } from './production-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeName = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/i;
const supplementedVersions = new Set(['binary@0.3.0', 'buffers@0.1.1', 'chainsaw@0.1.0', 'saxes@5.0.1']);

async function supplementalNotice(sourceRoot, dir, pkg, expected, packageBytes) {
  const key = `${pkg.name}@${pkg.version}`;
  if (!supplementedVersions.has(key)) return null;
  const mapping = JSON.parse(await fs.readFile(path.join(sourceRoot, 'third-party/npm-license-supplements.json'), 'utf8'));
  if (Object.keys(mapping).some(name => !supplementedVersions.has(name))) throw new Error('Unreviewed supplemental license version');
  const entry = mapping[key];
  if (!entry || entry.integrity !== expected.integrity || entry.packageSHA256 !== digest(packageBytes)
    || !/^third-party\/[a-z0-9.-]+-(?:NOTICE|LICENSE)\.txt$/.test(entry.file)
    || !Array.isArray(entry.sources) || !entry.sources.length
    || entry.sources.some(source => typeof source.url !== 'string' || !source.url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(source.sha256))) {
    throw new Error(`Supplemental license metadata mismatch: ${key}`);
  }
  const file = path.join(sourceRoot, entry.file), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error(`Invalid supplemental license: ${key}`);
  const bytes = await fs.readFile(file);
  if (digest(bytes) !== entry.sha256) throw new Error(`Reviewed supplemental license changed: ${key}`);
  if (entry.codeFile) {
    if (!/^[a-zA-Z0-9.-]+$/.test(entry.codeFile)) throw new Error(`Supplemental upstream source mismatch: ${key}`);
    const sourceFile = path.join(dir, entry.codeFile), sourceStat = await fs.lstat(sourceFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || await fs.realpath(sourceFile) !== sourceFile
      || digest(await fs.readFile(sourceFile)) !== entry.codeSHA256) {
      throw new Error(`Supplemental upstream source mismatch: ${key}`);
    }
  }
  const sources = entry.sources.map(source => `Source: ${source.url}\nSource SHA-256: ${source.sha256}`).join('\n');
  return `--- ${entry.file} (reviewed version-specific supplement) ---\n${sources}\n\n${bytes.toString('utf8').trimEnd()}`;
}

export async function npmNotices(sourceRoot, installedRoot = sourceRoot) {
  const lock = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  const entries = distributionDependencyEntries(lock);
  const parts = ['Third-party npm license and copyright texts', 'Generated from the locked browser-build and service-runtime dependency closures. Preserve these notices when redistributing. Optional native packages and build-only compilers are omitted from service distributions.'];
  for (const [relative, expected] of entries) {
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..') || expected.link) throw new Error('Unsupported locked package path');
    const dir = path.join(installedRoot, relative);
    if (await fs.realpath(dir) !== dir) throw new Error(`Linked dependency: ${relative}`);
    const packageBytes = await fs.readFile(path.join(dir, 'package.json'));
    const pkg = JSON.parse(packageBytes);
    if (pkg.version !== expected.version || pkg.license !== expected.license) throw new Error(`Lockfile metadata mismatch: ${relative}`);
    const files = (await fs.readdir(dir)).filter(name => noticeName.test(name)).sort();
    // The browser PDF distribution includes separately licensed decoder/font assets.
    if (pkg.name === 'pdfjs-dist') for (const relative of ['cmaps/LICENSE', 'standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION',
      'wasm/LICENSE_JBIG2', 'wasm/LICENSE_PDFJS_JBIG2', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_PDFJS_OPENJPEG']) files.push(relative);
    let readmeLicense, supplement;
    if (!files.length) {
      supplement = await supplementalNotice(sourceRoot, dir, pkg, expected, packageBytes);
      if (!supplement) {
        const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '');
        const section = /^#{1,3} License[^\n]*\n([\s\S]*)/mi.exec(readme)?.[1];
        if (section && /Copyright/i.test(section) && /Permission is hereby granted/i.test(section) && /THE SOFTWARE IS PROVIDED/i.test(section)) readmeLicense = section.trim();
        else throw new Error(`No license text found: ${relative}`);
      }
    }
    parts.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version} (${expected.license ?? 'not declared in published package metadata; see supplement'})\n${expected.resolved}\nIntegrity: ${expected.integrity}`);
    if (supplement) parts.push(`\n${supplement}`);
    if (readmeLicense) parts.push(`\n--- README.md license section ---\n${readmeLicense}`);
    for (const name of files) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid license file: ${relative}/${name}`);
      parts.push(`\n--- ${name} ---\n${(await fs.readFile(file, 'utf8')).trimEnd()}`);
    }
  }
  // Stable text output across clean checkouts; preserve all license wording.
  return parts.join('\n\n').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (digest(await fs.readFile(path.join(root, 'third-party/Sparkle-LICENSE.txt'))) !== SPARKLE.licenseSHA256) throw new Error('Reviewed Sparkle license changed');
  const target = path.join(root, 'third-party/npm-NOTICES.txt');
  const content = await npmNotices(root);
  if (process.argv[2] === '--write') {
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
    console.log('Wrote locked npm notices.');
  } else {
    if (await fs.readFile(target, 'utf8') !== content) throw new Error('npm notices changed; regenerate and review them');
    console.log('Locked npm notices match installed packages.');
  }
}
