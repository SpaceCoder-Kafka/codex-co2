import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageAuthors } from '../lib/message-authors.mjs';
import { displayName } from '../lib/display-name.mjs';
import { createHash } from 'node:crypto';
import { NATIVE_INPUT_DIGEST, NATIVE_INPUT_ID } from '../lib/user-presentation.mjs';
import { SharedRoom, secret } from '../lib/host.mjs';

const guest = { id: 'room-local-guest-1', name: '小林', kind: 'guest' };
const user = (id, text) => ({ id, role: 'user', text });
const native = (id, text, original = text, inputId) => ({ ...user(id, text), [NATIVE_INPUT_DIGEST]: createHash('sha256').update(original).digest('hex'),
  ...(inputId ? { [NATIVE_INPUT_ID]: inputId } : {}) });
function fixture() {
  const authors = new MessageAuthors('阿明');
  const items = [user('history', '旧历史')];
  const turns = new Map([['history', 'old']]);
  authors.observe(items, turns);
  return { authors, items, turns, add(id, text, turn = 'busy', live = true) {
    const item = user(id, text); items.push(item); turns.set(id, turn); authors.observe(items, turns, live ? id : null); return item;
  }, author(id) { return authors.decorate(items).find(i => i.id === id).author; } };
}

test('display names count Unicode code points consistently and reject controls before trimming', () => {
  assert.equal(displayName(` ${'😀'.repeat(40)} `), '😀'.repeat(40));
  for (const name of ['', ' ', '😀'.repeat(41), '\n张三', '张\u0085三', null]) assert.equal(displayName(name), null);
  assert.equal(displayName(' 小林 '), '小林');
});

test('initial history is unknown; live Desktop input gets owner name; late history is not invented as Desktop input', () => {
  const f = fixture();
  assert.equal(f.author('history').name, '历史消息 · 作者未知');
  f.add('desktop', '来自 Desktop');
  assert.equal(f.author('desktop').name, '阿明');
  assert.equal(f.author('desktop').kind, 'host');
  f.add('late-history', '补读到的历史', 'old', false);
  assert.equal(f.author('late-history').kind, 'unknown');
});

test('event before RPC response stays pending, then resolves exact text and turn, preserving other user attribution', () => {
  const f = fixture();
  const record = f.authors.begin('request-1', '建议正文', guest);
  f.add('suggestion', '建议正文');
  f.add('desktop', '来自 Desktop');
  assert.equal(f.author('suggestion').name, '作者待确认');
  f.authors.complete(record, { id: 'busy' });
  assert.deepEqual(f.author('suggestion'), guest);
  assert.equal(f.author('desktop').kind, 'host');
  // Refreshes retain the exact same item-based author, regardless of admission.
  f.authors.observe(f.items, new Map(f.items.map(i => [i.id, i.id === 'history' ? 'old' : 'busy'])));
  assert.deepEqual(f.author('suggestion'), guest);
});

test('response before event and history-only recovery both resolve the approved author', () => {
  const f = fixture();
  const record = f.authors.begin('request-1', '建议正文', guest);
  f.authors.complete(record, { id: 'busy' });
  f.add('suggestion', '建议正文', 'busy', false);
  assert.deepEqual(f.author('suggestion'), guest);
  f.add('foreign-turn', '建议正文', 'other');
  assert.equal(f.author('foreign-turn').kind, 'host');
});

test('busy turn may have owner and multiple same-name guests without a turn-wide author', () => {
  const f = fixture();
  f.add('owner', '分享者的输入');
  const a = f.authors.begin('a', '第一个建议', guest);
  f.add('guest-a', '第一个建议');
  f.authors.complete(a, { id: 'busy' });
  const other = { ...guest, id: 'room-local-guest-2' };
  const b = f.authors.begin('b', '第二个建议', other);
  f.authors.complete(b, { id: 'busy' });
  f.add('guest-b', '第二个建议');
  assert.equal(f.author('owner').kind, 'host');
  assert.deepEqual(f.author('guest-a'), guest);
  assert.deepEqual(f.author('guest-b'), other);
});

test('identical messages cannot be assigned by text alone and later ambiguity removes a provisional attribution', () => {
  const f = fixture();
  const record = f.authors.begin('request-1', '相同正文', guest);
  f.add('candidate-a', '相同正文');
  f.authors.complete(record, { id: 'busy' });
  assert.deepEqual(f.author('candidate-a'), guest);
  f.add('candidate-b', '相同正文');
  assert.equal(f.author('candidate-a').name, '作者待确认');
  assert.equal(f.author('candidate-b').kind, 'unknown');
});

test('two concurrent same-text submissions stay unknown; response item IDs can disambiguate', () => {
  const f = fixture();
  const a = f.authors.begin('a', '相同正文', guest);
  const b = f.authors.begin('b', '相同正文', { ...guest, id: 'guest-2' });
  f.add('candidate-a', '相同正文'); f.add('candidate-b', '相同正文');
  f.authors.complete(a, { id: 'busy' }); f.authors.complete(b, { id: 'busy' });
  assert.equal(f.author('candidate-a').kind, 'unknown');
  assert.equal(f.author('candidate-b').kind, 'unknown');
  const raw = id => ({ id, type: 'userMessage', content: [{ type: 'text', text: '相同正文' }] });
  f.authors.complete(a, { id: 'busy', items: [raw('candidate-a')] });
  f.authors.complete(b, { id: 'busy', items: [raw('candidate-b')] });
  assert.deepEqual(f.author('candidate-a'), guest);
  assert.equal(f.author('candidate-b').id, 'guest-2');
});

test('pre-dispatch items cannot be claimed; uncertain results never turn matching inputs into owner messages', () => {
  const f = fixture();
  f.add('owner', '重复正文');
  const record = f.authors.begin('a', '重复正文', guest);
  f.add('uncertain', '重复正文'); f.authors.uncertain(record);
  assert.equal(f.author('owner').kind, 'host');
  assert.equal(f.author('uncertain').name, '作者待确认');
  f.authors.clear();
  assert.equal(f.authors.entries.size, 0); assert.equal(f.authors.submissions.size, 0);
});

test('local owner name validates before room creation; legacy callers keep the default', () => {
  const options = { relayUrl: 'http://127.0.0.1:1234', registrationSecret: secret(), threadId: 'synthetic' };
  assert.equal(new SharedRoom(options).ownerName, '分享者');
  assert.equal(new SharedRoom({ ...options, ownerName: ' 阿明 ' }).ownerName, '阿明');
  for (const ownerName of ['', 'x'.repeat(41), '\n坏名字']) assert.throws(() => new SharedRoom({ ...options, ownerName }), /显示名称/);
});

test('unmatched input during an unresolved dispatch is not falsely attributed to Desktop', () => {
  const f = fixture();
  const record = f.authors.begin('request', '原始建议', guest);
  f.authors.complete(record, { id: 'busy' });
  f.add('transformed', '后端改写后的内容');
  assert.equal(f.author('transformed').name, '作者待确认');
  f.add('actual-guest', '原始建议');
  assert.equal(f.author('actual-guest').name, '小林');
  assert.equal(f.author('transformed').kind, 'host');
});

test('a late live event confirms only its own message and cannot relabel unrelated history', () => {
  const f = fixture();
  f.add('loaded-a', '首次在刷新中出现', 'busy', false);
  f.add('loaded-b', '另一条补读内容', 'old', false);
  f.authors.observe(f.items, new Map([['history','old'],['loaded-a','busy'],['loaded-b','old']]), 'loaded-a');
  assert.equal(f.author('loaded-a').kind, 'host');
  assert.equal(f.author('loaded-b').kind, 'unknown');
  assert.equal(f.author('history').kind, 'unknown');
});

test('private checkpoints recover known authors without storing text or inventing authors for old and late history', () => {
  const f = fixture();
  f.add('owner', '来自 Desktop 的私有正文');
  const record = f.authors.begin('request', '访客的私有正文', guest);
  f.add('guest', '访客的私有正文');
  f.authors.complete(record, { id: 'busy', clientUserMessageId: 'guest' });
  const checkpoint = JSON.parse(JSON.stringify(f.authors.checkpoint()));
  assert.ok(!JSON.stringify(checkpoint).includes('私有正文'));
  f.authors.clear();
  const restored = new MessageAuthors('新分享者名称', { evidence: checkpoint });
  const items = [...f.items, user('late', '只在重新分享后读到的正文')];
  const turns = new Map(items.map(i => [i.id, ['history', 'late'].includes(i.id) ? 'old' : 'busy']));
  restored.observe(items, turns);
  const names = Object.fromEntries(restored.decorate(items).map(i => [i.id, i.author.name]));
  assert.deepEqual(names, { history: '历史消息 · 作者未知', owner: '阿明', guest: '小林', late: '历史消息 · 作者未知' });
  items.push(user('new-owner', '重新分享后的输入')); turns.set('new-owner', 'next');
  restored.observe(items, turns, 'new-owner');
  assert.equal(restored.decorate(items).at(-1).author.name, '新分享者名称');
});

test('recovered correlations still revoke ambiguous text matches, while exact response IDs disambiguate', () => {
  for (const exact of [false, true]) {
    const f = fixture(), record = f.authors.begin('request', '相同正文', guest);
    f.add('first', '相同正文');
    f.authors.complete(record, { id: 'busy', ...(exact ? { clientUserMessageId: 'first' } : {}) });
    const restored = new MessageAuthors('阿明', { evidence: f.authors.checkpoint() });
    const items = [...f.items, user('duplicate', '相同正文')];
    restored.observe(items, new Map(items.map(i => [i.id, i.id === 'history' ? 'old' : 'busy'])));
    const first = restored.decorate(items).find(i => i.id === 'first');
    assert.equal(first.author.kind, exact ? 'guest' : 'unknown');
    assert.equal(restored.decorate(items).at(-1).author.kind, 'unknown');
  }
});

test('recovery handles acceptance before the item arrives and keeps uncertain submissions unknown', () => {
  for (const accepted of [true, false]) {
    const f = fixture(), record = f.authors.begin('request', '未及时读到的正文', guest);
    if (accepted) f.authors.complete(record, { id: 'busy', clientUserMessageId: 'delayed' });
    else f.authors.uncertain(record);
    const restored = new MessageAuthors('阿明', { evidence: f.authors.checkpoint() });
    const items = [...f.items, user('delayed', '未及时读到的正文')];
    restored.observe(items, new Map([['history', 'old'], ['delayed', 'busy']]));
    assert.equal(restored.decorate(items).at(-1).author.kind, accepted ? 'guest' : 'unknown');
  }
});

test('a reused item ID with changed text or turn cannot inherit a persisted author', () => {
  const f = fixture(); f.add('owner', '旧正文');
  for (const [text, turn] of [['新正文', 'busy'], ['旧正文', 'other-turn']]) {
    const restored = new MessageAuthors('阿明', { evidence: f.authors.checkpoint() });
    const items = [user('owner', text)]; restored.observe(items, new Map([['owner', turn]]));
    assert.equal(restored.decorate(items)[0].author.kind, 'unknown');
  }
});

test('a live input keeps its author when its display-only local turn becomes a native turn', () => {
  for (const guestInput of [false, true]) {
    const f = fixture(), local = 'co2:local-turn:' + 'a'.repeat(64);
    const record = guestInput && f.authors.begin('request', '新输入', guest);
    f.add('client-input', '新输入', local);
    f.authors.observe(f.items, new Map([['history', 'old'], ['client-input', 'native-turn']]));
    if (record) f.authors.complete(record, { id: 'native-turn', clientUserMessageId: 'client-input' });
    assert.equal(f.author('client-input').kind, guestInput ? 'guest' : 'host');
    const restored = new MessageAuthors('新名称', { evidence: f.authors.checkpoint() });
    assert.equal(restored.decorate(f.items).at(-1).author.kind, guestInput ? 'guest' : 'host');
  }
});

test('an accepted exact native ID recovers a post-dispatch input previously marked historical', () => {
  const f = fixture(), record = f.authors.begin('request', '新输入', guest);
  f.add('client-input', '新输入', 'temporary-turn');
  // This models the old checkpoint after a local-to-native turn transition.
  f.authors.observe(f.items, new Map([['history', 'old'], ['client-input', 'native-turn']]));
  f.authors.complete(record, { id: 'native-turn', clientUserMessageId: 'client-input' });
  const saved = f.authors.checkpoint();
  const restored = new MessageAuthors('阿明', { evidence: saved });
  assert.deepEqual(restored.decorate(f.items).at(-1).author, guest);
  for (const mutation of [
    r => { r.status = 'unknown'; },
    r => { r.responseIds = null; },
    r => { r.responseIds = ['different-input']; },
    r => { r.turnId = 'different-turn'; },
    r => { r.before = saved.sequence; },
    r => { r.digest = '0'.repeat(64); },
  ]) {
    const invalid = structuredClone(saved); mutation(invalid.submissions[0][1]);
    assert.equal(new MessageAuthors('阿明', { evidence: invalid }).decorate(f.items).at(-1).author.kind, 'unknown');
  }
});

test('legacy pending/unknown submissions cannot taint different original Desktop input across recovery', () => {
  for (const status of ['pending', 'unknown']) {
    const f = fixture(), record = f.authors.begin('old-request', '旧访客输入', guest);
    if (status === 'unknown') f.authors.uncertain(record);
    f.add('old-guest', '旧访客输入', 'old-guest-turn');
    const restored = new MessageAuthors('阿明', { evidence: f.authors.checkpoint() });
    const items = [...f.items, native('owner', '分享者的新输入')];
    const turns = new Map([...f.items.map(i => [i.id, i.id === 'history' ? 'old' : 'old-guest-turn']), ['owner', 'new-turn']]);
    restored.observe(items, turns, 'owner');
    assert.equal(restored.decorate(items).at(-1).author.kind, 'host');
    assert.equal(restored.decorate(items).find(i => i.id === 'old-guest').author.kind, 'unknown');
    const saved = restored.checkpoint();
    assert.ok(!JSON.stringify(saved).includes('分享者的新输入'));
    const reopened = new MessageAuthors('重启后', { evidence: saved });
    assert.equal(reopened.decorate(items).at(-1).author.kind, 'host');
  }
});

test('native original-input evidence excludes only different input; display text is not an origin proof', () => {
  const f = fixture(); f.authors.begin('old-request', '原始访客输入', guest);
  for (const item of [
    native('transformed', '展示层改写', '原始访客输入'),
    native('same-text', '原始访客输入'),
    user('no-proof', '其他后端改写后的输入'),
  ]) {
    f.items.push(item); f.turns.set(item.id, 'new-turn'); f.authors.observe(f.items, f.turns, item.id);
    assert.equal(f.author(item.id).kind, 'unknown');
  }
  const item = native('confirmed-other-input', '展示层改写', '主端输入');
  f.items.push(item); f.turns.set(item.id, 'new-turn'); f.authors.observe(f.items, f.turns, item.id);
  assert.equal(f.author(item.id).kind, 'host');
});

test('pre-dispatch native message IDs bound uncertain submissions even for identical text and late echoes', () => {
  for (const status of ['pending', 'unknown']) {
    const f = fixture(), record = f.authors.begin('request', '相同正文', guest, { clientUserMessageId: 'native-guest-id' });
    if (status === 'unknown') f.authors.uncertain(record);
    const restored = new MessageAuthors('阿明', { evidence: f.authors.checkpoint() });
    const items = [...f.items, native('owner', '相同正文', '相同正文', 'native-owner-id')];
    const turns = new Map([['history', 'old'], ['owner', 'busy']]);
    restored.observe(items, turns, 'owner');
    assert.equal(restored.decorate(items).at(-1).author.kind, 'host');
    items.push(native('native-guest-id', '相同正文', '相同正文', 'native-guest-id')); turns.set('native-guest-id', 'busy');
    restored.observe(items, turns, 'native-guest-id');
    assert.equal(restored.decorate(items).at(-1).author.kind, 'unknown');
    assert.equal(restored.decorate(items).find(i => i.id === 'owner').author.kind, 'host');
  }
});

test('changed native original input cannot inherit a host claim under unchanged display text', () => {
  const f = fixture(), item = native('owner', '简短展示', '原始输入');
  f.items.push(item); f.turns.set(item.id, 'busy'); f.authors.observe(f.items, f.turns, item.id);
  assert.equal(f.author(item.id).kind, 'host');
  item[NATIVE_INPUT_DIGEST] = native('x', 'x', '另一份输入')[NATIVE_INPUT_DIGEST];
  f.authors.observe(f.items, f.turns);
  assert.equal(f.author(item.id).kind, 'unknown');
});

test('a server display ID without native input identity cannot exclude a lost guest dispatch', () => {
  const f = fixture(), record = f.authors.begin('request', '访客输入', guest, { clientUserMessageId: 'client-id' });
  f.authors.uncertain(record);
  f.add('server-id-with-no-client-correlation', '访客输入');
  assert.equal(f.author('server-id-with-no-client-correlation').kind, 'unknown');
  const item = native('native-steering-display-id', '访客输入', '访客输入', 'client-id');
  f.items.push(item); f.turns.set(item.id, 'busy'); f.authors.observe(f.items, f.turns, item.id);
  assert.equal(f.author(item.id).kind, 'unknown');
  f.authors.complete(record, { id: 'busy', clientUserMessageId: 'client-id' });
  assert.deepEqual(f.author(item.id), guest);
});

test('private original-input metadata is validated on recovery and identity replacement clears host evidence', () => {
  const f = fixture(), item = native('owner', '原文', '原文', 'input-one');
  f.items.push(item); f.turns.set(item.id, 'busy'); f.authors.observe(f.items, f.turns, item.id);
  const saved = f.authors.checkpoint();
  for (const field of ['inputId', 'inputDigest']) {
    const invalid = structuredClone(saved); invalid.entries.at(-1)[1][field] = '';
    assert.throws(() => new MessageAuthors('host', { evidence: invalid }), /格式不兼容/);
  }
  const invalid = structuredClone(saved); invalid.submissions.push(['request', { before: 0, digest: item[NATIVE_INPUT_DIGEST],
    author: guest, status: 'unknown', turnId: null, responseIds: null, clientUserMessageId: '' }]);
  assert.throws(() => new MessageAuthors('host', { evidence: invalid }), /格式不兼容/);
  item[NATIVE_INPUT_ID] = 'input-two'; f.authors.observe(f.items, f.turns);
  assert.equal(f.author(item.id).kind, 'unknown');
});

test('refresh can repair an existing live host checkpoint blocked by legacy pending without relabeling history', () => {
  const f = fixture(); f.authors.begin('old', '旧访客输入', guest);
  f.add('blocked-owner', '主端的新问题', 'new-turn');
  assert.equal(f.author('blocked-owner').kind, 'unknown');
  const restored = new MessageAuthors('重开后', { evidence: f.authors.checkpoint() });
  const items = f.items.map(i => i.id === 'blocked-owner' ? native(i.id, i.text, i.text, 'owner-client') : i);
  restored.observe(items, f.turns);
  assert.equal(restored.decorate(items).at(-1).author.name, '阿明');
  assert.equal(restored.decorate(items)[0].author.kind, 'unknown');
  assert.equal(restored.checkpoint().submissions[0][1].status, 'pending');
});
