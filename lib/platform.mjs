import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Duplex } from 'node:stream';

const runFile = promisify(execFile);
export const WINDOWS_DESKTOP_PIPE = String.raw`\\.\pipe\codex-ipc`;

// The packaged Windows shell supplies its own absolute executable path. Never
// resolve a privileged helper through PATH or invoke a command interpreter.
export function platformBridgePath(env = process.env) {
  const executable = env.CO2_PLATFORM_BRIDGE;
  if (!executable || !path.isAbsolute(executable) || !/\.exe$/i.test(executable)) {
    throw new Error('The packaged Windows platform bridge is unavailable');
  }
  return executable;
}

async function bridge(command, args = []) {
  const { stdout } = await runFile(platformBridgePath(), ['--co2-platform', command, ...args], {
    windowsHide: true, timeout: 10000, maxBuffer: 16384,
  });
  const result = JSON.parse(stdout);
  if (result?.ok !== true) throw new Error('Windows local security check failed');
  return result;
}

export async function assertPrivateFile(file, stat, { maxBytes = Infinity } = {}) {
  stat ??= await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('需要同用户私有文件 (private regular file)');
  if (process.platform === 'win32') await bridge('check-path', [file, 'private-file']);
  else if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('需要同用户私有文件 (same-user private file)');
  return stat;
}

// Read-only checks for an existing Desktop endpoint/index. In particular, this
// function never changes permissions on the official Desktop's state.
export async function assertProtectedPath(file, { directory = false, privateAccess = false } = {}) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe local path');
  if (process.platform === 'win32') await bridge('check-path', [file, directory ? 'private-directory' : 'private-file']);
  else if (stat.uid !== process.getuid() || (stat.mode & (privateAccess ? 0o077 : 0o022))) throw new Error('Unsafe local permissions');
  return stat;
}

export async function ensurePrivateDirectory(directory) {
  if (process.platform === 'win32') { await bridge('secure-directory', [directory]); return; }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Private directory must be owned by this user');
  await fs.chmod(directory, 0o700);
}

export async function writePrivateFile(file, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Private file exceeds the write limit');
  if (process.platform !== 'win32') { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); return; }
  await new Promise((resolve, reject) => {
    const child = spawn(platformBridgePath(), ['--co2-platform', 'write-private-file', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows private file creation timed out')); }, 10000);
    child.once('error', () => finish(new Error('Windows private file bridge could not start')));
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 16384) { child.kill(); finish(new Error('Invalid private file bridge response')); } });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('close', code => {
      let result; try { result = JSON.parse(output); } catch { }
      finish(code === 0 && result?.ok === true ? null : new Error('Windows private file creation failed'));
    });
    // State bytes stay in a private pipe, never in process arguments or logs.
    child.stdin.end(bytes);
  });
}

export function windowsProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const result = JSON.parse(execFileSync(platformBridgePath(), ['--co2-platform', 'process-identity', String(pid)], {
      windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    return result.ok === true && typeof result.identity === 'string' ? result.identity : null;
  } catch { return null; }
}

export async function openDesktopLink(threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('Invalid Desktop conversation ID');
  if (process.platform === 'win32') throw new Error('Windows Desktop navigation requires the native manager broker');
  if (process.platform !== 'darwin') throw new Error('This system cannot open the official Desktop');
  await runFile('/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${threadId}`], { timeout: 5000 });
}

// Keep authentication and I/O on the SAME native pipe handle. A separate
// "check the pipe, then net.connect" would permit endpoint replacement between
// verification and initialize. The native bridge forwards no bytes until the
// connected server SID and pipe DACL have passed its checks.
export async function connectWindowsDesktop(endpoint, { timeoutMs = 10000 } = {}) {
  if (endpoint !== WINDOWS_DESKTOP_PIPE) throw new Error('Unsupported official Desktop named pipe');
  const child = spawn(platformBridgePath(), ['--co2-platform', 'desktop-ipc'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
  socket.on('error', () => {}); // Handshake failures are returned to the caller.
  socket.once('close', () => { if (child.exitCode == null) child.kill(); });
  // Hold stdout until the ready acknowledgement. It is never interpreted as
  // control text and can contain only official Desktop protocol bytes.
  try {
    await new Promise((resolve, reject) => {
      let text = '', settled = false;
      const timer = setTimeout(() => finish(new Error('Windows Desktop connection timed out')), timeoutMs);
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.stderr.off('data', data);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error('Windows platform bridge could not start'));
      const exited = () => finish(new Error('The existing Windows Desktop pipe could not be authenticated'));
      const data = bytes => {
        text += bytes.toString('ascii');
        if (text === 'CO2_IPC_READY\n') finish();
        else if (text.length > 1024 || text.includes('\n')) finish(new Error('Invalid Windows Desktop bridge acknowledgement'));
      };
      child.once('error', failed); child.once('exit', exited); child.stderr.on('data', data);
    });
    child.stderr.resume();
    child.on('error', () => socket.destroy(new Error('Windows Desktop bridge failed')));
    child.on('exit', () => socket.destroy());
    return socket;
  } catch (error) { socket.destroy(); child.kill(); throw error; }
}
