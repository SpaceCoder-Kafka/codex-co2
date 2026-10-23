import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Synthetic DOM and transport verify local decisions, never native rendering or a real share.
const html = fs.readFileSync(new URL('../owner/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../owner/owner.js', import.meta.url), 'utf8');
const languageScript = fs.readFileSync(new URL('../owner/i18n.js', import.meta.url), 'utf8');
const messages = JSON.parse(fs.readFileSync(new URL('../owner/locales.json', import.meta.url), 'utf8'));
class Element {
  constructor(tag = 'div') { Object.assign(this, { tag, children: [], dataset: {}, style: {}, value: '', textContent: '', disabled: false, checked: false }); }
  set innerHTML(_) { throw new Error('Untrusted collaboration text must stay plain text'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; if (this.tag === 'select') this.value = children[0]?.value ?? ''; }
  get firstElementChild() { return this.children[0]; }
  cloneNode() { const copy = new Element(this.tag); copy.textContent = this.textContent; return copy; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  removeAttribute(name) { delete this[name]; }
  focus() { this.focused = true; if (this.document) this.document.activeElement = this; }
  showModal() { assert.ok(!this.open, 'a second modal must not be opened'); this.open = true; }
  close() { this.open = false; this.onclose?.(); }
  scrollIntoView() { this.scrolledIntoView = true; }
  select() { this.selected = true; }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
}
function browser({ storage = new Map(), nativeLanguage, nativeCopy = 'success', browserClipboard, nativeUpdater = false, appInfo, updateState } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => {
    const node = new Element(m[1]); node.id = m[2];
    for (const attr of m[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    node.hidden = /\shidden[\s>]/.test(m[0]);
    return [m[2], node];
  }));
  elements.rooms.append(new Element());
  const connection = new Element(), sent = [], copies = [], copyRequests = [], copyTimeouts = new Map(), preferences = [], updates = [], links = [];
  let copyTimerSequence = 0;
  let socket, redacted;
  class Socket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 0; }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const descendants = e => [e, ...e.children.flatMap(descendants)];
  for (const match of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>(.*?)<\/select>/gs)) {
    for (const option of match[2].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)) {
      const node = new Element('option'); node.textContent = option[2];
      for (const attr of option[1].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
      elements[match[1]].append(node);
    }
  }
  const document = {
    documentElement: new Element('html'), activeElement: null,
    querySelector: s => s === '.connection' ? connection : elements[s.slice(1)],
    querySelectorAll: selector => {
      const all = Object.values(elements).flatMap(descendants);
      if (selector === 'button') return all.filter(e => e.tag === 'button');
      const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
      return attribute ? all.filter(e => e.getAttribute(attribute) != null) : [];
    },
    createElement: tag => { const node = new Element(tag); node.document = document; return node; },
    addEventListener() {},
  };
  for (const node of Object.values(elements).flatMap(descendants)) node.document = document;
  const window = { Co2Messages: messages, co2Language: nativeLanguage, co2AppInfo: appInfo, co2UpdateState: updateState,
    innerWidth: 1024, innerHeight: 768, addEventListener() {}, open: (...args) => links.push(args), webkit: { messageHandlers: {
    copyInvite: { postMessage: value => {
      copyRequests.push(JSON.parse(JSON.stringify(value)));
      if (nativeCopy === 'throw') throw new Error('Synthetic native bridge failure');
      copies.push(value.url);
      if (nativeCopy === 'success') window.co2InviteCopyResult({ requestId: value.requestId, ok: true });
    } }, languagePreference: { postMessage: value => preferences.push(value) },
  } } };
  if (nativeCopy === false) delete window.webkit.messageHandlers.copyInvite;
  if (nativeUpdater) window.webkit.messageHandlers.appUpdates = { postMessage: value => updates.push(JSON.parse(JSON.stringify(value))) };
  vm.runInNewContext(languageScript + '\n' + script, {
    document,
    WebSocket: Socket, URLSearchParams, location: { hash: '#owner=synthetic-only', pathname: '/' },
    history: { replaceState(_state, _title, url) { redacted = url; } },
    window, navigator: browserClipboard ? { clipboard: browserClipboard } : {},
    setTimeout: (fn, delay) => {
      if (delay !== 3000) return setTimeout(fn, delay);
      const id = `synthetic-copy-${++copyTimerSequence}`; copyTimeouts.set(id, fn); return id;
    },
    clearTimeout: id => { if (!copyTimeouts.delete(id)) clearTimeout(id); },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  socket.readyState = 1; socket.onopen();
  assert.equal(redacted, '/');
  const receive = m => socket.onmessage({ data: JSON.stringify(m) });
  const nodes = () => [...descendants(elements.rooms), ...descendants(elements['room-policies'])];
  const click = text => { const b = nodes().find(e => e.tag === 'button' && e.textContent === text); assert.ok(b, `Missing ${text}`); b.onclick(); };
  const threadRows = () => descendants(elements.threads).filter(e => e.className === 'thread-row');
  return { elements, socket, sent, copies, copyRequests, copyTimeouts, preferences, updates, links, receive, nodes, click, threadRows, window,
    expireCopies() { for (const [id, fn] of [...copyTimeouts]) { copyTimeouts.delete(id); fn(); } },
    acknowledgeCopy(ok, request = copyRequests.at(-1)) { window.co2InviteCopyResult({ requestId: request.requestId, ok }); } };
}
const room = () => ({ roomId: 'room-1', title: '<script>synthetic title</script>', ownerName: 'A', state: 'online',
  expiresAt: Date.now() + 3600000, inviteUrl: 'https://example.invalid/#invite=synthetic',
  guests: [{ id: 'guest-1', name: '<img onerror=synthetic>', status: 'pending' }],
  proposals: [{ id: 'proposal-1', name: 'B', status: 'pending', text: '<script>synthetic proposal</script>' }], approvalPending: false });
const network = (overrides = {}) => ({ intranetOnly: false, lanAddress: null, configurable: true,
  interfaces: [{ name: 'synthetic-en0', address: '192.168.40.20' }], ...overrides });
const lanState = (overrides = {}) => ({ type: 'state', rooms: [], connection: { state: 'local' },
  network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }), ...overrides });
function lifetimePage(options) {
  const page = browser(options);
  page.receive(lanState());
  page.receive({ type: 'threads', threads: [{ id: 'synthetic-thread', name: 'Synthetic session' }] });
  page.elements['owner-name'].value = 'A';
  return page;
}
const selectedLifetime = page => ['1h', '1d', '7d', 'permanent'].find(value => page.elements[`invite-lifetime-${value}`].checked);
function chooseLifetime(page, value) {
  for (const option of ['1h', '1d', '7d', 'permanent']) page.elements[`invite-lifetime-${option}`].checked = option === value;
  page.elements[`invite-lifetime-${value}`]?.onchange();
}

test('each intranet invitation lifetime requires confirmation and sends its exact value once', () => {
  for (const lifetime of ['1h', '1d', '7d', 'permanent']) {
    const page = lifetimePage(), e = page.elements;
    e.share.focus(); e.share.onclick();
    assert.equal(e['invite-lifetime-dialog'].open, true);
    assert.equal(e['invite-lifetime-dialog'].getAttribute('aria-labelledby'), 'invite-lifetime-title');
    assert.equal(e['invite-lifetime-dialog'].getAttribute('aria-describedby'), 'invite-lifetime-description');
    assert.equal(e['invite-lifetime'].getAttribute('aria-describedby'), 'invite-lifetime-hint');
    assert.equal(selectedLifetime(page), '1h');
    assert.equal(e['invite-lifetime-1h'].focused, true);
    assert.equal(e.share.disabled, true); assert.equal(e['intranet-only'].disabled, true);
    assert.equal(page.sent.some(m => m.type === 'share'), false);
    e.share.onclick();
    chooseLifetime(page, lifetime);
    assert.ok(e['invite-lifetime-hint'].textContent.includes(lifetime === 'permanent' ? '需保持应用和共享运行' : '访客也会断开'));
    e['invite-lifetime-confirm'].onclick(); e['invite-lifetime-confirm'].onclick(); e.share.onclick();
    assert.equal(e['invite-lifetime-dialog'].open, false);
    assert.deepEqual(page.sent.filter(m => m.type === 'share'), [{ type: 'share', threadId: 'synthetic-thread',
      ownerName: 'A', requireApproval: false, inviteLifetime: lifetime }]);
  }
});

test('cancel and Escape generate no invitation, restore focus and reset the next choice to one hour', () => {
  const page = lifetimePage(), e = page.elements;
  e.share.focus(); e.share.onclick();
  chooseLifetime(page, 'permanent');
  e['invite-lifetime-cancel'].onclick();
  assert.equal(e['invite-lifetime-dialog'].open, false); assert.equal(e.share.disabled, false);
  assert.equal(e.share.focused, true); assert.equal(e['intranet-only'].disabled, false);
  e.share.onclick(); assert.equal(selectedLifetime(page), '1h');
  let prevented = false;
  e['invite-lifetime-dialog'].oncancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(e['invite-lifetime-dialog'].open, false);
  assert.equal(page.sent.some(m => m.type === 'share'), false);
});

test('public share and history restore bypass the lifetime picker and omit intranet fields', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'state', rooms: [], network: network(),
    history: [{ threadId: 'past', title: 'Synthetic history', lastSharedAt: 1 }] });
  page.receive({ type: 'threads', threads: [{ id: 'synthetic-thread', name: 'Synthetic session' }] });
  e['owner-name'].value = 'A'; e.share.onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'share', threadId: 'synthetic-thread', ownerName: 'A', requireApproval: false });
  assert.ok(!e['invite-lifetime-dialog'].open);
  page.receive({ type: 'share-result', threadId: 'synthetic-thread' });
  page.click('重新分享并复制邀请');
  assert.deepEqual(page.sent.at(-1), { type: 'reshare', threadId: 'past' });
  assert.ok(!e['invite-lifetime-dialog'].open);
});

test('context menu, history and offline restore share the intranet lifetime picker and copy only after native acknowledgement', () => {
  for (const entry of ['context', 'history', 'offline']) {
    const page = lifetimePage({ nativeCopy: 'manual' }), e = page.elements;
    const saved = { threadId: 'synthetic-thread', title: 'Synthetic history', lastSharedAt: 1 };
    const old = { ...room(), threadId: saved.threadId, state: 'offline', intranetOnly: true, inviteLifetime: '1h', inviteExpiresAt: Date.now() + 3600000 };
    page.receive(lanState({ rooms: entry === 'offline' ? [old] : [], history: [saved] }));
    if (entry === 'context') {
      page.threadRows()[0].oncontextmenu({ preventDefault() {}, clientX: 100, clientY: 100 });
      e['menu-share'].onclick();
    } else page.click('重新分享并复制邀请');
    assert.equal(e['invite-lifetime-dialog'].open, true, entry);
    assert.equal(page.sent.some(m => ['share', 'reshare'].includes(m.type)), false, entry);
    chooseLifetime(page, '7d'); e['invite-lifetime-confirm'].onclick();
    assert.equal(page.sent.at(-1).inviteLifetime, '7d');
    assert.equal(page.sent.at(-1).threadId, saved.threadId);
    assert.equal(page.sent.at(-1).type, entry === 'context' ? 'share' : 'reshare');
    if (entry === 'context') continue;
    const fresh = { ...old, roomId: 'new-room', state: 'online', inviteLifetime: '7d', inviteExpiresAt: Date.now() + 7 * 86400000,
      inviteUrl: 'http://192.168.40.20:47830/#room=22222222-2222-4222-8222-222222222222&invite=' + 'B'.repeat(43) };
    page.receive(lanState({ rooms: [fresh], history: [saved] }));
    assert.equal(page.copyRequests.length, 0);
    page.receive({ type: 'share-result', roomId: fresh.roomId, threadId: saved.threadId, restored: true });
    assert.equal(page.copyRequests[0].url, fresh.inviteUrl);
    assert.equal(e.notice.textContent, '正在复制邀请…');
    page.acknowledgeCopy(entry === 'history');
    assert.equal(e.notice.textContent, entry === 'history' ? '邀请链接已复制' : '请手动复制链接');
    if (entry === 'offline') assert.equal(page.nodes().find(n => n.tag === 'input' && n.className === 'link').selected, true);
  }
});

test('intranet validity displays the fixed deadline or permanent state independently of rolling leases', () => {
  for (const [lifetime, duration] of [['1h', 3600000], ['1d', 86400000], ['7d', 7 * 86400000], ['permanent', null]]) {
    const page = browser(), r = { ...room(), intranetOnly: true, inviteLifetime: lifetime,
      expiresAt: Date.UTC(2030, 0, 1, 1), inviteExpiresAt: duration === null ? null : Date.UTC(2030, 0, 1) + duration,
      renewalSupported: true };
    page.receive(lanState({ rooms: [r] }));
    const expected = duration === null ? '不设固定到期时间 · 包含本会话中已展示的文本记录'
      : `有效至 ${new Date(r.inviteExpiresAt).toLocaleString('zh-CN')} · 到期后自动结束共享`;
    assert.ok(page.nodes().some(n => n.textContent === expected), lifetime);
    assert.ok(!page.nodes().some(n => /自动续期/.test(n.textContent)));
    if (duration === null) assert.ok(page.nodes().some(n => n.textContent.includes('停止共享、退出应用或更换入口后失效')));
    r.expiresAt += 3600000; page.receive(lanState({ rooms: [r] }));
    assert.ok(page.nodes().some(n => n.textContent === expected), 'lease renewal must not move the invitation deadline');
  }
});

test('intranet lifetime dialog and fixed or permanent validity translate without losing the selected value', () => {
  for (const language of ['zh-CN', 'zh-TW', 'en']) {
    const page = lifetimePage(), e = page.elements;
    e.share.onclick(); chooseLifetime(page, 'permanent');
    e.language.value = language; e.language.onchange();
    assert.equal(e['invite-lifetime-dialog'].open, true);
    assert.equal(selectedLifetime(page), 'permanent');
    assert.equal(e['invite-lifetime-title'].textContent, messages[language]['内网邀请有效期']);
    assert.deepEqual(['1h', '1d', '7d', 'permanent'].map(value => e[`invite-lifetime-label-${value}`].textContent), ['1 小时', '1 天', '7 天', '永久'].map(key => messages[language][key]));
    assert.equal(e['invite-lifetime-permanent'].getAttribute('type'), 'radio');
    assert.equal(e['invite-lifetime-permanent'].getAttribute('aria-describedby'), 'invite-permanent-tooltip');
    assert.equal(e['invite-permanent-tooltip'].getAttribute('role'), 'tooltip');
    assert.equal(e['invite-permanent-tooltip'].textContent, messages[language]['永久表示不设固定到期时间，但停止共享、退出应用或更换入口后，仍需生成新链接。']);
    assert.equal(e['invite-lifetime-hint'].textContent, messages[language]['不设固定到期时间，需保持应用和共享运行；停止共享、退出应用或更换入口后失效。']);
    e['invite-lifetime-cancel'].onclick();
    const r = { ...room(), intranetOnly: true, inviteExpiresAt: Date.UTC(2030, 0, 2), inviteLifetime: '1d' };
    page.receive(lanState({ rooms: [r] }));
    assert.ok(page.nodes().some(n => n.textContent === messages[language]['有效至 {time} · 到期后自动结束共享'].replace('{time}', new Date(r.inviteExpiresAt).toLocaleString(language))));
    r.inviteExpiresAt = null; r.inviteLifetime = 'permanent'; page.receive(lanState({ rooms: [r] }));
    assert.ok(page.nodes().some(n => n.textContent === messages[language]['不设固定到期时间 · 包含本会话中已展示的文本记录']));
  }
});

test('a network change, another window sharing the chosen session or disconnect cancels pending intranet generation', () => {
  for (const change of ['public', 'address', 'shared', 'disconnect']) {
    const page = lifetimePage(), e = page.elements;
    e.share.onclick(); chooseLifetime(page, 'permanent');
    if (change === 'public') page.receive({ type: 'state', rooms: [], network: network() });
    if (change === 'address') page.receive(lanState({ network: network({ intranetOnly: true, lanAddress: '10.5.0.20' }) }));
    if (change === 'shared') page.receive(lanState({ rooms: [{ ...room(), threadId: 'synthetic-thread' }] }));
    if (change === 'disconnect') page.socket.close();
    assert.equal(e['invite-lifetime-dialog'].open, false, change);
    e['invite-lifetime-confirm'].onclick();
    assert.equal(page.sent.some(m => ['share', 'reshare'].includes(m.type)), false, change);
    if (change === 'public' || change === 'address') assert.ok(e.notice.textContent.includes('访问范围已变更'));
    if (change === 'shared') assert.ok(e.notice.textContent.includes('此会话已在共享'));
  }
});

test('network work, connecting and invalid choices cannot confirm a pending intranet invitation', () => {
  const page = lifetimePage(), e = page.elements;
  e.share.onclick();
  page.receive(lanState({ networkBusy: true }));
  assert.equal(e['invite-lifetime-confirm'].disabled, true); e['invite-lifetime-confirm'].onclick();
  page.receive(lanState({ connection: { state: 'connecting' } }));
  assert.equal(e['invite-lifetime-confirm'].disabled, true); e['invite-lifetime-confirm'].onclick();
  page.receive(lanState()); assert.equal(e['invite-lifetime-confirm'].disabled, false);
  chooseLifetime(page, 'invalid'); e['invite-lifetime-confirm'].onclick();
  assert.equal(page.sent.some(m => m.type === 'share'), false);
  chooseLifetime(page, '1d'); e['invite-lifetime-confirm'].onclick();
  assert.equal(page.sent.at(-1).inviteLifetime, '1d');
});

test('native LAN invitation copy waits for a matching successful clipboard acknowledgement', () => {
  const page = browser({ nativeCopy: 'manual' }), r = room();
  r.inviteUrl = 'http://192.168.40.20:47830/#room=11111111-1111-4111-8111-111111111111&invite=' + 'A'.repeat(43);
  page.receive({ type: 'state', rooms: [r] });
  page.click('复制邀请');
  assert.equal(page.elements.notice.textContent, '正在复制邀请…');
  assert.match(page.copyRequests[0].requestId, /^copy-\d+$/);
  assert.equal(page.copyRequests[0].url, r.inviteUrl);
  assert.equal(page.copyTimeouts.size, 1);
  page.acknowledgeCopy(true);
  assert.equal(page.elements.notice.textContent, '邀请链接已复制');
  assert.equal(page.copyTimeouts.size, 0);
});

test('native copy rejection selects the currently rendered invitation for manual copying', () => {
  const page = browser({ nativeCopy: 'manual' }), r = room();
  page.receive({ type: 'state', rooms: [r] }); page.click('复制邀请');
  const previous = page.nodes().find(node => node.tag === 'input' && node.className === 'link');
  page.receive({ type: 'state', rooms: [r] });
  const current = page.nodes().find(node => node.tag === 'input' && node.className === 'link');
  assert.notEqual(current, previous);
  page.acknowledgeCopy(false);
  assert.equal(current.focused, true); assert.equal(current.selected, true);
  assert.equal(previous.selected, undefined);
  assert.equal(page.elements.notice.textContent, '请手动复制链接');
  assert.equal(page.copyTimeouts.size, 0);
});

test('a throwing native bridge falls back immediately instead of reporting a successful copy', () => {
  const page = browser({ nativeCopy: 'throw' }); page.receive({ type: 'state', rooms: [room()] }); page.click('复制邀请');
  assert.equal(page.copyRequests.length, 1); assert.equal(page.copies.length, 0);
  assert.equal(page.elements.notice.textContent, '请手动复制链接');
  assert.equal(page.nodes().find(node => node.tag === 'input' && node.className === 'link').selected, true);
  assert.equal(page.copyTimeouts.size, 0);
});

test('superseded and timed-out native copy acknowledgements cannot overwrite the latest result', () => {
  const page = browser({ nativeCopy: 'manual' }); page.receive({ type: 'state', rooms: [room()] });
  page.click('复制邀请'); const oldRequest = page.copyRequests[0];
  page.click('复制邀请'); const currentRequest = page.copyRequests[1];
  assert.notEqual(oldRequest.requestId, currentRequest.requestId);
  assert.equal(page.copyTimeouts.size, 1);
  page.acknowledgeCopy(true, oldRequest);
  assert.equal(page.elements.notice.textContent, '正在复制邀请…');
  page.expireCopies();
  assert.equal(page.elements.notice.textContent, '请手动复制链接');
  assert.equal(page.nodes().find(node => node.tag === 'input' && node.className === 'link').selected, true);
  page.acknowledgeCopy(true, currentRequest);
  assert.equal(page.elements.notice.textContent, '请手动复制链接');
  assert.equal(page.copyTimeouts.size, 0);
});

test('ordinary browser copying still reports actual clipboard success and preserves manual fallback', async () => {
  const written = [], clipboard = { writeText: async value => { written.push(value); } };
  const page = browser({ nativeCopy: false, browserClipboard: clipboard }), r = room();
  page.receive({ type: 'state', rooms: [r] }); page.click('复制邀请');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written, [r.inviteUrl]);
  assert.equal(page.elements.notice.textContent, '邀请链接已复制');
  clipboard.writeText = async () => { throw new Error('Synthetic clipboard denial'); };
  page.click('复制邀请'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements.notice.textContent, '请手动复制链接');
  assert.equal(page.nodes().find(node => node.tag === 'input' && node.className === 'link').selected, true);
  const unsupported = browser({ nativeCopy: false }); unsupported.receive({ type: 'state', rooms: [room()] }); unsupported.click('复制邀请');
  assert.equal(unsupported.elements.notice.textContent, '请手动复制链接');
});

test('access scope stays a draft until saved, then locks all entry operations until the server responds', () => {
  const page = browser(), e = page.elements;
  const state = { type: 'state', rooms: [], connection: { state: 'local' }, network: network(),
    history: [{ threadId: 'past', title: 'Synthetic history', lastSharedAt: Date.now() }] };
  page.receive(state); page.receive({ type: 'threads', threads: [{ id: 'selected', name: 'Synthetic' }] });
  e['owner-name'].value = 'A';
  assert.equal(e['network-current'].textContent, '当前：公网分享');
  assert.equal(e['save-network'].disabled, true);
  const before = page.sent.length;
  e['intranet-only'].checked = true; e['intranet-only'].onchange();
  assert.equal(page.sent.length, before);
  assert.equal(e['lan-address-row'].hidden, false);
  assert.equal(e['lan-address'].value, '192.168.40.20');
  assert.equal(e['network-current'].textContent, '当前：公网分享');
  assert.ok(e['network-note'].textContent.includes('尚未保存'));
  e['save-network'].onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'set-network-mode', intranetOnly: true, lanAddress: '192.168.40.20' });
  assert.equal(e['save-network'].disabled, true); assert.equal(e['intranet-only'].disabled, true);
  assert.equal(e.share.disabled, true); assert.equal(e['menu-share'].disabled, true);
  const saving = page.sent.length;
  e.share.onclick(); e['check-connection'].onclick(); e['rebuild-relay'].onclick(); e['rebuild-relay'].onclick();
  page.click('重新分享并复制邀请');
  assert.equal(page.sent.length, saving);
  page.receive({ ...state, networkBusy: true });
  assert.equal(e['intranet-only'].checked, true); assert.equal(e['network-current'].textContent, '当前：公网分享');
  page.receive({ ...state, network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }), networkBusy: false });
  page.receive({ type: 'network-result', network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }) });
  assert.equal(e['network-current'].textContent, '当前：仅内网可访问');
  assert.equal(e['network-status'].textContent, '访问范围已保存');
  assert.equal(e.share.disabled, false); assert.equal(e['intranet-only'].disabled, false);
  e['intranet-only'].checked = false; e['intranet-only'].onchange(); e['save-network'].onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'set-network-mode', intranetOnly: false });
});

test('multiple intranet addresses require an explicit choice and failed saves retain the draft for correction', () => {
  const page = browser(), e = page.elements;
  const interfaces = [{ name: 'synthetic-en0', address: '192.168.40.20' }, { name: 'synthetic-en1', address: '10.5.0.20' }];
  page.receive({ type: 'state', rooms: [], network: network({ interfaces }) });
  e['intranet-only'].checked = true; e['intranet-only'].onchange();
  assert.equal(e['lan-address'].value, '');
  e['save-network'].onclick();
  assert.equal(page.sent.filter(m => m.type === 'set-network-mode').length, 0);
  assert.ok(e['network-status'].textContent.includes('请选择'));
  e['lan-address'].value = '10.5.0.20'; e['lan-address'].onchange(); e['save-network'].onclick();
  assert.equal(page.sent.at(-1).lanAddress, '10.5.0.20');
  page.receive({ type: 'error', operation: 'set-network-mode', message: 'Synthetic write failure' });
  assert.equal(e['intranet-only'].checked, true); assert.equal(e['lan-address'].value, '10.5.0.20');
  assert.equal(e['save-network'].disabled, false); assert.ok(e['network-status'].textContent.includes('未能保存'));
  page.receive({ type: 'state', rooms: [], network: network() });
  assert.equal(e['lan-address'].value, '10.5.0.20');
  assert.ok(e['lan-address'].children.some(option => option.textContent.includes('已不可用')));
  e['save-network'].onclick();
  assert.equal(page.sent.filter(m => m.type === 'set-network-mode').length, 1);
});

test('server access scope synchronizes across windows while drafts remain separate and busy or active shares forbid changes', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'state', rooms: [], network: network() });
  page.receive({ type: 'state', rooms: [], network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }) });
  assert.equal(e['intranet-only'].checked, true);
  e['intranet-only'].checked = false; e['intranet-only'].onchange();
  page.receive({ type: 'state', rooms: [], network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }), networkBusy: true });
  assert.equal(e['intranet-only'].checked, false);
  assert.equal(e['network-current'].textContent, '当前：仅内网可访问');
  assert.equal(e['save-network'].disabled, true); assert.equal(e['intranet-only'].disabled, true);
  const before = page.sent.length; e['save-network'].onclick(); assert.equal(page.sent.length, before);
  page.receive({ type: 'state', rooms: [room()], network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }) });
  assert.equal(e['intranet-only'].disabled, true); assert.ok(e['network-note'].textContent.includes('先结束所有共享'));
  e['save-network'].onclick(); assert.equal(page.sent.length, before);
  page.receive({ type: 'state', rooms: [], network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }) });
  assert.equal(e['intranet-only'].disabled, false); assert.equal(e['intranet-only'].checked, false);
});

test('startup-managed access scope and disconnected managers cannot change the network even through direct handlers', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'state', rooms: [], network: network({ configurable: false }) });
  assert.equal(e['intranet-only'].disabled, true); assert.ok(e['network-note'].textContent.includes('启动参数'));
  e['intranet-only'].checked = true; e['intranet-only'].onchange(); e['save-network'].onclick();
  assert.equal(e['intranet-only'].checked, false);
  assert.equal(page.sent.filter(m => m.type === 'set-network-mode').length, 0);
  page.receive({ type: 'state', rooms: [], network: network() });
  page.socket.close();
  assert.equal(e['intranet-only'].disabled, true); assert.equal(e['lan-address'].disabled, true); assert.equal(e['save-network'].disabled, true);
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['intranet-only'].disabled, true); assert.equal(e['save-network'].disabled, true);
});

test('intranet repair uses intranet labels, preserves its address during language changes and confirms invitation replacement', () => {
  const page = browser(), e = page.elements;
  const state = { type: 'state', rooms: [], network: network({ intranetOnly: true, lanAddress: '192.168.40.20' }), connection: { state: 'unavailable' } };
  page.receive(state);
  assert.ok(e['public-status'].textContent.includes('内网入口')); assert.ok(!e['public-status'].textContent.includes('公网'));
  assert.equal(e['rebuild-relay'].textContent, '更新内网入口…');
  e['check-connection'].onclick(); assert.equal(e.notice.textContent, '正在检查内网连接…');
  page.receive({ ...state, connection: { state: 'local' } }); page.receive({ type: 'connection-result' });
  assert.equal(e.notice.textContent, '检查完成，内网入口连接正常');
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['network-current'].textContent, 'Current: intranet access only');
  assert.equal(e['lan-address'].value, '192.168.40.20');
  assert.equal(e['rebuild-relay'].textContent, 'Update intranet entry point…');
  page.receive(state); const before = page.sent.filter(m => m.type === 'rebuild-relay').length;
  e['rebuild-relay'].onclick(); assert.equal(page.sent.filter(m => m.type === 'rebuild-relay').length, before);
  assert.ok(e['rebuild-relay'].textContent.includes('Confirm update'));
  e['rebuild-relay'].onclick(); assert.equal(page.sent.filter(m => m.type === 'rebuild-relay').length, before + 1);
});

test('sharing limit settings validate drafts, save unlimited and link capacity errors directly to the setting', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'state', settings: { shareLimit: 10 }, rooms: [] });
  assert.equal(e['share-limit'].value, '10');
  for (const invalid of ['', '0', '-1', '1.5', '9007199254740992']) {
    e['share-limit'].value = invalid; e['share-limit'].oninput(); e['save-share-limit'].onclick();
    assert.equal(page.sent.some(m => m.type === 'set-share-limit'), false);
    assert.ok(e['share-limit-status'].textContent.includes('整数'));
  }
  e['share-limit'].value = '25'; e['share-limit'].oninput();
  page.receive({ type: 'state', settings: { shareLimit: 10 }, rooms: [] });
  assert.equal(e['share-limit'].value, '25');
  e['save-share-limit'].onclick(); assert.deepEqual(page.sent.at(-1), { type: 'set-share-limit', shareLimit: 25 });
  assert.equal(e['save-share-limit'].disabled, true);
  page.receive({ type: 'settings-result', settings: { shareLimit: 25 } });
  assert.equal(e['save-share-limit'].disabled, false);
  page.receive({ type: 'error', operation: 'share', code: 'SHARE_LIMIT_REACHED', message: '已达到同时共享上限（{limit} 条）', values: { limit: 25 } });
  assert.equal(e['share-limit-alert'].hidden, false);
  assert.equal(e['share-limit-message'].textContent, '已达到同时共享上限（25 条）');
  e['edit-share-limit'].onclick();
  assert.equal(e['panel-settings'].hidden, false);
  assert.equal(e['share-limit-setting'].scrolledIntoView, true);
  assert.equal(e['share-limit'].focused, true);
  e['share-limit-mode'].value = 'unlimited'; e['share-limit-mode'].onchange(); e['save-share-limit'].onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'set-share-limit', shareLimit: null });
  page.receive({ type: 'error', operation: 'set-share-limit', message: 'Synthetic failure' });
  assert.equal(e['save-share-limit'].disabled, false);
  assert.ok(e['share-limit-status'].textContent.includes('未能保存'));
  e['save-share-limit'].onclick(); page.receive({ type: 'settings-result', settings: { shareLimit: null } });
  assert.equal(e['share-limit'].hidden, true); assert.equal(e['share-limit-alert'].hidden, true);
  page.receive({ type: 'state', settings: { shareLimit: 3 }, rooms: [] });
  assert.equal(e['share-limit'].value, '3'); assert.equal(e['share-limit'].hidden, false);
  page.socket.close(); assert.equal(e['save-share-limit'].disabled, true);
});

test('owner rendering never admits or approves; each local button sends only its scoped decision', () => {
  const page = browser(); page.receive({ type: 'state', rooms: [room()] });
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
  assert.ok(page.nodes().some(n => n.tag === 'pre' && n.textContent === '<script>synthetic proposal</script>'));
  page.click('允许加入'); page.click('确认并交给 Agent'); page.click('不采纳'); page.click('拒绝');
  assert.deepEqual(page.sent.slice(2), [
    { type: 'admit', roomId: 'room-1', guestId: 'guest-1' },
    { type: 'approve', roomId: 'room-1', proposalId: 'proposal-1' },
    { type: 'reject', roomId: 'room-1', proposalId: 'proposal-1' },
    { type: 'deny', roomId: 'room-1', guestId: 'guest-1' },
  ]);
});

test('uncertain results offer no resubmit and stopped shares expose no invitation', () => {
  const page = browser(), r = room(); r.state = 'offline'; r.guests[0].status = 'admitted'; r.proposals[0].status = 'unknown'; r.proposals[0].text = ''; r.approvalPending = true;
  page.receive({ type: 'state', rooms: [r] });
  assert.ok(!page.nodes().some(e => e.tag === 'button' && /Agent|重试/.test(e.textContent)));
  assert.ok(page.nodes().some(e => String(e.textContent).includes('不会自动重试')));
  page.click('移除访客'); page.click('复制邀请'); page.click('停止共享');
  assert.deepEqual(page.copies, [r.inviteUrl]);
  assert.deepEqual(page.sent.slice(2), [{ type: 'remove-guest', roomId: r.roomId, guestId: 'guest-1' }, { type: 'revoke', roomId: r.roomId }]);
  r.state = 'revoked'; r.guests = []; r.proposals = []; page.receive({ type: 'state', rooms: [r] });
  assert.ok(!page.nodes().some(e => e.tag === 'input' || e.tag === 'button'));
});

test('empty threads disable sharing, names are validated, and disconnect disables all decisions', () => {
  const page = browser(); page.receive({ type: 'threads', threads: [] });
  assert.equal(page.elements.share.disabled, true);
  assert.ok(page.elements.threads.children[0].textContent.includes('暂无'));
  page.receive({ type: 'threads', threads: [{ id: 'thread-1', name: '合成会话' }] });
  assert.equal(page.elements.share.disabled, false);
  page.elements['owner-name'].value = 'A\nB'; page.elements.share.onclick();
  assert.equal(page.sent.length, 2);
  page.elements['owner-name'].value = ' 小林 '; page.elements.share.onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'share', threadId: 'thread-1', ownerName: '小林', requireApproval: false });
  page.receive({ type: 'state', rooms: [room()] }); page.socket.close();
  assert.ok(page.nodes().filter(e => e.tag === 'button').every(e => e.disabled));
  assert.equal(page.elements.share.disabled, true);
});

test('daily catalog context menu shares its selected thread directly without ID copying or a separate connection', () => {
  const page = browser(); page.receive({ type: 'state', attached: true, rooms: [] });
  page.receive({ type: 'threads', attached: true, total: 101, nextCursor: 100, threads: [{ id: 'first', name: '<script>标题</script>' }, { id: 'selected-id', name: '日常会话', cwd: '/synthetic/project' }] });
  assert.equal(page.sent.filter(m => m.type === 'approve' || m.type === 'share').length, 0);
  assert.equal(page.elements['thread-count'].textContent, 101);
  page.elements['load-more'].onclick(); assert.deepEqual(page.sent.at(-1), { type: 'threads', search: '', cursor: 100 });
  page.threadRows()[1].oncontextmenu({ preventDefault() {}, clientX: 100, clientY: 200 });
  assert.equal(page.elements['thread-menu'].hidden, false);
  page.elements['owner-name'].value = 'A'; page.elements['menu-share'].onclick();
  assert.equal(page.elements['thread-menu'].hidden, true);
  assert.deepEqual(page.sent.at(-1), { type: 'share', threadId: 'selected-id', ownerName: 'A', requireApproval: false });
  page.elements.share.onclick(); assert.equal(page.sent.filter(m => m.type === 'share').length, 1);
  page.receive({ type: 'share-result', threadId: 'selected-id' }); assert.equal(page.elements.share.disabled, false);
  page.receive({ type: 'threads', attached: true, cursor: 100, threads: [{ id: 'last', name: '下一页' }], nextCursor: null });
  assert.equal(page.threadRows().length, 3); assert.equal(page.elements['load-more'].hidden, true);
  page.receive({ type: 'threads', search: 'stale', threads: [] }); assert.equal(page.threadRows().length, 3);
  assert.ok(!html.includes('attach-thread'));
});


test('owner chooses approval before sharing and toggles each room without approving pending messages', () => {
  const page = browser();
  page.receive({ type: 'threads', threads: [{ id: 'thread-1', name: '合成会话' }] });
  page.elements['owner-name'].value = 'A'; page.elements['require-approval'].checked = true;
  page.elements.share.onclick();
  assert.deepEqual(page.sent.at(-1), { type: 'share', threadId: 'thread-1', ownerName: 'A', requireApproval: true });
  const r = room(); r.requireApproval = false;
  page.receive({ type: 'state', rooms: [r] }); page.click('消息审批：已关闭');
  assert.deepEqual(page.sent.at(-1), { type: 'set-message-policy', roomId: r.roomId, requireApproval: true });
  r.requireApproval = true; page.receive({ type: 'state', rooms: [r] }); page.click('消息审批：已开启');
  assert.deepEqual(page.sent.at(-1), { type: 'set-message-policy', roomId: r.roomId, requireApproval: false });
  assert.equal(page.sent.some(m => m.type === 'approve'), false);
  assert.ok(page.nodes().some(e => e.textContent === '确认并交给 Agent'));
});

test('tabs separate the catalog, shared rooms and settings and support keyboard navigation', () => {
  const page = browser(), e = page.elements;
  assert.equal(e['panel-shared'].hidden, true);
  e['tab-settings'].onclick();
  assert.equal(e['panel-sessions'].hidden, true);
  assert.equal(e['panel-settings'].hidden, false);
  assert.equal(e['tab-settings']['aria-selected'], 'true');
  e['tab-settings'].onkeydown({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(e['panel-shared'].hidden, false);
  assert.equal(e['tab-shared'].focused, true);
  assert.equal(e['tab-settings'].tabindex, '-1');
  e['new-share'].onclick(); assert.equal(e['panel-sessions'].hidden, false);
  assert.equal(e['page-title'].textContent, '选择会话');
  e['tab-shared'].onclick(); assert.equal(e['page-title'].textContent, '共享会话');
  page.receive({ type: 'state', rooms: [] });
  e['tab-shared'].onclick(); e['empty-browse'].onclick();
  assert.equal(e['panel-sessions'].hidden, false);
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
});

test('project groups use full paths, preserve collapse on pagination and share the clicked nested row', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'threads', total: 4, nextCursor: 3, threads: [
    { id: 'a1', name: 'One', cwd: '/one/app' }, { id: 'a2', name: 'Two', cwd: '/one/app/' },
    { id: 'b1', name: 'Other', cwd: '/two/app' },
  ] });
  assert.equal(e.threads.children.length, 2);
  const first = e.threads.children[0];
  assert.equal(first.children[1].children.length, 2);
  first.children[0].onclick();
  assert.equal(first.children[1].hidden, true);
  assert.equal(first.children[0]['aria-expanded'], 'false');
  page.receive({ type: 'threads', cursor: 3, threads: [{ id: 'a3', name: 'Next', cwd: '/one/app' }], nextCursor: null });
  assert.equal(e.threads.children[0].children[1].hidden, true);
  assert.equal(e.threads.children[0].children[1].children.length, 3);
  assert.equal(e.threads.children[1].children[1].hidden, false);
  const pick = page.threadRows().find(r => r.dataset.threadId === 'b1').firstElementChild;
  pick.onclick(); assert.equal(pick['aria-pressed'], 'true');
  assert.equal(e['selected-title'].textContent, 'Other');
  e['owner-name'].value = 'A'; e.share.onclick();
  assert.equal(page.sent.at(-1).threadId, 'b1');
  assert.equal(page.sent.filter(m => m.type === 'share').length, 1);
  page.receive({ type: 'threads', threads: [{ id: 'root', name: 'Root', cwd: '/' }, { id: 'none', name: 'No project' }] });
  assert.equal(e.threads.children.length, 2);
  assert.ok(e.threads.children[0].firstElementChild['aria-label'].startsWith('根目录'));
});

test('automatic display name is editable, validated and never overwrites a manual edit', () => {
  const page = browser(), e = page.elements;
  page.window.setCo2SuggestedName('本机用户');
  assert.equal(e['owner-name'].value, '本机用户');
  assert.equal(e['profile-name'].textContent, '本机用户');
  assert.ok(e['name-hint'].textContent.includes('macOS'));
  e['owner-name'].value = '自定义名称'; e['owner-name'].oninput();
  page.window.setCo2SuggestedName('迟到的默认名称');
  assert.equal(e['owner-name'].value, '自定义名称');
  e['owner-name'].value = ''; e['owner-name'].oninput();
  page.window.setCo2SuggestedName('另一个名称');
  assert.equal(e['owner-name'].value, '');
  const invalid = browser();
  for (const name of ['A\nB', ' ', '字'.repeat(41), { name: 'object' }]) invalid.window.setCo2SuggestedName(name);
  assert.equal(invalid.elements['owner-name'].value, '');
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
});

test('profile validation opens settings, invitation completion opens shared rooms, policies stay in settings', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'threads', threads: [{ id: 'one', name: '<synthetic>', cwd: '/test/project' }] });
  assert.equal(e['selected-title'].textContent, '<synthetic>');
  e.share.onclick(); assert.equal(e['panel-settings'].hidden, false);
  e['owner-name'].value = '小林'; e['owner-name'].oninput();
  assert.equal(e['profile-name'].textContent, '小林');
  e['require-approval'].checked = true; e['require-approval'].onchange();
  assert.ok(e['policy-summary'].textContent.includes('经你确认'));
  e.share.onclick(); page.receive({ type: 'share-result', threadId: 'one' });
  assert.equal(e['panel-shared'].hidden, false);
  page.receive({ type: 'state', rooms: [room()] });
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.equal(walk(e.rooms).some(n => n.textContent === '消息审批：已关闭'), false);
  assert.equal(walk(e['room-policies']).some(n => n.textContent === '消息审批：已关闭'), true);
  assert.equal(e['active-count'].textContent, 1);
  assert.equal(e['nav-pending'].textContent, 2);
  page.socket.close();
  assert.equal(e['tab-settings'].disabled, false);
  assert.equal(e.share.disabled, true);
});

test('language changes redraw UI while preserving user content, selection, collapse, drafts and pending decisions', () => {
  const storage = new Map(), page = browser({ storage }), e = page.elements;
  // A real title matching a UI translation key must remain user content.
  page.receive({ type: 'threads', attached: true, threads: [{ id: 'one', name: '选择会话', cwd: '/test/project' }] });
  const r = room(); r.title = '设置'; r.proposals[0].text = '确认并交给 Agent';
  page.receive({ type: 'state', rooms: [r] });
  e.threads.children[0].firstElementChild.onclick();
  e['owner-name'].value = '自选名称'; e['owner-name'].oninput();
  e['require-approval'].checked = true;
  e['tab-settings'].onclick();
  const before = page.sent.length;
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['page-title'].textContent, 'Settings');
  assert.equal(e['selected-title'].textContent, '选择会话');
  assert.equal(e['owner-name'].value, '自选名称');
  assert.equal(e['require-approval'].checked, true);
  assert.equal(e.threads.children[0].children[1].hidden, true);
  assert.equal(page.threadRows()[0].firstElementChild['aria-pressed'], 'true');
  assert.ok(page.nodes().some(n => n.tag === 'h2' && n.textContent === '设置'));
  assert.ok(page.nodes().some(n => n.tag === 'pre' && n.textContent === '确认并交给 Agent'));
  assert.ok(page.nodes().some(n => n.tag === 'button' && n.textContent === 'Approve and send to Agent'));
  assert.equal(page.sent.length, before);
  assert.deepEqual(page.preferences, ['en']);
  assert.equal(storage.get('co2.language'), 'en');
  e.language.value = 'zh-TW'; e.language.onchange();
  assert.equal(e['page-title'].textContent, '設定');
  page.click('確認並交給 Agent');
  assert.deepEqual(page.sent.at(-1), { type: 'approve', roomId: 'room-1', proposalId: 'proposal-1' });
  assert.equal(browser({ storage }).elements['page-title'].textContent, '選擇對話');
  assert.equal(browser({ storage, nativeLanguage: 'en' }).elements['page-title'].textContent, 'Select session');
});

test('language choice remains available after disconnect without restoring execution buttons', () => {
  const page = browser(), e = page.elements;
  page.receive({ type: 'state', rooms: [room()] }); page.socket.close();
  e.language.value = 'en'; e.language.onchange();
  assert.ok(page.nodes().filter(n => n.tag === 'button').every(n => n.disabled));
  assert.equal(e.share.disabled, true);
  assert.ok(e.notice.textContent.includes('disconnected'));
  assert.equal(e['tab-settings'].disabled, false);
  assert.equal(page.window.Co2I18n.setLanguage('unsupported'), false);
  assert.equal(page.window.Co2I18n.language, 'en');
});

test('history renders as inactive metadata; only a local click restores and copies a fresh invitation', () => {
  const page = browser({ nativeCopy: 'manual' }), saved = { threadId: 'old-thread', title: '<script>Saved title</script>', requireApproval: true,
    ownerName: 'A', lastSharedAt: Date.now() - 10000 };
  page.receive({ type: 'state', rooms: [], history: [saved], connection: { state: 'not-started' } });
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
  assert.ok(page.nodes().some(n => n.textContent === '未共享 · 旧邀请已失效'));
  assert.ok(!page.nodes().some(n => n.tag === 'input'));
  page.click('重新分享并复制邀请'); assert.deepEqual(page.sent.at(-1), { type: 'reshare', threadId: 'old-thread' });
  const fresh = { ...room(), threadId: 'old-thread' };
  page.receive({ type: 'state', rooms: [fresh], history: [saved], connection: { state: 'online' } });
  assert.equal(page.copies.length, 0);
  page.receive({ type: 'share-result', roomId: fresh.roomId, threadId: saved.threadId, restored: true });
  assert.deepEqual(page.copies, [fresh.inviteUrl]);
  assert.equal(page.elements.notice.textContent, '正在复制邀请…');
  page.acknowledgeCopy(true);
  assert.equal(page.elements.notice.textContent, '邀请链接已复制');
  assert.equal(page.sent.some(m => ['admit', 'approve'].includes(m.type)), false);
});

test('connection diagnosis and rebuilding are distinct local actions with an explicit warning before replacement', () => {
  const page = browser();
  page.receive({ type: 'state', rooms: [], connection: { state: 'unavailable' } });
  assert.ok(page.elements['public-status'].textContent.includes('当前网络无法访问'));
  page.elements['check-connection'].onclick(); assert.deepEqual(page.sent.at(-1), { type: 'check-connection' });
  page.receive({ type: 'connection-result' });
  const count = page.sent.length; page.elements['rebuild-relay'].onclick(); assert.equal(page.sent.length, count);
  assert.equal(page.elements['rebuild-relay'].textContent, '确认重建（旧邀请将失效）');
  page.elements['rebuild-relay'].onclick(); assert.deepEqual(page.sent.at(-1), { type: 'rebuild-relay' });
  page.receive({ type: 'connection-result', rebuilt: true });
  assert.equal(page.sent.some(m => m.type === 'reshare'), false, 'rebuilding must never reopen history by itself');
});

test('rebuilding immediately labels every reshare button and keeps them disabled until completion', () => {
  const page = browser(), e = page.elements;
  const history = ['old-1', 'old-2', 'offline'].map(threadId => ({ threadId, title: threadId, lastSharedAt: 1 }));
  const offline = { ...room(), threadId: 'offline', state: 'offline' };
  const state = { type: 'state', rooms: [offline], history, connection: { state: 'unavailable' } };
  const restores = () => page.nodes().filter(n => n.tag === 'button' && /重新分享/.test(n.textContent));
  page.receive(state);
  e['rebuild-relay'].onclick();
  assert.equal(restores().length, 3);
  assert.ok(restores().every(b => !b.disabled && b.textContent === '重新分享并复制邀请'));
  e['rebuild-relay'].onclick();
  const count = page.sent.length;
  const assertRebuilding = () => {
    assert.equal(restores().length, 3);
    assert.ok(restores().every(b => b.disabled && b.textContent === '入口重建中，稍后可重新分享…' && b['aria-busy'] === 'true'));
    assert.equal(e['rebuild-relay'].textContent, '正在重建…');
    assert.equal(e['public-connection'].hidden, false);
  };
  assertRebuilding();
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['rebuild-relay'].textContent, 'Rebuilding…');
  assert.equal(page.nodes().filter(n => n.tag === 'button' && n.textContent === 'Rebuilding connection; you can share again shortly…' && n.disabled).length, 3);
  e.language.value = 'zh-CN'; e.language.onchange();
  assertRebuilding();
  restores()[0].onclick(); e['check-connection'].onclick(); e['rebuild-relay'].onclick();
  assert.equal(page.sent.length, count, 'pending actions must not be submitted again');
  for (const connectionState of ['connecting', 'online']) {
    page.receive({ ...state, rooms: [], connection: { state: connectionState } });
    assertRebuilding();
  }
  page.receive({ type: 'connection-result', rebuilt: true });
  assert.ok(restores().every(b => !b.disabled && b.textContent === '重新分享并复制邀请' && b['aria-busy'] === 'false'));
  assert.equal(e['public-connection'].hidden, true);
  assert.equal(page.sent.some(m => m.type === 'reshare'), false);
});

test('connection checks show progress and a result even when reachability remains unchanged', () => {
  const page = browser(), e = page.elements;
  const state = { type: 'state', rooms: [], history: [{ threadId: 'old', title: 'Synthetic', lastSharedAt: 1 }], connection: { state: 'unavailable' } };
  const restore = () => page.nodes().find(n => n.tag === 'button' && /重新分享|正在检查连接/.test(n.textContent));
  page.receive(state); e['check-connection'].onclick();
  assert.equal(e['check-connection'].textContent, '正在检查…');
  assert.equal(e['check-connection'].disabled, true);
  assert.equal(e.notice.textContent, '正在检查公网连接…');
  assert.equal(restore().textContent, '正在检查连接，请稍候…');
  assert.equal(restore().disabled, true);
  page.receive(state);
  assert.equal(e['check-connection'].textContent, '正在检查…');
  page.receive({ type: 'connection-result' });
  assert.equal(e['check-connection'].textContent, '检查连接');
  assert.equal(e['check-connection'].disabled, false);
  assert.equal(e.notice.textContent, '检查完成，公网入口仍不可用，请检查网络或重建入口。');
  assert.equal(restore().disabled, false);
  e['check-connection'].onclick();
  page.receive({ ...state, connection: { state: 'online' } });
  page.receive({ type: 'connection-result' });
  assert.equal(e.notice.textContent, '检查完成，公网入口连接正常');
});

test('failed network actions restore reshare controls; connecting state also blocks another manager window', () => {
  const page = browser(), e = page.elements;
  const state = { type: 'state', rooms: [], history: [{ threadId: 'old', title: 'Synthetic', lastSharedAt: 1 }], connection: { state: 'unavailable' } };
  const restore = () => page.nodes().find(n => n.tag === 'button' && /重新分享|正在检查连接/.test(n.textContent));
  for (const operation of ['check-connection', 'rebuild-relay']) {
    page.receive(state); e[operation].onclick();
    if (operation === 'rebuild-relay') e[operation].onclick();
    page.receive({ type: 'error', operation, message: 'Synthetic failure' });
    assert.equal(restore().textContent, '重新分享并复制邀请');
    assert.equal(restore().disabled, false);
    assert.equal(e['check-connection'].disabled, false);
    assert.equal(e['rebuild-relay'].disabled, false);
    assert.equal(e.notice.textContent, 'Synthetic failure');
  }
  page.receive({ ...state, connection: { state: 'connecting' } });
  assert.equal(restore().textContent, '入口建立中，稍后可重新分享…');
  assert.equal(restore().disabled, true);
  const count = page.sent.length; restore().onclick();
  assert.equal(page.sent.length, count);
  page.receive({ ...state, connection: { state: 'online' } });
  assert.equal(restore().textContent, '重新分享并复制邀请');
  assert.equal(restore().disabled, false);
});

test('healthy and ordinary startup states keep network controls hidden; recovery dismisses an armed rebuild', () => {
  const page = browser(), e = page.elements;
  for (const state of ['not-started', 'local', 'connecting', 'online']) {
    page.receive({ type: 'state', rooms: [], connection: { state } });
    assert.equal(e['public-connection'].hidden, true, state);
  }
  for (const state of ['recovering', 'unavailable', 'stopped']) {
    page.receive({ type: 'state', rooms: [], connection: { state } });
    assert.equal(e['public-connection'].hidden, false, state);
  }
  e['rebuild-relay'].onclick();
  page.receive({ type: 'state', rooms: [], connection: { state: 'online' } });
  assert.equal(e['public-connection'].hidden, true);
  page.receive({ type: 'state', rooms: [], connection: { state: 'unavailable' } });
  const before = page.sent.length; e['rebuild-relay'].onclick();
  assert.equal(page.sent.length, before, 'a later failure requires a fresh confirmation');
  e['tab-shared'].onclick(); assert.equal(e['page-title'].textContent, '共享会话');
});

test('in-app and native notification clicks locate the exact request without sending any decision', () => {
  const page = browser(), r = room();
  const attention = [
    { id: 'room-1:guest', kind: 'guest', roomId: 'room-1', itemId: 'guest-1', members: ['guest-1'], count: 1 },
    { id: 'room-1:proposal', kind: 'proposal', roomId: 'room-1', itemId: 'proposal-1', members: ['proposal-1'], count: 1 },
  ];
  assert.equal(page.window.openCo2Attention(attention[0].id), false);
  page.receive({ type: 'state', rooms: [r], attention });
  assert.equal(page.elements.attention.hidden, false);
  assert.ok(page.elements['attention-summary'].textContent.includes('2'));
  page.elements['attention-toggle'].onclick();
  assert.equal(page.elements['attention-list'].hidden, false);
  page.elements['attention-list'].children[0].onclick();
  assert.equal(page.elements['panel-shared'].hidden, false);
  assert.ok(page.nodes().find(e => e.className === 'card guest').focused);
  page.window.openCo2Attention(attention[1].id);
  assert.ok(page.nodes().find(e => e.className === 'card proposal').focused);
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
  r.guests[0].status = 'admitted'; r.proposals[0].status = 'accepted';
  page.receive({ type: 'state', rooms: [r], attention: [] });
  assert.equal(page.elements.attention.hidden, true);
  page.window.openCo2Attention(attention[0].id);
  assert.equal(page.elements.notice.textContent, '该提醒已处理或失效。');
  assert.equal(page.sent.length, 2);
});

test('unexpected stopped share remains reachable from a notification; connection alerts focus repair controls', () => {
  const page = browser(), r = room(); r.state = 'revoked'; r.lastError = '本地 Codex 已断开';
  const item = { id: 'room-1:share-stopped', kind: 'share-stopped', roomId: r.roomId, itemId: 'stopped', count: 1 };
  page.receive({ type: 'state', rooms: [r], attention: [item] });
  page.window.openCo2Attention(item.id);
  assert.ok(page.nodes().find(e => e.className === 'room').focused);
  assert.ok(page.nodes().some(e => e.textContent === r.lastError));
  assert.ok(!page.nodes().some(e => e.className === 'link'));
  const network = { id: 'manager:connection', kind: 'connection', roomId: '', itemId: 'stopped', count: 1 };
  page.receive({ type: 'state', rooms: [r], connection: { state: 'stopped' }, attention: [network] });
  page.window.openCo2Attention(network.id);
  assert.equal(page.elements['public-connection'].focused, true);
  assert.equal(page.sent.length, 2);
});

test('acknowledging an ended share sends only its room decision and preserves share history', () => {
  for (const expired of [true, false]) {
    const page = browser(), r = room();
    Object.assign(r, { threadId: 'old-thread', state: 'revoked', guests: [], proposals: [],
      ...(expired ? { endReason: 'expired' } : { lastError: '本地 Codex 已断开' }) });
    const saved = { threadId: r.threadId, title: 'Synthetic history', ownerName: 'A', requireApproval: false, lastSharedAt: 1 };
    const attention = [{ id: `${r.roomId}:share-stopped`, kind: 'share-stopped', roomId: r.roomId, itemId: 'stopped', count: 1 }];
    page.receive({ type: 'state', rooms: [r], history: [saved], attention });
    assert.ok(page.nodes().some(n => n.className === 'room'));
    assert.ok(page.nodes().some(n => n.tag === 'button' && n.textContent === '重新分享并复制邀请'));
    page.click('我知道了');
    assert.deepEqual(page.sent.slice(2), [{ type: 'dismiss-room', roomId: r.roomId }]);
    assert.ok(page.nodes().some(n => n.className === 'room'), 'the server confirms dismissal before removing the card');
    page.receive({ type: 'state', rooms: [], history: [saved], attention: [] });
    assert.ok(!page.nodes().some(n => n.className === 'room'));
    assert.equal(page.elements.attention.hidden, true);
    assert.ok(page.nodes().some(n => n.textContent === saved.title));
    page.click('重新分享并复制邀请');
    assert.deepEqual(page.sent.at(-1), { type: 'reshare', threadId: r.threadId });
  }
  for (const state of ['online', 'offline', 'connecting']) {
    const page = browser(), r = room(); r.state = state;
    page.receive({ type: 'state', rooms: [r] });
    assert.ok(!page.nodes().some(n => n.tag === 'button' && n.textContent === '我知道了'), state);
  }
});

test('renewal capability is explicit and deadline updates preserve invitations and server share order', () => {
  const page = browser();
  const newest = { ...room(), roomId: 'newest', title: 'Newest', startedAt: 20, renewalSupported: true };
  const older = { ...room(), roomId: 'older', title: 'Older', startedAt: 10, renewalSupported: false,
    inviteUrl: 'https://example.invalid/#invite=older' };
  const titles = () => page.nodes().filter(n => n.tag === 'h2').map(n => n.textContent);
  page.receive({ type: 'state', rooms: [newest, older] });
  assert.deepEqual(titles(), ['Newest', 'Older']);
  assert.equal(page.nodes().filter(n => n.textContent === '连接正常时自动续期').length, 1);
  assert.equal(page.nodes().filter(n => n.textContent === '当前中继不支持自动续期').length, 1);
  const originalDeadline = page.nodes().find(n => n.textContent.startsWith('有效至 ')).textContent;
  page.click('复制邀请');
  newest.expiresAt += 3600000;
  page.receive({ type: 'state', rooms: [newest, older] });
  assert.deepEqual(titles(), ['Newest', 'Older']);
  assert.notEqual(page.nodes().find(n => n.textContent.startsWith('有效至 ')).textContent, originalDeadline);
  page.click('复制邀请');
  assert.deepEqual(page.copies, [newest.inviteUrl, newest.inviteUrl]);
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads'], 'renewal is driven by the host, never the management page');
  page.receive({ type: 'state', rooms: [{ ...room(), state: 'connecting' }] });
  assert.ok(!page.nodes().some(n => /自动续期/.test(n.textContent)), 'unknown capability is not reported as unsupported');
});

test('ended-share acknowledgement and renewal status translate with the management language', () => {
  for (const [language, acknowledgement, renewal] of [
    ['zh-TW', '我知道了', '連線正常時自動續期'],
    ['en', 'Got it', 'Renews automatically while connected'],
  ]) {
    const page = browser({ nativeLanguage: language }), r = room(); r.renewalSupported = true;
    page.receive({ type: 'state', rooms: [r] });
    assert.ok(page.nodes().some(n => n.textContent === renewal));
    r.state = 'revoked'; r.endReason = 'expired'; r.guests = []; r.proposals = [];
    page.receive({ type: 'state', rooms: [r], attention: [{ id: 'stopped', kind: 'share-stopped', roomId: r.roomId, itemId: 'stopped', count: 1 }] });
    page.click(acknowledgement);
    assert.deepEqual(page.sent.at(-1), { type: 'dismiss-room', roomId: r.roomId });
  }
});

test('About shows source metadata without native capabilities, opens fixed links and remembers browser Star dismissal', () => {
  const storage = new Map(), page = browser({ storage }), e = page.elements;
  page.receive({ type: 'state', appInfo: { version: '0.3.3', build: null, channel: 'source', canUpdate: false }, rooms: [] });
  assert.equal(page.window.showCo2About(), true);
  assert.equal(e['panel-about'].hidden, false);
  assert.equal(e['tab-about']['aria-selected'], 'true');
  assert.equal(e['tab-about'].focused, true);
  assert.equal(e['about-version'].textContent, '版本 v0.3.3');
  assert.equal(e['about-channel'].textContent, '源码运行');
  assert.equal(e['check-update'].disabled, true);
  e['check-update'].onclick();
  assert.deepEqual(page.updates, []);
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
  assert.ok(e['about-update-message'].textContent.includes('GitHub'));
  e['about-repository'].onclick(); e['about-releases'].onclick(); e['about-star-link'].onclick();
  assert.deepEqual(page.links, [
    ['https://github.com/SpaceCoder-Kafka/codex-co2', '_blank', 'noopener,noreferrer'],
    ['https://github.com/SpaceCoder-Kafka/codex-co2/releases', '_blank', 'noopener,noreferrer'],
    ['https://github.com/SpaceCoder-Kafka/codex-co2', '_blank', 'noopener,noreferrer'],
  ]);
  e['dismiss-star'].onclick();
  assert.equal(e['about-star'].hidden, true);
  assert.equal(storage.get('co2.starDismissed'), 'true');
  assert.equal(browser({ storage }).elements['about-star'].hidden, true);
  e['tab-settings'].onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(e['panel-about'].hidden, false);
});

test('native About keeps installed and available versions separate and prevents repeated update actions', () => {
  const page = browser({ nativeUpdater: true, appInfo: { version: '0.3.3', build: '13', channel: 'preview', canUpdate: true, starDismissed: false } }), e = page.elements;
  assert.deepEqual(page.updates, [{ action: 'info' }]);
  page.receive({ type: 'state', appInfo: { version: '99.0.0', channel: 'source', canUpdate: false }, rooms: [] });
  assert.equal(e['about-version'].textContent, '版本 v0.3.3 · Build 13');
  assert.equal(e['about-channel'].textContent, '预览版');
  e['check-update'].onclick(); e['check-update'].onclick();
  assert.equal(e['check-update'].disabled, true);
  assert.equal(e['check-update']['aria-busy'], 'true');
  assert.deepEqual(page.updates.at(-1), { action: 'check' });
  assert.equal(page.updates.filter(m => m.action === 'check').length, 1);
  page.window.receiveCo2UpdateState({ phase: 'available', version: '0.3.3', build: '14', lastChecked: '2026-10-23T02:00:00Z' });
  assert.equal(e['nav-update'].hidden, false);
  assert.equal(e['check-update'].disabled, false);
  assert.equal(e['check-update-label'].textContent, '更新到 v0.3.3 · Build 14');
  assert.ok(e['about-update-message'].textContent.includes('Build 14'));
  assert.equal(e['about-version'].textContent, '版本 v0.3.3 · Build 13');
  assert.ok(e['about-last-check'].textContent.startsWith('上次检查：'));
  page.receive({ type: 'state', rooms: [] });
  assert.equal(e['check-update-label'].textContent, '更新到 v0.3.3 · Build 14');
  assert.equal(e['about-version'].textContent, '版本 v0.3.3 · Build 13');
  e['check-update'].onclick(); e['check-update'].onclick();
  assert.equal(page.updates.filter(m => m.action === 'install').length, 1);
  page.window.receiveCo2UpdateState({ phase: 'downloading', version: '0.3.3', build: '14', progress: 0.5 });
  assert.equal(e['about-update-progress'].hidden, false);
  assert.equal(e['about-update-progress'].value, 0.5);
  assert.equal(e['about-update-progress']['aria-valuetext'], '50%');
  assert.ok(e['about-update-message'].textContent.endsWith('50%'));
  assert.equal(e['cancel-update'].hidden, false);
  e['cancel-update'].onclick(); e['cancel-update'].onclick();
  assert.equal(page.updates.filter(m => m.action === 'cancel').length, 1);
  page.window.receiveCo2UpdateState({ phase: 'idle', message: '更新已取消' });
  assert.equal(e['about-update-progress'].hidden, true);
  assert.equal(e['about-update-message'].textContent, '更新已取消');
  assert.equal(e['check-update'].disabled, false);
  assert.deepEqual(page.sent.map(m => m.type), ['auth', 'threads']);
});

test('native updater stays usable after helper disconnect and redraws state in all interface languages', () => {
  const page = browser({ nativeUpdater: true, appInfo: { version: '0.3.3', build: '13', channel: 'preview', canUpdate: true } }), e = page.elements;
  page.socket.close();
  assert.equal(e['check-update'].disabled, false);
  e['check-update'].onclick();
  page.window.receiveCo2UpdateState({ phase: 'error', message: '更新下载或验证失败，请重试。' });
  page.window.showCo2About();
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['page-title'].textContent, 'About');
  assert.equal(e['about-channel'].textContent, 'Preview');
  assert.equal(e['about-update-message'].textContent, 'The update could not be downloaded or verified. Try again.');
  assert.equal(e['check-update'].disabled, false);
  page.window.receiveCo2UpdateState({ phase: 'upToDate', lastChecked: 1792720800000 });
  assert.equal(e['about-update-message'].textContent, "You're up to date.");
  assert.equal(e['nav-update'].hidden, true);
  e.language.value = 'zh-TW'; e.language.onchange();
  assert.equal(e['about-channel'].textContent, '預覽版');
  assert.equal(e['about-update-message'].textContent, '目前已是最新版本。');
  e['about-repository'].onclick();
  assert.deepEqual(page.updates.at(-1), { action: 'openLink', link: 'repository' });
  assert.equal(page.links.length, 0);
  page.window.receiveCo2UpdateState({ phase: 'not-an-updater-phase', message: 'invalid' });
  assert.equal(e['about-update-message'].textContent, '目前已是最新版本。');
});

test('native Star preference overrides browser storage and dismissal uses the native preference bridge', () => {
  const storage = new Map([['co2.starDismissed', 'true']]);
  const page = browser({ nativeUpdater: true, storage, appInfo: { version: '0.3.3', build: '13', channel: 'preview', canUpdate: false, starDismissed: false } }), e = page.elements;
  assert.equal(e['about-star'].hidden, false);
  assert.equal(e['check-update'].disabled, true);
  e['dismiss-star'].onclick();
  assert.deepEqual(page.updates.at(-1), { action: 'dismissStar' });
  assert.equal(e['about-star'].hidden, true);
  page.window.receiveCo2AppInfo({ version: '0.3.3', build: '13', channel: 'preview', canUpdate: true, starDismissed: true });
  assert.equal(e['about-star'].hidden, true);
  assert.equal(e['check-update'].disabled, false);
});

test('About updates and intranet lifetime UI both redraw, while disconnect cancels the invitation without disabling native updates', () => {
  const page = lifetimePage({ nativeUpdater: true,
    appInfo: { version: '0.3.3', build: '17', channel: 'preview', canUpdate: true, starDismissed: false } }), e = page.elements;
  e.share.focus(); e.share.onclick(); chooseLifetime(page, 'permanent');
  page.window.receiveCo2UpdateState({ phase: 'available', version: '0.3.3', build: '18' });
  e.language.value = 'en'; e.language.onchange();
  assert.equal(e['invite-lifetime-dialog'].open, true);
  assert.equal(selectedLifetime(page), 'permanent');
  assert.equal(e['invite-lifetime-hint'].textContent, messages.en['不设固定到期时间，需保持应用和共享运行；停止共享、退出应用或更换入口后失效。']);
  assert.equal(e['check-update-label'].textContent, 'Update to v0.3.3 · Build 18');
  assert.equal(e['about-version'].textContent, 'Version v0.3.3 · Build 17');
  page.socket.close();
  assert.equal(e['invite-lifetime-dialog'].open, false);
  assert.equal(e['invite-lifetime-confirm'].disabled, true);
  assert.equal(e['intranet-only'].disabled, true);
  assert.equal(e['save-network'].disabled, true);
  assert.equal(e['check-update'].disabled, false);
  e['check-update'].onclick();
  assert.deepEqual(page.updates.at(-1), { action: 'install' });
  assert.equal(page.sent.some(m => ['share', 'reshare'].includes(m.type)), false);
});
