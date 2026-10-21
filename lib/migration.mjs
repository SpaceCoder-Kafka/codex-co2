import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { paths, readJson, writeJson, withLock, socketOpen, processIdentity } from './runtime.mjs';

const controls = ['server.json', 'Open-Test-Desktop.command', 'desktop-bridge-process.json',
  'host-service.json', 'demo-service.json', 'relay-service.json'];

export async function migrateRuntime(p, { legacyRoots = [] } = {}) {
  return withLock(p, async signal => {
    const state = await readJson(p.stateFile);
    if (!state || state.socketPath === p.socketPath) return { migrated: false, reason: 'No relocated backend state', root: p.root };
    if (typeof state.codexHome !== 'string') throw new Error('Invalid old runtime state; inspect server.json manually.');
    const old = paths(path.dirname(path.dirname(state.codexHome)));
    if (old.codexHome !== state.codexHome || old.socketPath !== state.socketPath || old.workspace !== state.workspace) {
      throw new Error('Old paths are not a consistent isolated runtime; refusing migration.');
    }
    // Migration handles an already-renamed checkout, never merges two homes.
    const previous = [...new Set([old.root, ...legacyRoots])].map(root => {
      if (!path.isAbsolute(root) || path.dirname(root) !== path.dirname(p.root) || root === p.root) {
        throw new Error('Legacy roots must be absolute sibling project paths.');
      }
      return paths(root);
    });
    for (const location of previous) {
      const storage = await fs.lstat(location.runtimeDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      const alias = storage?.isSymbolicLink() && await fs.readlink(location.runtimeDir) === p.runtimeDir;
      if (storage && !alias) throw new Error('The previous .coop directory still exists. Retire its services and reconcile storage manually; no credentials or history were copied.');
      const entries = await fs.readdir(location.root).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
      if (entries.some(name => name !== '.coop')) throw new Error('A previous project directory contains other files; refusing to add a compatibility alias.');
    }
    for (const name of ['sharing.lock', 'relay.lock']) {
      if (await fs.stat(path.join(p.runtimeDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) {
        throw new Error(`Inspect and retire ${name} before migration.`);
      }
    }
    const records = await Promise.all(controls.filter(name => name.endsWith('.json')).map(name => readJson(path.join(p.runtimeDir, name))));
    for (const record of records) {
      if (record?.pid && processIdentity(record.pid)) throw new Error(`Recorded PID ${record.pid} still exists. Verify and retire the previous test service before migration.`);
    }
    const commands = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 }).split('\n');
    if (commands.some(command => previous.some(location => command.includes(location.runtimeDir)) || command.includes(path.join(p.runtimeDir, 'desktop-profile')))) {
      throw new Error('A process still references the previous runtime or test Desktop profile. Close that test instance before migration.');
    }
    for (const location of [...previous, p]) {
      if (await socketOpen(location.socketPath)) throw new Error('A runtime socket is active; migration requires all backends stopped.');
    }
    signal.throwIfAborted();
    const archive = path.join(p.runtimeDir, 'migrations', randomUUID());
    await fs.mkdir(archive, { recursive: true, mode: 0o700 });
    // Copy only control records to the private archive. Do not touch auth, SQLite,
    // rollouts, profile files, SSH cleanup markers, or historical absolute paths.
    const archived = [];
    for (const name of controls) {
      try {
        await fs.copyFile(path.join(p.runtimeDir, name), path.join(archive, name), fs.constants.COPYFILE_EXCL);
        await fs.chmod(path.join(archive, name), name.endsWith('.command') ? 0o700 : 0o600);
        archived.push(name);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // 0.163.0 stores absolute rollout paths. Preserve their reachability without
    // rewriting or synchronizing the database/JSONL or aliasing the source tree.
    const aliases = [];
    for (const location of previous) {
      await fs.mkdir(location.root, { recursive: true, mode: 0o700 });
      try { await fs.symlink(p.runtimeDir, location.runtimeDir); }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readlink(location.runtimeDir) !== p.runtimeDir) throw error; }
      aliases.push(location.runtimeDir);
    }
    const report = { migrated: true, at: new Date().toISOString(), from: old.root, to: p.root, archive, archived, aliases,
      preserved: ['home', 'desktop-profile', 'workspace', 'identity-baseline.json', 'ssh', 'observations.ndjson'],
      note: 'Control records retired; isolated credentials and history remain in place. Legacy .coop aliases preserve absolute rollout paths. Native Desktop acceptance is separate.' };
    await writeJson(path.join(archive, 'migration.json'), report);
    // Retire the backend record last, so an interrupted migration still blocks start.
    for (const name of archived.filter(name => name !== 'server.json')) await fs.unlink(path.join(p.runtimeDir, name));
    await fs.unlink(p.stateFile);
    return report;
  });
}
