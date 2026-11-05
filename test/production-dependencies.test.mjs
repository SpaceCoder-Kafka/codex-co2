import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { distributionDependencyEntries, productionDependencyPlan, copyProductionDependencies, assertProductionDependencies } from '../scripts/production-dependencies.mjs';
import { npmNotices } from '../scripts/third-party-notices.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  await fs.mkdir(path.join(project, '.coop'), { recursive: true, mode: 0o700 });
  const root = await fs.realpath(await fs.mkdtemp(path.join(project, '.coop/runtime-dependencies-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(project, name), path.join(root, name));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json')));
  await fs.mkdir(path.join(root, 'node_modules'));
  for (const item of productionDependencyPlan(lock)) await fs.cp(path.join(project, item.relative), path.join(root, item.relative), { recursive: true, verbatimSymlinks: true });
  const service = path.join(root, 'service'); await fs.mkdir(service);
  return { root, lock, service, output: path.join(service, 'node_modules') };
}

test('published service dependency closure is exact while notices retain browser dependencies marked dev', async () => {
  const lock = JSON.parse(await fs.readFile(path.join(project, 'package-lock.json')));
  assert.deepEqual(Object.keys(lock.packages[''].dependencies).sort(), ['markdown-it', 'ws']);
  assert.equal(lock.packages['node_modules/mermaid'].dev, true);
  assert.deepEqual(productionDependencyPlan(lock).map(item => item.name).sort(), ['argparse', 'entities', 'linkify-it', 'markdown-it', 'mdurl', 'punycode.js', 'uc.micro', 'ws']);
  const names = distributionDependencyEntries(lock).map(([name]) => name);
  assert.ok(names.includes('node_modules/mermaid'));
  assert.ok(names.includes('node_modules/pdfjs-dist'));
  assert.ok(names.includes('node_modules/ws'));
  assert.ok(!names.includes('node_modules/esbuild'));
  assert.ok(!names.some(name => name.startsWith('node_modules/@esbuild/')));
  const unreviewed = structuredClone(lock); unreviewed.packages[''].devDependencies['new-browser-library'] = '1.0.0';
  assert.throws(() => distributionDependencyEntries(unreviewed), /Unreviewed browser-build dependency root/);
  const notices = await npmNotices(project);
  assert.match(notices, /mermaid@12\.2\.0/);
  assert.match(notices, /pdfjs-dist@6\.5\.438/);
  assert.match(notices, /LICENSE_JBIG2/);
  assert.doesNotMatch(notices, /\nesbuild@/);
});

test('cropped real modules run WebSocket, Node Markdown imports and browser Markdown without developer dependencies', async t => {
  const { root, service, output } = await fixture(t);
  await fs.mkdir(path.join(root, 'node_modules/ws/demo'));
  await fs.writeFile(path.join(root, 'node_modules/ws/demo/unused.js'), 'throw Error("demo must not ship")');
  const receipt = await copyProductionDependencies({ sourceRoot: root, destination: output });
  assert.equal((await assertProductionDependencies({ sourceRoot: root, nodeModules: output, receipt })).packages, 8);
  assert.equal((await assertProductionDependencies({ sourceRoot: '/nonexistent-build-copy', expectedLockSHA256: receipt.lockSHA256, nodeModules: output, receipt })).packages, 8);
  await assert.rejects(assertProductionDependencies({ expectedLockSHA256: '0'.repeat(64), nodeModules: output, receipt }), /does not match the lockfile/);
  assert.ok(!Object.keys(receipt.files).some(name => /\.map$|\.d\.[cm]?ts$|\/demo\/|\/test\/|\/bin\//.test(name)));
  assert.ok(!Object.keys(receipt.files).some(name => name.startsWith('mermaid/')));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    import {readFile} from 'node:fs/promises';
    import {createRequire} from 'node:module';
    import vm from 'node:vm';
    import WebSocket, {WebSocketServer} from 'ws';
    import MarkdownIt from 'markdown-it';
    const require=createRequire(import.meta.url);
    const markdown=new MarkdownIt({linkify:true});
    const html=markdown.render('# 中文测试\\n\\n[文件](/tmp/synthetic.pdf) &copy; https://example.invalid');
    assert.ok(html.includes('<h1>中文测试</h1>'));assert.ok(html.includes('©'));assert.ok(html.includes('https://example.invalid'));
    assert.ok(new (require('markdown-it'))().render('**兼容**').includes('<strong>兼容</strong>'));
    const browser={};vm.runInNewContext(await readFile(require.resolve('markdown-it/browser'),'utf8'),browser);
    assert.ok(browser.markdownit().render('**浏览器**').includes('<strong>浏览器</strong>'));
    const server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:true});await once(server,'listening');
    server.on('connection',socket=>socket.on('message',data=>socket.send(data)));
    const client=new WebSocket('ws://127.0.0.1:'+server.address().port);await once(client,'open');
    const echo=once(client,'message');client.send('synthetic compressed echo');assert.equal((await echo)[0].toString(),'synthetic compressed echo');
    const closed=once(client,'close');client.close();await closed;await new Promise(resolve=>server.close(resolve));
    console.log('cropped service modules ready');
  `], { cwd: service, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'C' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cropped service modules ready/);
});

test('package and receipt validation reject unreviewed versions, missing runtime files and stale locks', async t => {
  const { root, output, lock } = await fixture(t);
  const wrong = structuredClone(lock); wrong.packages['node_modules/ws'].version = '8.22.1';
  assert.throws(() => productionDependencyPlan(wrong), /Unreviewed runtime dependency version/);
  const file = path.join(root, 'node_modules/ws/index.js'); await fs.rm(file);
  await assert.rejects(copyProductionDependencies({ sourceRoot: root, destination: output }), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  await fs.copyFile(path.join(project, 'node_modules/ws/index.js'), file);
  const receipt = await copyProductionDependencies({ sourceRoot: root, destination: output });
  lock.packages[''].version = '0.4.999'; await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(assertProductionDependencies({ sourceRoot: root, nodeModules: output, receipt }), /does not match the lockfile/);
});

test('runtime validation rejects added files/directories, tampered bytes and linked source files', async t => {
  const { root, output } = await fixture(t);
  const outside = path.join(root, 'synthetic-outside.js'); await fs.writeFile(outside, 'synthetic sentinel');
  const input = path.join(root, 'node_modules/ws/lib/constants.js');
  await fs.rm(input); await fs.symlink(outside, input);
  await assert.rejects(copyProductionDependencies({ sourceRoot: root, destination: output }), /Unsafe dependency file/);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  await fs.rm(input); await fs.copyFile(path.join(project, 'node_modules/ws/lib/constants.js'), input);
  const receipt = await copyProductionDependencies({ sourceRoot: root, destination: output });
  const extra = path.join(output, 'extra-package'); await fs.mkdir(extra);
  await assert.rejects(assertProductionDependencies({ sourceRoot: root, nodeModules: output, receipt }), /directory inventory mismatch/);
  await fs.rm(extra, { recursive: true });
  const map = path.join(output, 'ws/extra.js.map'); await fs.writeFile(map, '{}');
  await assert.rejects(assertProductionDependencies({ sourceRoot: root, nodeModules: output, receipt }), /file inventory mismatch/);
  await fs.rm(map);
  await fs.appendFile(path.join(output, 'ws/lib/constants.js'), '\n// synthetic tamper');
  await assert.rejects(assertProductionDependencies({ sourceRoot: root, nodeModules: output, receipt }), /digest mismatch/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic sentinel');
  await assert.rejects(copyProductionDependencies({ sourceRoot: root, destination: output }), { code: 'EEXIST' });
});
