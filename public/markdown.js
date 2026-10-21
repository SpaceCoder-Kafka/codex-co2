// markdown-it parses text only. Build allowlisted DOM nodes, never HTML strings.
(() => {
  const parser = window.markdownit({ html: false, linkify: false, typographer: false });
  const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  function appendTokens(parent, tokens, document) {
    const stack = [parent];
    for (const token of tokens) {
      const current = stack.at(-1);
      if (token.type === 'inline') { appendTokens(current, token.children || [], document); continue; }
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
  window.renderMarkdown = (container, text) => {
    try { appendTokens(container, parser.parse(text, {}), container.ownerDocument || document); }
    catch { container.textContent = text; }
  };
})();
