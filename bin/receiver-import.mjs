import path from 'node:path';
import { parseImportLink, claimReceiverImport } from '../lib/import-handoff.mjs';

function attachmentSummary(version, counts, language) {
  const en = language === 'en', tw = language === 'zh-TW';
  if (version === 1) return en ? 'The sharing app provided a text-only snapshot.'
    : tw ? '分享端提供的是純文字快照。' : '分享端提供的是纯文字快照。';
  if (!counts || !(counts.saved || counts.missing || counts.remote)) return '';
  const details = [];
  if (counts.saved) details.push(en ? `Files saved: ${counts.saved}` : tw ? `已儲存 ${counts.saved} 個附件` : `已保存 ${counts.saved} 个附件`);
  if (counts.remote) details.push(en ? `External images linked: ${counts.remote}` : tw ? `保留 ${counts.remote} 個外部圖片連結` : `保留 ${counts.remote} 个外部图片链接`);
  if (counts.missing) details.push(en ? `Files unavailable: ${counts.missing} (see the original messages)` : tw ? `${counts.missing} 個附件未儲存，詳見對應訊息` : `${counts.missing} 个附件未保存，详见对应消息`);
  return details.join(en ? '. ' : '。') + (en ? '.' : '。');
}

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
    const { snapshot, fetchAsset } = await claimReceiverImport(raw);
    failure = '导入未完成，请检查本机 Codex 是否正在运行。';
    const { importReceiverSnapshot } = await import('../lib/receiver-import.mjs');
    const { threadId, attachments } = await importReceiverSnapshot({ snapshot, runtimeDir, fetchAsset });
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(threadId)) throw new Error('thread ID');
    result = { threadId };
    const summary = attachmentSummary(snapshot.version, attachments, process.env.CO2_RECEIVER_LANGUAGE);
    if (summary) result.attachmentSummary = summary;
  } else throw new Error('operation');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  // Normal transport errors may contain the whole link. Only propagate
  // explicitly user-facing errors produced by the receiver.
  process.stdout.write(JSON.stringify({ error: error.safeMessage || failure }));
  process.exitCode = 1;
}
