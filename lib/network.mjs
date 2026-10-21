import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

// Newly issued tunnel names can remain NXDOMAIN in the OS negative cache.
// Retry through Node's resolver using the SAME configured DNS servers. TLS still
// verifies the original hostname; no global DNS or certificate settings change.
export function lookupFresh(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (!error || !['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return callback(error, address, family);
    const wanted = typeof options === 'number' ? options : options?.family;
    const method = wanted === 6 ? 'resolve6' : 'resolve4';
    const resolver = new dns.Resolver();
    resolver[method](hostname, (freshError, addresses) => {
      if (freshError || !addresses.length) return callback(error);
      const resultFamily = wanted === 6 ? 6 : 4;
      if (options?.all) callback(null, addresses.map(address => ({ address, family: resultFamily })));
      else callback(null, addresses[0], resultFamily);
    });
  });
}

export function checkHealth(origin, { signal } = {}) {
  return new Promise(resolve => {
    const url = new URL('/health', origin);
    const transport = url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    const request = transport.get(url, { lookup: lookupFresh, maxHeaderSize: 65536, signal }, response => {
      let body = '';
      response.on('data', data => { body += data; if (body.length > 4096) request.destroy(new Error('Health response too large')); });
      response.on('end', () => finish({ ok: response.statusCode === 200 && body.trim() === '{"ok":true}', reason: `HTTP ${response.statusCode}` }));
      response.on('error', error => finish({ ok: false, reason: error.code ?? 'response-error' }));
    });
    const timer = setTimeout(() => request.destroy(new Error('Health timeout')), 5000);
    request.on('error', error => finish({ ok: false, reason: error.code ?? error.message }));
  });
}
