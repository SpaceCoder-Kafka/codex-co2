import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { cleanAuthorEvidence } from './message-authors.mjs';
import { writeJson } from './runtime.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const threadIdValid = id => typeof id === 'string' && id.length > 0 && id.length <= 100;

// Local presentation evidence is independent of invitation/admission lifetime.
// No text, authentication, URLs, or execution permissions belong in this file.
export function createMessageAuthorHistory({ entries = [], persist = async () => {} } = {}) {
  let records = entries, writes = Promise.resolve(), failed = false;
  return {
    get(threadId) {
      const record = records.find(record => record.threadId === threadId);
      return record && structuredClone(record.evidence);
    },
    remember(threadId, evidence) {
      if (!threadIdValid(threadId)) throw new Error('无效的作者记录会话 ID');
      const record = { threadId, evidence: cleanAuthorEvidence(evidence) };
      records = [record, ...records.filter(old => old.threadId !== threadId)].slice(0, 50);
      const data = { version: 1, entries: records };
      let droppedCurrent = false;
      while (Buffer.byteLength(JSON.stringify(data, null, 2)) + 1 > MAX_BYTES && records.length) {
        droppedCurrent = records.length === 1; records.pop();
      }
      writes = writes.catch(() => {}).then(() => persist(data)).then(() => { failed = droppedCurrent; }, () => { failed = true; });
    },
    get failed() { return failed; },
    flush: () => writes,
  };
}

export async function openMessageAuthorHistory(file) {
  let entries = [];
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > MAX_BYTES) throw new Error('作者恢复文件需要同用户私有文件');
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 50
        || new Set(data.entries.map(record => record?.threadId)).size !== data.entries.length) throw new Error('作者恢复记录格式不兼容');
      entries = data.entries.map(record => {
        if (!threadIdValid(record?.threadId)) throw new Error('作者恢复记录格式不兼容');
        return { threadId: record.threadId, evidence: cleanAuthorEvidence(record.evidence) };
      });
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return createMessageAuthorHistory({ entries, persist: data => writeJson(file, data) });
}
