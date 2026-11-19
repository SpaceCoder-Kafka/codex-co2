import path from 'node:path';
import os from 'node:os';
import { assertProtectedPath } from './platform.mjs';

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
      await Promise.all([assertProtectedPath(indexPath), assertProtectedPath(path.dirname(indexPath), { directory: true })]);
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(indexPath, { readOnly: true, enableExtensions: false });
      // Keep schema detection, the count and the page on one read snapshot during Desktop updates.
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; BEGIN;');
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch {
      throw new Error('无法只读访问 Codex 会话索引；请确认 Desktop 已运行且索引版本受支持');
    } finally { db?.close(); }
  }
  const project = row => ({ id: row.id, name: row.title.slice(0, 512), updatedAt: row.updated_at * 1000, cwd: row.cwd.slice(0, 4096) });
  return {
    async list({ cursor = 0, search = '' } = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || typeof search !== 'string' || search.length > 200) throw new Error('无效的会话列表查询');
      return query(db => {
        const hasName = db.prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name='name'").get();
        const hasSpawnEdges = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='thread_spawn_edges'").get();
        // Use Unicode whitespace for both title fields. SQLite trim() alone only strips spaces.
        db.function('display_title', { deterministic: true, directOnly: true }, (name, title) => {
          if (name?.trim()) return name;
          return title?.trim() ? title : null;
        });
        // Older indexes may lack spawn edges. Where available, match just the child ID.
        const excludeChildren = hasSpawnEdges
          ? 'AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=threads.id)'
          : '';
        const catalog = `FROM (
          SELECT id, display_title(${hasName ? 'name' : 'NULL'}, title) AS catalog_title, updated_at, cwd
          FROM threads WHERE archived=0 ${excludeChildren}
        ) WHERE catalog_title IS NOT NULL
          AND (:search='' OR instr(lower(catalog_title),lower(:search))>0 OR instr(lower(cwd),lower(:search))>0)`;
        const total = db.prepare(`SELECT count(*) AS n ${catalog}`).get({ search }).n;
        const rows = db.prepare(`SELECT id,catalog_title AS title,updated_at,cwd ${catalog}
          ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET :cursor`).all({ search, cursor });
        if (rows.some(row => !UUID.test(row.id) || typeof row.title !== 'string' || typeof row.cwd !== 'string' || !Number.isSafeInteger(row.updated_at))) throw new Error('Unsupported index metadata');
        return { threads: rows.map(project), total, nextCursor: cursor + rows.length < total ? cursor + rows.length : null, catalog: 'desktop-index' };
      });
    },
    async contains(id) {
      // Existing shares and recovery check membership independently of picker visibility.
      if (!UUID.test(id ?? '')) return false;
      return query(db => Boolean(db.prepare('SELECT id FROM threads WHERE id=? AND archived=0').get(id)));
    },
  };
}
