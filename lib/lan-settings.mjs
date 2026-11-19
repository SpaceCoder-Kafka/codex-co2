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
    if (!data || ![1, 2, 3].includes(data.version) || Object.keys(data).some(key => !['version', 'intranetOnly', 'lanAddress', ...(data.version >= 2 ? ['lanPort'] : []), ...(data.version === 3 ? ['previousLanAddress'] : [])].includes(key))) throw new Error('内网设置格式不兼容');
    const network = normalizeLanSettings({ intranetOnly: data.intranetOnly, lanAddress: data.lanAddress });
    const port = data.version >= 2 ? data.lanPort : null;
    if (port !== null && (!network.intranetOnly || !network.lanAddress || !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('内网端口记录无效');
    if (data.version === 3 && (!port || !privateIPv4(data.previousLanAddress) || data.previousLanAddress === network.lanAddress)) throw new Error('内网设置格式不兼容');
    return { network, port, previousAddress: data.previousLanAddress ?? null };
  } finally { await handle.close(); }
}

export async function openLanSettings(file) {
  let current = { intranetOnly: false, lanAddress: null };
  let port = null, previousAddress = null;
  try { ({ network: current, port, previousAddress } = await readSettings(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  const persist = async (network, nextPort, previous = null) => {
    try { await readSettings(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeJson(file, previous ? { version: 3, ...network, lanPort: nextPort, previousLanAddress: previous }
      : nextPort === null ? { version: 1, ...network } : { version: 2, ...network, lanPort: nextPort });
    current = network; port = nextPort; previousAddress = previous;
  };
  return {
    get: () => ({ ...current }),
    getPort: () => port,
    previousAddress: () => previousAddress,
    moveAddress(address) {
      const update = writes.then(() => {
        if (!privateIPv4(address) || !current.intranetOnly || !current.lanAddress || !port || previousAddress || current.lanAddress === address) throw new Error('无效的内网共享设置');
        return persist({ intranetOnly: true, lanAddress: address }, port, current.lanAddress);
      });
      writes = update.catch(() => {});
      return update;
    },
    set(value) {
      const next = normalizeLanSettings(value);
      const update = writes.then(async () => {
        // Recheck the destination before replacing it; never follow a changed
        // symlink or silently accept a file owned/readable by another user.
        await persist(next, next.intranetOnly && next.lanAddress === current.lanAddress ? port : null);
      });
      writes = update.catch(() => {});
      return update;
    },
    setPort(value) {
      if (!Number.isInteger(value) || value < 1024 || value > 65535) return Promise.reject(new Error('内网端口记录无效'));
      const update = writes.then(async () => {
        if (!current.intranetOnly || !current.lanAddress) throw new Error('保存端口前必须选择内网地址');
        await persist({ ...current }, value);
      });
      writes = update.catch(() => {});
      return update;
    },
    flush: () => writes,
  };
}
