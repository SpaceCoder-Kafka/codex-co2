import mermaid from 'mermaid';
let used = false;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false, maxTextSize: 32768, maxEdges: 500, flowchart: { htmlLabels: false }, secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'themeCSS', 'flowchart', 'fontFamily'] });
window.addEventListener('message', async event => {
  const value = event.data;
  if (used || event.source !== parent || !value || value.type !== 'render' || !/^[a-f0-9]{32}$/.test(value.nonce || '') || typeof value.source !== 'string' || value.source.length > 32768) return;
  used = true;
  const send = message => parent.postMessage({ nonce: value.nonce, ...message }, '*');
  try {
    // Input configuration, HTML and callbacks are outside this display-only bridge.
    if (/%%\s*\{|^\s*---|<\/?(?:script|iframe|img|svg|foreignObject)\b/i.test(value.source)) throw Error('不支持图内配置或 HTML');
    const result = await mermaid.render('diagram-' + value.nonce, value.source, document.getElementById('diagram'));
    if (result.svg.length > 2 * 1024 * 1024) throw Error('图形过大');
    const xml = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    const styles = [...xml.querySelectorAll('style')].map(node => { const css = node.textContent; node.remove(); return css; }).join('\n');
    for (const node of xml.querySelectorAll('[style]')) { node.setAttribute('data-co2-style', node.getAttribute('style')); node.removeAttribute('style'); }
    send({ type: 'svg', svg: new XMLSerializer().serializeToString(xml.documentElement), styles });
  } catch { send({ type: 'error' }); }
});
