import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const desktopIndexPath = () => path.join(os.homedir(), '.codex', 'state_5.sqlite');

// Explicitly authorized metadata exception. Do not select rollout paths,
// previews, first messages, credentials, settings, or any conversation body.
// Open for each query so refresh sees new chats and no long-lived read locks
// interfere with the Desktop. Never copy a database or checkpoint its WAL.
export function createThreadCatalog({ indexPath = desktopIndexPath() } = {}) {
  async function query(fn) {
    if (!path.isAbsolute(indexPath)) throw new Error('会话索引必须使用绝对路径');
    let db;
    try {
      const [stat, parent] = await Promise.all([fs.lstat(indexPath), fs.lstat(path.dirname(indexPath))]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) ||
          !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) throw new Error('Unsafe index');
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(indexPath, { readOnly: true, enableExtensions: false });
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250;');
      return fn(db);
    } catch {
      throw new Error('无法只读访问 Codex 会话索引；请确认 Desktop 已运行且索引版本受支持');
    } finally { db?.close(); }
  }
  const project = row => ({ id: row.id, name: row.title.slice(0, 512) || '未命名会话', updatedAt: row.updated_at * 1000, cwd: row.cwd.slice(0, 4096) });
  return {
    async list({ cursor = 0, search = '' } = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || typeof search !== 'string' || search.length > 200) throw new Error('无效的会话列表查询');
      return query(db => {
        // Bound parameters keep titles, project paths and user searches inert.
        // Newer indexes distinguish the display name from the original title.
        // Both are title metadata; older supported indexes can omit name.
        const title = db.prepare('PRAGMA table_info(threads)').all().some(c => c.name === 'name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
        const where = `archived=0 AND (instr(lower(${title}),lower(?))>0 OR instr(lower(cwd),lower(?))>0)`;
        const total = db.prepare(`SELECT count(*) AS n FROM threads WHERE ${where}`).get(search, search).n;
        const rows = db.prepare(`SELECT id,${title} AS title,updated_at,cwd FROM threads WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET ?`).all(search, search, cursor);
        if (rows.some(row => !UUID.test(row.id) || typeof row.title !== 'string' || typeof row.cwd !== 'string' || !Number.isSafeInteger(row.updated_at))) throw new Error('Unsupported index metadata');
        return { threads: rows.map(project), total, nextCursor: cursor + rows.length < total ? cursor + rows.length : null, catalog: 'desktop-index' };
      });
    },
    async contains(id) {
      if (!UUID.test(id ?? '')) return false;
      return query(db => Boolean(db.prepare('SELECT id FROM threads WHERE id=? AND archived=0').get(id)));
    },
  };
}
