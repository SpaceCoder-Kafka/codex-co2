import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import Papa from 'papaparse';
import { mountOffice } from './office-preview.mjs';

const MAX_TEXT = 1024 * 1024, MAX_CELLS = 100000;
const element = (doc, tag, text) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
export function decodePreviewText(bytes) {
  if (bytes.length > MAX_TEXT) throw Error('文本预览超过 1 MiB，请下载原件查看');
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 255 && bytes[1] === 254) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 254 && bytes[1] === 255) { encoding = 'utf-16be'; offset = 2; }
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text) || new TextEncoder().encode(text).length > MAX_TEXT) throw Error('文件编码或内容不适合文本预览');
  return text;
}
export function parseTable(text, name = '') {
  const parsed = Papa.parse(text, { delimiter: /\.tsv$/i.test(name) ? '\t' : ',', skipEmptyLines: false, dynamicTyping: false });
  if (parsed.errors.some(e => e.code === 'MissingQuotes')) throw Error('表格引号不完整');
  let cells = 0, truncated = false;
  const rows = [];
  for (const row of parsed.data) {
    if (cells + row.length > MAX_CELLS || rows.length >= 20000 || row.length > 1000) { truncated = true; break; }
    cells += row.length; rows.push(row);
  }
  return { sheets: [{ name: name || '表格', rows }], truncated };
}
function renderTable(container, model, source, isCurrent) {
  const doc = container.ownerDocument, toolbar = element(doc, 'div'); toolbar.className = 'preview-toolbar';
  const select = element(doc, 'select'), previous = element(doc, 'button', '上一页'), label = element(doc, 'span'), next = element(doc, 'button', '下一页');
  for (let i = 0; i < model.sheets.length; i++) { const option = element(doc, 'option', model.sheets[i].name); option.value = String(i); select.append(option); }
  select.setAttribute('aria-label', '工作表'); previous.type = next.type = 'button'; toolbar.append(select, previous, label, next);
  const view = element(doc, 'div'); view.className = 'table-scroll'; view.tabIndex = 0;
  container.append(toolbar, view); let sheet = 0, page = 0, sourceMode = false;
  const draw = () => {
    if (!isCurrent()) return;
    view.replaceChildren();
    const rows = model.sheets[sheet].rows, pages = Math.max(1, Math.ceil(rows.length / 200)); page = Math.max(0, Math.min(page, pages - 1));
    if (sourceMode) { const pre = element(doc, 'pre', source); view.append(pre); }
    else {
      const table = element(doc, 'table');
      for (const row of rows.slice(page * 200, (page + 1) * 200)) {
        const tr = element(doc, 'tr'); for (const cell of row) tr.append(element(doc, 'td', cell)); table.append(tr);
      }
      view.append(table); if (!rows.length) view.append(element(doc, 'p', '（空表格）'));
    }
    previous.disabled = sourceMode || page === 0; next.disabled = sourceMode || page === pages - 1; label.textContent = `${page + 1} / ${pages}`;
  };
  select.onchange = () => { sheet = Number(select.value); page = 0; draw(); };
  previous.onclick = () => { page--; draw(); }; next.onclick = () => { page++; draw(); };
  if (source !== undefined) { const toggle = element(doc, 'button', '查看源码'); toggle.type = 'button'; toggle.onclick = () => { sourceMode = !sourceMode; toggle.textContent = sourceMode ? '查看表格' : '查看源码'; draw(); }; toolbar.append(toggle); }
  if (model.truncated) container.append(element(doc, 'p', '表格预览已达到行列或单元格上限，下载原件可查看完整内容。'));
  draw(); return { dispose() {} };
}
function loadWorkbook(bytes, isCurrent) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/vendor/xlsx.worker.mjs', { type: 'module' });
    const cancel = setInterval(() => { if (!isCurrent()) { finish(); reject(Error('预览已取消')); } }, 100);
    const timer = setTimeout(() => { finish(); reject(Error('表格解析超时')); }, 15000);
    const finish = () => { clearTimeout(timer); clearInterval(cancel); worker.terminate(); };
    worker.onmessage = e => { finish(); e.data.error ? reject(Error(e.data.error)) : resolve(e.data); };
    worker.onerror = () => { finish(); reject(Error('表格解析失败')); };
    const copy = bytes.slice(); worker.postMessage(copy, [copy.buffer]);
  });
}
async function mountPdf({ container, bytes, isCurrent }) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
  const doc = container.ownerDocument, toolbar = element(doc, 'div'); toolbar.className = 'preview-toolbar';
  const previous = element(doc, 'button', '上一页'), label = element(doc, 'span'), next = element(doc, 'button', '下一页'), smaller = element(doc, 'button', '缩小'), bigger = element(doc, 'button', '放大');
  for (const button of [previous, next, smaller, bigger]) button.type = 'button'; toolbar.append(previous, label, next, smaller, bigger);
  const canvas = element(doc, 'canvas'); canvas.className = 'file-pdf-canvas'; container.append(toolbar, canvas);
  let disposed = false, page = 1, zoom = 1, renderTask, pdf, generation = 0;
  const loading = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: '/vendor/pdf-cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdf-fonts/', wasmUrl: '/vendor/pdf-codecs/', isEvalSupported: false, useWasm: false, disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 16777216, stopAtErrors: true });
  const dispose = () => { disposed = true; generation++; clearInterval(cancel); renderTask?.cancel(); loading.destroy().catch(() => {}); canvas.width = canvas.height = 0; };
  const cancel = setInterval(() => { if (!isCurrent()) dispose(); }, 100);
  try { pdf = await loading.promise; } catch (error) { dispose(); throw error; }
  async function draw() {
    const current = ++generation; renderTask?.cancel();
    if (disposed || !isCurrent()) return;
    const pdfPage = await pdf.getPage(page); if (current !== generation || disposed) return;
    const base = pdfPage.getViewport({ scale: 1 }), fit = Math.min(1.5, (container.clientWidth || 720) / base.width), scale = Math.min(zoom * fit, Math.sqrt(4194304 / (base.width * base.height)));
    const viewport = pdfPage.getViewport({ scale }); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    label.textContent = `${page} / ${pdf.numPages}`; previous.disabled = page === 1; next.disabled = page === pdf.numPages;
    renderTask = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    try { await renderTask.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
    pdfPage.cleanup();
  }
  const safeDraw = () => { draw().catch(() => { if (!disposed) { dispose(); container.append(element(doc, 'p', 'PDF 无法继续渲染，请下载原件查看')); } }); };
  previous.onclick = () => { page--; safeDraw(); }; next.onclick = () => { page++; safeDraw(); };
  smaller.onclick = () => { zoom = Math.max(.25, zoom / 1.25); safeDraw(); }; bigger.onclick = () => { zoom = Math.min(4, zoom * 1.25); safeDraw(); };
  try { await draw(); return { dispose }; } catch (error) { dispose(); throw error; }
}

export async function mountPreview({ container, bytes, name = '', kind, mime, renderMarkdown, isCurrent = () => true }) {
  if (!isCurrent()) return { dispose() {} };
  container.replaceChildren();
  if (kind === 'pdf') return mountPdf({ container, bytes, isCurrent });
  if (kind === 'docx' || kind === 'pptx') return mountOffice({ container, bytes, kind, isCurrent });
  if (kind === 'xlsx') return renderTable(container, await loadWorkbook(bytes, isCurrent), undefined, isCurrent);
  const text = decodePreviewText(bytes), doc = container.ownerDocument;
  if (kind === 'table') return renderTable(container, parseTable(text, name), text, isCurrent);
  if (kind === 'markdown') {
    const button = element(doc, 'button', '查看源码'), view = element(doc, 'div'); button.type = 'button'; view.className = 'markdown'; container.append(button, view);
    let source = false, cleanup = () => {};
    const draw = async () => {
      cleanup(); view.replaceChildren(); if (!isCurrent()) return;
      if (source || !renderMarkdown) view.append(element(doc, 'pre', text));
      else { renderMarkdown(view, text); cleanup = await enhanceMarkdown(view, { isCurrent }); }
      button.textContent = source ? '查看排版' : '查看源码';
    };
    button.onclick = () => { source = !source; draw().catch(() => {}); }; await draw(); return { dispose() { cleanup(); } };
  }
  const pre = element(doc, 'pre'), code = element(doc, 'code', text); pre.append(code); container.append(pre);
  const ext = name.split('.').pop().toLowerCase(), languages = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', rs: 'rust', sh: 'bash', yml: 'yaml', md: 'markdown', htm: 'xml', html: 'xml', svg: 'xml' };
  const language = languages[ext] || ext; if (hljs.getLanguage(language)) code.className = 'language-' + language;
  return { dispose: await enhanceMarkdown(pre, { isCurrent }) };
}

function sanitizedSvg(svg, styles = '') {
  // Keep styled SVG in its inert XML document while sanitizing. Parsing into an
  // HTML fragment would try to apply its styles under the parent page's CSP.
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.getElementsByTagName('parsererror').length || document.documentElement.localName !== 'svg') throw Error('图形内容无效');
  const root = document.documentElement;
  DOMPurify.sanitize(root, { USE_PROFILES: { svg: true, svgFilters: true }, IN_PLACE: true, FORBID_TAGS: ['foreignObject', 'a', 'script', 'image', 'style'], FORBID_ATTR: ['href', 'xlink:href', 'style'] });
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const a of [...node.attributes]) if (/^on/i.test(a.name) || /(?:url\s*\(\s*(?!#)|@import|https?:|data:|javascript:)/i.test(a.value)) node.removeAttribute(a.name);
    const inline = node.getAttribute('data-co2-style');
    if (inline && /@import|expression|(?:url\s*\(\s*(?!#))|javascript:|https?:|data:|[<>]/i.test(inline)) node.removeAttribute('data-co2-style');
  }
  const serialized = new XMLSerializer().serializeToString(root).replaceAll('data-co2-style=', 'style=');
  const css = typeof styles === 'string' && styles.length < 512 * 1024 && !/@import|expression|(?:url\s*\(\s*(?!#))|javascript:|https?:|data:|[<>]/i.test(styles) ? styles : '';
  const escaped = css.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return serialized.replace(/<\/svg>$/, '<style>' + escaped + '</style></svg>');
}
function mermaidImage(node, source, isCurrent) {
  const doc = node.ownerDocument, nonceBytes = crypto.getRandomValues(new Uint8Array(16)), nonce = [...nonceBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const frame = doc.createElement('iframe');
  // Mermaid measures text and SVG geometry. display:none would turn every
  // getBBox into zero and produce an empty 16x16 diagram.
  frame.style.position = 'fixed'; frame.style.left = '-10000px'; frame.style.top = '0'; frame.style.width = '1024px'; frame.style.height = '768px'; frame.style.opacity = '0'; frame.style.pointerEvents = 'none'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('sandbox', 'allow-scripts'); frame.src = '/rich-render.html'; frame.title = '图形生成';
  let disposed = false, url, cancel, timer;
  const cleanup = () => { disposed = true; clearTimeout(timer); clearInterval(cancel); window.removeEventListener('message', receive); frame.remove(); if (url) URL.revokeObjectURL(url); };
  const fail = message => { if (!isCurrent() || disposed) { cleanup(); return; } node.dataset.renderError = message; frame.remove(); clearTimeout(timer); clearInterval(cancel); window.removeEventListener('message', receive); };
  function receive(event) {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.nonce !== nonce || disposed || !isCurrent()) return;
    if (event.data.type === 'error') { fail('图形无法渲染，保留源码'); return; }
    if (event.data.type !== 'svg' || typeof event.data.svg !== 'string' || event.data.svg.length > 2 * 1024 * 1024) return;
    try {
      const value = sanitizedSvg(event.data.svg, event.data.styles); url = URL.createObjectURL(new Blob([value], { type: 'image/svg+xml' }));
      const img = doc.createElement('img'); img.src = url; img.alt = 'Mermaid 图形'; img.className = 'mermaid-image';
      const pre = doc.createElement('pre'); pre.textContent = source; pre.hidden = true;
      const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = '查看源码'; toggle.onclick = () => { pre.hidden = !pre.hidden; img.hidden = !pre.hidden; toggle.textContent = pre.hidden ? '查看源码' : '查看图形'; };
      node.replaceChildren(toggle, img, pre); frame.remove(); clearTimeout(timer); clearInterval(cancel); window.removeEventListener('message', receive);
    } catch { fail('图形无法渲染，保留源码'); }
  }
  window.addEventListener('message', receive);
  frame.onload = () => { if (!disposed && isCurrent()) frame.contentWindow.postMessage({ type: 'render', nonce, source }, '*'); };
  timer = setTimeout(() => fail('图形生成超时，保留源码'), 10000); cancel = setInterval(() => { if (!isCurrent()) cleanup(); }, 100);
  doc.body.append(frame); return cleanup;
}
export async function enhanceMarkdown(container, { isCurrent = () => true } = {}) {
  const cleanups = [];
  for (const code of container.querySelectorAll('code[class*="language-"]')) {
    if (code.dataset.enhanced || !isCurrent()) continue;
    const language = /(?:^|\s)language-([\w+-]+)/.exec(code.className)?.[1]; if (!language || !hljs.getLanguage(language) || code.textContent.length > MAX_TEXT) continue;
    const output = hljs.highlight(code.textContent, { language, ignoreIllegals: true }).value;
    code.replaceChildren(DOMPurify.sanitize(output, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], RETURN_DOM_FRAGMENT: true })); code.dataset.enhanced = 'true';
  }
  for (const math of container.querySelectorAll('[data-math]')) {
    if (math.dataset.enhanced || !isCurrent() || math.textContent.length > 16384) continue;
    try { const output = katex.renderToString(math.textContent, { output: 'mathml', trust: false, throwOnError: true, displayMode: math.dataset.display === 'true', maxExpand: 1000, maxSize: 20 }); math.replaceChildren(DOMPurify.sanitize(output, { USE_PROFILES: { mathMl: true }, FORBID_ATTR: ['style', 'href', 'xlink:href'], RETURN_DOM_FRAGMENT: true })); math.dataset.enhanced = 'true'; } catch { /* Preserve readable source. */ }
  }
  for (const diagram of container.querySelectorAll('pre[data-mermaid]')) {
    if (diagram.dataset.enhanced || !isCurrent() || diagram.textContent.length > 32768) continue;
    diagram.dataset.enhanced = 'true'; cleanups.push(mermaidImage(diagram, diagram.textContent, isCurrent));
  }
  return () => { for (const dispose of cleanups) dispose(); };
}
