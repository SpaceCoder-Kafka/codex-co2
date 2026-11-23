import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDesktopAppBridge } from '../lib/desktop-app-bridge.mjs';
import { startDesktopBridge } from '../plugins/co2-desktop-bridge/server.mjs';
import { attachDesktopApp } from '../lib/desktop-app-adapter.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';

test('real bridge, adapter and scope compose through startup, selected read and queued acknowledgement', async t => {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-desktop-stack-')));
  const manager = createDesktopAppBridge({ runtimeDir });
  let plugin, attachment, scoped;
  t.after(async () => { scoped?.close(); attachment?.close(); plugin?.close(); await manager.close(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  const target = randomUUID(), source = randomUUID(); let reads = 0, writes = 0;
  const nativeRequest = async (method, params) => {
    if (method === 'tools/list') return { tools: [{ name: 'read_thread' }] };
    assert.equal(params.tool, 'read_thread'); assert.equal(params.threadId, source);
    assert.equal(params.arguments.threadId, target); reads++;
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ schemaVersion: 1,
      thread: { id: target, hostId: 'local', title: 'Synthetic stack', status: { type: 'idle' } },
      page: { order: 'newest_first', nextCursor: null, hasMore: false },
      turns: [{ id: 'synthetic-turn', status: 'completed', items: [{ id: 'synthetic-message', type: 'agentMessage', text: 'Synthetic response' }] }],
    }) }] };
  };
  attachment = await attachDesktopApp({ bridge: manager, catalog: { contains: async id => id === target, list: async () => [] },
    queue: { submit: async request => { assert.equal(request.canDispatch(), true); writes++;
      return { id: randomUUID(), clientUserMessageId: request.clientUserMessageId, wakePending: true }; } },
    launchBridge: async () => { plugin = await startDesktopBridge({ runtimeDir, sourceThreadId: source, nativeRequest }); }, pollIntervalMs: 10000 });
  assert.equal(reads, 0);
  await attachment.selectThread(target);
  const rpc = await attachment.rpcFactory();
  scoped = new ScopedThread({ rpc, threadId: target, ownerName: 'Synthetic host' });
  await scoped.start();
  assert.equal(scoped.snapshot.items[0].text, 'Synthetic response');
  const requestId = randomUUID();
  assert.equal((await scoped.submitApproved('Synthetic input', requestId, { canDispatch: () => true })).kind, 'queued');
  await scoped.submitApproved('Synthetic input', requestId, { canDispatch: () => true });
  assert.equal(writes, 1);
  plugin.close();
  await new Promise(resolve => rpc.once('closed', resolve));
  assert.equal(scoped.snapshot.status, 'offline');
  await assert.rejects(scoped.submitApproved('Not dispatched', randomUUID(), { canDispatch: () => true }));
  assert.equal(writes, 1);
});

test('native outer size errors traverse the bridge and preserve paged dialogue with omitted-detail limits', async t => {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-desktop-size-stack-')));
  const manager = createDesktopAppBridge({ runtimeDir });
  let plugin, attachment;
  t.after(async () => { await attachment?.close(); await plugin?.close(); await manager.close(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  const target = randomUUID(), source = randomUUID(), calls = [];
  const nativeSizeError = 'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.';
  const nativeRequest = async (method, params) => {
    if (method === 'tools/list') return { tools: [{ name: 'read_thread' }] };
    assert.equal(params.tool, 'read_thread'); assert.equal(params.threadId, source);
    assert.equal(params.arguments.threadId, target);
    const options = params.arguments; calls.push(options);
    if (!options.cursor && options.includeOutputs) return { success: false, contentItems: [{ type: 'inputText', text: nativeSizeError }] };
    const older = options.cursor === 'older';
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ schemaVersion: 1,
      thread: { id: target, hostId: 'local', title: 'Synthetic sized conversation', status: { type: 'idle' } },
      page: { order: 'newest_first', nextCursor: older ? null : 'older', hasMore: !older },
      turns: [{ id: older ? 'older-turn' : 'newer-turn', status: 'completed', items: older
        ? [{ id: 'older-message', type: 'userMessage', content: [{ type: 'text', text: 'Older unmodified input' }] }]
        : [{ id: 'newer-message', type: 'agentMessage', text: 'Newer unmodified response' }] }],
    }) }] };
  };
  attachment = await attachDesktopApp({ bridge: manager, catalog: { contains: async id => id === target, list: async () => [] },
    queue: { submit: async () => assert.fail('read fallback cannot submit input') },
    launchBridge: async () => { plugin = await startDesktopBridge({ runtimeDir, sourceThreadId: source, nativeRequest }); } });
  await attachment.selectThread(target);
  const { thread } = await (await attachment.rpcFactory()).request('thread/read', { threadId: target });
  assert.equal(thread.historyDetailsOmitted, true); assert.equal(thread.historyTruncated, true);
  assert.deepEqual(thread.turns.map(turn => turn.id), ['older-turn', 'newer-turn']);
  assert.equal(thread.turns[0].items[0].content[0].text, 'Older unmodified input');
  assert.equal(thread.turns[1].items[0].text, 'Newer unmodified response');
  assert.deepEqual(calls.slice(0, 4).map(options => [options.cursor ?? null, options.turnLimit, options.includeOutputs, options.maxOutputCharsPerItem]), [
    [null, 10, true, 20000], [null, 1, true, 20000], [null, 1, false, 0], ['older', 10, true, 20000],
  ]);
  await assert.rejects((await attachment.rpcFactory()).request('thread/read', { threadId: source }), { code: 'DESKTOP_APP_SCOPE' });
});
