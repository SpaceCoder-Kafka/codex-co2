import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { privateIPv4 } from './lan-network.mjs';
import { writeJson } from './runtime.mjs';
import { assertPrivateFile } from './platform.mjs';

export function normalizeLanSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['intranetOnly', 'lanAddress'].includes(key))
    || typeof value.intranetOnly !== 'boolean'
    || (value.lanAddress !== null && !privateIPv4(value.lanAddress))) throw new Error('无效的内网共享设置');
  if (!value.intranetOnly && value.lanAddress !== null) throw new Error('公网模式不能保留内网监听地址');
  return { intranetOnly: value.intranetOnly, lanAddress: value.lanAddress };
}

async function readSettings(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    await assertPrivateFile(file, stat, { maxBytes: 4096 });
    const data = JSON.parse(await handle.readFile('utf8'));
    if (!data || data.version !== 1 || Object.keys(data).some(key => !['version', 'intranetOnly', 'lanAddress'].includes(key))) throw new Error('内网设置格式不兼容');
    return normalizeLanSettings({ intranetOnly: data.intranetOnly, lanAddress: data.lanAddress });
  } finally { await handle.close(); }
}

export async function openLanSettings(file) {
  let current = { intranetOnly: false, lanAddress: null };
  try { current = await readSettings(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  return {
    get: () => ({ ...current }),
    set(value) {
      const next = normalizeLanSettings(value);
      const update = writes.then(async () => {
        // Recheck the destination before replacing it; never follow a changed
        // symlink or silently accept a file owned/readable by another user.
        try { await readSettings(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await writeJson(file, { version: 1, ...next });
        current = next;
      });
      writes = update.catch(() => {});
      return update;
    },
    flush: () => writes,
  };
}
