import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';

// Exercise the real browser script with synthetic UI/transport only. These tests
// establish rendering decisions, not mobile browser layout or live transport.
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/guest.js', import.meta.url), 'utf8');
const notificationScript = fs.readFileSync(new URL('../public/notifications.js', import.meta.url), 'utf8');
const imageScript = fs.readFileSync(new URL('../public/images.js', import.meta.url), 'utf8');
const markdownScript = fs.readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8');
const inviteRecoveryScript = fs.readFileSync(new URL('../public/invite-recovery.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    Object.assign(this, { tag, children: [], dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, listeners: new Map(),
      hidden: false, disabled: false, value: '', textContent: '',
      scrollHeight: 500, scrollTop: 0, clientHeight: 500 });
  }
  set innerHTML(_value) { throw new Error('Guest messages must not use innerHTML'); }
  set textContent(value) { this.valueText = value; this.children = []; }
  get textContent() { return (this.valueText ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...children) {
    this.children.push(...children.flatMap(child => child.tag === '#fragment' ? child.children : [child]));
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  trigger(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...event }); }
  requestSubmit() { if (!this.submitButton?.disabled) this.trigger('submit'); }
  focus() { this.onFocus?.(); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  select() { this.selected = true; }
  click() { this.clicked = true; return this.trigger('click'); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.trigger('close'); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { this.loadCalls = (this.loadCalls ?? 0) + 1; }
  remove() { this.removed = true; }
}

function browser({ storage = new Map(), persistentStorage = new Map(), storageBlocked = false, sessionStorageBlocked = false, viewport = null, notification = null, focused = true, markdown = false, inviteRecovery = false,
  invitation = `#room=synthetic-room&invite=${'x'.repeat(43)}` } = {}) {
  const urls = { created: [], revoked: [] };
  class PreviewURL extends URL {
    static createObjectURL(blob) { const url = `blob:synthetic-${urls.created.length}`; urls.created.push({ url, size: blob.size, blob }); return url; }
    static revokeObjectURL(url) { urls.revoked.push(url); }
  }
  const elements = Object.fromEntries([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map(match => {
      const element = new Element();
      element.hidden = /\shidden(?:\s|>)/.test(match[0]);
      element.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
      return [match[1], element];
    }));
  const sockets = [];
  elements['proposal-form'].submitButton = elements['send-button'];
  class Socket {
    static OPEN = 1;
    constructor(url) {
      Object.assign(this, { url: String(url), readyState: 0, listeners: new Map(), sent: [] });
      sockets.push(this);
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(raw) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)); }
    open() { this.readyState = 1; this.listeners.get('open')?.(); }
    receive(message) { this.listeners.get('message')?.({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.listeners.get('close')?.(); }
  }
  const hash = invitation;
  let redactedUrl;
  let reloadCount = 0;
  const windowListeners = new Map();
  const location = {
    hash, pathname: '/', href: `https://synthetic.invalid/${hash}`, protocol: 'https:',
    reload() { reloadCount++; },
  };
  const documentListeners = new Map();
  const document = {
    body: new Element('body'), documentElement: new Element('html'),
    visibilityState: 'visible', hasFocus: () => focused,
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    getElementById(id) { assert.ok(elements[id], `Missing HTML element: ${id}`); return elements[id]; },
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
    createDocumentFragment: () => new Element('#fragment'),
  };
  for (const element of Object.values(elements)) element.onFocus = () => { document.activeElement = element; };
  const panelMarkup = html.slice(html.indexOf('<div id="collaboration-panel"'), html.indexOf('</header>'));
  elements['collaboration-panel'].append(...[...panelMarkup.matchAll(/\bid="([^"]+)"/g)]
    .map(match => elements[match[1]]).filter(element => element !== elements['collaboration-panel']));
  let clockNow = Date.now(), timerId = 0;
  const timers = new Map();
  const schedule = (fn, ms, repeat = false) => {
    const id = ++timerId; timers.set(id, { fn, due: clockNow + ms, ms, repeat }); return id;
  };
  class ClockDate extends Date { static now() { return clockNow; } }
  const context = { Date: ClockDate,
    URLSearchParams, URL: PreviewURL, WebSocket: Socket, crypto: webcrypto, Uint8Array, Blob, TextDecoder, atob, btoa,
    document,
    window: {
      ...(viewport ? { visualViewport: viewport } : {}),
      ...(notification ? { Notification: notification } : {}),
      location, focus() {},
      history: { replaceState(_state, _title, url) { redactedUrl = url; location.hash = ''; } },
      addEventListener(name, listener) { windowListeners.set(name, listener); },
      setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
      setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
      sessionStorage: { getItem: key => { if (sessionStorageBlocked) throw new Error('Storage blocked'); return storage.get(key); },
        setItem: (key, value) => { if (sessionStorageBlocked) throw new Error('Storage blocked'); storage.set(key, value); },
        removeItem: key => { if (sessionStorageBlocked) throw new Error('Storage blocked'); storage.delete(key); } },
      localStorage: { getItem: key => { if (storageBlocked) throw new Error('Storage blocked'); return persistentStorage.get(key); },
        setItem: (key, value) => { if (storageBlocked) throw new Error('Storage blocked'); persistentStorage.set(key, value); } },
    },
  };
  vm.runInNewContext(imageScript, context);
  if (markdown) { context.window.markdownit = MarkdownIt; vm.runInNewContext(markdownScript, context); }
  vm.runInNewContext(notificationScript, context);
  if (inviteRecovery) vm.runInNewContext(inviteRecoveryScript, context);
  vm.runInNewContext(script, context);
  assert.equal(redactedUrl, '/');
  return {
    elements, sockets, document, urls, storage, persistentStorage,
    documentEvent(name, event) { documentListeners.get(name)?.(event); },
    tick(ms) {
      const until = clockNow + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.due <= until).sort((a,b) => a[1].due-b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; clockNow = timer.due;
        if (timer.repeat) timer.due += timer.ms; else timers.delete(id);
        timer.fn();
      }
      clockNow = until;
    },
    sleep(ms) { clockNow += ms; },
    online() { windowListeners.get('online')?.(); },
    pagehide() { windowListeners.get('pagehide')?.(); },
    pageshow() { windowListeners.get('pageshow')?.({ persisted: true }); },
    join({ heartbeat = false, admitted = true } = {}) {
      elements['display-name'].value = '合成访客';
      elements['join-form'].trigger('submit');
      const socket = sockets.at(-1);
      socket.open();
      socket.receive({ type: 'pending', guestId: 'synthetic-guest', heartbeat });
      if (admitted) socket.receive({ type: 'admitted', guestId: 'synthetic-guest' });
      return socket;
    },
    messages() { return elements.messages.children.map(article => article.children[1].textContent); },
    visibility(state) { document.visibilityState = state; documentListeners.get('visibilitychange')?.(); },
    navigateHash(hash) { location.hash = hash; windowListeners.get('hashchange')?.(); },
    get reloadCount() { return reloadCount; },
    get hash() { return location.hash; },
  };
}

function snapshot(socket, revision, items, status = 'running') {
  socket.receive({ type: 'data', payload: {
    type: 'snapshot', title: '合成共享会话', status, revision, items,
  } });
}

const prompt = { id: 'u-1', role: 'user', text: '只回复 desktop-to-phone-ok，不使用工具' };
const reply = text => ({ id: 'a-1', role: 'assistant', text });

function offerInviteRecovery(page, reason = 'expired') {
  const socket = page.sockets.at(-1);
  assert.match(socket.url, /\/recovery$/); socket.open();
  assert.equal(socket.sent[0].type, 'status');
  socket.receive({ type: 'recovery-status', status: 'recoverable', reason, recoveryExpiresAt: Date.now() + 7 * 86400000 });
  return socket;
}
function requestInviteRecovery(page) {
  page.elements['invite-recovery-name'].value = '恢复申请者';
  page.elements['invite-recovery-form'].trigger('submit');
  const socket = page.sockets.at(-1); socket.open();
  const request = socket.sent[0]; assert.equal(request.type, 'request');
  return { socket, request };
}
const updatedInvitation = `https://synthetic.invalid/#room=updated-room&invite=${'y'.repeat(43)}&scope=updated-scope`;

test('recoverable expired invitation offers a request only after server verification and never grants local access', () => {
  const page = browser({ inviteRecovery: true });
  assert.equal(page.elements['invite-recovery-panel'].hidden, true);
  offerInviteRecovery(page);
  assert.equal(page.elements['join-panel'].hidden, true);
  assert.equal(page.elements['invite-recovery-form'].hidden, false);
  assert.equal(page.elements['invite-recovery-title'].textContent, '邀请已到期');
  assert.equal(page.elements['send-button'].disabled, true);
  const { socket, request } = requestInviteRecovery(page);
  assert.match(page.elements['invite-recovery-description'].textContent, /尚未确认送达/);
  assert.notEqual(request.receiptToken, request.visitorToken);
  const saved = JSON.parse(page.persistentStorage.get('co2.invitation-requests'))[0];
  assert.equal(saved.requestId, request.requestId); assert.equal(saved.confirmed, false);
  assert.ok(!JSON.stringify(saved).includes('inviteToken')); assert.ok(!JSON.stringify(saved).includes('https:'));
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'pending', expiresAt: saved.expiresAt });
  assert.match(page.elements['invite-recovery-feedback'].textContent, /申请已送达/);
  assert.equal(page.elements['invite-recovery-form'].hidden, true);
  assert.equal(page.elements['send-button'].disabled, true);
});

test('same browser reopens or refreshes a recovery request using its receipt without creating another request', () => {
  const persistentStorage = new Map(), storage = new Map();
  const first = browser({ inviteRecovery: true, persistentStorage, storage }); offerInviteRecovery(first);
  const { request } = requestInviteRecovery(first); // Intentionally lose the creation ACK.
  first.pagehide();
  for (const invitation of [`#room=synthetic-room&invite=${'x'.repeat(43)}`, '']) {
    const next = browser({ inviteRecovery: true, persistentStorage, storage, invitation });
    assert.equal(next.elements['join-panel'].hidden, true);
    const socket = next.sockets[0]; socket.open();
    assert.deepEqual(socket.sent[0], { type: 'watch', requestId: request.requestId, receiptToken: request.receiptToken });
    socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'pending', expiresAt: Date.now() + 60000 });
    assert.equal(socket.sent.filter(message => message.type === 'request').length, 0);
    assert.match(next.elements['invite-recovery-feedback'].textContent, /申请已送达/);
  }
  const other = browser({ inviteRecovery: true, persistentStorage, storage, invitation: `#room=different-room&invite=${'z'.repeat(43)}` });
  other.sockets[0].open(); assert.equal(other.sockets[0].sent[0].type, 'status');
  assert.equal(other.sockets[0].sent[0].roomId, 'different-room', 'another invitation cannot inherit this tab request');
});

test('approval changes only the invitation and applicant credential; admission and snapshot remain mandatory', () => {
  const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
  page.elements['proposal-text'].value = 'Do not replay this old draft'; page.elements['proposal-text'].trigger('input');
  const { socket, request } = requestInviteRecovery(page);
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  const joined = page.sockets.at(-1); assert.match(joined.url, /\/guest$/); joined.open();
  assert.equal(joined.sent[0].roomId, 'updated-room'); assert.equal(joined.sent[0].sessionId, request.visitorToken);
  assert.equal(joined.sent[0].inviteToken, 'y'.repeat(43)); assert.equal(page.elements['proposal-text'].value, '');
  assert.equal(page.elements['send-button'].disabled, true); assert.deepEqual(page.messages(), []);
  joined.receive({ type: 'admitted' }); page.elements['proposal-text'].value = 'new input';
  page.elements['proposal-text'].trigger('input'); assert.equal(page.elements['send-button'].disabled, true);
  snapshot(joined, 1, [], 'idle'); assert.equal(page.elements['send-button'].disabled, false);
  assert.equal(joined.sent.filter(message => message.type === 'proposal').length, 0);
  assert.equal(page.hash, '');
});

test('approved recovery remains claimable on reopen and waits for a background page to become visible', () => {
  const persistentStorage = new Map();
  const first = browser({ inviteRecovery: true, persistentStorage }); offerInviteRecovery(first);
  const { socket, request } = requestInviteRecovery(first);
  first.visibility('hidden');
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  assert.match(first.elements['invite-recovery-title'].textContent, /已更新/);
  assert.equal(first.sockets.filter(socket => /\/guest$/.test(socket.url)).length, 0);
  first.visibility('visible'); assert.match(first.sockets.at(-1).url, /\/guest$/);
  const next = browser({ inviteRecovery: true, persistentStorage }); next.sockets[0].open();
  assert.equal(next.sockets[0].sent[0].type, 'watch');
  next.sockets[0].receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 50000, inviteUrl: updatedInvitation });
  const guest = next.sockets.at(-1); guest.open(); assert.equal(guest.sent[0].sessionId, request.visitorToken);
});

test('blocked browser storage keeps the recovery and approved connection usable entirely in memory', () => {
  const page = browser({ inviteRecovery: true, storageBlocked: true, sessionStorageBlocked: true }); offerInviteRecovery(page, 'interrupted');
  const { socket, request } = requestInviteRecovery(page);
  assert.equal(page.elements['invite-recovery-storage'].hidden, false);
  assert.match(page.elements['invite-recovery-storage'].textContent, /保持本页打开/);
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  const guest = page.sockets.at(-1); guest.open(); assert.equal(guest.sent[0].sessionId, request.visitorToken);
  assert.equal(page.reloadCount, 0); assert.equal(page.persistentStorage.size, 0);
});

test('an unavailable recovery endpoint or unknown invitation cannot expose the request action', () => {
  const unsupported = browser({ inviteRecovery: true }); unsupported.sockets[0].close();
  assert.equal(unsupported.elements['invite-recovery-panel'].hidden, true);
  unsupported.online(); unsupported.tick(300000); assert.equal(unsupported.sockets.length, 1);
  const unknown = browser({ inviteRecovery: true }); unknown.sockets[0].open();
  unknown.sockets[0].receive({ type: 'recovery-status', status: 'unavailable' });
  assert.equal(unknown.elements['invite-recovery-form'].hidden, true);
  assert.equal(unknown.elements['join-panel'].hidden, true);
  assert.equal(unknown.elements['invite-recovery-title'].textContent, '邀请不可恢复');
});

test('rejected, unavailable and expired receipts stop watching and never submit or restore grants automatically', () => {
  for (const status of ['rejected', 'unavailable', 'expired']) {
    const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
    const { socket, request } = requestInviteRecovery(page);
    socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'pending', expiresAt: Date.now() + 60000 });
    socket.receive({ type: 'recovery-request', requestId: request.requestId, status });
    const count = page.sockets.length; page.tick(300000); page.online(); page.visibility('visible');
    assert.equal(page.sockets.length, count); assert.equal(page.elements['invite-recovery-form'].hidden, true);
    assert.equal(page.elements['send-button'].disabled, true);
  }
});

test('recovery rejects another requester result and cross-origin, malformed or expired replacement invitations', () => {
  for (const inviteUrl of [updatedInvitation.replace('synthetic.invalid', 'elsewhere.invalid'), 'javascript:alert(1)',
    updatedInvitation.replace('/#', '/unexpected#'), `${updatedInvitation}&invite=${'z'.repeat(43)}`]) {
    const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
    const { socket, request } = requestInviteRecovery(page);
    socket.receive({ type: 'recovery-request', requestId: 'another-request', status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
    assert.equal(page.sockets.filter(socket => /\/guest$/.test(socket.url)).length, 0);
    socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl });
    assert.equal(page.sockets.filter(socket => /\/guest$/.test(socket.url)).length, 0);
    assert.match(page.elements['invite-recovery-title'].textContent, /无法更新/);
  }
});

test('lost recovery connection only watches, while explicit creation retry reuses its original ID and secrets', () => {
  const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
  const { socket, request } = requestInviteRecovery(page); socket.close();
  page.tick(1000); const watch = page.sockets.at(-1); watch.open();
  assert.deepEqual(watch.sent[0], { type: 'watch', requestId: request.requestId, receiptToken: request.receiptToken });
  watch.receive({ type: 'recovery-request', requestId: request.requestId, status: 'unavailable' });
  assert.equal(page.elements['invite-recovery-button'].textContent, '重试提交');
  page.elements['invite-recovery-form'].trigger('submit');
  const retry = page.sockets.at(-1); retry.open(); assert.deepEqual(retry.sent[0], request);
});

test('revocation after recovered admission invalidates the local request and cannot restart it through old results', () => {
  const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
  const { socket, request } = requestInviteRecovery(page);
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  const guest = page.sockets.at(-1); guest.open(); guest.receive({ type: 'admitted' });
  guest.receive({ type: 'revoked' });
  assert.deepEqual(JSON.parse(page.persistentStorage.get('co2.invitation-requests')), []);
  socket.receive({ type: 'recovery-request', requestId: request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  const count = page.sockets.length; page.online(); page.tick(300000); assert.equal(page.sockets.length, count);
  assert.equal(page.elements['invite-recovery-panel'].hidden, true);
});

test('live expiration and system interruption clear old content before verifying recovery, while denial suppresses it', () => {
  for (const type of ['expired', 'interrupted', 'paused', 'denied']) {
    const page = browser({ inviteRecovery: true });
    page.sockets[0].open(); page.sockets[0].receive({ type: 'recovery-status', status: 'active' });
    const guest = page.join(); snapshot(guest, 1, [prompt], 'idle');
    guest.receive({ type }); assert.deepEqual(page.messages(), []);
    assert.equal(page.elements['send-button'].disabled, true);
    if (type === 'denied') {
      const count = page.sockets.length; page.tick(300000); page.online(); assert.equal(page.sockets.length, count);
      assert.equal(page.elements['invite-recovery-panel'].hidden, true);
    } else {
      offerInviteRecovery(page, type === 'expired' ? 'expired' : type);
      assert.equal(page.elements['invite-recovery-form'].hidden, false);
    }
  }
});

test('failed join probes the original invite and confirmed recovery cancels the normal reconnect loop', () => {
  const page = browser({ inviteRecovery: true });
  page.sockets[0].open(); page.sockets[0].receive({ type: 'recovery-status', status: 'temporarily-offline' });
  const guest = page.join({ admitted: false }); guest.receive({ type: 'join-rejected' });
  offerInviteRecovery(page, 'interrupted');
  const count = page.sockets.filter(socket => /\/guest$/.test(socket.url)).length;
  page.tick(300000);
  assert.equal(page.sockets.filter(socket => /\/guest$/.test(socket.url)).length, count);
  assert.equal(page.elements['invite-recovery-form'].hidden, true, 'unreachable recovery service must not leave an enabled action');
});

test('a recovered room later expiring starts a new explicit request instead of reusing the earlier approval', () => {
  const page = browser({ inviteRecovery: true }); offerInviteRecovery(page);
  const first = requestInviteRecovery(page);
  first.socket.receive({ type: 'recovery-request', requestId: first.request.requestId, status: 'approved', expiresAt: Date.now() + 60000, inviteUrl: updatedInvitation });
  const guest = page.sockets.at(-1); guest.open(); guest.receive({ type: 'admitted' }); guest.receive({ type: 'expired' });
  const probe = page.sockets.at(-1); probe.open();
  assert.equal(probe.sent[0].roomId, 'updated-room');
  probe.receive({ type: 'recovery-status', status: 'recoverable', reason: 'expired', recoveryExpiresAt: Date.now() + 7 * 86400000 });
  const next = requestInviteRecovery(page);
  assert.notEqual(next.request.requestId, first.request.requestId);
  assert.notEqual(next.request.visitorToken, first.request.visitorToken);
  assert.equal(next.request.roomId, 'updated-room');
});

test('Desktop-originated reply renders live without a guest proposal or reconnect', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 10, [prompt]);
  assert.deepEqual(page.messages(), [prompt.text]);
  snapshot(socket, 11, [prompt, reply('desktop-')]);
  assert.deepEqual(page.messages(), [prompt.text, 'desktop-']);
  snapshot(socket, 12, [prompt, reply('desktop-to-phone-ok')], 'idle');
  assert.deepEqual(page.messages(), [prompt.text, 'desktop-to-phone-ok']);
  assert.equal(page.elements['agent-status'].textContent, 'Agent 空闲');
  assert.equal(page.sockets.length, 1);
  assert.deepEqual(socket.sent.map(message => message.type), ['join', 'snapshot-request']);
});

test('equal revisions still render; older revisions cannot replace a newer reply', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 20, [prompt]);
  snapshot(socket, 20, [prompt, reply('same-revision-reply')]);
  assert.deepEqual(page.messages(), [prompt.text, 'same-revision-reply']);
  snapshot(socket, 19, [prompt, reply('stale-reply')]);
  assert.deepEqual(page.messages(), [prompt.text, 'same-revision-reply']);
});

test('a reply off the bottom remains in the DOM even when automatic scrolling is suppressed', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 1, [prompt]);
  Object.assign(page.elements.conversation, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
  snapshot(socket, 2, [prompt, reply('new-reply')]);
  assert.equal(page.elements.conversation.scrollTop, 0);
  assert.deepEqual(page.messages(), [prompt.text, 'new-reply']);
  assert.equal(page.elements['new-replies-button'].hidden, false);
});

test('new reply indicator does not interrupt history reading and clicking it only scrolls', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 1, [prompt, reply('initial')]);
  assert.equal(page.elements['new-replies-button'].hidden, true);
  Object.assign(page.elements.conversation, { scrollHeight: 1200, clientHeight: 400, scrollTop: 100 });
  snapshot(socket, 2, [prompt, reply('initial')], 'idle');
  assert.equal(page.elements['new-replies-button'].hidden, true, 'status-only change is not a new reply');
  snapshot(socket, 3, [prompt, reply('initial, updated')], 'idle');
  assert.equal(page.elements.conversation.scrollTop, 100);
  assert.equal(page.elements['new-replies-button'].hidden, false);
  const sent = socket.sent.length;
  page.elements['new-replies-button'].trigger('click');
  assert.equal(page.elements.conversation.scrollTop, page.elements.conversation.scrollHeight);
  assert.equal(page.elements['new-replies-button'].hidden, true);
  assert.equal(socket.sent.length, sent, 'viewing a reply must not send anything');
});

test('scrolling to the bottom clears the new reply indicator', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 1, [prompt]);
  Object.assign(page.elements.conversation, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
  snapshot(socket, 2, [prompt, reply('new-reply')]);
  assert.equal(page.elements['new-replies-button'].hidden, false);
  page.elements.conversation.scrollTop = 800;
  page.elements.conversation.trigger('scroll');
  assert.equal(page.elements['new-replies-button'].hidden, true);
});

test('returning to a visible page requests one snapshot only while admitted and connected', () => {
  const page = browser();
  page.visibility('visible');
  assert.equal(page.sockets.length, 0, 'visibility must not initiate a connection');
  const socket = page.join();
  snapshot(socket, 1, [prompt], 'idle');
  page.elements['proposal-text'].value = '合成建议';
  page.elements['proposal-form'].trigger('submit');
  const before = socket.sent.length;
  page.visibility('hidden');
  assert.equal(socket.sent.length, before);
  page.visibility('visible');
  assert.equal(socket.sent.length, before + 1);
  assert.deepEqual(socket.sent.at(-1), { type: 'snapshot-request' });
  assert.equal(socket.sent.filter(message => message.type === 'proposal').length, 1);
  socket.close();
  page.visibility('visible');
  assert.equal(socket.sent.length, before + 1);
  assert.equal(page.sockets.length, 1, 'visibility must not reconnect or seek readmission');
});

test('snapshot text is literal and invalid statuses cannot silently change the transcript', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 1, [prompt, reply('<script>unsafe()</script>')]);
  assert.deepEqual(page.messages(), [prompt.text, '<script>unsafe()</script>']);
  snapshot(socket, 2, [prompt, reply('ignored-invalid-status')], 'complete');
  assert.deepEqual(page.messages(), [prompt.text, '<script>unsafe()</script>']);
});

test('reconnect resets the revision epoch and never automatically replays a guest proposal', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 100, [prompt], 'idle');
  page.elements['proposal-text'].value = '合成建议';
  page.elements['proposal-form'].trigger('submit');
  assert.equal(socket.sent.at(-1).type, 'proposal');
  socket.close();
  assert.equal(page.elements['proposal-text'].disabled, true);
  assert.equal(page.elements.proposals.children[0].children[0].dataset.status, 'unknown');
  page.elements['reconnect-button'].trigger('click');
  const reconnected = page.sockets.at(-1);
  reconnected.open();
  snapshot(reconnected, 1, [prompt, reply('not-yet-admitted')]);
  assert.deepEqual(page.messages(), [prompt.text]);
  reconnected.receive({ type: 'admitted', guestId: 'new-guest' });
  snapshot(reconnected, 1, [prompt, reply('recovered-reply')]);
  assert.deepEqual(page.messages(), [prompt.text, 'recovered-reply']);
  assert.deepEqual(reconnected.sent.map(message => message.type), ['join', 'snapshot-request']);
});

test('a valid same-document invitation reloads once without sending or mixing old session state', () => {
  const page = browser();
  const socket = page.join();
  snapshot(socket, 1, [prompt], 'idle');
  page.elements['proposal-text'].value = '不能重发的合成建议';
  page.elements['proposal-form'].trigger('submit');
  socket.receive({ type: 'revoked' });
  const sent = socket.sent.length;
  const nextHash = `#room=new-synthetic-room&invite=${'n'.repeat(43)}`;
  assert.equal(page.hash, '', 'startup must scrub the original invitation');
  page.navigateHash(nextHash);
  assert.equal(page.reloadCount, 1);
  assert.equal(page.hash, nextHash, 'the new page must be able to consume the new invitation');
  page.navigateHash(nextHash);
  assert.equal(page.reloadCount, 1, 'repeated hash events must not start additional reloads');
  assert.equal(socket.sent.length, sent, 'invitation navigation must not send a proposal or join');
  assert.equal(page.sockets.length, 1, 'the old page must not open another socket');
});

test('hash navigation without a structurally valid invitation does not reload', () => {
  const page = browser();
  for (const hash of ['', '#history', '#room=other', '#invite=short', '#room=other&invite=short']) {
    page.navigateHash(hash);
  }
  assert.equal(page.reloadCount, 0);
  assert.equal(page.sockets.length, 0);
});

test('human authors display actual room names, roles and distinct bubble classes with honest legacy fallback', () => {
  const page = browser(); const socket = page.join();
  snapshot(socket, 1, [
    { ...prompt, author: { id: 'a', name: '阿明', kind: 'host' } },
    { id: 'g', role: 'user', text: '建议', author: { id: 'b', name: '小林', kind: 'guest' } },
    { id: 'unknown', role: 'user', text: '未知' },
    { id: 'pending', role: 'user', text: '待归属', author: { id: 'unknown', name: '作者待确认', kind: 'unknown' } },
    reply('回复'),
  ]);
  const articles = page.elements.messages.children;
  assert.deepEqual(articles.map(a => a.children[0].textContent), ['阿明 · 分享者', '小林 · 协作者', '历史消息 · 作者未知', '作者待确认', 'Codex']);
  assert.match(articles[0].className, /message-host/);
  assert.match(articles[1].className, /message-guest/);
  socket.receive({ type: 'revoked' });
  assert.equal(page.elements.messages.children.length, 0);
  assert.equal(page.elements['proposal-feedback'].textContent, '访问已结束，旧建议不会自动重发。');
});

test('processing proposals become uncertain on disconnect and are never replayed', () => {
  const page = browser(), socket = page.join(); snapshot(socket, 1, [prompt], 'idle');
  page.elements['proposal-text'].value = '合成执行中建议'; page.elements['proposal-form'].trigger('submit');
  const proposal = socket.sent.find(m => m.type === 'proposal');
  socket.receive({ type: 'data', payload: { type: 'proposal-status', requestId: proposal.requestId, status: 'processing' } });
  assert.equal(page.elements.proposals.children[0].children[0].dataset.status, 'processing');
  socket.close();
  assert.equal(page.elements.proposals.children[0].children[0].dataset.status, 'unknown');
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
});


test('guest composer follows host approval policy and submission status without acquiring policy controls', () => {
  const page = browser(), socket = page.join(); snapshot(socket, 1, []);
  for (const requireApproval of [false, true, false]) {
    socket.receive({ type: 'data', payload: { type: 'message-policy', requireApproval } });
    assert.match(page.elements['proposal-help'].textContent, requireApproval ? /已开启消息审批/ : /无需逐条审批/);
    page.elements['proposal-text'].value = '合成协作输入'; page.elements['proposal-form'].trigger('submit');
    const message = socket.sent.at(-1);
    assert.deepEqual(Object.keys(message).sort(), ['requestId', 'text', 'type']);
    assert.match(page.elements['proposal-feedback'].textContent, requireApproval ? /等待分享者确认/ : /正在提交给 Agent/);
    socket.receive({ type: 'data', payload: { type: 'proposal-status', requestId: message.requestId, status: 'accepted' } });
    assert.equal(page.elements['proposal-feedback'].textContent, '已交给 Agent');
  }
  assert.equal(socket.sent.some(m => m.type === 'set-message-policy'), false);
});

test('Enter sends once through the form; Shift+Enter and IME commit preserve the draft', () => {
  const page = browser(), socket = page.join(); snapshot(socket, 1, [], 'idle');
  const input = page.elements['proposal-text'];
  const compose = text => { input.value = text; input.trigger('input'); };
  let prevented = 0;
  const enter = extra => input.trigger('keydown', { key: 'Enter', preventDefault() { prevented++; }, ...extra });
  compose('第一行\n第二行');
  for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) enter(extra);
  assert.equal(prevented, 0);
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 0);
  assert.equal(input.value, '第一行\n第二行');
  enter(); enter();
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
  assert.equal(socket.sent.at(-1).text, '第一行\n第二行');
  assert.equal(input.value, '');
  compose('新草稿'); enter({ repeat: true });
  assert.equal(input.value, '新草稿');
  socket.receive({ type: 'offline' }); enter();
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
  assert.equal(input.value, '新草稿');
});

test('Enter retains validation and optional message approval', () => {
  const page = browser(), socket = page.join(); snapshot(socket, 1, [], 'idle');
  const input = page.elements['proposal-text'];
  socket.receive({ type: 'data', payload: { type: 'message-policy', requireApproval: true } });
  for (const text of ['   ', 'x'.repeat(8001)]) {
    input.value = text; input.trigger('input'); input.trigger('keydown', { key: 'Enter' });
    assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 0);
    assert.equal(input.value, text);
  }
  input.value = '等待审批'; input.trigger('input'); input.trigger('keydown', { key: 'Enter' });
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
  assert.equal(page.elements.proposals.children[0].children[0].dataset.status, 'pending');
});

test('structured images request admitted room bytes once, survive redraw, enlarge and clear on revocation', () => {
  const page = browser(), socket = page.join(), imageId = 'a'.repeat(64);
  const item = { ...prompt, images: [{ id: imageId, name: 'example.png' }] };
  snapshot(socket, 1, [item]);
  assert.deepEqual(socket.sent.at(-1), { type: 'image-request', imageId });
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  socket.receive({ type: 'data', payload: { type: 'image-chunk', imageId, mime: 'image/png', total: 1, index: 0, data } });
  let button = page.elements.messages.children[0].children[2].children[0];
  assert.equal(button.children[0].src, 'data:image/png;base64,' + data);
  button.trigger('click'); const dialog = page.document.body.children[0]; assert.equal(dialog.open, true);
  snapshot(socket, 2, [item]); button = page.elements.messages.children[0].children[2].children[0];
  assert.equal(button.children[0].tag, 'img');
  assert.equal(socket.sent.filter(m => m.type === 'image-request').length, 1);
  socket.receive({ type: 'revoked' });
  assert.equal(dialog.open, false); assert.equal(dialog.children[1].src, undefined);
  assert.equal(page.elements.messages.children.length, 0);
});

test('unavailable images, unsafe MIME, unsolicited chunks and disconnect cannot create an image preview', () => {
  for (const invalid of [
    { type: 'image-unavailable' },
    { type: 'image-chunk', mime: 'image/svg+xml', index: 0, total: 1, data: 'PHN2Zy8+' },
    { type: 'image-chunk', mime: 'image/png', index: 1, total: 1, data: 'aAAA' },
    { type: 'image-chunk', mime: 'image/png', index: 0, total: 9999, data: 'aAAA' },
  ]) {
    const page = browser(), socket = page.join(), imageId = 'a'.repeat(64);
    snapshot(socket, 1, [{ ...prompt, images: [{ id: imageId, name: '<script>.png' }] }]);
    socket.receive({ type: 'data', payload: { ...invalid, imageId } });
    const button = page.elements.messages.children[0].children[2].children[0];
    assert.match(button.textContent, /无法预览/); assert.equal(button.children.length, 0);
    socket.close(); button.trigger('click'); assert.equal(socket.sent.filter(m => m.type === 'image-request').length, 1);
  }
});

test('assistant images render at Markdown positions, preserve text, reuse cached bytes and enlarge through the existing preview', () => {
  const page = browser({ markdown: true }), socket = page.join(), imageId = 'e'.repeat(64);
  const item = { ...reply('之前\n\n![本地图片](/synthetic/example.png)\n\n之后'), images: [{ id: imageId, name: '本地图片', index: 0 }] };
  snapshot(socket, 1, [item]);
  assert.deepEqual(socket.sent.at(-1), { type: 'image-request', imageId });
  let article = page.elements.messages.children[0], text = article.children[1], figure = text.children[1].children[0];
  assert.equal(article.children.length, 2, 'no duplicate image appended below the reply');
  assert.equal(figure.tag, 'span', 'valid inline container inside a Markdown paragraph');
  assert.equal(text.children[0].textContent, '之前'); assert.equal(text.children[2].textContent, '之后');
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  socket.receive({ type: 'data', payload: { type: 'image-chunk', imageId, mime: 'image/png', total: 1, index: 0, data } });
  assert.equal(figure.children[0].children[0].src, 'data:image/png;base64,' + data);
  figure.children[0].trigger('click'); assert.equal(page.document.body.children[0].open, true);
  snapshot(socket, 2, [item]);
  text = page.elements.messages.children[0].children[1]; figure = text.children[1].children[0];
  assert.equal(figure.children[0].children[0].tag, 'img');
  assert.equal(socket.sent.filter(m => m.type === 'image-request').length, 1);
  socket.receive({ type: 'revoked' });
  assert.equal(page.document.body.children[0].open, false);
  assert.equal(page.elements.messages.children.length, 0);
});

test('remote assistant images load without host fetches or referrers, retry failures and reject unsafe URL metadata', () => {
  const page = browser({ markdown: true }), socket = page.join(), imageId = 'f'.repeat(64);
  snapshot(socket, 1, [{ ...reply('![远程](https://example.invalid/image.png)'),
    images: [{ id: imageId, name: '远程', index: 0, url: 'https://example.invalid/image.png' }] }]);
  const button = page.elements.messages.children[0].children[1].children[0].children[0].children[0];
  assert.equal(button.children[0].src, 'https://example.invalid/image.png');
  assert.equal(button.children[0].referrerPolicy, 'no-referrer');
  assert.equal(socket.sent.some(m => m.type === 'image-request'), false);
  button.children[0].trigger('error'); assert.match(button.textContent, /无法加载远程图片/);
  button.trigger('click'); assert.equal(button.children[0].tag, 'img');
  for (const url of ['javascript:alert(1)', 'file:///private/example.png', 'data:image/svg+xml,<svg/>']) {
    const other = browser({ markdown: true }), connection = other.join();
    snapshot(connection, 1, [{ ...reply('![危险](https://example.invalid/a.png)'), images: [{ id: imageId, name: '危险', index: 0, url }] }]);
    assert.equal(connection.sent.some(m => m.type === 'image-request'), false);
    assert.match(other.elements.messages.children[0].children[1].textContent, /\[图片：危险\]/);
  }
});

test('text previews load only by click, render HTML as code, handle empty files and preserve the message', () => {
  for (const text of ['# 标题\n<script>bad()</script>\n{"name":"合成"}', '']) {
    const page = browser(), socket = page.join(), fileId = 'c'.repeat(64);
    snapshot(socket, 1, [{ ...prompt, files: [{ id: fileId, name: 'example.html', kind: 'text' }] }]);
    assert.equal(socket.sent.some(m => m.type === 'file-request'), false);
    const figure = page.elements.messages.children[0].children[2]; figure.children[0].trigger('click');
    assert.deepEqual(socket.sent.at(-1), { type: 'file-request', fileId });
    socket.receive({ type: 'data', payload: { type: 'file-chunk', fileId, mime: 'text/plain; charset=utf-8', index: 0, total: 1, data: Buffer.from(text).toString('base64') } });
    assert.equal(figure.children[2].tag, 'pre');
    assert.equal(figure.children[2].children[0].tag, 'code');
    assert.equal(figure.children[2].children[0].textContent, text || '（空文件）');
    assert.deepEqual(page.messages(), [prompt.text]);
  }
});

test('MP4 controls and media element survive snapshot redraw; revocation stops video and revokes its Blob URL', () => {
  const page = browser(), socket = page.join(), fileId = 'd'.repeat(64);
  const item = { ...prompt, files: [{ id: fileId, name: 'clip.mp4', kind: 'video' }] };
  snapshot(socket, 1, [item]);
  page.elements.messages.children[0].children[2].children[0].trigger('click');
  socket.receive({ type: 'data', payload: { type: 'file-chunk', fileId, mime: 'video/mp4', index: 0, total: 1, data: Buffer.from('synthetic MP4').toString('base64') } });
  const video = page.elements.messages.children[0].children[2].children[2];
  assert.equal(video.tag, 'video'); assert.equal(video.controls, true); assert.equal(video.playsInline, true);
  assert.equal(video.src, 'blob:synthetic-0'); video.currentTime = 4; video.paused = false;
  snapshot(socket, 2, [item, reply('正在流式回复')]);
  assert.equal(page.elements.messages.children[0].children[2].children[2], video);
  assert.equal(video.currentTime, 4); assert.equal(socket.sent.filter(m => m.type === 'file-request').length, 1);
  socket.receive({ type: 'revoked' });
  assert.equal(video.paused, true); assert.equal(video.src, undefined); assert.deepEqual(page.urls.revoked, ['blob:synthetic-0']);
});

test('file MIME cannot cross preview types and forged packet IDs never create media', () => {
  const page = browser(), socket = page.join(), fileId = 'e'.repeat(64);
  snapshot(socket, 1, [{ ...prompt, files: [{ id: fileId, name: 'note.txt', kind: 'text' }] }]);
  const figure = page.elements.messages.children[0].children[2]; figure.children[0].trigger('click');
  socket.receive({ type: 'data', payload: { type: 'file-chunk', fileId: 'f'.repeat(64), mime: 'text/plain; charset=utf-8', index: 0, total: 1, data: 'b2s=' } });
  assert.equal(figure.children.length, 2);
  socket.receive({ type: 'data', payload: { type: 'file-chunk', fileId, mime: 'text/html', index: 0, total: 1, data: 'b2s=' } });
  assert.match(figure.children[0].textContent, /无法预览/); assert.equal(figure.children.length, 2);
});

test('automatic reconnect retains unsent tab draft, seeks fresh admission and never replays submitted messages', () => {
  const page = browser(), socket = page.join(); snapshot(socket, 1, [], 'idle');
  page.elements['proposal-text'].value = 'Already submitted'; page.elements['proposal-form'].trigger('submit');
  page.elements['proposal-text'].value = 'Still a draft'; page.elements['proposal-text'].trigger('input');
  socket.close(); page.tick(1000);
  const next = page.sockets.at(-1); assert.notEqual(next, socket); next.open();
  next.receive({ type: 'pending', guestId: 'new-guest' });
  assert.equal(page.elements['proposal-text'].value, 'Still a draft');
  assert.equal(page.elements['send-button'].disabled, true);
  assert.deepEqual(next.sent.map(m => m.type), ['join']);
  next.receive({ type: 'admitted', guestId: 'new-guest' }); snapshot(next, 1, [], 'idle');
  assert.equal(page.elements['send-button'].disabled, false);
  assert.deepEqual(next.sent.map(m => m.type), ['join', 'snapshot-request']);
  assert.equal(page.elements.proposals.children[0].children[0].dataset.status, 'unknown');
  assert.ok(![...page.storage.values()].join().includes('Already submitted'));
  assert.ok(![...page.storage.values()].join().includes('invite'));
});

test('drafts survive reopening the same invitation in a tab but never cross rooms, persist sent messages or submit automatically', () => {
  const storage = new Map(), first = browser({ storage }); first.join();
  first.elements['proposal-text'].value = 'Unsent draft'; first.elements['proposal-text'].trigger('input');
  const same = browser({ storage }); assert.equal(same.elements['proposal-text'].value, 'Unsent draft');
  assert.equal(same.sockets.length, 0);
  const other = browser({ storage, invitation: `#room=other-room&invite=${'y'.repeat(43)}` });
  assert.equal(other.elements['proposal-text'].value, '');
  const socket = same.join(); snapshot(socket, 1, [], 'idle'); same.elements['proposal-form'].trigger('submit');
  assert.equal(storage.size, 0); assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
  same.elements['proposal-form'].trigger('submit'); assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 1);
});

test('wake detects a half-open browser connection, retries the same URL and sends no proposal', () => {
  const page = browser(), first = page.join({ heartbeat: true }); snapshot(first, 1, [], 'idle');
  page.tick(25000); assert.deepEqual(first.sent.at(-1), { type: 'ping' }); first.receive({ type: 'pong' });
  page.sleep(80000); page.visibility('visible'); assert.equal(first.readyState, 3);
  page.tick(1000); const next = page.sockets.at(-1); next.open();
  assert.equal(next.url, first.url); assert.deepEqual(next.sent.map(m => m.type), ['join']);
});

test('revocation and expiry cancel retries; temporary rejection backs off and eventually stops automatic attempts', () => {
  for (const type of ['revoked', 'expired', 'denied']) {
    const page = browser(), socket = page.join(); socket.receive({ type });
    page.tick(300000); page.online(); assert.equal(page.sockets.length, 1);
    assert.equal(page.elements['send-button'].disabled, true);
  }
  const page = browser(), first = page.join(); first.close();
  for (let i = 0; i < 8; i++) {
    page.tick(i < 5 ? 1000 * 2 ** i : 30000);
    const current = page.sockets.at(-1); current.open(); current.receive({ type: 'join-rejected' });
  }
  const attempts = page.sockets.length; page.tick(300000);
  assert.equal(page.sockets.length, attempts); assert.match(page.elements.notice.textContent, /自动重连未成功/);
});

test('page suspension cancels retries and bfcache restoration only rejoins after the original user initiated a connection', () => {
  const page = browser(), socket = page.join(); page.pagehide(); page.tick(60000);
  assert.equal(page.sockets.length, 1); assert.equal(socket.readyState, 3);
  page.pageshow(); assert.equal(page.sockets.length, 2); page.sockets.at(-1).open();
  assert.deepEqual(page.sockets.at(-1).sent.map(m => m.type), ['join']);
  const fresh = browser(); fresh.pageshow(); fresh.online(); assert.equal(fresh.sockets.length, 0);
});

test('remembered personal identity automatically rejoins the same invitation without storing the invitation or replaying messages', () => {
  const storage = new Map(), first = browser({ storage }), socket = first.join();
  socket.receive({ type: 'data', payload: { type: 'visitor-recovery', expiresAt: Date.now() + 60000, name: '已确认同伴', resumed: false } });
  const identity = JSON.parse(storage.get('co2.visitor-identity'));
  assert.equal(identity.token, socket.sent.find(m => m.type === 'join').sessionId);
  assert.equal(identity.name, '已确认同伴');
  assert.ok(!JSON.stringify(identity).includes('invite'));
  const sent = socket.sent.length; first.elements['copy-recovery'].trigger('click');
  assert.equal(first.elements['recovery-code'].value, identity.token);
  assert.equal(first.elements['recovery-code'].selected, true);
  assert.equal(socket.sent.length, sent, 'copying a personal credential sends no network message');
  socket.receive({ type: 'data', payload: { type: 'share-paused' } });
  assert.equal(first.elements['connection-label'].textContent, '共享已暂停');
  assert.equal(first.elements['recovery-code'].value, identity.token);
  socket.receive({ type: 'revoked' });
  assert.equal(first.elements['connection-label'].textContent, '共享已暂停');
  const refreshed = browser({ storage }); assert.equal(refreshed.sockets.length, 1);
  refreshed.sockets[0].open(); assert.equal(refreshed.sockets[0].sent[0].sessionId, identity.token);
  assert.deepEqual(refreshed.sockets[0].sent.map(m => m.type), ['join']);
  assert.equal(refreshed.elements['send-button'].disabled, true);
});

test('new temporary origin accepts an explicit recovery credential; it remains separate from the public invitation', () => {
  const page = browser(), credential = 'r'.repeat(42) + 'A';
  page.elements['recovery-input'].value = credential;
  page.elements['recovery-input'].trigger('input'); assert.equal(page.elements['display-name'].required, false);
  page.elements['join-form'].trigger('submit'); page.sockets[0].open();
  const join = page.sockets[0].sent[0]; assert.equal(join.sessionId, credential);
  assert.equal(join.name, '恢复中的同伴'); assert.equal(page.hash, '');
  assert.equal(page.elements['recovery-input'].value, '');
  const bad = browser(); bad.elements['recovery-input'].value = 'invalid'; bad.elements['join-form'].trigger('submit');
  assert.equal(bad.sockets.length, 0);
});

const scopedInvitation = (scope, room = 'synthetic-room') => `#room=${room}&invite=${'x'.repeat(43)}&scope=${scope}`;
function confirmIdentity(socket, scopeId = 'scope-one') {
  socket.receive({ type: 'data', payload: { type: 'visitor-recovery', scopeId,
    expiresAt: Date.now() + 60000, name: '已确认同伴', resumed: false } });
}

test('approved identity survives a closed tab and matches a replacement room by stable scope, without replay', () => {
  const persistentStorage = new Map();
  const first = browser({ persistentStorage, invitation: scopedInvitation('scope-one') });
  const socket = first.join(), token = socket.sent[0].sessionId;
  assert.equal(persistentStorage.size, 0, 'unapproved identities are not remembered');
  confirmIdentity(socket);
  const stored = JSON.parse(persistentStorage.get('co2.visitor-identities'));
  assert.equal(stored[0].scopeId, 'scope-one'); assert.equal(stored[0].token, token);
  assert.equal(first.elements['identity-notice'].hidden, false);
  assert.match(first.elements['identity-notice'].textContent, /自动保存/);
  assert.ok(!JSON.stringify(stored).includes('invite'));
  const next = browser({ persistentStorage, invitation: scopedInvitation('scope-one', 'replacement-room') });
  assert.equal(next.elements['recovery-input'].value, token, 'the matched credential is automatically filled');
  assert.equal(next.sockets.length, 1); next.sockets[0].open();
  assert.equal(next.sockets[0].sent[0].sessionId, token);
  assert.equal(next.sockets[0].sent[0].roomId, 'replacement-room');
  assert.deepEqual(next.sockets[0].sent.map(m => m.type), ['join']);
  assert.equal(next.elements['send-button'].disabled, true, 'local identity is not local admission');
});

test('multiple sharing scopes keep separate identities; unknown, stopped and expired scopes do not auto-join', () => {
  const persistentStorage = new Map();
  const first = browser({ persistentStorage, invitation: scopedInvitation('scope-one') });
  confirmIdentity(first.join());
  const other = browser({ persistentStorage, invitation: scopedInvitation('scope-two', 'other-room') });
  assert.equal(other.sockets.length, 0); confirmIdentity(other.join(), 'scope-two');
  assert.equal(JSON.parse(persistentStorage.get('co2.visitor-identities')).length, 2);
  const restored = browser({ persistentStorage, invitation: scopedInvitation('scope-one', 'new-room') });
  assert.equal(restored.sockets.length, 1);
  const stopped = browser({ persistentStorage, invitation: scopedInvitation('new-scope', 'new-room') });
  assert.equal(stopped.sockets.length, 0);
  const entries = JSON.parse(persistentStorage.get('co2.visitor-identities'));
  entries.forEach(entry => { entry.expiresAt = Date.now() - 1; });
  persistentStorage.set('co2.visitor-identities', JSON.stringify(entries));
  assert.equal(browser({ persistentStorage, invitation: scopedInvitation('scope-one') }).sockets.length, 0);
});

test('revocation deletes only the current remembered identity, while pausing retains it for replacement invitations', () => {
  const persistentStorage = new Map();
  const first = browser({ persistentStorage, invitation: scopedInvitation('scope-one') });
  const socket = first.join(); confirmIdentity(socket);
  socket.receive({ type: 'data', payload: { type: 'share-paused' } });
  assert.equal(JSON.parse(persistentStorage.get('co2.visitor-identities')).length, 1);
  const next = browser({ persistentStorage, invitation: scopedInvitation('scope-one', 'new-room') });
  const resumed = next.sockets[0]; resumed.open(); resumed.receive({ type: 'admitted' }); confirmIdentity(resumed);
  resumed.receive({ type: 'revoked' });
  assert.equal(JSON.parse(persistentStorage.get('co2.visitor-identities')).length, 0);
  assert.equal(next.elements['recovery-code'].value, '');
  assert.equal(next.elements['recovery-panel'].hidden, true);
  assert.equal(browser({ persistentStorage, invitation: scopedInvitation('scope-one', 'third-room') }).sockets.length, 0);
});

test('blocked persistent storage leaves admission usable and visibly prompts the guest to save a backup', () => {
  const page = browser({ storageBlocked: true, invitation: scopedInvitation('scope-one') });
  const socket = page.join(); confirmIdentity(socket);
  assert.equal(page.elements['send-button'].disabled, true, 'a snapshot is still required');
  assert.match(page.elements['identity-notice'].textContent, /未能长期保存/);
  assert.equal(page.elements['identity-warning'].hidden, false);
  page.elements['open-backup-warning'].trigger('click');
  assert.equal(page.elements['collaboration-backup'].hidden, false);
  assert.equal(page.elements['recovery-code'].value, socket.sent[0].sessionId);
});

test('backup file can be imported in a new origin for the matching scope, but grants no local admission', async () => {
  const page = browser({ invitation: scopedInvitation('scope-one', 'new-room') });
  const record = { type: 'codex-co2-recovery', version: 1, approved: true,
    scopeId: 'scope-one', roomId: 'original-room', name: '原来的同伴', token: 'r'.repeat(43), expiresAt: Date.now() + 60000 };
  const input = page.elements['import-recovery'];
  input.files = [{ size: 300, text: async () => JSON.stringify(record) }];
  await input.trigger('change');
  assert.equal(page.elements['recovery-input'].value, record.token);
  assert.equal(page.elements['display-name'].value, record.name);
  assert.equal(page.elements['join-button'].textContent, '恢复连接');
  assert.equal(page.sockets.length, 0, 'reading a backup never sends a request on its own');
  assert.equal(page.persistentStorage.size, 0, 'only host confirmation may persist an imported identity');
  page.elements['join-form'].trigger('submit'); page.sockets[0].open();
  assert.equal(page.sockets[0].sent[0].sessionId, record.token);
  assert.equal(page.elements['send-button'].disabled, true);
  const other = browser({ invitation: scopedInvitation('scope-two') });
  other.elements['import-recovery'].files = input.files; await other.elements['import-recovery'].trigger('change');
  assert.match(other.elements['join-feedback'].textContent, /不属于当前共享/);
  assert.equal(other.elements['recovery-input'].value, ''); assert.equal(other.sockets.length, 0);
  record.expiresAt = Date.now() - 1;
  const expired = browser({ invitation: scopedInvitation('scope-one') });
  expired.elements['import-recovery'].files = input.files; await expired.elements['import-recovery'].trigger('change');
  assert.match(expired.elements['join-feedback'].textContent, /无效或已到期/);
});

test('only a host-confirmed scope is remembered; the fragment alone cannot rebind an identity', () => {
  const page = browser({ invitation: scopedInvitation('forged-scope') });
  const socket = page.join(); confirmIdentity(socket, 'actual-scope');
  const saved = JSON.parse(page.persistentStorage.get('co2.visitor-identities'))[0];
  assert.equal(saved.scopeId, 'actual-scope');
  assert.equal(browser({ persistentStorage: page.persistentStorage, invitation: scopedInvitation('forged-scope', 'new-room') }).sockets.length, 0);
});

test('a backup download contains only confirmed identity data and remains available after a pause', async () => {
  const page = browser({ invitation: scopedInvitation('scope-one') });
  const socket = page.join(); confirmIdentity(socket);
  socket.receive({ type: 'data', payload: { type: 'share-paused' } });
  page.elements['download-recovery'].trigger('click');
  const record = JSON.parse(await page.urls.created[0].blob.text());
  assert.equal(record.type, 'codex-co2-recovery'); assert.equal(record.version, 1);
  assert.equal(record.scopeId, 'scope-one'); assert.equal(record.token, socket.sent[0].sessionId);
  assert.deepEqual(Object.keys(record).sort(), ['approved', 'expiresAt', 'name', 'roomId', 'scopeId', 'token', 'type', 'version']);
  assert.equal(socket.sent.filter(m => m.type === 'proposal').length, 0);
  page.tick(1000); assert.deepEqual(page.urls.revoked, [page.urls.created[0].url]);
});

test('legacy tab identities migrate on host confirmation and corrupt tab data cannot hide a valid persistent identity', () => {
  const storage = new Map([['co2.visitor-identity', JSON.stringify({ roomId: 'synthetic-room',
    token: 'l'.repeat(43), name: '旧访客', approved: true })]]), persistentStorage = new Map();
  const page = browser({ storage, persistentStorage, invitation: scopedInvitation('scope-one') });
  assert.equal(page.sockets.length, 1); const socket = page.sockets[0]; socket.open();
  socket.receive({ type: 'admitted' }); confirmIdentity(socket);
  storage.set('co2.visitor-identity', '{broken-json');
  const returning = browser({ storage, persistentStorage, invitation: scopedInvitation('scope-one', 'new-room') });
  assert.equal(returning.sockets.length, 1); returning.sockets[0].open();
  assert.equal(returning.sockets[0].sent[0].sessionId, 'l'.repeat(43));
});

test('collaboration navigation stays local, restores focus and closes by Escape, outside press or tabbing away', () => {
  const page = browser();
  const e = page.elements;
  e['collaboration-toggle'].trigger('click');
  assert.equal(e['collaboration-panel'].hidden, false);
  assert.equal(e['collaboration-toggle']['aria-expanded'], 'true');
  assert.equal(page.document.activeElement, e['open-proposals']);
  e['open-proposals'].trigger('click');
  assert.equal(e['collaboration-proposals'].hidden, false);
  assert.equal(e['collaboration-menu'].hidden, true);
  assert.equal(e['proposals-empty'].hidden, false);
  assert.equal(page.document.activeElement, e['collaboration-back']);
  e['collaboration-back'].trigger('click');
  assert.equal(e['collaboration-menu'].hidden, false);
  e['open-help'].trigger('click');
  page.documentEvent('pointerdown', { target: e['keyboard-help'] });
  assert.equal(e['collaboration-panel'].hidden, false, 'interacting inside the panel must not close it');
  let prevented = false;
  page.documentEvent('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(e['collaboration-panel'].hidden, true);
  assert.equal(page.document.activeElement, e['collaboration-toggle']);
  e['collaboration-toggle'].trigger('click');
  page.documentEvent('pointerdown', { target: e.messages });
  assert.equal(e['collaboration-panel'].hidden, true);
  e['collaboration-toggle'].trigger('click');
  e['open-help'].trigger('click');
  e['collaboration-close'].trigger('click');
  assert.equal(page.document.activeElement, e['collaboration-toggle']);
  e['collaboration-toggle'].trigger('click');
  e['proposal-text'].focus();
  page.documentEvent('focusin', { target: e['proposal-text'] });
  assert.equal(e['collaboration-panel'].hidden, true);
  assert.equal(page.document.activeElement, e['proposal-text'], 'tabbing away must not steal focus');
  assert.equal(page.sockets.length, 0, 'menu navigation cannot connect or send anything');
});

test('compact send mode follows host policy and submission history retains honest statuses', () => {
  const page = browser(); const e = page.elements;
  assert.equal(e['send-mode'].textContent, '同步中');
  const socket = page.join(); snapshot(socket, 1, [prompt]);
  socket.receive({ type: 'data', payload: { type: 'message-policy', requireApproval: false } });
  assert.equal(e['send-mode'].textContent, '直接发送');
  e['proposal-text'].value = '合成提交'; e['proposal-text'].trigger('input');
  e['proposal-form'].trigger('submit');
  assert.equal(e['submission-summary'].textContent, '1 条提交');
  assert.equal(e['proposals-empty'].hidden, true);
  assert.equal(e['proposal-feedback'].dataset.kind, 'info');
  assert.equal(e.proposals.children[0].children[0].textContent, '正在提交给 Agent');
  const request = socket.sent.find(message => message.type === 'proposal');
  socket.receive({ type: 'data', payload: { type: 'proposal-status', requestId: request.requestId, status: 'accepted' } });
  assert.equal(e.proposals.children[0].children[0].textContent, '已交给 Agent');
  socket.receive({ type: 'data', payload: { type: 'message-policy', requireApproval: true } });
  assert.equal(e['send-mode'].textContent, '需确认');
  socket.receive({ type: 'data', payload: { type: 'proposal-status', requestId: request.requestId, status: 'failed' } });
  assert.equal(e['proposal-feedback'].dataset.kind, 'warning');
  assert.equal(e['proposal-feedback'].textContent, '提交失败');
});

test('backup task requires confirmed unexpired identity and survives pause but clears on revocation', () => {
  const page = browser({ invitation: scopedInvitation('scope-one') }); const e = page.elements;
  assert.equal(e['open-backup'].disabled, true);
  e['open-backup'].trigger('click');
  assert.equal(e['collaboration-panel'].hidden, true);
  const socket = page.join(); confirmIdentity(socket);
  assert.equal(e['open-backup'].disabled, false);
  assert.equal(e['identity-warning'].hidden, true);
  e['collaboration-toggle'].trigger('click'); e['open-backup'].trigger('click');
  assert.equal(e['collaboration-backup'].hidden, false);
  assert.match(e['recovery-note'].textContent, /身份有效至/);
  e['manual-recovery'].open = true; e['recovery-code'].type = 'text';
  e['collaboration-back'].trigger('click');
  assert.equal(e['manual-recovery'].open, false);
  assert.equal(e['recovery-code'].type, 'password');
  socket.receive({ type: 'data', payload: { type: 'share-paused' } });
  assert.equal(e['open-backup'].disabled, false);
  const revoked = browser({ invitation: scopedInvitation('scope-one') });
  const other = revoked.join(); confirmIdentity(other);
  revoked.elements['open-backup'].trigger('click');
  other.receive({ type: 'revoked' });
  assert.equal(revoked.elements['recovery-panel'].hidden, true);
  assert.equal(revoked.elements['backup-unavailable'].hidden, false);
  assert.equal(revoked.elements['recovery-code'].value, '');
  page.tick(86400000);
  e['collaboration-toggle'].trigger('click'); e['collaboration-toggle'].trigger('click');
  assert.equal(e['open-backup'].disabled, true);
});

test('backup download feedback stays in its task and does not hide a connection warning', () => {
  const page = browser({ invitation: scopedInvitation('scope-one') });
  const socket = page.join(); confirmIdentity(socket);
  socket.receive({ type: 'offline' });
  const warning = page.elements.notice.textContent;
  page.elements['download-recovery'].trigger('click');
  assert.match(page.elements['recovery-feedback'].textContent, /已请求下载/);
  assert.equal(page.elements.notice.textContent, warning);
  assert.equal(page.elements.notice.hidden, false);
});

test('composer grows up to 160px, shows count at 7200 characters and shrinks after sending', () => {
  const page = browser(); const e = page.elements;
  const socket = page.join(); snapshot(socket, 1, [prompt]);
  const input = e['proposal-text'];
  input.value = 'x'.repeat(7199); input.scrollHeight = 240; input.trigger('input');
  assert.equal(input.style.height, '160px');
  assert.equal(input.style.overflowY, 'auto');
  assert.equal(e['character-count'].hidden, true);
  input.value += 'x'; input.trigger('input');
  assert.equal(e['character-count'].hidden, false);
  assert.equal(e['character-count'].textContent, '7,200 / 8,000');
  input.value = '短消息'; input.scrollHeight = 32; input.trigger('input');
  assert.equal(input.style.height, '48px');
  assert.equal(input.style.overflowY, 'hidden');
  assert.equal(e['character-count'].hidden, true);
  e['proposal-form'].trigger('submit');
  assert.equal(input.value, '');
  assert.equal(input.style.height, '48px');
  assert.equal(e['character-count'].hidden, true);
});

test('a failed browser send keeps the draft and exposes actionable feedback outside the menu', () => {
  const page = browser(); const socket = page.join(); snapshot(socket, 1, [prompt]);
  const input = page.elements['proposal-text'];
  input.value = '保留这条草稿'; input.trigger('input');
  socket.send = () => { throw new Error('synthetic send failure'); };
  page.elements['proposal-form'].trigger('submit');
  assert.equal(input.value, '保留这条草稿');
  assert.equal(page.elements['proposal-feedback'].dataset.kind, 'warning');
  assert.match(page.elements['proposal-feedback'].textContent, /尚未发送，草稿已保留/);
  assert.equal(page.elements['proposals-empty'].hidden, false);
});

test('visual viewport changes keep the composer within the resized shell without moving history', () => {
  const listeners = new Map();
  const viewport = { height: 710, offsetTop: 0, addEventListener(name, listener) { listeners.set(name, listener); } };
  const page = browser({ viewport });
  const socket = page.join(); snapshot(socket, 1, [prompt]);
  page.elements.conversation.scrollTop = 100;
  page.elements['proposal-text'].value = '合成多行草稿';
  page.elements['proposal-text'].scrollHeight = 300;
  viewport.height = 360; viewport.offsetTop = 8; listeners.get('resize')();
  assert.equal(page.document.documentElement.style['--viewport-height'], '360px');
  assert.equal(page.document.documentElement.style['--viewport-top'], '8px');
  assert.equal(page.elements['proposal-text'].style.height, '160px');
  assert.equal(page.elements.conversation.scrollTop, 100);
  viewport.offsetTop = 12; listeners.get('scroll')();
  assert.equal(page.document.documentElement.style['--viewport-top'], '12px');
  assert.equal(page.elements['proposal-text'].value, '合成多行草稿');
});

test('live guest snapshots notify on run end, ignore stale/initial history and stop after disconnect or revocation', () => {
  const shown = [];
  class Notification {
    static permission = 'granted';
    constructor(_title, _options) { shown.push(this); }
    close() { this.closed = true; }
  }
  const page = browser({ notification: Notification, focused: false });
  const socket = page.join(); snapshot(socket, 1, [prompt], 'idle');
  assert.equal(shown.length, 0);
  snapshot(socket, 3, [prompt], 'running');
  snapshot(socket, 2, [prompt, reply('过期回复')], 'idle');
  assert.equal(shown.length, 0);
  snapshot(socket, 4, [prompt, reply('最新回复')], 'idle');
  snapshot(socket, 4, [prompt, reply('最新回复')], 'idle');
  assert.equal(shown.length, 1);
  page.elements.conversation.scrollTop = 10;
  shown[0].onclick();
  assert.equal(page.elements.conversation.scrollTop, page.elements.conversation.scrollHeight);
  assert.equal(page.document.activeElement, page.elements.conversation);
  snapshot(socket, 5, [prompt], 'running'); socket.close();
  page.tick(1000); const next = page.sockets.at(-1); next.open(); next.receive({ type: 'admitted' });
  snapshot(next, 1, [prompt, reply('离线期间的历史回复')], 'idle');
  assert.equal(shown.length, 1);
  snapshot(next, 2, [prompt], 'running'); next.receive({ type: 'revoked' });
  snapshot(next, 3, [prompt, reply('无权接收')], 'idle');
  assert.equal(shown.length, 1);
  assert.equal(page.elements['task-toast'].hidden, true);
});

test('only confirmed admission automatically requests notification permission and synchronization does not await it', async () => {
  let requests = 0, finish;
  class Notification {
    static permission = 'default';
    static requestPermission() { requests++; return new Promise(resolve => { finish = resolve; }); }
  }
  const page = browser({ notification: Notification });
  const socket = page.join({ admitted: false });
  assert.equal(requests, 0);
  socket.receive({ type: 'admitted' });
  assert.equal(requests, 1);
  assert.ok(socket.sent.some(message => message.type === 'snapshot-request'));
  snapshot(socket, 1, [prompt], 'idle');
  assert.equal(page.elements['proposal-text'].disabled, false);
  socket.receive({ type: 'admitted' }); assert.equal(requests, 1);
  Notification.permission = 'granted'; finish('granted'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements['notification-test'].disabled, false);
});
