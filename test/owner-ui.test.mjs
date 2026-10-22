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
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  select() { this.selected = true; }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
}
function browser({ storage = new Map(), nativeLanguage } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => {
    const node = new Element(m[1]); node.id = m[2];
    for (const attr of m[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    node.hidden = /\shidden[\s>]/.test(m[0]);
    return [m[2], node];
  }));
  elements.rooms.append(new Element());
  const connection = new Element(), sent = [], copies = [], preferences = [];
  let socket, redacted;
  class Socket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 0; }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const descendants = e => [e, ...e.children.flatMap(descendants)];
  const window = { Co2Messages: messages, co2Language: nativeLanguage, innerWidth: 1024, innerHeight: 768, addEventListener() {}, webkit: { messageHandlers: {
    copyInvite: { postMessage: value => copies.push(value) }, languagePreference: { postMessage: value => preferences.push(value) },
  } } };
  vm.runInNewContext(languageScript + '\n' + script, {
    document: {
      documentElement: new Element('html'),
      querySelector: s => s === '.connection' ? connection : elements[s.slice(1)],
      querySelectorAll: () => Object.values(elements).flatMap(descendants).filter(e => e.tag === 'button'),
      createElement: tag => new Element(tag),
      addEventListener() {},
    },
    WebSocket: Socket, URLSearchParams, location: { hash: '#owner=synthetic-only', pathname: '/' },
    history: { replaceState(_state, _title, url) { redacted = url; } },
    window, navigator: {}, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  socket.readyState = 1; socket.onopen();
  assert.equal(redacted, '/');
  const receive = m => socket.onmessage({ data: JSON.stringify(m) });
  const nodes = () => [...descendants(elements.rooms), ...descendants(elements['room-policies'])];
  const click = text => { const b = nodes().find(e => e.tag === 'button' && e.textContent === text); assert.ok(b, `Missing ${text}`); b.onclick(); };
  const threadRows = () => descendants(elements.threads).filter(e => e.className === 'thread-row');
  return { elements, socket, sent, copies, preferences, receive, nodes, click, threadRows, window };
}
const room = () => ({ roomId: 'room-1', title: '<script>synthetic title</script>', ownerName: 'A', state: 'online',
  expiresAt: Date.now() + 3600000, inviteUrl: 'https://example.invalid/#invite=synthetic',
  guests: [{ id: 'guest-1', name: '<img onerror=synthetic>', status: 'pending' }],
  proposals: [{ id: 'proposal-1', name: 'B', status: 'pending', text: '<script>synthetic proposal</script>' }], approvalPending: false });

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
  const page = browser(), saved = { threadId: 'old-thread', title: '<script>Saved title</script>', requireApproval: true,
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
