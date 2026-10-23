import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedAttachmentPath } from '../lib/attachment-paths.mjs';

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
  for (const file of ['/synthetic/person/.codex/state_5.sqlite', '/work/.coop/manager-settings.json', '/work/credentials.json']) {
    assert.equal(protectedAttachmentPath(file, options), true);
  }
  assert.equal(protectedAttachmentPath('/work/project/note.md', options), false);
});
