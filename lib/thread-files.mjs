import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createContentMarkdown } from './markdown-parser.mjs';
import { protectedAttachmentPath } from './attachment-paths.mjs';
import { storedGuestUploadPath } from './guest-uploads.mjs';

export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = MAX_VIDEO_BYTES;
export const MAX_TEXT_BYTES = 1024 * 1024;
const SOURCE = Symbol('structured file attachment');
const ASSISTANT = Symbol('assistant output attachment');
const markdown = createContentMarkdown();
const textExtensions = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml',
  '.html', '.htm', '.css', '.scss', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.dart', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.zsh', '.bash', '.sql', '.toml', '.ini', '.cfg', '.conf', '.diff', '.patch',
  '.ndjson', '.rst', '.tex', '.properties', '.vue', '.svelte', '.svg']);
const textNames = new Set(['dockerfile', 'makefile', 'readme', 'license']);
const kinds = new Map([
  ['.mp4', 'video'], ['.mp3', 'audio'], ['.wav', 'audio'], ['.m4a', 'audio'], ['.ogg', 'audio'], ['.flac', 'audio'],
  ['.pdf', 'pdf'], ['.csv', 'table'], ['.tsv', 'table'], ['.md', 'markdown'], ['.markdown', 'markdown'],
  ['.xlsx', 'xlsx'], ['.docx', 'docx'], ['.pptx', 'pptx'],
  // Legacy Office containers have no safe browser renderer. Keep their exact
  // originals available through the same scoped download transport instead.
  ['.doc', 'download'], ['.xls', 'download'], ['.ppt', 'download'],
]);
export const fileKind = file => kinds.get(path.extname(file).toLowerCase())
  ?? (textExtensions.has(path.extname(file).toLowerCase()) || textNames.has(path.basename(file).toLowerCase()) ? 'text' : storedGuestUploadPath(file) ? 'download' : null);
const kindOf = fileKind;
const textKinds = new Set(['text', 'table', 'markdown']);
const validPath = file => typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file) && !file.includes('\0');

// The display label is inert text. It never supplies a source path or grants
// read scope; callers still bind the real parsed token and its position.
export function markdownLinkLabel(tokens, start) {
  let depth = 1, label = '';
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'link_open') depth++;
    if (token.type === 'link_close' && --depth === 0) break;
    if (['text', 'code_inline', 'image', 'co2_math'].includes(token.type)) label += token.content || '';
    else if (['softbreak', 'hardbreak'].includes(token.type)) label += ' ';
  }
  return [...label.replace(/\s+/g, ' ').trim()].slice(0, 240).join('');
}

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

// Assistant output grants file scope only at real Markdown link/media tokens.
// Count every token (including unsupported ones) to keep positions identical to
// the browser parser. Neither examples nor a plain path are read capabilities.
export function assistantFileRefs(itemId, text, key) {
  const refs = [], positions = { link: 0, image: 0 };
  function visit(tokens) {
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];
      const syntax = token.type === 'link_open' ? 'link' : token.type === 'image' ? 'image' : null;
      if (syntax) {
        const index = positions[syntax]++, url = token.attrGet(syntax === 'link' ? 'href' : 'src') || '';
        if (refs.length >= 8) continue;
        let source;
        try {
          if (!(url.startsWith('/') && !url.startsWith('//') || /^[A-Za-z]:[\\/]/.test(url))) continue;
          source = decodeURIComponent(url);
          if (source.startsWith('//') || !validPath(source) || !kindOf(source)) continue;
        } catch { continue; }
        refs.push({ id: createHmac('sha256', key).update(JSON.stringify(['assistant-file', itemId, syntax, index, source])).digest('hex'),
          name: path.basename(source).slice(0, 240),
          label: syntax === 'link' ? markdownLinkLabel(tokens, tokenIndex) : (token.content || '').slice(0, 240),
          kind: kindOf(source), index, syntax, [SOURCE]: source, [ASSISTANT]: true });
      } else if (token.children) visit(token.children);
    }
  }
  if (typeof text === 'string') visit(markdown.parse(text, {}));
  return refs;
}

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

export async function readFilePreview(ref, { representation = 'preview' } = {}) {
  if (!['preview', 'original'].includes(representation)) throw new Error('Unsupported file representation');
  const source = ref?.[SOURCE], kind = source && kindOf(source);
  const options = { allowVisualizations: ref?.[ASSISTANT] === true };
  if (!kind || protectedAttachmentPath(path.resolve(source), options)) throw new Error('Unavailable file');
  if (kind === 'download' && representation !== 'original') throw new Error('Preview unavailable; download the original file');
  const resolved = await fs.realpath(source);
  if (protectedAttachmentPath(resolved, options)) throw new Error('Unavailable file');
  const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await file.stat(), current = await fs.stat(resolved);
    const limit = representation === 'original' || !textKinds.has(kind) ? MAX_FILE_BYTES : MAX_TEXT_BYTES;
    if (!stat.isFile() || stat.size > limit
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
  // Download never decodes, rebuilds or rewrites the source file. An authorized
  // original remains downloadable even if its contents cannot be previewed.
  if (representation === 'original') return { bytes, mime: 'application/octet-stream' };
  if (textKinds.has(kind)) return { bytes: decodeText(bytes), mime: 'text/plain; charset=utf-8' };
  if (kind === 'pdf') {
    if (!/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) throw new Error('Invalid PDF');
    return { bytes, mime: 'application/pdf' };
  }
  if (['docx', 'xlsx', 'pptx'].includes(kind)) {
    // Full bounded ZIP/XML inspection belongs to the isolated preview parser;
    // the host never extracts files or invokes an Office execution backend.
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid Office container');
    const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[kind];
    return { bytes, mime };
  }
  const extension = path.extname(source).toLowerCase();
  if (kind === 'audio' && extension !== '.m4a') {
    const signature = bytes.subarray(0, 12).toString('ascii');
    const valid = extension === '.mp3' ? bytes.length >= 3 && (signature.startsWith('ID3')
      || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0)
      : extension === '.wav' ? bytes.length >= 12 && signature.startsWith('RIFF') && signature.slice(8, 12) === 'WAVE'
      : extension === '.ogg' ? signature.startsWith('OggS') && bytes.length >= 27 && bytes[4] === 0
      : extension === '.flac' ? signature.startsWith('fLaC') && bytes.length >= 8 : false;
    if (!valid) throw new Error('Invalid audio');
    return { bytes, mime: { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[extension] };
  }
  // ISO base media container with an MP4 brand. Codec compatibility is checked
  // by the browser; do not transcode or invoke an execution backend.
  if (bytes.length < 16) throw new Error('Invalid media container');
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > bytes.length || size > 4096 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4');
  const brands = [bytes.toString('ascii', 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(bytes.toString('ascii', i, i + 4));
  const allowed = kind === 'audio' ? ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42']
    : ['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'];
  if (!brands.some(b => allowed.includes(b))) throw new Error('Invalid media container');
  return { bytes, mime: kind === 'audio' ? 'audio/mp4' : 'video/mp4' };
}
