import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { protectedAttachmentPath, resolveAttachmentPath } from '../lib/attachment-paths.mjs';

test('Windows attachment boundaries reject case aliases, private state and non-local filesystem namespaces', () => {
  const options = { platform: 'win32', home: 'C:\\Synthetic\\Person' };
  for (const file of ['c:\\synthetic\\PERSON\\.CODEX\\state_5.sqlite', 'C:/Synthetic/Person/.SSH/key.txt',
    'C:\\Work\\.COOP\\sharing-history.json', 'C:\\Work\\AUTH.JSON', 'C:\\Work\\note.txt:stream.md',
    '\\\\server\\share\\note.md', '\\\\?\\C:\\Work\\note.md', 'C:\\Work\\NUL.txt', 'C:\\Work.\\note.md']) {
    assert.equal(protectedAttachmentPath(file, options), true, file);
  }
  assert.equal(protectedAttachmentPath('C:\\Work\\note.md', options), false);
  const image = 'c:\\synthetic\\person\\.codex\\VISUALIZATIONS\\image.png';
  assert.equal(protectedAttachmentPath(image, options), true);
  assert.equal(protectedAttachmentPath(image, { ...options, allowVisualizations: true }), false);
});

test('POSIX attachment boundaries preserve generated-image exception without exposing private runtime files', () => {
  const options = { platform: 'darwin', home: '/synthetic/person' };
  assert.equal(protectedAttachmentPath('/synthetic/person/.codex/visualizations/image.png', { ...options, allowVisualizations: true }), false);
  assert.equal(protectedAttachmentPath('/synthetic/person/.codex/Visualizations/data.trace', { ...options, allowVisualizations: true }), true);
  for (const file of ['/synthetic/person/.codex/state_5.sqlite', '/synthetic/Person/.Codex/state_5.sqlite',
    '/work/.coop/manager-settings.json', '/work/.Coop/private-data', '/work/credentials.json']) {
    assert.equal(protectedAttachmentPath(file, options), true);
  }
  assert.equal(protectedAttachmentPath('/work/project/note.md', options), false);
});

test('retained uploads keep working through a migrated runtime alias but cannot resolve outside their upload directory', async t => {
  if (process.platform === 'win32') return t.skip('POSIX migration alias');
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-paths-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'active', '.coop'), oldRuntime = path.join(dir, 'previous', '.coop');
  const relative = path.join('guest-uploads', randomUUID(), randomUUID(), 'synthetic.txt');
  const file = path.join(runtime, relative), oldFile = path.join(oldRuntime, relative);
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'synthetic');
  await fs.mkdir(path.dirname(oldRuntime)); await fs.symlink(runtime, oldRuntime);
  assert.equal(await resolveAttachmentPath(oldFile), file);
  const relocated = path.join(dir, 'relocated');
  await fs.rename(path.dirname(file), relocated); await fs.symlink(relocated, path.dirname(file));
  await assert.rejects(resolveAttachmentPath(oldFile), /attachment path changed/);
});
