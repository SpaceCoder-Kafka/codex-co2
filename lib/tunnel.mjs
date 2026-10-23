import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateFile } from './platform.mjs';

export function validateTunnelOptions({ tokenFile, origin } = {}) {
  if (!tokenFile) return;
  if (!path.isAbsolute(tokenFile)) throw new Error('Tunnel token file must be an absolute path');
  let url;
  try { url = new URL(origin); } catch { throw new Error('Named tunnel requires --origin https://your-hostname'); }
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Named tunnel origin must be an HTTPS origin without a path');
}

export async function startTunnel(localUrl, { binary = 'cloudflared', signal, onSpawn = () => {}, tokenFile, origin } = {}) {
  const url = new URL(localUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Tunnel may expose only the local relay listener');
  validateTunnelOptions({ tokenFile, origin });
  if (tokenFile) {
    const stat = await fs.lstat(tokenFile);
    await assertPrivateFile(tokenFile, stat).catch(() => { throw new Error('Tunnel token file must be a private same-user regular file (0600)'); });
  }
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key];
  signal?.throwIfAborted();
  // cloudflared reads the explicit credential file; its contents never enter
  // Co² memory, argv, diagnostics or the public relay. Configure the named
  // tunnel's ingress to point only to the local relay, never the owner listener.
  const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', ...(tokenFile
    ? ['run', '--token-file', tokenFile, '--url', url.origin]
    : ['--url', url.origin])];
  const child = spawn(binary, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.once('spawn', () => onSpawn(child));
  let closing;
  const close = () => closing ??= (async () => {
    if (!child.pid || child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  let tail = '', connected = false;
  try {
    const publicUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel did not become ready within 60 seconds')), 60000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('cloudflared unavailable; install the official cloudflared package')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Tunnel exited before startup')); });
      child.stderr.on('data', chunk => {
        tail = (tail + chunk.toString()).slice(-8000);
        connected ||= tail.includes('Registered tunnel connection');
        const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (connected && (tokenFile || match)) { clearTimeout(timer); resolve(tokenFile ? origin : match[0]); }
      });
    });
    signal?.throwIfAborted();
    return { url: publicUrl, pid: child.pid, child, close: async () => { signal?.removeEventListener('abort', abort); await close(); } };
  } catch (error) { signal?.removeEventListener('abort', abort); await close(); throw error; }
}
