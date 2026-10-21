import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageAuthors } from '../lib/message-authors.mjs';
import { displayName } from '../lib/display-name.mjs';
import { SharedRoom, secret } from '../lib/host.mjs';

const guest = { id: 'room-local-guest-1', name: '小林', kind: 'guest' };
const user = (id, text) => ({ id, role: 'user', text });
function fixture() {
  const authors = new MessageAuthors('阿明');
  const items = [user('history', '旧历史')];
  const turns = new Map([['history', 'old']]);
  authors.observe(items, turns);
  return { authors, items, add(id, text, turn = 'busy', live = true) {
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
