import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { privateIPv4, validLanHostname } from './lan-network.mjs';
import { MAX_FILE_BYTES } from './thread-files.mjs';
import { MAX_IMAGE_BYTES } from './thread-images.mjs';

export const importClaimPath = '/guest-import/claim';
export const importAssetPath = '/guest-import/asset';
export const importWindowChunks = 8;
export const importTicketPattern = /^[0-9a-f]{64}$/;
const maxSnapshotBytes = 64 * 1024;
const validId = value => typeof value === 'string' && importTicketPattern.test(value);

export function parseImportLink(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('无效的 Co² 导入链接');
  const link = new URL(raw);
  const origin = link.searchParams.get('origin'), ticket = link.searchParams.get('ticket');
  if (link.protocol !== 'codex-co2:' || link.host !== 'import' || link.username || link.password || link.pathname || link.hash
    || link.searchParams.size !== 2 || !origin || !importTicketPattern.test(ticket ?? '')) throw new Error('无效的 Co² 导入链接');
  const url = new URL(origin);
  const local = privateIPv4(url.hostname) || validLanHostname(url.hostname) || url.hostname === '127.0.0.1';
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && Number(url.port) >= 1024))) {
    throw new Error('导入链接需要 HTTPS 共享地址或明确的本地共享地址');
  }
  return { origin, ticket };
}

export function validateImportSnapshot(snapshot) {
  if (snapshot?.version !== 1 || typeof snapshot.title !== 'string' || typeof snapshot.truncated !== 'boolean'
    || !Array.isArray(snapshot.messages) || !snapshot.messages.length || Buffer.byteLength(JSON.stringify(snapshot)) > maxSnapshotBytes
    || snapshot.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim())) {
    throw new Error('没有可导入的对话文本，或共享快照格式不受支持');
  }
  return { version: 1, title: snapshot.title, truncated: snapshot.truncated,
    messages: snapshot.messages.map(({ role, text }) => ({ role, text })) };
}

export function importSnapshotFromGuestView(snapshot) {
  if (snapshot?.type !== 'snapshot' || !['idle', 'running'].includes(snapshot.status) || !Array.isArray(snapshot.items)) {
    throw new Error('共享会话未连接');
  }
  return validateImportSnapshot({ version: 1, title: snapshot.title, truncated: snapshot.historyTruncated === true,
    messages: snapshot.items.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.text === 'string' && m.text.trim())
      .map(({ role, text }) => ({ role, text })) });
}

function validatedAttachment(ref) {
  if (!validId(ref?.id) || !['file', 'image'].includes(ref.kind) || typeof ref.name !== 'string' || [...ref.name].length > 240) {
    throw new Error('共享附件格式不受支持');
  }
  const attachment = { id: ref.id, name: ref.name, kind: ref.kind };
  if (ref.index !== undefined || ref.syntax !== undefined) {
    if (!['image', 'link'].includes(ref.syntax) || !Number.isSafeInteger(ref.index) || ref.index < 0) throw new Error('无效的附件位置');
    Object.assign(attachment, { index: ref.index, syntax: ref.syntax });
  }
  if (ref.remoteUrl !== undefined) {
    const url = typeof ref.remoteUrl === 'string' && ref.remoteUrl.length <= 4096 && URL.canParse(ref.remoteUrl) && new URL(ref.remoteUrl);
    if (ref.kind !== 'image' || !url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的外链图片');
    attachment.remoteUrl = url.href;
  }
  if (ref.unavailable === true) attachment.unavailable = true;
  return attachment;
}

export function validateImportManifest(data) {
  if (data?.version !== 2 || typeof data.title !== 'string' || typeof data.truncated !== 'boolean' ||
    !Array.isArray(data.messages) || !data.messages.length || Buffer.byteLength(JSON.stringify(data)) > maxSnapshotBytes) {
    throw new Error('共享会话清单格式不受支持');
  }
  const messages = data.messages.map(message => {
    if (!['user', 'assistant'].includes(message?.role) || typeof message.text !== 'string' ||
      !Array.isArray(message.attachments) || message.attachments.length > 16 || (!message.text.trim() && !message.attachments.length)) {
      throw new Error('没有可导入的对话或附件');
    }
    return { role: message.role, text: message.text, attachments: message.attachments.map(validatedAttachment) };
  });
  return { version: 2, title: data.title, truncated: data.truncated, messages };
}

// The host already bound each opaque id to the selected thread. Preserve Markdown
// token positions only for structured references that appear in the guest view.
export function importManifestFromGuestView(snapshot) {
  if (snapshot?.type !== 'snapshot' || !['idle', 'running'].includes(snapshot.status) || !Array.isArray(snapshot.items)) {
    throw new Error('共享会话未连接');
  }
  const messages = [];
  const originals = Array.isArray(snapshot.capabilities) && snapshot.capabilities.includes('file-original');
  const activities = snapshot.capabilities?.includes('activity-details');
  const visibleItems = snapshot.items.filter(item => typeof item?.text === 'string' &&
    (['user', 'assistant'].includes(item.role) || (activities && item.role === 'activity')));
  for (const item of visibleItems.slice(-500)) {
    if (item.role === 'activity') continue;
    const attachments = [];
    const files = item.files ?? [];
    const images = item.images ?? [];
    const coveredImages = new Set(files.map(file => file.previewImageId).filter(validId));
    for (const ref of images) {
      if (originals && coveredImages.has(ref.id)) continue;
      const attachment = { id: ref.id, name: ref.name, kind: 'image' };
      if (ref.index !== undefined) Object.assign(attachment, { syntax: 'image', index: ref.index });
      if (ref.linkIndex !== undefined) Object.assign(attachment, { syntax: 'link', index: ref.linkIndex });
      if (ref.url !== undefined) attachment.remoteUrl = ref.url;
      attachments.push(attachment);
    }
    for (const ref of files) {
      if (!originals && ref.previewImageId && images.some(image => image.id === ref.previewImageId)) continue;
      if (ref.syntax && attachments.some(image => image.syntax === ref.syntax && image.index === ref.index)) continue;
      const attachment = { id: ref.id, name: ref.name, kind: 'file' };
      if (ref.syntax !== undefined) Object.assign(attachment, { syntax: ref.syntax, index: ref.index });
      else if (ref.previewImageId) {
        const preview = images.find(image => image.id === ref.previewImageId);
        if (preview?.index !== undefined) Object.assign(attachment, { syntax: 'image', index: preview.index });
      }
      if (!originals) attachment.unavailable = true;
      attachments.push(attachment);
    }
    if (item.text.trim() || attachments.length) messages.push({ role: item.role, text: item.text, attachments });
  }
  return validateImportManifest({ version: 2, title: snapshot.title, truncated: snapshot.historyTruncated === true || visibleItems.length > 500, messages });
}

function lookupLanName(hostname, options, callback) {
  dns.lookup(hostname, { family: 4, all: true }, (err, records) => {
    if (err) return callback(err);
    if (!records?.length || !records.every(r => privateIPv4(r.address))) return callback(new Error('共享名称未解析到内网地址'));
    if (options.all) callback(null, records);
    else callback(null, records[0].address, 4);
  });
}

// Both requests stay on the origin confirmed in the native dialog. Neither follows
// redirects nor sends browser credentials. Paths and headers come from this module.
async function importRequest(origin, endpoint, ticket, headers, timeout) {
  const url = new URL(endpoint, origin);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { Origin: origin, Authorization: 'Co2Import ' + ticket, 'Content-Length': '0', ...headers },
      ...(url.protocol === 'http:' && validLanHostname(url.hostname) ? { lookup: lookupLanName } : {}) }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function readBounded(response, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('导入内容过大');
    chunks.push(chunk);
  }
  if (!response.complete) throw new Error('导入传输中断');
  return Buffer.concat(chunks, bytes);
}

async function claimData(origin, ticket, headers) {
  const response = await importRequest(origin, importClaimPath, ticket, headers, 16000);
  try {
    if (response.statusCode !== 200) throw new Error('导入请求未能领取，请保持访客网页在线，再次点击「导入到我的 Codex」');
    if (!response.headers['content-type']?.startsWith('application/json')) throw new Error('共享站点返回的导入数据无效');
    return JSON.parse((await readBounded(response, maxSnapshotBytes)).toString('utf8'));
  } finally { response.destroy(); }
}

export async function claimImportSnapshot(raw) {
  const { origin, ticket } = parseImportLink(raw);
  return validateImportSnapshot(await claimData(origin, ticket, {}));
}

export async function claimReceiverImport(raw) {
  const { origin, ticket } = parseImportLink(raw);
  const data = await claimData(origin, ticket, { 'X-Co2-Import-Version': '2' });
  if (data?.version === 1) return { snapshot: validateImportSnapshot(data) };
  const snapshot = validateImportManifest(data);
  const files = new Map();
  for (const message of snapshot.messages) {
    for (const attachment of message.attachments) {
      if (!attachment.remoteUrl && !attachment.unavailable) files.set(attachment.id, attachment.kind);
    }
  }
  if (files.size && !validId(data.transferToken)) throw new Error('缺少附件领取凭据');
  async function fetchAsset(ref) {
    const kind = files.get(ref.id);
    if (!kind || kind !== ref.kind) throw new Error('附件未授权');
    const response = await importRequest(origin, importAssetPath, data.transferToken, { 'X-Co2-Asset': ref.id }, 120000);
    try {
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0] !== 'application/octet-stream') {
        throw new Error('无法取得附件原件');
      }
      return await readBounded(response, kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES);
    } finally { response.destroy(); }
  }
  return { snapshot, fetchAsset };
}
