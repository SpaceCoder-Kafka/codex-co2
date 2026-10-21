#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopRpcClient, desktopIpcPath } from '../lib/desktop-ipc.mjs';

const { values } = parseArgs({ options: { thread: { type: 'string' }, 'ipc-path': { type: 'string' }, 'observe-ms': { type: 'string', default: '0' } } });
const observeMs = Number(values['observe-ms']);
if (!values.thread || !Number.isInteger(observeMs) || observeMs < 0 || observeMs > 30000) throw new Error('Use --thread UUID [--observe-ms 0..30000]');
const rpc = await DesktopRpcClient.connect(values['ipc-path'] ?? desktopIpcPath());
let changes = 0;
rpc.on('notification', () => changes++);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configuration = () => digest({ cwd: rpc.nativeState?.cwd, settings: rpc.nativeState?.latestThreadSettings,
  permissions: rpc.nativeState?.currentPermissions, modelProvider: rpc.nativeState?.modelProvider });
try {
  await rpc.request('thread/read', { threadId: values.thread });
  const configBefore = configuration(), ownerBefore = digest(rpc.owner);
  await delay(observeMs);
  const { thread } = await rpc.request('thread/read', { threadId: values.thread });
  let installedBundledVersion = null;
  try { installedBundledVersion = execFileSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', ['--version'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch {}
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), installedBundledVersion,
    transport: 'existing Desktop IPC', streamVersion: 11, threadId: thread.id, revision: rpc.revision,
    turns: thread.turns.length, textItems: thread.turns.reduce((n, t) => n + t.items.length, 0),
    historyTruncated: thread.historyTruncated, stateChanges: changes,
    sameNativeOwner: ownerBefore === digest(rpc.owner), configurationUnchanged: configBefore === configuration(),
    submissionTested: false, nativeRenderingTested: false, spawnedBackend: false, readCredentialOrHistoryFiles: false }, null, 2));
} finally { rpc.close(); }
