import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Packaged services validate only generated, explicitly named resources. They
// never invoke a compiler or search node_modules at request time.
export async function loadWebAssets(publicDir) {
  publicDir = await fs.realpath(publicDir);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourcePublic = path.join(root, 'public');
  if (path.resolve(publicDir) === path.resolve(sourcePublic)) {
    const builder = new URL('../scripts/build-web.mjs', import.meta.url);
    try { await fs.access(builder); }
    catch { return readWebAssets(publicDir, true); }
    const { ensureWebAssets } = await import(builder.href);
    await ensureWebAssets();
  }
  return readWebAssets(publicDir, path.resolve(publicDir) === path.resolve(sourcePublic));
}
export async function readWebAssets(publicDir, required = false) {
  publicDir = await fs.realpath(publicDir);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(publicDir, 'vendor/asset-manifest.json'), 'utf8')); }
  catch (error) { if (!required && error.code === 'ENOENT') return {}; throw error; }
  if (manifest.version !== 1 || !manifest.assets || !manifest.files) throw Error('Invalid preview resource manifest');
  const assets = {};
  for (const [url, relative] of Object.entries(manifest.assets)) {
    if ((!/^\/vendor\/(?:pdf-(?:cmaps|fonts|images|codecs)\/)?[a-zA-Z0-9._-]+$/.test(url) && url !== '/rich-render.html')
      || typeof relative !== 'string' || relative.includes('..') || path.isAbsolute(relative)
      || relative.includes('\\') || !/^(?:vendor\/(?:pdf-(?:cmaps|fonts|images|codecs)\/)?[a-zA-Z0-9._-]+|rich-render\.html)$/.test(relative)) throw Error('Unsafe preview resource');
    const file = path.join(publicDir, relative);
    if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw Error('Invalid preview resource file');
    const bytes = await fs.readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[url]) throw Error('Preview resource digest mismatch');
    assets[url] = [file, url.endsWith('.html') ? 'text/html; charset=utf-8' : url.endsWith('.ttf') ? 'font/ttf' : /\.(?:bcmap|pfb)$/.test(url) ? 'application/octet-stream' : 'text/javascript; charset=utf-8'];
  }
  return assets;
}
