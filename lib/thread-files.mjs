import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { protectedAttachmentPath } from './attachment-paths.mjs';

export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
const SOURCE = Symbol('structured file attachment');
const textExtensions = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml',
  '.html', '.htm', '.css', '.scss', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.dart', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.zsh', '.bash', '.sql', '.toml', '.ini', '.cfg', '.conf', '.diff', '.patch',
  '.ndjson', '.rst', '.tex', '.properties', '.vue', '.svelte', '.svg']);
const textNames = new Set(['dockerfile', 'makefile', 'readme', 'license']);
const kindOf = file => path.extname(file).toLowerCase() === '.mp4' ? 'video'
  : textExtensions.has(path.extname(file).toLowerCase()) || textNames.has(path.basename(file).toLowerCase()) ? 'text' : null;
const validPath = file => typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file) && !file.includes('\0');

// These parts are produced from native attachment records, never parsed from
// prompt text, mention paths, agent output or guest-supplied request fields.
export function fileInputParts(content) {
  return content.filter(p => p?.type === 'localFile' && validPath(p.path) && kindOf(p.path)).slice(0, 8)
    .map(p => ({ type: 'localFile', path: p.path }));
}

export function nativeFileParts(attachments) {
  if (!Array.isArray(attachments)) return [];
  return fileInputParts(attachments.filter(a => a && a.startLine == null && a.endLine == null)
    .map(a => ({ type: 'localFile', path: a.fsPath ?? a.path })));
}

export function fileRefs(itemId, content, key) {
  const seen = new Set();
  return fileInputParts(content).filter(p => !seen.has(p.path) && seen.add(p.path)).map(source => ({
    id: createHmac('sha256', key).update(JSON.stringify(['file', itemId, source.path])).digest('hex'),
    name: path.basename(source.path).slice(0, 240), kind: kindOf(source.path), [SOURCE]: source.path,
  }));
}
export const filePaths = item => (item.files ?? []).map(ref => ref[SOURCE]).filter(Boolean);

function decodeText(bytes) {
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  // Refuse binary disguised by a text extension, rather than displaying a
  // guessed encoding or executing HTML, Markdown, terminal escapes or scripts.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) throw new Error('Invalid text');
  const normalized = Buffer.from(text, 'utf8');
  if (normalized.length > MAX_TEXT_BYTES) throw new Error('Text exceeds preview limit');
  return normalized;
}

export async function readFilePreview(ref) {
  const source = ref?.[SOURCE], kind = source && kindOf(source);
  if (!kind || protectedAttachmentPath(path.resolve(source))) throw new Error('Unavailable file');
  const resolved = await fs.realpath(source);
  if (protectedAttachmentPath(resolved)) throw new Error('Unavailable file');
  const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await file.stat(), current = await fs.stat(resolved);
    const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_TEXT_BYTES;
    if (!stat.isFile() || stat.size > limit || (kind === 'video' && stat.size < 16)
      || stat.dev !== current.dev || stat.ino !== current.ino || await fs.realpath(source) !== resolved) throw new Error('Unavailable file');
    const buffer = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) throw new Error('File changed');
    bytes = buffer.subarray(0, size);
  } finally { await file.close(); }
  if (kind === 'text') return { bytes: decodeText(bytes), mime: 'text/plain; charset=utf-8' };
  // ISO base media container with an MP4 brand. Codec compatibility is checked
  // by the browser; do not transcode or invoke an execution backend.
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > bytes.length || size > 4096 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4');
  const brands = [bytes.toString('ascii', 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(bytes.toString('ascii', i, i + 4));
  if (!brands.some(b => ['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(b))) throw new Error('Invalid MP4');
  return { bytes, mime: 'video/mp4' };
}
