import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from './runtime.mjs';

const validChild = value => value && Object.keys(value).sort().join(',') === 'fingerprint,pid'
  && Number.isSafeInteger(value.pid) && value.pid > 1 && /^[a-f0-9]{64}$/.test(value.fingerprint ?? '');
function read(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096) throw new Error('Unsafe background child ownership record');
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'children,version' || value.version !== 1
      || !Array.isArray(value.children) || value.children.length > 4 || !value.children.every(validChild)) throw new Error('Invalid background child ownership record');
    return value.children;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export class BackgroundChildren {
  constructor(runtimeDir, executable) {
    if (!path.isAbsolute(executable)) throw new Error('Background child executable must be absolute');
    this.executable = executable; this.file = path.join(runtimeDir, 'background-children.json');
  }
  record(child) {
    const value = { pid: child.pid, fingerprint: child.fingerprint };
    if (!validChild(value)) throw new Error('Invalid background child');
    read(this.file);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ version: 1, children: [value] }) + '\n'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    try {
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  owned(child) {
    const current = processIdentity(child.pid);
    return current?.fingerprint === child.fingerprint && current.identity.includes(`${this.executable} tunnel `);
  }
  async retire() {
    for (const child of read(this.file)) {
      if (!this.owned(child)) continue;
      try { process.kill(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 30 && this.owned(child); attempt++) await delay(100);
      if (this.owned(child)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        for (let attempt = 0; attempt < 10 && this.owned(child); attempt++) await delay(100);
      }
      if (this.owned(child)) throw new Error('An owned background tunnel did not stop');
    }
    this.clear();
  }
  clear() { try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
