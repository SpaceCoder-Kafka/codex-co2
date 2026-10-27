import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const LIMIT = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unsafe = () => new Error('邀请恢复记录无法安全读取或保存，已停止恢复授权。');

// A disabled background preference is a durable revocation boundary. Call
// this only while holding the sharing lease, before opening any recovery
// store. Remove the snapshot durably before its incomplete-commit marker so
// a crash cannot expose an older eligible snapshot without that marker.
export function clearRecoveryStore(file) {
  if (process.platform === 'win32' || !path.isAbsolute(file) || file !== path.resolve(file)
    || path.basename(path.dirname(file)) !== '.coop') throw unsafe();
  const directory = path.dirname(file), pending = `${file}.pending`, opened = [];
  let directoryFd;
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
  try {
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const identity = fs.fstatSync(directoryFd);
    const checkDirectory = () => {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid()
        || (current.mode & 0o777) !== 0o700 || !same(current, identity)) throw unsafe();
    };
    checkDirectory();
    const inspect = target => {
      let fd;
      try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      opened.push(fd);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw unsafe();
      return stat;
    };
    const snapshot = inspect(file), marker = inspect(pending);
    const remove = (target, expected) => {
      checkDirectory();
      let current;
      try { current = fs.lstatSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Boolean(current) !== Boolean(expected) || (current && !same(current, expected))) throw unsafe();
      if (current) fs.unlinkSync(target);
      fs.fsyncSync(directoryFd);
    };
    remove(file, snapshot);
    remove(pending, marker);
  } catch { throw unsafe(); }
  finally {
    for (const fd of opened) fs.closeSync(fd);
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

// Recovery state is security-sensitive even though it contains only credential
// hashes. A durable pending marker deliberately makes an interrupted commit
// fail closed instead of loading an older approval or revocation snapshot.
export function openRecoveryStore(file) {
  if (process.platform === 'win32' || !path.isAbsolute(file) || file !== path.resolve(file)
    || path.basename(path.dirname(file)) !== '.coop') throw unsafe();
  const directory = path.dirname(file), pending = `${file}.pending`;
  const sameUser = stat => stat.uid === process.getuid();
  let identity;
  const checkDirectory = () => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameUser(stat) || (stat.mode & 0o777) !== 0o700
      || (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino))) throw unsafe();
    identity ??= { dev: stat.dev, ino: stat.ino };
  };
  const syncDirectory = () => {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const exists = target => {
    try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const read = () => {
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !sameUser(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > LIMIT) throw unsafe();
      const bytes = Buffer.alloc(Math.min(stat.size + 1, LIMIT + 1));
      let count = 0, size;
      while (count < bytes.length && (size = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += size;
      if (count !== stat.size || fs.fstatSync(fd).size !== stat.size) throw unsafe();
      return bytes.subarray(0, count);
    } finally { fs.closeSync(fd); }
  };
  checkDirectory();
  if (exists(pending)) throw unsafe();
  const bytes = read();
  let expected = bytes && digest(bytes), value = null;
  if (bytes) {
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw unsafe(); }
  }
  return {
    file, value,
    write(value) {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > LIMIT) throw unsafe();
      checkDirectory();
      let marker, temp;
      try {
        // Exclusive creation also prevents two service instances from writing
        // this file concurrently. A prior incomplete transaction is not erased.
        marker = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(marker, 0o600);
        fs.writeFileSync(marker, '{"version":1}\n'); fs.fsyncSync(marker); fs.closeSync(marker); marker = undefined;
        syncDirectory();
        const previous = read();
        if ((previous && digest(previous)) !== expected) throw unsafe();
        temp = `${file}.${randomUUID()}.tmp`;
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file); temp = undefined; syncDirectory();
        fs.unlinkSync(pending); syncDirectory();
        expected = digest(bytes);
      } catch {
        // Keep the pending marker: the preceding file is not a trusted fallback.
        if (marker !== undefined) { try { fs.closeSync(marker); } catch {} }
        if (temp) { try { fs.unlinkSync(temp); } catch {} }
        throw unsafe();
      }
    },
  };
}
