import { Unzip, UnzipInflate } from 'fflate';

export const OFFICE_LIMITS = Object.freeze({ entries: 4096, entry: 8 * 1024 * 1024, expanded: 64 * 1024 * 1024, nodes: 30000, xml: 4 * 1024 * 1024 });
const decoder = new TextDecoder('utf-8', { fatal: true });
const safeEntry = name => name && name.length < 512 && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !name.split('/').some(p => p === '..' || p === '.');

// Count actual decompressor output, including entries we do not render. Metadata
// alone cannot bound an adversarial ZIP. This function also runs in the worker.
export function unpackOffice(bytes) {
  const entries = new Map(); let count = 0, expanded = 0, failure;
  const unzip = new Unzip(file => {
    if (++count > OFFICE_LIMITS.entries || !safeEntry(file.name) || entries.has(file.name)) throw Error('Office ZIP 条目无效或过多');
    const chunks = []; let size = 0;
    const keep = /(?:\.xml|\.rels|\.(?:png|jpe?g|webp))$/i.test(file.name);
    file.ondata = (error, data, final) => {
      if (error) { failure = error; return; }
      size += data.length; expanded += data.length;
      if (size > OFFICE_LIMITS.entry || expanded > OFFICE_LIMITS.expanded) { failure = Error('Office 解压内容超过预览上限'); file.terminate(); return; }
      if (keep) chunks.push(data);
      if (final) {
        if (!keep) { entries.set(file.name, null); return; }
        const value = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
        entries.set(file.name, value);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Bound each inflater invocation: a tiny DEFLATE stream must not allocate
  // the entire expanded document before the size callback can reject it.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
    if (failure) throw failure;
  }
  if (failure) throw failure;
  if (!entries.has('[Content_Types].xml')) throw Error('不是可识别的 Office 文件');
  return [...entries].filter(([, value]) => value !== null);
}

export function validatePackageXml(entries, { rejectExternal = false } = {}) {
  for (const [name, bytes] of entries) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue;
    if (bytes.length > OFFICE_LIMITS.xml) throw Error('Office XML 超过解析上限');
    const text = decoder.decode(bytes);
    if (text.includes('\0') || /<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('Office XML 不允许实体或文档类型声明');
    if (rejectExternal && /\.rels$/i.test(name) && /TargetMode\s*=\s*['"]External['"]/i.test(text)) throw Error('Office 包含外部资源关系，请下载原件查看');
  }
}

export function officeXml(bytes, parser = new DOMParser()) {
  if (!bytes || bytes.length > OFFICE_LIMITS.xml) throw Error('Office XML 缺失或过大');
  const text = decoder.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('Office XML 不允许实体或文档类型声明');
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw Error('Office XML 无效');
  return doc;
}
const children = (node, name) => [...node.children].filter(c => c.localName === name);
const descendants = (node, name) => [...node.getElementsByTagName('*')].filter(c => c.localName === name);
const first = (node, name) => descendants(node, name)[0];
const attr = (node, name) => node && [...node.attributes].find(a => a.localName === name)?.value;
const number = (value, max = 100000000) => { const n = Number(value); return Number.isFinite(n) && Math.abs(n) <= max ? n : 0; };

export function packageTarget(source, target) {
  if (typeof target !== 'string' || /[\\\0]|^[a-z][a-z0-9+.-]*:|^\//i.test(target)) return null;
  const parts = source.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function rasterMime(bytes) {
  if (!bytes || bytes.length > OFFICE_LIMITS.entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const w = view.getUint32(16), h = view.getUint32(20);
    return w && h && w <= 16384 && h <= 16384 && w * h <= 16777216 ? 'image/png' : null;
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    let w = 0, h = 0;
    if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8X') {
      w = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); h = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8 ') { w = view.getUint16(26, true) & 16383; h = view.getUint16(28, true) & 16383; }
    else if (bytes.length >= 25 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true); w = (bits & 16383) + 1; h = ((bits >>> 14) & 16383) + 1;
    }
    return w && h && w <= 16384 && h <= 16384 && w * h <= 16777216 ? 'image/webp' : null;
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset++] !== 255) return null;
      let marker = bytes[offset++]; while (marker === 255) marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const size = view.getUint16(offset); if (size < 2 || offset + size > bytes.length) return null;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        const h = view.getUint16(offset + 3), w = view.getUint16(offset + 5);
        return w && h && w <= 16384 && h <= 16384 && w * h <= 16777216 ? 'image/jpeg' : null;
      }
      offset += size;
    }
  }
  return null;
}

export async function mountOffice({ container, bytes, kind, isCurrent = () => true }) {
  let worker, disposed = false, timer, monitor, rejectPending;
  const urls = new Set(), cleanups = [];
  const dispose = () => { disposed = true; worker?.terminate(); clearTimeout(timer); clearInterval(monitor); rejectPending?.(Error('预览已取消')); rejectPending = null; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); for (const fn of cleanups) fn(); };
  try {
  const data = await new Promise((resolve, reject) => {
    rejectPending = reject;
    monitor = setInterval(() => { if (!isCurrent()) dispose(); }, 100);
    worker = new Worker('/vendor/office.worker.mjs', { type: 'module' });
    timer = setTimeout(() => { worker.terminate(); clearInterval(monitor); reject(Error('Office 解析超时')); }, 15000);
    worker.onmessage = event => { clearTimeout(timer); clearInterval(monitor); worker.terminate(); rejectPending = null; event.data.error ? reject(Error(event.data.error)) : resolve(event.data.entries); };
    worker.onerror = () => { clearTimeout(timer); clearInterval(monitor); worker.terminate(); reject(Error('Office 解析失败')); };
    // Keep the original bytes intact for a later download.
    const copy = bytes.slice(); worker.postMessage(copy, [copy.buffer]);
  });
  if (disposed || !isCurrent()) { dispose(); return { dispose }; }
  const entries = new Map(data), doc = container.ownerDocument, warnings = new Set(); let nodes = 0;
  function create(tag, text) { if (++nodes > OFFICE_LIMITS.nodes) throw Error('Office 内容超过显示上限，请下载原件查看'); const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  const xml = path => officeXml(entries.get(path));
  function relationships(source) {
    const names = source.split('/'), name = names.pop(), path = [...names, '_rels', name + '.rels'].join('/');
    const out = new Map(); if (!entries.has(path)) return out;
    for (const rel of descendants(xml(path), 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') { warnings.add('外部资源未加载'); continue; }
      const target = packageTarget(source, rel.getAttribute('Target'));
      if (target && entries.has(target)) out.set(rel.getAttribute('Id'), target);
    }
    return out;
  }
  function image(parent, source, id) {
    const path = relationships(source).get(id), data = entries.get(path), mime = rasterMime(data);
    if (!mime) { parent.append(create('span', '〔图片格式或尺寸不支持〕')); return; }
    const url = URL.createObjectURL(new Blob([data], { type: mime })); urls.add(url);
    const img = create('img'); img.src = url; img.alt = '文档内嵌图片'; img.loading = 'lazy'; img.className = 'office-image'; parent.append(img);
  }
  function run(parent, node, source) {
    for (const child of node.children) {
      if (child.localName === 't') parent.append(doc.createTextNode(child.textContent));
      else if (child.localName === 'tab') parent.append(doc.createTextNode('\t'));
      else if (child.localName === 'br') parent.append(create('br'));
      else if (['drawing', 'pict'].includes(child.localName)) {
        const blip = first(child, 'blip'); if (blip) image(parent, source, attr(blip, 'embed')); else warnings.add('部分浮动对象未展示');
      }
    }
  }
  function paragraph(node, source) {
    const style = attr(first(node, 'pStyle'), 'val') || '', heading = /heading([1-6])/i.exec(style);
    const p = create(heading ? 'h' + heading[1] : 'p');
    if (first(node, 'numPr')) { p.className = 'office-list-item'; p.append(doc.createTextNode('• ')); }
    for (const r of descendants(node, 'r')) {
      const span = create('span'), props = children(r, 'rPr')[0];
      if (props) {
        if (children(props, 'b').length && attr(children(props, 'b')[0], 'val') !== '0') span.style.fontWeight = 'bold';
        if (children(props, 'i').length) span.style.fontStyle = 'italic';
        if (children(props, 'u').length) span.style.textDecoration = 'underline';
        const color = attr(first(props, 'color'), 'val'); if (/^[0-9a-f]{6}$/i.test(color || '')) span.style.color = '#' + color;
      }
      run(span, r, source); p.append(span);
    }
    const align = attr(first(node, 'jc'), 'val'); if (['left', 'right', 'center', 'justify'].includes(align)) p.style.textAlign = align;
    return p;
  }
  function wordTable(node, source) {
    const table = create('table'); table.className = 'office-table';
    const vertical = new Map();
    for (const row of children(node, 'tr')) {
      const tr = create('tr'); let column = 0;
      for (const cell of children(row, 'tc')) {
        const span = Math.max(1, number(attr(first(cell, 'gridSpan'), 'val'), 100)), merge = first(children(cell, 'tcPr')[0] || cell, 'vMerge');
        if (merge && attr(merge, 'val') !== 'restart' && vertical.has(column)) {
          const previous = vertical.get(column); previous.rowSpan = (previous.rowSpan || 1) + 1;
          for (const child of children(cell, 'p')) if (child.textContent.trim()) previous.append(paragraph(child, source));
          column += span; continue;
        }
        const td = create('td'); if (span > 1) td.colSpan = span;
        for (const child of cell.children) { if (child.localName === 'p') td.append(paragraph(child, source)); else if (child.localName === 'tbl') td.append(wordTable(child, source)); }
        if (merge && attr(merge, 'val') === 'restart') vertical.set(column, td); else vertical.delete(column);
        column += span; tr.append(td);
      }
      table.append(tr);
    }
    return table;
  }
  const body = create('div'); body.className = 'office-document';
  if (kind === 'docx') {
    const source = 'word/document.xml', document = xml(source), root = first(document, 'body');
    if (!root) throw Error('Word 正文不存在');
    for (const child of root.children) {
      if (child.localName === 'p') body.append(paragraph(child, source));
      else if (child.localName === 'tbl') body.append(wordTable(child, source));
      else if (child.localName !== 'sectPr') warnings.add('部分文档对象未展示');
    }
    if (descendants(document, 'altChunk').length || descendants(document, 'object').length) warnings.add('嵌入对象未执行或加载');
    warnings.add('阅读视图保留主要内容；复杂分页、修订和浮动布局请下载原件查看');
  } else {
    const source = 'ppt/presentation.xml', presentation = xml(source), rels = relationships(source);
    const slides = descendants(presentation, 'sldId').map(s => rels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id'))).filter(Boolean);
    if (!slides.length || slides.length > 500) throw Error('幻灯片为空或超过 500 页');
    const size = first(presentation, 'sldSz'), width = number(size?.getAttribute('cx')) || 12192000, height = number(size?.getAttribute('cy')) || 6858000;
    let index = 0, contentOnly = false;
    const nav = create('div'); nav.className = 'preview-toolbar';
    const previous = create('button', '上一页'), label = create('span'), next = create('button', '下一页'), mode = create('button', '内容列表');
    for (const button of [previous, next, mode]) button.type = 'button'; nav.append(previous, label, next, mode); body.append(nav);
    const slide = create('div'); body.append(slide);
    function draw() {
      if (disposed || !isCurrent()) return;
      for (const url of urls) URL.revokeObjectURL(url); urls.clear(); nodes = 10;
      slide.replaceChildren(); slide.className = contentOnly ? 'office-slide-content' : 'office-slide'; slide.style.aspectRatio = String(width / height);
      const path = slides[index], document = xml(path), tree = first(document, 'spTree');
      if (!tree) throw Error('幻灯片内容缺失');
      for (const shape of tree.children) {
        if (!['sp', 'pic', 'graphicFrame', 'grpSp'].includes(shape.localName)) continue;
        const block = create('div'); block.className = 'office-shape';
        const transform = first(shape, 'xfrm'), off = transform && children(transform, 'off')[0], ext = transform && children(transform, 'ext')[0];
        if (!contentOnly && off && ext) {
          block.style.position = 'absolute'; block.style.left = number(off.getAttribute('x')) / width * 100 + '%'; block.style.top = number(off.getAttribute('y')) / height * 100 + '%';
          block.style.width = Math.max(1, number(ext.getAttribute('cx')) / width * 100) + '%'; block.style.height = Math.max(1, number(ext.getAttribute('cy')) / height * 100) + '%';
        }
        for (const p of descendants(shape, 'p')) {
          const text = descendants(p, 't').map(t => t.textContent).join(''); if (text) block.append(create('p', text));
        }
        for (const blip of descendants(shape, 'blip')) image(block, path, attr(blip, 'embed'));
        for (const tbl of descendants(shape, 'tbl')) {
          const table = create('table'); table.className = 'office-table';
          for (const row of children(tbl, 'tr')) { const tr = create('tr'); for (const cell of children(row, 'tc')) tr.append(create('td', descendants(cell, 't').map(t => t.textContent).join(''))); table.append(tr); }
          block.replaceChildren(table);
        }
        if (!block.childNodes.length || descendants(shape, 'chart').length || descendants(shape, 'relIds').length) block.append(create('span', '〔图表、SmartArt 或复杂对象：请下载原件查看〕'));
        slide.append(block);
      }
      label.textContent = `${index + 1} / ${slides.length}`; previous.disabled = index === 0; next.disabled = index === slides.length - 1; mode.textContent = contentOnly ? '基本布局' : '内容列表';
    }
    previous.onclick = () => { index--; draw(); }; next.onclick = () => { index++; draw(); }; mode.onclick = () => { contentOnly = !contentOnly; draw(); }; draw();
    warnings.add('基本布局预览；字体、母版、图表、动画和复杂组合可能降级，可切换内容列表');
  }
  container.append(body);
  for (const warning of warnings) { const note = create('p', warning); note.className = 'preview-note'; container.append(note); }
  return { dispose };
  } catch (error) { dispose(); throw error; }
}
