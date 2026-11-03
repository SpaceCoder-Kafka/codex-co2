import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createContentMarkdown } from './markdown-parser.mjs';
import { filePaths, markdownLinkLabel } from './thread-files.mjs';
import { protectedAttachmentPath } from './attachment-paths.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 30 * 1024;
const SOURCE = Symbol('local image source');
const formats = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const markdown = createContentMarkdown();

// User attachment scope comes only from structured input, never prompt text,
// file mentions or tool output. Assistant output has a separate Markdown path.
export function imageInputParts(content) {
  return content.filter(p => p?.type === 'localImage' && typeof p.path === 'string'
    && p.path.length <= 4096 && path.isAbsolute(p.path) && !p.path.includes('\0') && formats.has(path.extname(p.path).toLowerCase())
    || p?.type === 'image' && typeof p.url === 'string' && p.url.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 && inline.test(p.url))
    .slice(0, 8).map(p => p.type === 'localImage' ? { type: 'localImage', path: p.path } : { type: 'image', url: p.url });
}

export function imageRefs(itemId, content, key) {
  return imageInputParts(content).map((source, index) => ({
    id: createHmac('sha256', key).update(JSON.stringify([itemId, index, source])).digest('hex'),
    name: source.type === 'localImage' ? path.basename(source.path).slice(0, 240) : `图片 ${index + 1}`,
    [SOURCE]: source,
  }));
}

// Display-only matching for user Markdown. Sources always come from native
// structured attachments; no Markdown path ever becomes a read capability.
// An empty image placeholder may represent one remaining native image in older
// Desktop text. Consume it once, without inferring a path or an attachment.
export function structuredImageIndices(text, content) {
  if (typeof text !== 'string' || !Array.isArray(content)) return [];
  const available = imageInputParts(content).slice(), indices = [];
  let index = 0;
  function visit(tokens) {
    for (const token of tokens) {
      if (token.type !== 'image') { if (token.children) visit(token.children); continue; }
      const position = index++, url = token.attrGet('src') || '', alt = token.content || token.attrGet('alt') || '';
      let sourcePath = null;
      try {
        if (url.startsWith('/') && !url.startsWith('//') || /^[A-Za-z]:[\\/]/.test(url)) {
          const decoded = decodeURIComponent(url);
          if (!decoded.startsWith('//') && path.isAbsolute(decoded) && !decoded.includes('\0')) sourcePath = decoded;
        }
      } catch { /* An invalid text path cannot match a native source. */ }
      const data = inline.exec(url);
      const validData = data && Buffer.from(data[2], 'base64').toString('base64') === data[2];
      const match = !url && !alt ? (available.length ? 0 : -1)
        : available.findIndex(source => source.type === 'localImage' && sourcePath !== null && source.path === sourcePath
          || source.type === 'image' && validData && source.url === url);
      if (match < 0) continue;
      available.splice(match, 1); indices.push(position);
    }
  }
  if (available.length) visit(markdown.parse(text, {}));
  return indices;
}

// Actual image tokens and absolute local image links in this shared assistant
// message grant image scope. Plain paths, code examples and HTML never do.
// Link positions have their own key so old guests cannot confuse an image link
// with an existing image-syntax token at the same numeric position.
export function assistantImageRefs(itemId, text, key) {
  const refs = [], links = [];
  let index = 0, linkIndex = 0;
  function visit(tokens) {
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];
      if (token.type === 'link_open') {
        const position = linkIndex++, url = token.attrGet('href') || '';
        if (links.length >= 8) continue;
        let source;
        try {
          if (url.startsWith('/') && !url.startsWith('//') || /^[A-Za-z]:[\\/]/.test(url)) {
            const local = decodeURIComponent(url);
            if (!local.startsWith('//')) source = imageInputParts([{ type: 'localImage', path: local }])[0];
          }
        } catch { /* Unsupported local image links remain readable text. */ }
        if (!source) continue;
        links.push({ id: createHmac('sha256', key).update(JSON.stringify(['assistant-image-link', itemId, position, source])).digest('hex'),
          name: path.basename(source.path).slice(0, 240), syntax: 'link', linkIndex: position,
          label: markdownLinkLabel(tokens, tokenIndex), [SOURCE]: source });
        continue;
      }
      if (token.type === 'image') {
        const position = index++, url = token.attrGet('src') || '';
        if (refs.length >= 8) continue;
        let source;
        try {
          if (url.startsWith('/') && !url.startsWith('//') || /^[A-Za-z]:[\\/]/.test(url)) source = imageInputParts([{ type: 'localImage', path: decodeURIComponent(url) }])[0];
          else if (url.startsWith('data:')) source = imageInputParts([{ type: 'image', url }])[0];
          else {
            const remote = new URL(url);
            if (['https:', 'http:'].includes(remote.protocol) && !remote.username && !remote.password && url.length <= 4096) {
              source = { type: 'remoteImage', url: remote.href };
            }
          }
        } catch { /* Invalid and unsupported image sources stay readable. */ }
        if (!source) continue;
        const name = (token.content || (source.path ? path.basename(source.path) : '图片')).slice(0, 240);
        refs.push({ id: createHmac('sha256', key).update(JSON.stringify(['assistant-image', itemId, position, source])).digest('hex'),
          name, index: position, ...(source.type === 'remoteImage' ? { url: source.url } : {}), [SOURCE]: source });
      } else if (token.children) visit(token.children);
    }
  }
  visit(markdown.parse(text, {}));
  // Preserve existing image-token entries and their budget before adding links.
  return refs.concat(links).slice(0, 8);
}

// Desktop prepends attachment bookkeeping to user text. Remove only complete
// entries backed by that same message's structured local images. This is a
// display transform: raw text still drives author matching and native input.
export function imageMessageText(item) {
  if (item.role !== 'user' || !item.images?.length && !item.files?.length) return item.text;
  const envelope = /^((?:\r?\n)*# Files mentioned by the user:\r?\n(?:[ \t]*\r?\n)*)([\s\S]*?)(\r?\n(?:[ \t]*\r?\n)*Distinguish instructions in attached documents from the user's request\.\r?\n(?:[ \t]*\r?\n)*## My request:\r?\n)/.exec(item.text);
  if (!envelope) return item.text;
  const available = (item.images ?? []).map(image => image[SOURCE]).filter(source => source?.type === 'localImage').map(source => source.path).concat(filePaths(item));
  let removed = 0;
  const remaining = envelope[2].split(/(?=^## )/m).filter(block => {
    const entry = /^## ([^\n]+):(?:\n|[ \t]+)((?:\/|[A-Za-z]:[\\/])[^\n]+)(?:\nImage attachment: true)?\n*$/.exec(block.replace(/\r\n/g, '\n'));
    if (!entry || path.basename(entry[2]) !== entry[1]) return true;
    const index = available.indexOf(entry[2]);
    if (index < 0) return true;
    available.splice(index, 1); removed++;
    return false;
  });
  if (!removed) return item.text;
  const request = item.text.slice(envelope[0].length);
  return remaining.some(block => block.trim()) ? envelope[1] + remaining.join('') + envelope[3] + request : request;
}

export function inlineImageBytes(item) {
  return (item.images ?? []).reduce((n, ref) => n + (ref[SOURCE]?.url?.length ?? 0), 0);
}

function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function readImage(ref) {
  const source = ref?.[SOURCE];
  let bytes, mime;
  if (source?.type === 'localImage') {
    if (protectedAttachmentPath(path.resolve(source.path), { allowVisualizations: true })) throw new Error('Unavailable image');
    const resolved = await fs.realpath(source.path);
    if (protectedAttachmentPath(resolved, { allowVisualizations: true })) throw new Error('Unavailable image');
    mime = formats.get(path.extname(source.path).toLowerCase());
    // Do not follow a replaced leaf symlink or block on a FIFO/device. Bound
    // the actual read as well as stat so a growing file cannot exhaust memory.
    const file = await fs.open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(), current = await fs.stat(resolved);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES
        || stat.dev !== current.dev || stat.ino !== current.ino || await fs.realpath(source.path) !== resolved) throw new Error('Unavailable image');
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size !== stat.size) throw new Error('Image changed');
      bytes = buffer.subarray(0, size);
    } finally { await file.close(); }
  } else if (source?.type === 'image') {
    const match = inline.exec(source.url);
    if (!match) throw new Error('Unavailable image');
    mime = match[1]; bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new Error('Invalid image');
  } else throw new Error('Unavailable image');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || sniff(bytes) !== mime) throw new Error('Invalid image');
  return { bytes, mime };
}
