import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { writeJson } from './runtime.mjs';

const clean = value => {
  if (!value || typeof value.threadId !== 'string' || !value.threadId || value.threadId.length > 100
    || typeof value.title !== 'string' || value.title.length > 300
    || typeof value.ownerName !== 'string' || value.ownerName.length > 80
    || typeof value.requireApproval !== 'boolean' || !Number.isSafeInteger(value.lastSharedAt)) return null;
  // Deliberately exclude all tokens, origins, guests, messages and transcript data.
  return { threadId: value.threadId, title: value.title, ownerName: value.ownerName,
    requireApproval: value.requireApproval, lastSharedAt: value.lastSharedAt };
};

export async function openShareHistory(file) {
  let records = [];
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 128 * 1024) throw new Error('分享历史文件需要同用户私有文件');
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('分享历史格式不兼容');
      records = data.entries.map(clean).filter(Boolean).slice(0, 50);
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  let failed = false;
  return {
    list: () => records.map(record => ({ ...record })),
    remember(value) {
      const entry = clean(value);
      if (!entry) return;
      records = [entry, ...records.filter(record => record.threadId !== entry.threadId)].slice(0, 50);
      const data = { version: 1, entries: records };
      writes = writes.catch(() => {}).then(() => writeJson(file, data)).then(() => { failed = false; }, () => { failed = true; });
    },
    get failed() { return failed; },
    flush: () => writes,
  };
}
