import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPrivateFile, ensurePrivateDirectory } from './platform.mjs';

export async function readBackgroundSettings(runtimeDir) {
  const file = path.join(runtimeDir, 'background-settings.json');
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertPrivateFile(file, await handle.stat(), { maxBytes: 1024 });
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'enabled,version' || value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('Invalid background service setting');
    return { enabled: value.enabled };
  } catch (error) { if (error.code === 'ENOENT') return { enabled: true }; throw error; }
  finally { await handle?.close(); }
}

export async function writeBackgroundSettings(runtimeDir, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid background service setting');
  await ensurePrivateDirectory(runtimeDir);
  await readBackgroundSettings(runtimeDir); // refuse unsafe existing destinations
  const file = path.join(runtimeDir, 'background-settings.json');
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, enabled }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.rename(temp, file);
    const directory = await fs.open(runtimeDir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
