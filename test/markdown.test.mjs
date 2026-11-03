import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';

class Node {
  constructor(tag = '#text') { this.tag = tag; this.children = []; this.attrs = {}; this.value = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attrs[name] = value; }
  set innerHTML(_) { throw new Error('No HTML injection'); }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map(n => n.textContent).join(''); }
}
const document = { createElement: tag => new Node(tag), createTextNode(text) { const node = new Node(); node.textContent = text; return node; } };
const window = { markdownit: MarkdownIt };
vm.runInNewContext(fs.readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8'), { window, document, URL });
function render(text) { const node = new Node('div'); window.renderMarkdown(node, text); return node; }
function all(node, tag) { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(c => all(c, tag))]; }

test('assistant Markdown renders semantic headings, emphasis, nested lists, quotes, code and scrollable tables', () => {
  const node = render('# 标题\n\n段落 **加粗** 与 `code`\n\n- 第一项\n  - 嵌套项\n\n> 引用\n\n```js\nconst a = 1;\n```\n\n| 名称 | 结果 |\n| --- | --- |\n| 测试 | 成功 |');
  for (const tag of ['h1', 'p', 'strong', 'ul', 'li', 'blockquote', 'pre', 'code', 'table', 'th', 'td']) assert.ok(all(node, tag).length, tag);
  assert.equal(all(node, 'table')[0].children[0].tag, 'thead');
  assert.ok(all(node, 'div').some(n => n.className === 'table-scroll'));
  assert.match(node.textContent, /嵌套项/);
});

test('raw HTML, scripts, unsafe/local links and images cannot create executable DOM or load remote assets', () => {
  const node = render('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [file](file:///etc/passwd) [relative](/secret) [safe](https://example.com/a)\n\n![图片说明](https://tracker.example/a.png)');
  for (const tag of ['script', 'img', 'iframe', 'svg']) assert.equal(all(node, tag).length, 0);
  const links = all(node, 'a');
  assert.equal(links.filter(n => n.attrs.href).length, 1);
  assert.equal(links.find(n => n.attrs.href).attrs.href, 'https://example.com/a');
  assert.equal(links.find(n => n.attrs.href).attrs.rel, 'noopener noreferrer');
  assert.match(node.textContent, /<script>/);
  assert.match(node.textContent, /图片说明/);
});

test('streaming incomplete Markdown and large code blocks stay readable', () => {
  for (const text of ['**正在', '```js\nconst unfinished =', '[尚未完成](', '| 名称 |']) assert.ok(render(text).textContent.length);
  const text = '<code> '.repeat(8000);
  assert.equal(all(render('```\n' + text), 'code')[0].textContent.trimEnd(), text.trimEnd());
});

test('image callback binds previews to parsed image positions while keeping code literal and unsupported images readable', () => {
  const node = new Node('div'), images = [];
  window.renderMarkdown(node, '之前 ![本地](/synthetic/a.png) ![不支持](/bad.svg)\n\n`![代码](/code.png)`\n\n之后 ![远程](https://example.invalid/a.png)', {
    renderImage(parent, index, alt) {
      images.push({ index, alt });
      if (index === 1) return false;
      const image = document.createElement('img'); image.setAttribute('alt', alt); parent.append(image); return true;
    },
  });
  assert.deepEqual(images, [{ index: 0, alt: '本地' }, { index: 1, alt: '不支持' }, { index: 2, alt: '远程' }]);
  assert.equal(all(node, 'img').length, 2);
  assert.match(node.textContent, /\[图片：不支持\]/);
  assert.equal(all(node, 'code')[0].textContent, '![代码](/code.png)');
  assert.match(node.textContent, /之前.*之后/s);
});

test('file callback binds real links and media without duplicate labels or code-example scope', () => {
  const node = new Node('div'), calls = [];
  window.renderMarkdown(node, '[web](https://example.invalid) [结果](/synthetic/out.pdf) ![声音](/synthetic/voice.wav) `[/example](/synthetic/code.pdf)`', {
    renderFile(parent, index, syntax) {
      calls.push({ index, syntax });
      if (syntax === 'link' && index === 0) return false;
      const card = new Node('button'); card.textContent = '产物'; parent.append(card); return true;
    },
  });
  assert.deepEqual(calls, [{ index: 0, syntax: 'link' }, { index: 1, syntax: 'link' }, { index: 0, syntax: 'image' }]);
  assert.equal(all(node, 'button').length, 2); assert.ok(!node.textContent.includes('结果')); assert.match(node.textContent, /code.pdf/);
});

test('standalone file context follows one top-level paragraph link without changing token positions', () => {
  const node = new Node('div'), calls = [];
  const source = '[**Word 文档**](/synthetic/out.docx)\n\n正文 [链接](/synthetic/readme.md)。\n\n- [列表](/synthetic/list.pdf)\n\n> [引用](/synthetic/quote.pdf)\n\n# [标题](/synthetic/title.pdf)\n\n[一](/synthetic/a.pdf) [二](/synthetic/b.csv)\n\n![图片](/synthetic/a.png)\n\n`[代码](/synthetic/code.docx)`\n\n[最后的 `表格`](/synthetic/final.xlsx)';
  window.renderMarkdown(node, source, { renderFile(parent, index, syntax, context) {
    calls.push({ index, syntax, standalone: context?.standalone === true });
    if (syntax !== 'link' || !context?.standalone) return false;
    const card = new Node('button'); card.textContent = '独立文档'; parent.append(card); return true;
  } });
  assert.deepEqual(calls, [
    { index: 0, syntax: 'link', standalone: true },
    ...Array.from({ length: 6 }, (_, index) => ({ index: index + 1, syntax: 'link', standalone: false })),
    { index: 0, syntax: 'image', standalone: false },
    { index: 7, syntax: 'link', standalone: true },
  ]);
  assert.equal(all(node, 'button').length, 2);
  assert.match(node.textContent, /正文 链接。/);
  assert.match(node.textContent, /\[代码\]\(\/synthetic\/code\.docx\)/);
  assert.equal(all(node, 'strong').length, 0, 'handled labels do not render a duplicate formatted caption');
});

test('math, Mermaid and language fences expose only inert enhancement targets and preserve incomplete source', () => {
  const node = render('$x^2$\n\n$$\nx+y\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x=1\n```');
  const nodes = tag => all(node, tag);
  assert.ok(nodes('span').some(n => Object.hasOwn(n.attrs, 'data-math')));
  assert.ok(nodes('div').some(n => n.attrs['data-display'] === 'true'));
  assert.ok(nodes('pre').some(n => Object.hasOwn(n.attrs, 'data-mermaid')));
  assert.ok(nodes('code').some(n => n.className === 'language-js'));
  assert.equal(render('$unfinished').textContent, '$unfinished');
  assert.equal(all(node, 'script').length, 0);
});

test('an unfinished Mermaid fence stays literal until its closing fence arrives', () => {
  const source = '```mermaid\ngraph TD; A-->B';
  assert.equal(all(render(source), 'pre').some(node => Object.hasOwn(node.attrs, 'data-mermaid')), false);
  assert.equal(all(render(source + '\n```'), 'pre').some(node => Object.hasOwn(node.attrs, 'data-mermaid')), true);
});
