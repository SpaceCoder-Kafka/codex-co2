import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const configQuote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function absolute(value, label) {
  if (!value || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label} must be an absolute, single-line path`);
  return path.resolve(value);
}

function paths(options) {
  const root = absolute(options.root, 'root');
  const runtimeDir = absolute(options.runtimeDir ?? path.join(root, '.runtime'), 'runtimeDir');
  const tag = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return { root, runtimeDir, tag, generatedDir: path.join(runtimeDir, 'ssh'), targetSshDir: absolute(options.sshDir ?? path.join(os.homedir(), '.ssh'), 'sshDir') };
}

async function readOptional(filename) {
  try { return await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function writePrivate(filename, value, mode = 0o600) {
  // Refuse to replace a symlink rather than silently editing a user's unrelated file.
  try { if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error(`Refusing symlink: ${filename}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, value, { mode, flag: 'wx' });
    await fs.chmod(temp, mode);
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function markers(tag, kind) {
  return { start: `# BEGIN codex-thread-collaboration:${tag}:${kind}`, end: `# END codex-thread-collaboration:${tag}:${kind}` };
}

function removeBlock(text, marker) {
  const lines = text.split('\n');
  const start = lines.indexOf(marker.start);
  const end = lines.indexOf(marker.end);
  if (start === -1 && end === -1) return text;
  if (start === -1 || end < start || lines.lastIndexOf(marker.start) !== start || lines.lastIndexOf(marker.end) !== end) throw new Error('Malformed managed SSH block; refusing to rewrite');
  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

function addBlock(text, marker, body) {
  const clean = removeBlock(text, marker);
  // SSH uses the first obtained option. Put the explicit test host before a
  // pre-existing Host * stanza; removal restores the original bytes exactly.
  return `${marker.start}\n${body.trimEnd()}\n${marker.end}\n${clean}`;
}

function validateManagedKeys(text, marker, publicKeys) {
  removeBlock(text, marker); // Also validates marker pairing before any writes.
  const lines = text.split('\n');
  const start = lines.indexOf(marker.start);
  const end = lines.indexOf(marker.end);
  if (start === -1) return;
  if (lines.slice(start + 1, end).filter((line) => line.trim()).some((line) => !publicKeys.some((key) => line.endsWith(` ${key}`)))) {
    throw new Error('Managed key block contains an unfamiliar key; refusing to modify it');
  }
}

async function ensureKey(filename, comment) {
  const privateExists = await fs.stat(filename).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (!privateExists) await exec('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', filename]);
  await fs.chmod(filename, 0o600);
  const publicPath = `${filename}.pub`;
  let pub = await readOptional(publicPath);
  if (!pub) {
    const { stdout } = await exec('/usr/bin/ssh-keygen', ['-y', '-f', filename]);
    pub = `${stdout.trim()} ${comment}\n`;
    await writePrivate(publicPath, pub);
  }
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?\n?$/.test(pub)) throw new Error(`Invalid generated public key: ${publicPath}`);
  return { privatePath: filename, publicPath, publicKey: pub.trim() };
}

/** Generate transport assets. No real SSH configuration is changed unless install=true. */
export async function prepareSsh(options) {
  const p = paths(options);
  const codexHome = absolute(options.codexHome, 'codexHome');
  const cliPath = absolute(options.cliPath, 'cliPath');
  const socketPath = absolute(options.socketPath ?? path.join(codexHome, 'app-server-control', 'app-server-control.sock'), 'socketPath');
  const host = options.host ?? '127.0.0.1';
  const user = options.user ?? os.userInfo().username;
  const port = Number(options.port ?? 22);
  const alias = options.alias ?? 'codex-coop';
  if (!/^[a-zA-Z0-9_.:[\]-]+$/.test(host) || host.startsWith('-')) throw new Error('Invalid SSH host');
  if (!/^[a-zA-Z0-9_.-]+$/.test(user) || user.startsWith('-')) throw new Error('Invalid SSH user');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)) throw new Error('Invalid SSH alias');
  const binDir = path.join(p.generatedDir, 'bin');
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.chmod(p.generatedDir, 0o700);
  const configPath = path.join(p.generatedDir, 'environment.sh');
  const scriptPath = path.join(p.root, 'scripts', 'ssh-entry.sh');
  await fs.access(scriptPath);
  const entryPath = path.join(binDir, 'ssh-entry');
  const shellPath = path.join(binDir, 'coop-shell');
  await writePrivate(configPath, Object.entries({ CODEX_HOME: codexHome, CODEX_INSTALL_DIR: binDir, CODEX_COOP_CLI: cliPath, CODEX_COOP_SHELL: shellPath, CODEX_COOP_SOCKET: socketPath }).map(([key, value]) => `${key}=${shellQuote(value)}\n`).join(''));
  for (const [name, mode] of [['ssh-entry', 'entry'], ['coop-shell', 'shell'], ['codex', 'codex'], ['pkill', 'deny-pkill']]) {
    await writePrivate(path.join(binDir, name), `#!/bin/sh\nexec /bin/sh ${shellQuote(scriptPath)} ${shellQuote(configPath)} ${mode} "$@"\n`, 0o700);
  }
  const keyA = await ensureKey(path.join(p.generatedDir, 'id_ed25519_a'), `codex-coop:${p.tag}:a`);
  const keyB = await ensureKey(path.join(p.generatedDir, 'id_ed25519_b'), `codex-coop:${p.tag}:b`);
  const aliasA = `${alias}-a`;
  const aliasB = `${alias}-b`;
  const guestIdentityPath = `~/.ssh/codex-coop-${p.tag}-b`;
  const config = (name, identity) => `Host ${name}\n  HostName ${host}\n  Port ${port}\n  User ${user}\n  IdentityFile ${configQuote(identity)}\n  IdentitiesOnly yes\n  IdentityAgent none\n  BatchMode yes\n  RequestTTY no\n  ForwardAgent no\n  ClearAllForwardings yes\n  ServerAliveInterval 15\n  ServerAliveCountMax 3\n`;
  const configAPath = path.join(p.generatedDir, 'config-a');
  const configBPath = path.join(p.generatedDir, 'config-b');
  await writePrivate(configAPath, config(aliasA, keyA.privatePath));
  await writePrivate(configBPath, config(aliasB, guestIdentityPath));
  const forced = `command=${configQuote(shellQuote(entryPath))},no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty`;
  const authorizedKeysPath = path.join(p.generatedDir, 'authorized_keys');
  await writePrivate(authorizedKeysPath, [keyA, keyB].map((key) => `${forced} ${key.publicKey}\n`).join(''));
  const manifestPath = path.join(p.generatedDir, 'manifest.json');
  const result = { ...p, codexHome, cliPath, socketPath, host, user, port, aliasA, aliasB, configAPath, configBPath, authorizedKeysPath, entryPath, guestIdentityPath, manifestPath, keys: { a: { privatePath: keyA.privatePath, publicPath: keyA.publicPath }, b: { privatePath: keyB.privatePath, publicPath: keyB.publicPath } } };
  await writePrivate(manifestPath, `${JSON.stringify({ ...result, publicKeys: [keyA.publicKey, keyB.publicKey] }, null, 2)}\n`);
  if (options.install) await installSsh({ ...options, ...result, sshDir: p.targetSshDir });
  return { ...result, installed: Boolean(options.install) };
}

/** Install A's config and both test keys on the execution host; idempotent and scoped. */
export async function installSsh(options) {
  const p = paths(options);
  const manifest = JSON.parse(await fs.readFile(path.join(p.generatedDir, 'manifest.json'), 'utf8'));
  const configPath = path.join(p.targetSshDir, 'config');
  const authorizedPath = path.join(p.targetSshDir, 'authorized_keys');
  const configMarker = markers(p.tag, 'config');
  const keysMarker = markers(p.tag, 'keys');
  const currentConfig = await readOptional(configPath);
  const currentKeys = await readOptional(authorizedPath);
  validateManagedKeys(currentKeys, keysMarker, manifest.publicKeys);
  const unownedConfig = removeBlock(currentConfig, configMarker);
  if (unownedConfig.split('\n').some((line) => /^\s*Host\s+/i.test(line) && line.trim().split(/\s+/).slice(1).includes(manifest.aliasA))) throw new Error(`SSH alias ${manifest.aliasA} already exists outside the managed block`);
  const configText = addBlock(currentConfig, configMarker, await fs.readFile(manifest.configAPath, 'utf8'));
  const keyText = addBlock(currentKeys, keysMarker, await fs.readFile(manifest.authorizedKeysPath, 'utf8'));
  await fs.mkdir(p.targetSshDir, { recursive: true, mode: 0o700 });
  await writePrivate(configPath, configText);
  await writePrivate(authorizedPath, keyText);
  return { configPath, authorizedPath, alias: manifest.aliasA };
}

/** Remove only this project's managed blocks; retain generated keys for explicit deletion. */
export async function removeSsh(options) {
  const p = paths(options);
  const manifest = JSON.parse(await fs.readFile(path.join(p.generatedDir, 'manifest.json'), 'utf8'));
  const configPath = path.join(p.targetSshDir, 'config');
  const authorizedPath = path.join(p.targetSshDir, 'authorized_keys');
  const currentConfig = await readOptional(configPath);
  const currentKeys = await readOptional(authorizedPath);
  const keyMarker = markers(p.tag, 'keys');
  // An edited block could contain unrelated keys. Do not erase those accidentally.
  validateManagedKeys(currentKeys, keyMarker, manifest.publicKeys);
  const nextConfig = removeBlock(currentConfig, markers(p.tag, 'config'));
  const nextKeys = removeBlock(currentKeys, keyMarker);
  if (nextConfig !== currentConfig) await writePrivate(configPath, nextConfig);
  if (nextKeys !== currentKeys) await writePrivate(authorizedPath, nextKeys);
  return { configPath, authorizedPath, removed: nextConfig !== currentConfig || nextKeys !== currentKeys, generatedKeysRetained: true };
}
