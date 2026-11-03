// markdown-it parses text only. Build allowlisted DOM nodes, never HTML strings.
(() => {
  const parser = window.markdownit({ html: false, linkify: false, typographer: false });
  parser.inline.ruler.after('escape', 'co2_math', (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== '$' || /\s/.test(state.src[start + 1] || ' ')) return false;
    const marker = state.src[start + 1] === '$' ? '$$' : '$';
    let end = state.src.indexOf(marker, start + marker.length);
    while (end > start && state.src[end - 1] === '\\') end = state.src.indexOf(marker, end + marker.length);
    if (end < 0 || /\s/.test(state.src[end - 1])) return false;
    if (!silent) { const token = state.push('co2_math', '', 0); token.content = state.src.slice(start + marker.length, end); token.markup = marker; }
    state.pos = end + marker.length; return true;
  });
  parser.block.ruler.before('fence', 'co2_math_block', (state, start, end, silent) => {
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (line.trim() !== '$$') return false;
    let close = start + 1;
    while (close < end && state.src.slice(state.bMarks[close], state.eMarks[close]).trim() !== '$$') close++;
    if (close === end) return false;
    if (!silent) { const token = state.push('co2_math', '', 0); token.content = state.getLines(start + 1, close, 0, false); token.markup = '$$'; }
    state.line = close + 1; return true;
  });
  const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  function appendTokens(parent, tokens, document, images) {
    const stack = [parent];
    for (const token of tokens) {
      const current = stack.at(-1);
      if (images.skipLink) {
        if (token.type === 'image') images.index++;
        if (token.type === 'link_open') { images.linkIndex++; images.skipLink++; }
        if (token.type === 'link_close') images.skipLink--;
        continue;
      }
      if (token.type === 'inline') { appendTokens(current, token.children || [], document, images); continue; }
      if (token.type === 'image') {
        const index = images.index++;
        if (images.render?.(current, index, token.content || token.attrGet('alt') || '图片') || images.file?.(current, index, 'image')) continue;
      }
      if (token.type === 'link_open') {
        const index = images.linkIndex++;
        if (images.file?.(current, index, 'link')) { images.skipLink = 1; continue; }
      }
      if (token.type === 'co2_math') {
        const node = document.createElement(token.markup === '$$' ? 'div' : 'span');
        node.setAttribute('data-math', ''); node.setAttribute('data-display', String(token.markup === '$$')); node.textContent = token.content;
        current.append(node); continue;
      }
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      if (token.nesting === 1) {
        const node = document.createElement(tags.has(token.tag) ? token.tag : token.type === 'link_open' ? 'a' : 'span');
        if (token.type === 'link_open') {
          const href = token.attrGet('href') || '';
          try {
            const url = new URL(href);
            if (['https:', 'http:'].includes(url.protocol)) {
              node.setAttribute('href', url.href);
              node.setAttribute('target', '_blank');
              node.setAttribute('rel', 'noopener noreferrer');
            }
          } catch { /* Relative and local links remain readable text. */ }
        }
        if (token.tag === 'ol' && token.attrGet('start')) node.setAttribute('start', token.attrGet('start'));
        if (token.hidden) node.className = 'markdown-tight';
        if (token.tag === 'table') {
          const wrap = document.createElement('div');
          wrap.className = 'table-scroll';
          wrap.setAttribute('tabindex', '0');
          wrap.setAttribute('aria-label', '表格，支持横向滚动');
          wrap.append(node); current.append(wrap);
        } else current.append(node);
        stack.push(node);
        continue;
      }
      if (token.type === 'fence' || token.type === 'code_block') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = token.content;
        const language = (token.info || '').trim().split(/\s/)[0];
        if (/^[a-zA-Z0-9_+-]{1,40}$/.test(language)) code.className = 'language-' + language;
        const closing = token.map && images.lines[token.map[1] - 1]?.trim();
        const completeFence = token.type === 'fence' && closing?.startsWith(token.markup) && [...closing].every(char => char === token.markup[0] || /\s/.test(char));
        if (language === 'mermaid' && completeFence) pre.setAttribute('data-mermaid', '');
        if (['math', 'latex'].includes(language)) { pre.setAttribute('data-math', ''); pre.setAttribute('data-display', 'true'); }
        pre.setAttribute('tabindex', '0');
        pre.append(code); current.append(pre);
      } else if (token.type === 'code_inline') {
        const code = document.createElement('code'); code.textContent = token.content; current.append(code);
      } else if (token.type === 'hardbreak') current.append(document.createElement('br'));
      else if (token.type === 'hr') current.append(document.createElement('hr'));
      else {
        const text = token.type === 'softbreak' ? '\n' : token.type === 'image' ? `[图片：${token.content || token.attrGet('alt') || '未加载'}]` : token.content;
        current.append(document.createTextNode(text || ''));
      }
    }
  }
  window.renderMarkdown = (container, text, { renderImage, renderFile } = {}) => {
    try { appendTokens(container, parser.parse(text, {}), container.ownerDocument || document, { index: 0, linkIndex: 0, render: renderImage, file: renderFile, lines: text.split(/\r?\n/) }); }
    catch { container.textContent = text; }
  };
})();
