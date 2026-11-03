import MarkdownIt from 'markdown-it';

// Keep math boundaries identical to the browser: formula source is not a file link.
export function createContentMarkdown() {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
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
  return parser;
}
