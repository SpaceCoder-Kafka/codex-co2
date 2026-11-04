import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = ['package-lock.json', 'public/preview-renderers.mjs', 'public/office-preview.mjs', 'public/office-worker.mjs', 'public/xlsx-worker.mjs', 'public/rich-render.mjs', 'public/rich-render.html', 'scripts/build-web.mjs'];
const mime = name => name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.ttf') ? 'font/ttf' : /\.(?:bcmap|pfb)$/.test(name) ? 'application/octet-stream' : 'text/javascript; charset=utf-8';
async function sourceDigest(root) {
  const hash = createHash('sha256');
  for (const name of inputs) { hash.update(name); hash.update(await fs.readFile(path.join(root, name))); }
  return hash.digest('hex');
}
export async function buildWeb({ root = projectRoot, publicDir = path.join(root, 'public'), dependencyRoot = root, stopService = false } = {}) {
  const dependencyRequire = createRequire(path.join(dependencyRoot, 'package.json'));
  const { build, stop } = dependencyRequire('esbuild');
  try {
  const within = value => value === dependencyRoot || value.startsWith(dependencyRoot + path.sep);
  const isolatedDependencies = { name: 'locked-dependency-root', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.isolatedResolution || args.path.startsWith('node:') || path.isAbsolute(args.path)) return;
      const result = await builder.resolve(args.path, { kind: args.kind, resolveDir: within(args.resolveDir) ? args.resolveDir : dependencyRoot, pluginData: { isolatedResolution: true } });
      if (!result.errors.length && !result.external && !within(result.path)) return { errors: [{ text: 'Dependency escaped the isolated install: ' + args.path }] };
      return result;
    });
  } };
  const vendor = path.join(publicDir, 'vendor');
  await fs.mkdir(vendor, { recursive: true });
  const common = { bundle: true, minify: true, sourcemap: false, platform: 'browser', target: ['chrome120', 'firefox122', 'safari17'], legalComments: 'inline', logLevel: 'silent', plugins: [isolatedDependencies] };
  const result = await build({ ...common, absWorkingDir: root, entryPoints: { previews: 'public/preview-renderers.mjs', 'office.worker': 'public/office-worker.mjs', 'xlsx.worker': 'public/xlsx-worker.mjs' }, outdir: vendor, format: 'esm', splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'chunk-[hash]', metafile: true, external: ['node:*', '@napi-rs/canvas'] });
  await build({ ...common, absWorkingDir: root, entryPoints: ['public/rich-render.mjs'], outfile: path.join(vendor, 'rich-render.js'), format: 'iife', external: ['node:*'] });
  await fs.copyFile(dependencyRequire.resolve('pdfjs-dist/build/pdf.worker.mjs'), path.join(vendor, 'pdf.worker.mjs'));
  const names = Object.keys(result.metafile.outputs).map(name => path.relative(vendor, path.resolve(root, name)));
  names.push('rich-render.js', 'pdf.worker.mjs');
  const pdfRoot = path.resolve(path.dirname(dependencyRequire.resolve('pdfjs-dist/build/pdf.worker.mjs')), '..');
  for (const [source, destination, allowed] of [['cmaps', 'pdf-cmaps', /\.bcmap$/], ['standard_fonts', 'pdf-fonts', /\.(?:pfb|ttf)$/], ['wasm', 'pdf-codecs', /^(?:jbig2|openjpeg)_nowasm_fallback\.js$/]]) {
    const files = (await fs.readdir(path.join(pdfRoot, source))).filter(name => allowed.test(name)).sort();
    await fs.mkdir(path.join(vendor, destination), { recursive: true });
    for (const name of files) { await fs.copyFile(path.join(pdfRoot, source, name), path.join(vendor, destination, name)); names.push(destination + '/' + name); }
  }
  const assets = Object.fromEntries(names.sort().map(name => ['/vendor/' + name.replaceAll(path.sep, '/'), 'vendor/' + name.replaceAll(path.sep, '/')]));
  assets['/rich-render.html'] = 'rich-render.html';
  const manifest = { version: 1, sourceSHA256: await sourceDigest(root), assets, files: {} };
  for (const [url, name] of Object.entries(assets)) manifest.files[url] = createHash('sha256').update(await fs.readFile(path.join(publicDir, name))).digest('hex');
  await fs.writeFile(path.join(vendor, 'asset-manifest.json'), JSON.stringify(manifest));
  return assets;
  } finally {
    // Packaging owns an isolated install that is pruned immediately after this
    // call. Release the compiler executable before Windows removes that tree.
    if (stopService) await stop();
  }
}
const builds = new Map();
export async function ensureWebAssets({ root = projectRoot, publicDir = path.join(root, 'public') } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(publicDir, 'vendor/asset-manifest.json'), 'utf8'));
    if (manifest.version !== 1 || manifest.sourceSHA256 !== await sourceDigest(root)) manifest = null;
    else for (const [url, name] of Object.entries(manifest.assets)) {
      if (!/^\/vendor\/(?:pdf-(?:cmaps|fonts|codecs)\/)?[a-zA-Z0-9._-]+$/.test(url) && url !== '/rich-render.html' || typeof name !== 'string' || name.includes('..') || path.isAbsolute(name)) throw Error('Invalid web asset manifest');
      const bytes = await fs.readFile(path.join(publicDir, name));
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[url]) { manifest = null; break; }
    }
  } catch { manifest = null; }
  if (!manifest) {
    const key = root + '\0' + publicDir;
    if (!builds.has(key)) builds.set(key, buildWeb({ root, publicDir }).finally(() => builds.delete(key)));
    await builds.get(key); return ensureWebAssets({ root, publicDir });
  }
  return Object.fromEntries(Object.entries(manifest.assets).map(([url, name]) => [url, [path.join(publicDir, name), mime(name)]]));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = await buildWeb(); console.log(`Built ${Object.keys(assets).length} self-hosted preview resources.`);
}
