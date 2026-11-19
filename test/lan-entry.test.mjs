import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serveLanEntry, serveLanEntryProbe } from '../lib/lan-entry.mjs';

const canonicalOrigin = 'http://desk-co2-35001.local:35001';
const entryOrigin = 'http://v4-c0a82802.desk-co2-35001.local:35001';
const probeId = '946e5c6a-2a01-404e-b8d5-d82f704c28a9';
const options = { entryOrigin, canonicalOrigin, probeId };
const fragment = '#room=synthetic-room&invite=' + 'a'.repeat(43) + '&scope=synthetic-scope';

function request(handler, url, { method = 'GET', headers = {}, ...config } = {}) {
  const res = {
    headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, fields = {}) {
      this.status = status;
      for (const [key, value] of Object.entries(fields)) this.setHeader(key, value);
      return this;
    },
    end(body = '') { this.body = body; },
  };
  handler({ url, method, headers }, res, { ...options, ...config });
  return res;
}

test('address-specific entry serves a non-cacheable landing page and its script only', () => {
  const page = request(serveLanEntry, '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.ok(page.headers['content-security-policy'].includes("connect-src 'self' " + canonicalOrigin + ";"));
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(page.body.includes('data-canonical-origin="' + canonicalOrigin + '"'));
  assert.match(page.body, /正在打开共享会话/);
  assert.equal(request(serveLanEntry, '/', { method: 'HEAD' }).body, '');
  for (const resource of ['/?invite=synthetic', '/guest', '/guest.js', '/owner', '/lan-entry-check', '/recovery']) {
    assert.equal(request(serveLanEntry, resource).status, 404);
  }
  assert.equal(request(serveLanEntry, '/', { method: 'POST' }).status, 405);
  for (const target of ['https://remote.example', 'http://malicious@desk.local:1111', canonicalOrigin + '/evil']) {
    assert.equal(request(serveLanEntry, '/', { canonicalOrigin: target }).status, 503);
  }
  assert.equal(request(serveLanEntry, '/', { probeId: 'bad"marker' }).status, 503);
});

test('only the exact published landing origin can read the canonical listener marker', () => {
  const headers = { origin: entryOrigin };
  const allowed = request(serveLanEntryProbe, '/lan-entry-check', { headers });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.body, '');
  assert.equal(allowed.headers['access-control-allow-origin'], entryOrigin);
  assert.equal(allowed.headers['x-co2-lan-entry'], probeId);
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  for (const origin of [undefined, 'null', canonicalOrigin, 'http://another.local:35001']) {
    const denied = request(serveLanEntryProbe, '/lan-entry-check', { headers: { origin } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['x-co2-lan-entry'], undefined);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(request(serveLanEntryProbe, '/lan-entry-check?room=synthetic', { headers }).status, 404);
  assert.equal(request(serveLanEntryProbe, '/lan-entry-check', { method: 'POST', headers }).status, 405);
});

async function openInBrowser(hash, replies) {
  const status = { textContent: '' }, navigations = [], probes = [];
  const script = request(serveLanEntry, '/entry.js').body;
  let attempts = 0;
  await vm.runInNewContext(script, {
    URLSearchParams, AbortController, document: {
      body: { dataset: { canonicalOrigin, probeId } },
      getElementById: id => { assert.equal(id, 'entry-status'); return status; },
    },
    location: { hash, replace: url => navigations.push(url) },
    setTimeout(callback, ms) {
      if (ms === 4000) return 0;
      assert.ok(attempts < replies.length, 'unexpected extra attempt');
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    fetch: async (url, settings) => {
      probes.push({ url, settings, navigationsBeforeRequest: navigations.length });
      const next = replies[attempts++];
      if (next instanceof Error) throw next;
      return { status: next.status, headers: new Headers({ 'X-Co2-Lan-Entry': next.marker }) };
    },
  });
  return { probes, navigations, status: status.textContent };
}

test('a warm browser automatically retries stale DNS and a mismatching listener before carrying its fragment', async () => {
  const result = await openInBrowser(fragment, [
    Error('ERR_CONNECTION_REFUSED'), { status: 403, marker: probeId }, { status: 204, marker: 'previous-listener' },
    { status: 200, marker: probeId }, { status: 204, marker: probeId },
  ]);
  assert.equal(result.probes.length, 5);
  for (const { url, settings, navigationsBeforeRequest } of result.probes) {
    assert.equal(navigationsBeforeRequest, 0);
    if (url === '/') { assert.equal(settings.mode, 'same-origin'); assert.equal(settings.method, 'HEAD'); }
    else { assert.equal(url, canonicalOrigin + '/lan-entry-check'); assert.equal(settings.mode, 'cors'); }
    assert.equal(settings.credentials, 'omit');
    assert.equal(settings.cache, 'no-store');
    assert.equal(settings.redirect, 'error');
    assert.equal(settings.referrerPolicy, 'no-referrer');
    assert.equal(settings.headers, undefined);
  }
  assert.match(result.status, /自动继续/);
  assert.deepEqual(result.navigations, [canonicalOrigin + '/' + fragment]);
});

test('only room, invitation, and optional scope are relayed to the guest application', async () => {
  for (const hash of ['', '#invite=short', '#room=r&invite=short']) {
    const result = await openInBrowser(hash, []);
    assert.match(result.status, /完整邀请/);
    assert.deepEqual(result.probes, []); assert.deepEqual(result.navigations, []);
  }
  const result = await openInBrowser(fragment + '&next=https://foreign.example&unrelated=value', [{ status: 204, marker: probeId }]);
  assert.deepEqual(result.navigations, [canonicalOrigin + '/' + fragment]);
});

test('the landing page survives a host restart while waiting on a cached address', async () => {
  const replacement = '19a1915b-ef39-4115-a41f-36e5505a37a3';
  const result = await openInBrowser(fragment, [{ status: 204, marker: replacement }, { status: 200, marker: replacement }]);
  assert.equal(result.probes[1].url, '/');
  assert.deepEqual(result.navigations, [canonicalOrigin + '/' + fragment]);
});
