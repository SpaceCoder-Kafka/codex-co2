import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { filePaths } from './thread-files.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 30 * 1024;
const SOURCE = Symbol('local image source');
const formats = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// Only structured user input grants attachment scope. Never scrape text,
// Markdown, tool output, file mentions or remote URLs for filesystem access.
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
    const entry = /^## ([^\n]+):(?:\n|[ \t]+)(\/[^\n]+)(?:\nImage attachment: true)?\n*$/.exec(block.replace(/\r\n/g, '\n'));
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
    mime = formats.get(path.extname(source.path).toLowerCase());
    // Do not follow a replaced leaf symlink or block on a FIFO/device. Bound
    // the actual read as well as stat so a growing file cannot exhaust memory.
    const file = await fs.open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error('Unavailable image');
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
