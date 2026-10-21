import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { publicSource, sourceRoot } from './public-source.mjs';

const requested = process.argv[2];
if (!requested || !path.isAbsolute(requested)) throw new Error('Provide an absolute path to a new destination');
const parent = await fs.realpath(path.dirname(requested)), destination = path.join(parent, path.basename(requested));
const root = await fs.realpath(sourceRoot);
if (destination === root || destination.startsWith(root + path.sep) || root.startsWith(destination + path.sep)) throw new Error('Destination must be outside this checkout');
for (const name of [destination, destination + '.review.json']) {
  try { await fs.lstat(name); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Destination or review report already exists; nothing was overwritten');
}
const source = await publicSource();
const temporary = await fs.mkdtemp(path.join(parent, '.co2-export-'));
try {
  for (const [name, bytes] of source.contents) {
    const target = path.join(temporary, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const check = await publicSource(temporary);
  if (check.sha256 !== source.sha256) throw new Error('Export does not match the reviewed source set');
  const git = args => execFileSync('git', args, { cwd: temporary, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git(['init', '--initial-branch=main', '--template=']);
  git(['-c', 'core.autocrlf=false', 'add', '--all']);
  const tree = git(['write-tree']);
  await fs.rename(temporary, destination);
  await fs.writeFile(destination + '.review.json', JSON.stringify({ prepared: new Date().toISOString(), sourceSHA256: source.sha256, stagedTree: tree, files: source.files,
    historyCopied: false, commitCreated: false, remoteConfigured: false, published: false,
    pending: ['Choose public Git author name/email and create initial commit', 'Enable private vulnerability reporting', 'Final-package native and clean-Mac acceptance', 'Associate source commit and release assets before publication'],
    scan: 'Pattern screening only; not a complete secret or rights audit' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ destination, sourceSHA256: source.sha256, stagedTree: tree, committed: false, published: false }));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
