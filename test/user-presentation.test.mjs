import test from 'node:test';
import assert from 'node:assert/strict';
import { userPresentation, safeUserPresentation, userMessageMetadata, delegatedUserIntent } from '../lib/user-presentation.mjs';

const envelope = value => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
test('complete native question reply envelopes expose only question summaries and answers', () => {
  const reply = { questionItemId: '["request_user_input_async","private-call",0]', question: '在哪儿验收？', answer: '本机浏览器', callId: 'private-call' };
  const expected = { text: '本机浏览器', presentation: { kind: 'question_reply', replies: [{ question: reply.question, answer: reply.answer }] } };
  assert.deepEqual(userPresentation(envelope([reply])), expected);
  assert.deepEqual(userPresentation(envelope(reply)), expected);
  assert.ok(!JSON.stringify(expected).includes('private-call'));
  for (const text of [`示例：\n${envelope(reply)}`, `\`\`\`xml\n${envelope(reply)}\n\`\`\``, `> ${envelope(reply)}`, envelope({ ...reply, answer: 1 }), envelope([])]) {
    assert.deepEqual(userPresentation(text), { text }, 'ordinary examples and malformed envelopes remain literal');
  }
  assert.deepEqual(safeUserPresentation({ ...expected.presentation, callId: 'private' }), expected.presentation);
});

test('only the complete plan execution request becomes a user confirmation with native plan preference', () => {
  const text = 'PLEASE IMPLEMENT THIS PLAN:\n# 请求计划\n\n- 实现';
  assert.deepEqual(userPresentation(text), { text: '是的，执行此计划', presentation: { kind: 'plan_execution', plan: '# 请求计划\n\n- 实现' } });
  assert.equal(userPresentation(text, '# 原生计划').presentation.plan, '# 原生计划');
  for (const ordinary of ['实现 ' + text, '```text\n' + text + '\n```', 'PLEASE IMPLEMENT THIS PLAN:', 'PLEASE IMPLEMENT THIS PLAN: inline example']) {
    assert.deepEqual(userPresentation(ordinary), { text: ordinary });
  }
  assert.deepEqual(userPresentation('normal text', '# native'), { text: 'normal text' });
});

test('native message timestamps and ChatGPT source are an explicit display whitelist', () => {
  assert.deepEqual(userMessageMetadata({ restoreMessage: { createdAt: 1793660000123, context: { token: 'private' } },
    clientUserMessageId: 'chatgpt-messaging:private-chat:private-message', sender: { name: 'private' } }),
  { createdAt: 1793660000123, source: { kind: 'chatgpt' } });
  for (const createdAt of [0, -1, NaN, Infinity, '2026-11-03', 8.65e15]) assert.deepEqual(userMessageMetadata({ createdAt }), {});
  assert.deepEqual(userMessageMetadata({ source: { kind: 'unsupported', title: 'private' } }), {});
  assert.deepEqual(userMessageMetadata({ messageMetadata: { aeon: { version: 1, sourceChannel: 'chatgpt', sourceId: 'private-source', threadId: 'private-chat' } } }), { source: { kind: 'chatgpt' } });
  assert.deepEqual(userMessageMetadata({ messageMetadata: { aeon: { version: 2, sourceChannel: 'chatgpt' } } }), {});
});

test('only exact native delegation deliveries yield current-chat user intent without origin context', () => {
  const raw = { id: 'delivered', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
    output: '<codex_delegation><source_thread_id>private-source-thread</source_thread_id><input>审查当前改动 &lt;tag&gt; &amp; 文本</input></codex_delegation>',
    arguments: { privateToken: 'private-token' }, result: { sourceContext: 'private-context' } };
  assert.deepEqual(delegatedUserIntent(raw), { text: '审查当前改动 <tag> & 文本', source: { kind: 'cross_chat' } });
  const nested = { ...raw, output: '<codex_delegation><source_thread_id>private-thread</source_thread_id><input><codex_delegation_content version="1"><source_orbit_id>private-orbit</source_orbit_id><task>当前任务 &lt;步骤&gt;</task></codex_delegation_content></input></codex_delegation>',
    messageMetadata: { aeon: { version: 1, sourceChannel: 'chatgpt', sourceId: 'private-source', threadId: 'private-chat' } } };
  assert.deepEqual(delegatedUserIntent(nested), { text: '当前任务 <步骤>', source: { kind: 'chatgpt' } });
  assert.ok(!JSON.stringify(delegatedUserIntent(nested)).includes('private-'));
  for (const name of ['create_thread', 'handoff_thread']) assert.ok(delegatedUserIntent({ ...raw, name }));
  assert.ok(delegatedUserIntent({ ...raw, namespace: 'cloud_threads', name: 'send_message' }));
  for (const invalid of [{ ...raw, namespace: 'other' }, { ...raw, name: 'automation_update' }, { ...raw, type: 'mcpToolCall' },
    { ...raw, output: '```xml\n' + raw.output + '\n```' }, { ...raw, output: raw.output.slice(0, -10) },
    { ...raw, output: 'example:\n' + raw.output }, { ...raw, output: raw.output.replace('</input>', '<context>private</context></input>') },
    { ...nested, output: nested.output.replace('<input>', '<source_orbit_id>other</source_orbit_id><input>') }]) {
    assert.equal(delegatedUserIntent(invalid), null);
  }
});
