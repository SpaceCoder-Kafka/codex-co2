import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { privateIPv4, validLanHostname } from './lan-network.mjs';

export const importClaimPath = '/guest-import/claim';
export const importTicketPattern = /^[0-9a-f]{64}$/;
const maxSnapshotBytes = 64 * 1024;

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

function lookupLanName(hostname, options, callback) {
  dns.lookup(hostname, { family: 4, all: true }, (err, records) => {
    if (err) return callback(err);
    if (!records?.length || !records.every(r => privateIPv4(r.address))) return callback(new Error('共享名称未解析到内网地址'));
    if (options.all) callback(null, records);
    else callback(null, records[0].address, 4);
  });
}

// The ticket authorizes only this text snapshot. Never send browser cookies or
// follow redirects from the origin presented in the native confirmation dialog.
export async function claimImportSnapshot(raw) {
  const { origin, ticket } = parseImportLink(raw);
  const url = new URL(importClaimPath, origin);
  const transport = url.protocol === 'https:' ? https : http;
  const response = await new Promise((resolve, reject) => {
    const req = transport.request(url, { method: 'POST', signal: AbortSignal.timeout(16000),
      headers: { Origin: origin, Authorization: 'Co2Import ' + ticket, 'Content-Length': '0' },
      ...(url.protocol === 'http:' && validLanHostname(url.hostname) ? { lookup: lookupLanName } : {}) }, resolve);
    req.on('error', reject);
    req.end();
  });
  try {
    if (response.statusCode !== 200) throw new Error('导入请求未能领取，请保持访客网页在线，再次点击「导入到我的 Codex」');
    if (!response.headers['content-type']?.startsWith('application/json')) throw new Error('共享站点返回的导入数据无效');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxSnapshotBytes) throw new Error('共享快照过大');
      chunks.push(chunk);
    }
    return validateImportSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { response.destroy(); }
}
