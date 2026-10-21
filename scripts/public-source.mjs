import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const forbiddenPath = /(?:^|\/)(?:\.git|\.coop|node_modules|dist|auth\.json|\.npmrc|\.env(?:\..*)?)(?:\/|$)|\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db|jsonl|ndjson|har|zip|dmg|log)$/i;
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider credential', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})/],
  ['credential-bearing URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['personal absolute path', /\/(?:Users|home)\/[A-Za-z][^\s"'<>]*/],
  ['private documentation reference', /codex-co2-\x64oc/],
];

export function scanPublicFile(name, bytes) {
  if (forbiddenPath.test(name)) throw new Error(`Private export path: ${name}`);
  const text = bytes.toString('utf8');
  for (const [label, pattern] of patterns) if (pattern.test(text)) throw new Error(`Public scan: ${label} in ${name}`);
}

export async function publicSource(root = sourceRoot) {
  root = await fs.realpath(root);
  const names = JSON.parse(await fs.readFile(path.join(root, 'scripts/public-files.json'), 'utf8'));
  if (!Array.isArray(names) || new Set(names).size !== names.length || !names.includes('scripts/public-files.json')) throw new Error('Invalid public allowlist');
  const files = {}, contents = new Map();
  for (const name of [...names].sort()) {
    if (typeof name !== 'string' || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe export path');
    const absolute = path.join(root, name), stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error(`Non-regular public file: ${name}`);
    const bytes = await fs.readFile(absolute);
    scanPublicFile(name, bytes); files[name] = hash(bytes); contents.set(name, bytes);
  }
  return { files, contents, sha256: hash(JSON.stringify(files)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await publicSource();
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: sourceRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  const extra = tracked.filter(name => !Object.hasOwn(result.files, name));
  if (extra.length) throw new Error(`Tracked files outside the public allowlist: ${extra.join(', ')}`);
  console.log(JSON.stringify({ publicFiles: result.contents.size, sourceSHA256: result.sha256, patternScan: 'passed', note: 'Pattern screening is not a complete secret or rights audit.' }));
}
