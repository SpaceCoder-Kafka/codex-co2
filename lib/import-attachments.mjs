import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createContentMarkdown } from './markdown-parser.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './platform.mjs';
import { MAX_FILE_BYTES } from './thread-files.mjs';
import { MAX_IMAGE_BYTES, imageMimeType } from './thread-images.mjs';

const maxFiles = 128, maxTotalBytes = 256 * 1024 * 1024;
const markdown = createContentMarkdown();

// Keep the exact source consumed by the pinned parser, including reference-style
// links. A token's ordinal is meaningful only in the same grammar as the guest.
for (const [ruleName, tokenType] of [['link', 'link_open'], ['image', 'image']]) {
  const ruler = markdown.inline.ruler;
  const original = ruler.__rules__.find(rule => rule.name === ruleName).fn;
  ruler.at(ruleName, (state, silent) => {
    if (silent) return original(state, silent);
    const start = state.pos, count = state.tokens.length;
    if (!original(state, false)) return false;
    const token = state.tokens.slice(count).find(t => t.type === tokenType);
    const labelEnd = state.md.helpers.parseLinkLabel(state, start + (ruleName === 'image' ? 1 : 0), ruleName === 'link');
    if (token && labelEnd >= 0) {
      token.meta ??= {};
      token.meta.importLabel = state.src.slice(start, labelEnd + 1);
      token.meta.importTail = state.src.slice(labelEnd + 1, state.pos);
    }
    return true;
  });
}

function markdownRefs(text) {
  const refs = { image: [], link: [] };
  function visit(tokens) {
    for (const token of tokens) {
      if (token.type === 'link_open') refs.link.push(token);
      else if (token.type === 'image') refs.image.push(token);
      else if (token.children) visit(token.children);
    }
  }
  visit(markdown.parse(text, {}));
  return refs;
}

// Identical Markdown can occur in code, math, or another live link. Tag the
// candidate destinations in memory and let the parser identify the exact use.
// Reference definitions and every unbound use of them stay as originally typed.
function rebind(text, ref, target) {
  const before = markdownRefs(text);
  const token = before[ref.syntax][ref.index];
  if (!token?.meta?.importLabel) return null;
  const { importLabel, importTail } = token.meta;
  const prefix = importTail ? ']' : importLabel;
  const needle = prefix + importTail;
  const nonce = '/co2-position-' + randomUUID() + '/';
  const offsets = [];
  const probe = text.replaceAll(needle, (_, offset) => {
    offsets.push(offset);
    return prefix + '(' + nonce + offset + ')';
  });
  if (!offsets.length) return null;
  const located = markdownRefs(probe)[ref.syntax][ref.index];
  const address = located?.attrGet(ref.syntax === 'link' ? 'href' : 'src') ?? '';
  const offset = Number(address.slice(nonce.length));
  if (!address.startsWith(nonce) || !offsets.includes(offset)) return null;
  const title = token.attrGet('title');
  const suffix = title ? ' "' + title.replace(/[\\"]/g, '\\$&') + '"' : '';
  const changed = text.slice(0, offset) + prefix + '(' + target + suffix + ')' + text.slice(offset + needle.length);
  // A shortcut such as [report] can also occur in a reference definition.
  // Accept the edit only when precisely the selected destination changed.
  const after = markdownRefs(changed);
  for (const syntax of ['image', 'link']) {
    const attr = syntax === 'link' ? 'href' : 'src';
    if (after[syntax].length !== before[syntax].length || before[syntax].some((t, i) =>
      after[syntax][i].attrGet(attr) !== (t === token ? markdown.normalizeLink(target) : t.attrGet(attr)))) return null;
  }
  return changed;
}

function shortUtf8(text, limit) {
  let result = '', size = 0;
  for (const c of text) {
    size += Buffer.byteLength(c);
    if (size > limit) break;
    result += c;
  }
  return result;
}

function storageName(ref, number, bytes) {
  const label = ref.name.replace(/[^\p{L}\p{M}\p{N} ._()-]/gu, '_').trim().replace(/^\.+|[. ]+$/g, '') || '附件';
  const extension = path.extname(label);
  let ext = shortUtf8(extension, 24);
  if (ref.kind === 'image') {
    const mime = imageMimeType(bytes);
    if (!mime) throw new Error('Invalid image');
    const formats = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] };
    if (!formats[mime].includes(ext.toLowerCase())) ext = formats[mime][0];
  }
  // A local prefix prevents filename collisions, Windows device names, hidden
  // configuration and special discovery names such as AGENTS.md or Makefile.
  return String(number).padStart(3, '0') + '-' + shortUtf8(label.slice(0, label.length - extension.length), 160) + ext;
}

function markdownPath(file) {
  return file.split(path.sep).map(encodeURIComponent).join('/').replace(/^([A-Z])%3A\//i, '$1:/')
    .replaceAll('(', '%28').replaceAll(')', '%29');
}

export async function materializeImportAttachments(manifest, workspace, fetchAsset) {
  const directory = path.join(workspace, 'attachments');
  const summary = { saved: 0, missing: 0, remote: 0, missingFiles: [] };
  const seen = new Map(), messages = [];
  let attempted = 0, transferred = 0;
  async function materialize(ref) {
    if (ref.remoteUrl) { summary.remote++; return { remote: ref.remoteUrl }; }
    if (ref.unavailable) return { reason: '分享端未提供原件' };
    const number = ++attempted;
    if (number > maxFiles || transferred >= maxTotalBytes) return { reason: '超过本次导入配额' };
    let file;
    try {
      const bytes = await fetchAsset(ref);
      if (!Buffer.isBuffer(bytes)) return { reason: '原件不可用' };
      transferred += bytes.length;
      if (bytes.length > (ref.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES) || transferred > maxTotalBytes) {
        return { reason: '超过本次导入配额' };
      }
      const name = storageName(ref, number, bytes);
      await ensurePrivateDirectory(directory);
      file = path.join(directory, name);
      await writePrivateFile(file, bytes);
      summary.saved++;
      return { target: markdownPath(file) };
    } catch (error) {
      if (file && error.code !== 'EEXIST') await fs.rm(file, { force: true }).catch(() => {});
      return { reason: '未能取得或保存原件' };
    }
  }
  for (const message of manifest.messages) {
    let text = message.text;
    const additions = [];
    for (const ref of message.attachments) {
      const key = ref.kind + ':' + ref.id;
      if (!seen.has(key)) {
        const result = await materialize(ref);
        seen.set(key, result);
        if (result.reason) summary.missing++;
      }
      const result = seen.get(key);
      const name = ref.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() || '附件';
      const label = name.replace(/[\\\x60*_\[\]<>$~|]/g, '\\$&');
      if (result.reason) {
        summary.missingFiles.push({ message: messages.length + 1, name, reason: result.reason });
        additions.push('附件「' + label + '」未保存（' + result.reason + '）。');
      }
      if (ref.syntax && Number.isInteger(ref.index)) {
        if (result.remote) {
          const token = markdownRefs(text)[ref.syntax][ref.index];
          if (token?.attrGet(ref.syntax === 'image' ? 'src' : 'href') === markdown.normalizeLink(result.remote)) continue;
        } else {
          const changed = rebind(text, ref, result.target ?? '#co2-attachment-unavailable');
          if (changed !== null) { text = changed; continue; }
        }
      }
      if (result.remote) {
        additions.push('外链图片 [' + label + '](<' + result.remote.replaceAll('>', '%3E').replaceAll('<', '%3C') + '>)');
      } else if (result.target) {
        additions.push((ref.kind === 'image' ? '!' : '') + '[' + label + '](' + result.target + ')');
      }
    }
    messages.push({ role: message.role, text: [text, ...additions].filter(Boolean).join('\n\n') });
  }
  return { messages, summary };
}
