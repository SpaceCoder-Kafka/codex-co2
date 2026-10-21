import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeName = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/i;

export async function npmNotices(sourceRoot, installedRoot = sourceRoot) {
  const lock = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages).filter(([name, pkg]) => name && !pkg.dev).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const parts = ['Third-party npm license and copyright texts', 'Generated from package-lock.json. Preserve these notices when redistributing.'];
  for (const [relative, expected] of entries) {
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..') || expected.link) throw new Error('Unsupported locked package path');
    const dir = path.join(installedRoot, relative);
    if (await fs.realpath(dir) !== dir) throw new Error(`Linked dependency: ${relative}`);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.version !== expected.version || pkg.license !== expected.license) throw new Error(`Lockfile metadata mismatch: ${relative}`);
    const files = (await fs.readdir(dir)).filter(name => noticeName.test(name)).sort();
    if (!files.length) throw new Error(`No license text found: ${relative}`);
    parts.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version} (${expected.license})\n${expected.resolved}\nIntegrity: ${expected.integrity}`);
    for (const name of files) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid license file: ${relative}/${name}`);
      parts.push(`\n--- ${name} ---\n${(await fs.readFile(file, 'utf8')).trimEnd()}`);
    }
  }
  return parts.join('\n\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
