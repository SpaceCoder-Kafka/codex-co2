import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { attachmentInput, MAX_ATTACHMENTS, trustedAttachments } from './guest-uploads.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 8192;
const invalid = () => new Error('共享附件记录不可用。');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function checkPrivate(stat, directory) {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw invalid();
}

function checkDirectory(dir) { checkPrivate(fs.lstatSync(dir), true); }

function checkedUploadPath(root, relative) {
  if (typeof relative !== 'string') throw invalid();
  const [room, upload, name, ...extra] = relative.split('/');
  if (!UUID.test(room ?? '') || !UUID.test(upload ?? '') || extra.length || !name || !/^[\p{L}\p{N} ._()-]+$/u.test(name) ||
      /^\.|[. ]$/u.test(name) || Buffer.byteLength(name) > 255) throw invalid();
  const roomDir = path.join(root, room), uploadDir = path.join(roomDir, upload);
  checkDirectory(roomDir); checkDirectory(uploadDir);
  const file = path.join(uploadDir, name);
  checkPrivate(fs.lstatSync(file), false);
  return file;
}

function scopeHash(threadId, text) {
  // The heading only avoids disk lookups on ordinary messages. Matching the
  // entire original text and the selected thread is what identifies a record.
  if (typeof threadId !== 'string' || !UUID.test(threadId) || typeof text !== 'string' ||
      text.length > 65536 || !text.startsWith('# Files mentioned by the user:\n')) return null;
  return digest([threadId.toLowerCase(), text]);
}

// The Desktop read API doesn't return native file records for ordinary files.
// Keep only evidence minted from this host's own uploads at dispatch. Nothing
// in the conversation (including a path in a matching message) is used as a path.
export function createDesktopUploadHistory(runtimeDir) {
  if (!path.isAbsolute(runtimeDir) || path.basename(runtimeDir) !== '.coop') throw invalid();
  const records = path.join(runtimeDir, 'desktop-upload-history');
  const uploads = path.join(runtimeDir, 'guest-uploads');
  const cache = new Map();
  function cacheResult(key, files) {
    cache.delete(key); cache.set(key, { files, expires: files.length ? Infinity : Date.now() + 15000 });
    if (cache.size > 1024) cache.delete(cache.keys().next().value);
  }

  function read(key) {
    checkDirectory(runtimeDir); checkDirectory(records);
    const file = path.join(records, key), before = fs.lstatSync(file);
    checkPrivate(before, false);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd); checkPrivate(stat, false);
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw invalid();
      const bytes = Buffer.alloc(stat.size + 1);
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw invalid();
      const { hash, paths } = JSON.parse(bytes.subarray(0, stat.size).toString('utf8'));
      if (!Array.isArray(paths) || !paths.length || paths.length > MAX_ATTACHMENTS ||
          new Set(paths).size !== paths.length || hash !== digest([key, paths])) throw invalid();
      checkDirectory(uploads);
      return paths.map(relative => checkedUploadPath(uploads, relative));
    } finally { fs.closeSync(fd); }
  }

  return {
    remember(threadId, text, attachments) {
      const key = scopeHash(threadId, text);
      if (!key || !trustedAttachments(attachments) || !attachments.length || attachments.includes(undefined) ||
          new Set(attachments).size !== attachments.length) throw invalid();
      const prefix = attachmentInput('', attachments)[0].text;
      if (!text.startsWith(prefix) || text.length - prefix.length > 8000) throw invalid();
      checkDirectory(runtimeDir); checkDirectory(uploads);
      const paths = attachments.map(ref => {
        const relative = path.relative(uploads, ref.path).split(path.sep).join('/');
        if (checkedUploadPath(uploads, relative) !== ref.path) throw invalid();
        ref.verify();
        return relative;
      });
      try { fs.mkdirSync(records, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      checkDirectory(records);
      // Each submission owns an immutable key, so independent writers cannot
      // lose one another's records through a read-modify-write of one manifest.
      const destination = path.join(records, key), temporary = path.join(records, randomUUID());
      const existingRecord = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (existingRecord) {
        const existing = read(key);
        if (existing.some((file, i) => file !== attachments[i]?.path) || existing.length !== paths.length) throw invalid();
      } else {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
          try { fs.writeFileSync(fd, JSON.stringify({ hash: digest([key, paths]), paths })); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          fs.renameSync(temporary, destination);
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      cacheResult(key, attachments.map(ref => ref.path));
      if (!existingRecord) return () => {
        cacheResult(key, []);
        checkDirectory(runtimeDir); checkDirectory(records);
        fs.rmSync(destination, { force: true });
      };
    },
    filesFor(threadId, text) {
      const key = scopeHash(threadId, text);
      if (!key) return [];
      const cached = cache.get(key);
      let files = cached?.files;
      if (!cached || cached.expires <= Date.now()) {
        try { files = read(key); } catch { files = []; }
        cacheResult(key, files);
      }
      return files.map(file => ({ type: 'localFile', path: file }));
    },
  };
}
