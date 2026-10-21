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
