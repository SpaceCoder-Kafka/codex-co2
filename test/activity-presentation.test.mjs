import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';

// Exercise only presentation against opaque synthetic room references. No
// Desktop, filesystem reads, model calls or real sharing service are involved.
class Element {
  constructor(tag = 'div') { Object.assign(this, { tag, children: [], dataset: {}, listeners: new Map(), hidden: false, disabled: false }); }
  set innerHTML(_) { throw Error('Presentation must use safe DOM'); }
  set textContent(value) { this.valueText = String(value); this.children = []; }
  get textContent() { return (this.valueText ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.valueText = ''; this.children = [...children]; }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(key, value) { this.listeners.set(key, value); }
  click() { this.listeners.get('click')?.({ preventDefault() {}, stopPropagation() {} }); }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
  pause() { this.paused = true; }
  load() {}
}
const byClass = (node, name) => [...(node.className?.split(' ').includes(name) ? [node] : []), ...node.children.flatMap(child => byClass(child, name))];
const byTag = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => byTag(child, tag))];
const id = character => character.repeat(64);
function presentation({ original = true } = {}) {
  let readable = true, timerId = 0;
  const sent = [], enhanced = [], revoked = [], timers = new Map(), blobs = [];
  const document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; } };
  class PreviewURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:synthetic-' + blobs.length; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const window = { markdownit: MarkdownIt,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(key) { timers.delete(key); },
    co2PreviewLoader: async () => ({
      async enhanceMarkdown(container, options) { enhanced.push({ container, options }); return () => { container.enhancementDisposed = true; }; },
      async mountPreview({ container, bytes, isCurrent }) { if (isCurrent()) container.textContent = new TextDecoder().decode(bytes); return { dispose() { container.previewDisposed = true; } }; },
    }),
  };
  const context = { window, document, URL: PreviewURL, Uint8Array, Blob, TextDecoder, atob, btoa };
  vm.runInNewContext(fs.readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(new URL('../public/images.js', import.meta.url), 'utf8'), context);
  const images = window.createThreadImages({ send: request => { sent.push(request); return true; }, canRead: () => readable, capabilities: () => original ? ['file-original', 'activity-details'] : ['activity-details'] });
  const receive = (ref, value, options = {}) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const type = ref.kind === 'activity' ? 'activity' : (ref.kind ?? 'image') === 'image' ? 'image' : 'file';
    const total = Math.max(1, Math.ceil(bytes.length / 30720));
    for (let index = 0; index < total; index++) images.receive({ type: type + '-chunk', [type + 'Id']: ref.id,
      mime: type === 'activity' ? 'application/json' : type === 'image' ? 'image/png' : original ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      ...(type === 'file' && original ? { representation: 'original' } : {}), total, index, data: bytes.subarray(index * 30720, (index + 1) * 30720).toString('base64'), ...options });
  };
  return { images, sent, enhanced, document, blobs, receive, root: () => new Element('div'), revoke() { readable = false; images.pause(); }, async flush() { await new Promise(resolve => setImmediate(resolve)); } };
}

test('file references preserve Markdown labels as compact lazy entries with preview-only downloads', async () => {
  const page = presentation(), parent = page.root(), ref = { id: id('a'), name: 'synthetic-output.pdf', label: '验收说明', kind: 'pdf', syntax: 'link', index: 0 };
  assert.equal(page.images.render([ref], parent, { inline: true }), 1);
  assert.equal(page.sent.length, 0);
  const button = byClass(parent, 'file-link')[0], panel = byClass(parent, 'file-preview-panel')[0], download = byClass(parent, 'file-download')[0];
  assert.equal(byClass(parent, 'message-file-inline').length, 1);
  assert.equal(button.textContent.includes('验收说明'), true); assert.equal(parent.textContent.includes('32 MiB'), false);
  assert.equal(parent.textContent.includes('synthetic-output.pdf'), false);
  assert.equal(panel.hidden, true); assert.equal(download.hidden, true); assert.equal(download.textContent, '');
  button.click(); assert.equal(page.sent[0].type, 'file-request'); assert.equal(page.sent[0].representation, 'original');
  const bytes = Buffer.from('synthetic bytes'); page.receive(ref, bytes); await page.flush();
  assert.equal(panel.hidden, false); assert.equal(download.hidden, false); download.click();
  assert.deepEqual(Buffer.from(await page.blobs.at(-1).arrayBuffer()), bytes);
  button.click(); assert.equal(panel.hidden, true); assert.equal(download.hidden, true);
  const attached = page.root(); page.images.render([{ ...ref, id: id('b'), label: undefined, index: undefined }], attached);
  assert.equal(byClass(attached, 'file-chip').length, 1); assert.match(attached.textContent, /synthetic-output.pdf/);
  const forged = page.root(); assert.equal(page.images.render([{ ...ref, id: '/tmp/not-authorized.pdf' }], forged), 0);
});

test('ordinary image links stay lazy and open the existing dialog after loading without changing thumbnail semantics', () => {
  const page = presentation(), parent = page.root(), ref = { id: id('c'), name: 'image.png', label: '查看截图', syntax: 'link', linkIndex: 1 };
  page.images.render([ref], parent, { inline: true, link: true });
  assert.equal(page.sent.length, 0); assert.equal(byTag(parent, 'img').length, 0);
  const button = byClass(parent, 'file-link')[0]; assert.match(button.textContent, /查看截图/); button.click();
  assert.equal(page.sent[0].type, 'image-request'); assert.equal(page.sent[0].imageId, ref.id);
  page.receive(ref, Buffer.from('synthetic png'));
  const dialog = byTag(page.document.body, 'dialog')[0]; assert.equal(dialog.open, true);
  const dialogImage = byClass(dialog, 'image-dialog-image')[0]; assert.match(dialogImage.src, /^data:image\/png/);
  const thumb = page.root(); page.images.render([{ ...ref, label: '缩略图' }], thumb, { inline: true });
  assert.equal(byTag(thumb, 'img').length, 1); assert.equal(page.sent.length, 1, 'thumbnail and link share the same authorized bytes');
  byClass(dialog, 'image-dialog-close')[0].click(); button.click(); assert.equal(dialog.open, true); assert.equal(page.sent.length, 1);
  page.revoke(); assert.equal(dialog.open, false); button.click(); assert.equal(dialog.open, false); assert.equal(page.sent.length, 1);
});

test('remote image links remain direct browser previews and cannot obtain the original-download capability', () => {
  const page = presentation(), root = page.root(), ref = { id: id('3'), name: 'remote.png', label: '远程截图', url: 'https://synthetic.invalid/image.png' };
  page.images.render([ref], root, { inline: true, link: true }); assert.equal(page.sent.length, 0);
  assert.equal(byTag(root, 'img').length, 0); byClass(root, 'file-link')[0].click();
  const dialog = byTag(page.document.body, 'dialog')[0]; assert.equal(dialog.open, true); assert.equal(page.sent.length, 0);
  assert.equal(byClass(dialog, 'image-dialog-image')[0].src, ref.url);
  const download = byClass(dialog, 'image-dialog-download')[0]; assert.equal(download.hidden, true); assert.equal(download.disabled, true);
  download.click(); assert.equal(page.blobs.length, 0);
});

test('closing a file while loading keeps its late result collapsed and a failed reference remains a retryable compact entry', async () => {
  const page = presentation(), root = page.root(), ref = { id: id('d'), name: 'synthetic.md', kind: 'markdown' };
  page.images.render([ref], root, { inline: true });
  const button = byClass(root, 'file-link')[0]; button.click(); button.click(); page.receive(ref, '# 文件'); await page.flush();
  assert.equal(button['aria-expanded'], 'false'); assert.equal(byClass(root, 'file-preview-panel')[0].hidden, true);
  const failure = page.root(), broken = { ...ref, id: id('e'), label: '缺失文件' }; page.images.render([broken], failure, { inline: true });
  byClass(failure, 'file-link')[0].click(); page.images.receive({ type: 'file-unavailable', fileId: broken.id });
  assert.match(byClass(failure, 'file-preview-notice')[0].textContent, /无法预览/);
  assert.equal(byClass(failure, 'file-download')[0].hidden, false); assert.match(byClass(failure, 'file-link')[0].textContent, /缺失文件/);
});

test('Diff overview exposes only bounded file summaries and preserves the one-patch accordion across redraws', () => {
  const page = presentation(), parent = page.root(), ref = { id: id('f'), name: '文件变更', kind: 'activity', activityKind: 'diff', status: 'completed',
    summary: { fileCount: 5, added: 23, removed: 4, files: [{ path: 'src/a.js', added: 10, removed: 2 }, { path: '/private/source/b.js', added: 9, removed: 1 }, { path: 'src/c.js', added: 4, removed: 1 }], remaining: 2 } };
  page.images.render([ref], parent);
  assert.equal(page.sent.length, 0); assert.equal(byClass(parent, 'activity-diff-file').length, 3);
  assert.match(byClass(parent, 'activity-summary')[0].textContent, /已编辑 5 个文件\+23−4/);
  assert.equal(parent.textContent.includes('已完成'), false); assert.equal(parent.textContent.includes('/private/source'), false);
  byClass(parent, 'activity-diff-more')[0].click(); assert.equal(page.sent[0].type, 'activity-request');
  page.receive(ref, { kind: 'diff', status: 'completed', files: [{ path: 'src/a.js', kind: 'update', diff: '-old\n+new' }, { path: 'src/b.js', kind: 'add', diff: '+second' }] });
  assert.equal(byClass(parent, 'diff-preview').length, 0); const toggles = byClass(parent, 'activity-file-toggle'); toggles[0].click();
  const firstBody = byClass(parent, 'diff-file-body')[0]; assert.match(firstBody.textContent, /old/);
  toggles[1].click(); assert.equal(firstBody.children.length, 0); assert.equal(byClass(parent, 'diff-preview').length, 1);
  page.images.retain(new Set([ref.id])); const redraw = page.root(); page.images.render([ref], redraw);
  assert.equal(byClass(redraw, 'activity-file-toggle')[1]['aria-expanded'], 'true'); assert.equal(byClass(redraw, 'diff-preview').length, 1);
  const oldToggle = byClass(redraw, 'activity-file-toggle')[0]; page.images.retain(new Set([id('1')])); const next = page.root(); page.images.render([{ ...ref, id: id('1') }], next);
  oldToggle.click(); assert.equal(firstBody.children.length, 0); assert.equal(byClass(next, 'diff-preview').length, 0); assert.equal(page.sent.length, 1);
});

test('plan previews and full details use safe semantic Markdown with no file or tool authority', async () => {
  const page = presentation(), parent = page.root(), ref = { id: id('2'), name: '计划', kind: 'activity', activityKind: 'plan', status: 'completed',
    preview: '# 合成计划\n\n- 初步检查\n- 验证结果' };
  page.images.render([ref], parent); assert.equal(page.sent.length, 0);
  const preview = byClass(parent, 'activity-plan-preview')[0]; assert.equal(byTag(preview, 'h1').length, 1); assert.equal(byTag(preview, 'li').length, 2);
  byClass(parent, 'activity-summary')[0].click();
  page.receive(ref, { kind: 'plan', status: 'completed', text: '## 实施步骤\n\n**检查** [本地文件](/synthetic/forbidden.pdf) ![图片](/synthetic/forbidden.png)\n\n<script>unsafe()</script>\n\n```js\nconst value = 1;\n```' }); await page.flush();
  const body = byClass(parent, 'activity-plan-body')[0]; assert.equal(byTag(body, 'h2').length, 1); assert.equal(byTag(body, 'strong').length, 1);
  assert.equal(byTag(body, 'script').length, 0); assert.equal(byTag(body, 'img').length, 0); assert.equal(byClass(body, 'file-link').length, 0);
  assert.equal(byTag(body, 'a').some(link => !!link.href), false); assert.equal(page.sent.length, 1);
  assert.equal(page.enhanced.length, 1); assert.equal(page.enhanced[0].options.isCurrent(), true);
  page.images.retain(new Set()); assert.equal(page.enhanced[0].options.isCurrent(), false); assert.equal(body.enhancementDisposed, true);
});

test('retired plan enhancement promises cannot mutate or retain resources after revocation', async () => {
  const page = presentation(), root = page.root(), ref = { id: id('4'), name: '旧计划', kind: 'activity', activityKind: 'plan' };
  page.images.render([ref], root); byClass(root, 'activity-summary')[0].click();
  page.receive(ref, { kind: 'plan', text: '# 已撤销\n\n$x^2$' }); page.revoke(); await page.flush();
  assert.equal(page.enhanced.length, 0); assert.equal(page.sent.length, 1);
});

test('closing historical work after more than 128 activity entries cannot erase a later Diff or plan', async () => {
  const page = presentation(), history = Array.from({ length: 181 }, (_, index) => ({
    id: index.toString(16).padStart(64, '0'), name: '合成历史活动 ' + index, kind: 'activity', activityKind: index < 133 ? 'command' : 'tool',
  }));
  // Work groups call render only after disclosure. Render three synthetic
  // historical groups, then perform the same retain-with-no-views lifecycle
  // as closing them and redrawing the transcript.
  const groups = [page.root(), page.root(), page.root()];
  for (let index = 0; index < history.length; index++) page.images.render([history[index]], groups[Math.floor(index / 61)]);
  const opened = byClass(groups[0], 'activity-summary')[0]; opened.click();
  page.receive(history[0], { kind: 'command', status: 'completed', text: '合成历史输出', exitCode: 0 });
  const oldDetail = byClass(groups[0], 'activity-detail')[0]; assert.ok(oldDetail); opened.click();
  const diff = { id: id('a'), name: '合成七文件变更', kind: 'activity', activityKind: 'diff',
    summary: { fileCount: 7, added: 52, removed: 16, files: [{ path: 'lib/a.dart', added: 36, removed: 11 }, { path: 'lib/b.dart', added: 1, removed: 1 }, { path: 'lib/c.dart', added: 11, removed: 1 }], remaining: 4 } };
  const plan = { id: id('b'), name: '合成计划', kind: 'activity', activityKind: 'plan', preview: '# 下一步\n\n保持查看入口。' };
  page.images.retain(new Set([...history.map(ref => ref.id), diff.id, plan.id]));
  const current = page.root(); assert.equal(page.images.render([diff, plan], current), 2);
  assert.equal(byClass(current, 'activity-card').length, 2); assert.match(current.textContent, /已编辑 7 个文件/);
  assert.match(current.textContent, /再显示 4 个文件/); assert.equal(byClass(current, 'activity-plan-preview').length, 1);
  assert.equal(page.sent.length, 1, 'retained hidden caches never force a request merely to display a new entry');
  byClass(current, 'activity-summary')[0].click();
  assert.equal(page.sent.at(-1).activityId, diff.id);
  page.receive(diff, { kind: 'diff', files: [{ path: 'lib/a.dart', kind: 'update', diff: '-before\n+after' }] });
  const currentDetail = byClass(current, 'activity-detail')[0]; assert.ok(currentDetail);
  page.revoke(); page.images.clear(); await page.flush();
  assert.equal(oldDetail.removed, true); assert.equal(currentDetail.removed, true);
  const sentBefore = page.sent.length; opened.click(); byClass(current, 'activity-summary')[0].click();
  assert.equal(page.sent.length, sentBefore, 'retired historical and current buttons cannot read after revocation');
});

test('an out-of-contract metadata overflow keeps a retry entry and cancels evicted unmounted reads and queues', () => {
  const page = presentation(), capacity = Math.floor((48 * 1024 - 1) / 64), parent = page.root();
  const refs = Array.from({ length: capacity }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), name: '合成边界活动 ' + index, kind: 'activity', activityKind: 'tool' }));
  page.images.render(refs, parent);
  const controls = byClass(parent, 'activity-summary'); controls[0].click(); controls[1].click();
  assert.equal(page.sent.length, 1, 'the second read waits behind the first');
  const overflow = { id: id('c'), name: '合成额外变更', kind: 'activity', activityKind: 'diff' }, fallbackRoot = page.root();
  assert.equal(page.images.render([overflow], fallbackRoot), 1);
  const fallback = byClass(fallbackRoot, 'activity-summary')[0]; assert.match(fallback.textContent, /合成额外变更.*点击重试/);
  fallback.click(); assert.match(fallback.textContent, /稍后重试/); assert.equal(page.sent.length, 1);
  // A redraw with old groups closed makes their state unmounted. Replacing all
  // of that metadata eventually evicts the active read and its queued peer.
  const nextRefs = Array.from({ length: capacity }, (_, index) => ({ id: (index + 10000).toString(16).padStart(64, '0'), name: '合成新活动 ' + index, kind: 'activity', activityKind: 'tool' }));
  page.images.retain(new Set([...refs.map(ref => ref.id), ...nextRefs.map(ref => ref.id), overflow.id]));
  assert.equal(fallback.disabled, true);
  const next = page.root(); page.images.render(nextRefs, next); page.images.mounted();
  assert.equal(page.sent.length, 1, 'the evicted queued read is not sent later');
  controls[0].click(); controls[1].click(); fallback.click(); assert.equal(page.sent.length, 1);
  // Retiring one currently mounted reference makes a retry slot available.
  page.images.retain(new Set([overflow.id]));
  const current = page.root(); assert.equal(page.images.render([overflow], current), 1);
  byClass(current, 'activity-summary')[0].click(); assert.equal(page.sent.at(-1).activityId, overflow.id);
  page.receive(refs[0], { kind: 'tool', text: 'stale result must not enter the new detail' });
  assert.equal(byClass(current, 'activity-detail').length, 0);
  page.receive(overflow, { kind: 'diff', files: [{ path: 'only.txt', kind: 'add', diff: '+current' }] });
  assert.equal(byClass(current, 'activity-file-toggle').length, 1);
  const detail = byClass(current, 'activity-detail')[0];
  page.revoke(); page.images.clear();
  assert.equal(detail.removed, true);
});
