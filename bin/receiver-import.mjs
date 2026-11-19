import path from 'node:path';
import { parseImportLink, claimImportSnapshot } from '../lib/import-handoff.mjs';

// The native shell writes the one-time link through stdin. Inspecting it must
// not contact the sharing host: the user first confirms the displayed origin.
let failure = '无效的会话导入链接。';
try {
  const [action, runtimeDir] = process.argv.slice(2);
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk.toString('utf8');
    if (Buffer.byteLength(raw) > 4096) throw new Error('link length');
  }
  const { origin } = parseImportLink(raw);
  let result;
  if (action === 'inspect') {
    result = { origin };
  } else if (action === 'import' && path.isAbsolute(runtimeDir ?? '')) {
    failure = '无法取得会话内容。请返回访客网页，重新点击导入。';
    const snapshot = await claimImportSnapshot(raw);
    failure = '导入未完成，请检查本机 Codex 是否正在运行。';
    const { importReceiverSnapshot } = await import('../lib/receiver-import.mjs');
    const { threadId } = await importReceiverSnapshot({ snapshot, runtimeDir });
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(threadId)) throw new Error('thread ID');
    result = { threadId };
  } else throw new Error('operation');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  // Normal transport errors may contain the whole link. Only propagate
  // explicitly user-facing errors produced by the receiver.
  process.stdout.write(JSON.stringify({ error: error.safeMessage || failure }));
  process.exitCode = 1;
}
