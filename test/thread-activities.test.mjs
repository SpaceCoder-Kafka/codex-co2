import test from 'node:test';
import assert from 'node:assert/strict';
import { activityItem, activityDetail, projectActivity, turnDiffActivity, aggregateTurnActivities, MAX_ACTIVITY_DETAIL_BYTES } from '../lib/thread-activities.mjs';
import { projectDesktopThread } from '../lib/desktop-ipc.mjs';

const key = 'synthetic-room-key', detail = item => JSON.parse(activityDetail(item).bytes);
const sample = (type, fields = {}) => ({ id: `synthetic-${type}`, type, ...fields });

test('command cards expose bounded display data, never execution or approval capabilities', () => {
  const raw = sample('commandExecution', { command: 'node synthetic-check.mjs', cwd: '/synthetic/project', status: 'completed',
    aggregatedOutput: '<script>literal output</script>', exitCode: 0, durationMs: 45,
    processId: 'private-process', terminalId: 'private-terminal', arguments: 'private-args',
    requests: [{ method: 'execCommandApproval', id: 'private-request' }] });
  const item = activityItem(raw, key);
  assert.deepEqual(Object.keys(item), ['id', 'role', 'kind', 'status', 'text', 'detailId']);
  assert.equal(item.kind, 'command'); assert.equal(item.status, 'completed');
  assert.deepEqual(detail(item), { kind: 'command', title: raw.command, status: 'completed', text: raw.aggregatedOutput, durationMs: 45, exitCode: 0 });
  assert.ok(!JSON.stringify(projectActivity(raw)).includes('private-'));
  assert.ok(!JSON.stringify(projectActivity(raw)).includes('cwd'));
  const copy = activityDetail(item); copy.bytes.fill(0);
  assert.equal(detail(item).title, raw.command, 'read callers cannot overwrite the authorized detail');
});

test('tool cards extract recognized text only and discard app context, raw arguments and nested metadata', () => {
  const raw = sample('mcpToolCall', { server: 'synthetic', tool: 'report', status: 'completed', durationMs: 12,
    arguments: { token: 'private-argument' }, appContext: { resourceUri: 'private-resource' }, mcpAppUi: { resourceUri: 'private-ui' },
    result: { content: [{ type: 'text', text: 'visible result' }, { type: 'image', data: 'private-image' },
      { type: 'resource', resource: { text: 'private-resource-text' } }],
      _meta: { accessToken: 'private-token' }, structuredContent: { password: 'private-password' } } });
  const item = activityItem(raw, key);
  assert.equal(detail(item).text, 'visible result');
  assert.ok(!JSON.stringify(projectActivity(raw)).includes('private-'));
  assert.ok(!activityDetail(item).bytes.toString().includes('private-'));
  assert.equal(detail(activityItem(sample('mcpToolCall', { tool: 'bad', status: 'completed', result: { isError: true, content: [] },
    error: { message: 'visible error', stack: 'private-stack' } }), key)).status, 'failed');
  const dynamic = activityItem(sample('dynamicToolCall', { tool: 'inspect', namespace: 'fixture', status: 'completed', success: false,
    contentItems: [{ type: 'inputText', text: 'dynamic text' }, { type: 'output_text', text: 'second text' },
      { type: 'text', text: 99 }, { type: 'private', text: 'private-content' }] }), key);
  assert.equal(detail(dynamic).text, 'dynamic text\nsecond text'); assert.equal(dynamic.status, 'failed');
  const output = activityItem(sample('functionCallOutput', { name: 'fixture', namespace: 'test', output: 'standalone text' }), key);
  assert.equal(detail(output).text, 'standalone text');
  assert.equal(detail(activityItem({ ...raw, result: { unknown: 'private-object' } }, key)).text, '');
});

test('Diff and structured/text plans retain only display fields and normalize step status', () => {
  const diff = activityItem(sample('fileChange', { status: 'completed', changes: [
    { path: '/synthetic/code.mjs', kind: { type: 'update', move_path: '/synthetic/new.mjs', grant: 'private-grant' }, diff: '-old\n+new', credential: 'private-field' },
    { path: '/synthetic/unknown.mjs', kind: { type: 'unrecognized' }, diff: 'ignored' },
  ] }), key);
  assert.deepEqual(detail(diff).files, [{ path: '/synthetic/code.mjs', kind: 'update', diff: '-old\n+new' }]);
  const plan = activityItem(sample('todo-list', { explanation: 'display explanation', plan: [
    { step: 'Read', status: 'completed', secret: 'private-step' }, { step: 'Verify', status: 'in_progress' },
    { step: 'Finish', status: 'invented-status' },
  ] }), key);
  assert.equal(plan.status, 'running');
  assert.deepEqual(detail(plan).steps.map(step => step.status), ['completed', 'running', 'pending']);
  assert.equal(detail(activityItem(sample('plan', { text: '# Proposed plan\n\n- Synthetic change' }), key)).text, '# Proposed plan\n\n- Synthetic change');
  assert.ok(!activityDetail(plan).bytes.toString().includes('private-step'));
});

test('unknown and malformed activity variants never gain detail scope', () => {
  for (const raw of [null, {}, sample('reasoning', { text: 'private-reasoning' }), sample('collabToolCall', { receiverThreadId: 'private-child' }),
    sample('unknown'), sample('commandExecution', { aggregatedOutput: 'orphan' }), sample('fileChange'), sample('mcpToolCall'),
    sample('dynamicToolCall'), sample('functionCallOutput'), sample('todo-list'), sample('plan', { text: {} })]) {
    assert.equal(projectActivity(raw), null); assert.equal(activityItem(raw, key), null);
  }
  assert.throws(() => activityDetail({ detailId: 'a'.repeat(64) }), /Unavailable/);
});

test('details and escaped output stay below one MiB; truncation and content changes produce distinct room-bound references', () => {
  const raw = sample('commandExecution', { command: 'synthetic', status: 'running', aggregatedOutput: 'old log\n' + '\\"😀'.repeat(500000) + '\nlatest line' });
  const item = activityItem(raw, key), bytes = activityDetail(item).bytes;
  assert.ok(bytes.length <= MAX_ACTIVITY_DETAIL_BYTES); assert.equal(detail(item).truncated, true);
  assert.ok(detail(item).text.endsWith('latest line')); assert.ok(!detail(item).text.includes('\ufffd'));
  assert.equal(activityItem(raw, key).detailId, item.detailId);
  assert.notEqual(activityItem(raw, 'different-room').detailId, item.detailId);
  assert.notEqual(activityItem({ ...raw, status: 'completed' }, key).detailId, item.detailId);
  assert.notEqual(activityItem({ ...raw, aggregatedOutput: raw.aggregatedOutput + '\nnew output' }, key).detailId, item.detailId);
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `/synthetic/file-${i}`, kind: { type: 'add' }, diff: '\\"'.repeat(10000) }));
  const fileItem = activityItem(sample('fileChange', { status: 'completed', changes: files }), key);
  assert.ok(activityDetail(fileItem).bytes.length <= MAX_ACTIVITY_DETAIL_BYTES); assert.equal(detail(fileItem).truncated, true);
});

test('turn-level Diff uses a stable synthetic item and suppresses identical per-file content', () => {
  const changes = [sample('fileChange', { changes: [{ path: '/synthetic/a', kind: 'update', diff: '-old\n+new\n' }] })];
  assert.equal(turnDiffActivity('turn', '-old\n+new', changes), null);
  const a = turnDiffActivity('turn', 'separate turn diff', changes), b = turnDiffActivity('turn', 'updated turn diff', changes);
  assert.equal(a.id, b.id); assert.equal(activityItem(a, key).kind, 'diff');
  assert.notEqual(activityItem(a, key).detailId, activityItem(b, key).detailId);
  assert.equal(turnDiffActivity('turn', '', changes), null);
});

test('legacy and canonical Desktop projection include equivalent whitelisted activities and one aggregate turn Diff', () => {
  const items = [sample('commandExecution', { command: 'synthetic run', status: 'completed', aggregatedOutput: 'visible output', arguments: { secret: 'private' } }),
    sample('mcpToolCall', { server: 'fixture', tool: 'inspect', status: 'completed', result: { content: [{ type: 'text', text: 'visible tool text' }], _meta: 'private' } }),
    sample('todo-list', { plan: [{ step: 'Check', status: 'completed' }] }), sample('plan', { text: 'visible plan' }),
    sample('fileChange', { status: 'completed', changes: [{ path: '/synthetic/a', kind: { type: 'add' }, diff: '+one' }] }),
    sample('reasoning', { text: 'private-reasoning' })];
  const turn = { turnId: 'turn', status: 'completed', diff: '+another turn change', items };
  const base = { id: 'thread', hostId: 'local', title: 'synthetic' };
  const legacy = projectDesktopThread({ ...base, turns: [turn], turnsPagination: { hasLoadedOldest: true } }, 'thread');
  const canonical = projectDesktopThread({ ...base, turns: [], turnHistory: { kind: 'canonical', history: { isComplete: true,
    islands: [{ entries: [{ value: 'turn-key' }] }], entitiesByKey: { 'turn-key': turn } } } }, 'thread');
  assert.deepEqual(legacy, canonical);
  assert.deepEqual(legacy.turns[0].items.map(item => item.type), ['commandExecution', 'mcpToolCall', 'todo-list', 'plan', 'fileChange']);
  assert.ok(!JSON.stringify(legacy).includes('private'));
  const projected = legacy.turns[0].items.map(item => activityItem(item, key));
  assert.ok(projected.every(Boolean));
  assert.deepEqual(projected.map(item => item.kind), ['command', 'tool', 'plan', 'plan', 'diff']);
  assert.equal(detail(projected.at(-1)).files.length, 2);
});

test('turn diffs aggregate all files, prefer cumulative overlapping patches and expose only three bounded summaries', () => {
  const patch = (name, text) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${text}\n`;
  const items = [sample('fileChange', { changes: [{ path: '/synthetic/project/a.mjs', kind: 'update', diff: '-old\n+new' }] }),
    { ...sample('fileChange'), id: 'second', changes: Array.from({ length: 80 }, (_, index) => ({ path: `/synthetic/project/extra-${index}`, kind: 'add', diff: '+one' })) }];
  const combined = aggregateTurnActivities('turn', patch('a.mjs', '-old\n+new') + patch('b.mjs', '-before\n+after\n+second'), items, 'completed', '/synthetic/project');
  assert.equal(combined.length, 1);
  const card = activityItem(combined[0], key), result = detail(card);
  assert.equal(result.files.length, 82); assert.equal(result.truncated, undefined);
  assert.equal(result.files.filter(file => file.path === 'a.mjs').length, 1);
  assert.equal(result.files.find(file => file.path === 'a.mjs').diff, patch('a.mjs', '-old\n+new'));
  assert.deepEqual(card.summary, { fileCount: 82, added: 83, removed: 2, remaining: 79, files: [
    { path: 'a.mjs', added: 1, removed: 1 }, { path: 'extra-0', added: 1, removed: 0 }, { path: 'extra-1', added: 1, removed: 0 }] });
  assert.ok(!JSON.stringify(card).includes('/synthetic/project'));
  assert.deepEqual(aggregateTurnActivities('turn', undefined, combined), combined, 'normalized projection is idempotent');
  const changed = aggregateTurnActivities('turn', patch('a.mjs', '-old\n+newer'), combined, 'completed');
  assert.notEqual(activityItem(changed[0], key).detailId, card.detailId);
  const withFinal = aggregateTurnActivities('turn', undefined, [...combined, { id: 'final', type: 'agentMessage', text: 'Done', phase: 'final_answer' }], 'completed');
  assert.deepEqual(withFinal.map(item => item.type), ['agentMessage', 'fileChange'], 'aggregate is the final turn summary after the assistant reply');
});

test('plan preview is bounded by bytes and activity detail JSON remains under one MiB for many paths', () => {
  const plan = activityItem(sample('plan', { text: '中文😀'.repeat(3000) }), key);
  assert.ok(Buffer.byteLength(plan.preview) <= 1024); assert.ok(!plan.preview.includes('\ufffd'));
  assert.equal(detail(plan).text, '中文😀'.repeat(3000));
  const files = Array.from({ length: 1024 }, (_, i) => ({ path: `${i}-` + '\\"'.repeat(4000), kind: 'update', diff: '\\"'.repeat(1000) }));
  const card = activityItem(sample('fileChange', { changes: files }), key);
  assert.ok(activityDetail(card).bytes.length <= MAX_ACTIVITY_DETAIL_BYTES); assert.equal(detail(card).truncated, true);
  assert.equal(card.summary.fileCount, 1024); assert.equal(card.summary.files.length, 3);
});
