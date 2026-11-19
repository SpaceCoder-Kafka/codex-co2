import { createHash } from 'node:crypto';
import { validLanHostname } from './lan-network.mjs';

// This function is served as a separate script on the address-specific host.
// The fragment stays in the browser throughout the reachability check.
async function openLanEntry() {
  const { canonicalOrigin, probeId } = document.body.dataset;
  const status = document.getElementById('entry-status');
  const invitation = new URLSearchParams(location.hash.slice(1));
  const room = invitation.get('room'), invite = invitation.get('invite');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(room || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(invite || '')) {
    status.textContent = '请打开分享者发来的完整邀请链接。';
    return;
  }
  const fragment = new URLSearchParams({ room, invite });
  const scope = invitation.get('scope');
  if (/^[A-Za-z0-9_-]{1,128}$/.test(scope || '')) fragment.set('scope', scope);
  const started = Date.now();
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const options = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal };
      const response = await fetch(canonicalOrigin + '/lan-entry-check', { ...options, mode: 'cors' });
      const marker = response.status === 204 && response.headers.get('X-Co2-Lan-Entry');
      let currentMarker = probeId;
      if (marker && marker !== probeId) {
        // The host can restart during the wait. Recheck this landing address
        // independently before accepting any marker from the canonical name.
        const entry = await fetch('/', { ...options, method: 'HEAD', mode: 'same-origin' });
        currentMarker = entry.status === 200 && entry.headers.get('X-Co2-Lan-Entry');
      }
      if (marker && marker === currentMarker) {
        location.replace(canonicalOrigin + '/#' + fragment);
        return;
      }
    } catch { /* A previously visited hostname can still resolve to the old IP. */ }
    finally { clearTimeout(timeout); }
    const message = Date.now() - started < 60000
      ? '已连接到分享者的新地址。正在等待浏览器连接原访客页面，连接后会自动继续。'
      : '仍在重试。请确认你和分享者使用可互访的局域网，并请分享者检查共享是否在线。';
    if (status.textContent !== message) status.textContent = message;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

const script = '(' + openLanEntry.toString() + ')();';
const style = `html{color-scheme:light dark}body{font-family:system-ui,sans-serif;margin:0;padding:0 1.5rem}
main{max-width:34rem;margin:clamp(3rem,18vh,10rem) auto}h1{font-size:1.6rem}p{line-height:1.65}`;
const styleHash = createHash('sha256').update(style).digest('base64');
const validProbeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(id);

function commonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Direct socket, port and exact Host have already been checked by the relay.
export function serveLanEntry(req, res, { canonicalOrigin, probeId }) {
  commonHeaders(res);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
  if (req.url !== '/' && req.url !== '/entry.js') return res.writeHead(404).end();
  const canonical = URL.canParse(canonicalOrigin) && new URL(canonicalOrigin);
  if (!canonical || canonical.protocol !== 'http:' || !canonical.port || canonical.origin !== canonicalOrigin
    || !validLanHostname(canonical.hostname) || !validProbeId(probeId)) return res.writeHead(503).end();
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'sha256-${styleHash}'; connect-src 'self' ${canonicalOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  if (req.url === '/entry.js') {
    return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : script);
  }
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Co² · 打开共享会话</title><style>${style}</style><script src="/entry.js" defer></script></head>
<body data-canonical-origin="${canonicalOrigin}" data-probe-id="${probeId}"><main>
<h1>正在打开共享会话</h1><p role="status" id="entry-status">已连接到共享入口，正在打开访客页面。</p>
<noscript>请启用 JavaScript 以打开共享会话。</noscript></main></body></html>`;
  return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Co2-Lan-Entry': probeId }).end(req.method === 'HEAD' ? undefined : html);
}

export function serveLanEntryProbe(req, res, { entryOrigin, probeId }) {
  commonHeaders(res);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (req.url !== '/lan-entry-check') return res.writeHead(404).end();
  if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
  if (!entryOrigin || req.headers.origin !== entryOrigin || !validProbeId(probeId)) return res.writeHead(403).end();
  return res.writeHead(204, {
    'Access-Control-Allow-Origin': entryOrigin,
    'Access-Control-Expose-Headers': 'X-Co2-Lan-Entry',
    'X-Co2-Lan-Entry': probeId,
  }).end();
}
