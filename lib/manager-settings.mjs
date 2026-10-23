import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { writeJson } from './runtime.mjs';
import { assertPrivateFile } from './platform.mjs';

export const DEFAULT_SHARE_LIMIT = 10;
export const validShareLimit = value => value === null || (Number.isSafeInteger(value) && value > 0);

// Only the authenticated local manager can write these host-wide preferences.
export function createManagerSettings({ shareLimit = DEFAULT_SHARE_LIMIT, persist = async () => {} } = {}) {
  if (!validShareLimit(shareLimit)) throw new Error('共享上限必须为正整数或无限制');
  let writes = Promise.resolve();
  return {
    get: () => ({ shareLimit }),
    setShareLimit(value) {
      if (!validShareLimit(value)) return Promise.reject(new Error('共享上限必须为正整数或无限制'));
      const update = writes.then(async () => {
        await persist({ version: 1, shareLimit: value });
        shareLimit = value;
      });
      writes = update.catch(() => {});
      return update;
    },
    flush: () => writes,
  };
}

export async function openManagerSettings(file) {
  let shareLimit = DEFAULT_SHARE_LIMIT;
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      await assertPrivateFile(file, stat, { maxBytes: 4096 });
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !validShareLimit(data.shareLimit)) throw new Error('管理设置格式不兼容');
      shareLimit = data.shareLimit;
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return createManagerSettings({ shareLimit, persist: data => writeJson(file, data) });
}
