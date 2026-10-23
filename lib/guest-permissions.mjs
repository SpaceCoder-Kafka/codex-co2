import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeJson } from './runtime.mjs';
import { displayName } from './display-name.mjs';
import { assertPrivateFile } from './platform.mjs';

export const recoveryHash = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const DAY = 86400000;

// Approval is bound to a sharing scope for ONE thread, never to a name or URL.
export class GuestPermissions {
  constructor(scopes = [], file) { this.scopes = scopes; this.file = file; }
  begin(threadId, inherit = false) {
    const previous = inherit && this.scopes.find(scope => scope.threadId === threadId);
    if (previous) return previous.id;
    const scope = { id: randomUUID(), threadId, grants: [] };
    this.scopes = [scope, ...this.scopes.filter(old => old.threadId !== threadId)].slice(0, 50);
    return scope.id;
  }
  get(scopeId, hash) {
    const grant = this.scopes.find(scope => scope.id === scopeId)?.grants.find(grant => grant.hash === hash && grant.expiresAt > Date.now());
    return grant && { ...grant };
  }
  allow(scopeId, hash, { name, participantId }, expiresAt) {
    const scope = this.scopes.find(scope => scope.id === scopeId);
    if (!scope || !recoveryHash(hash) || !displayName(name) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now() || expiresAt > Date.now() + DAY) return;
    scope.grants = [{ hash, name, participantId, expiresAt }, ...scope.grants.filter(grant => grant.hash !== hash && grant.expiresAt > Date.now())].slice(0, 32);
  }
  forget(scopeId, hash) {
    const scope = this.scopes.find(scope => scope.id === scopeId);
    if (scope) scope.grants = scope.grants.filter(grant => grant.hash !== hash);
  }
  revoke(scopeId) { this.scopes = this.scopes.filter(scope => scope.id !== scopeId); }
  clear() { this.scopes = []; }
  async save() {
    if (this.file) await writeJson(this.file, { version: 1, scopes: this.scopes.map(scope => ({ ...scope,
      grants: scope.grants.filter(grant => grant.expiresAt > Date.now()) })) });
  }
}

export async function openGuestPermissions(file) {
  let scopes = [];
  let opened = false;
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    opened = true;
    try {
      const stat = await handle.stat();
      await assertPrivateFile(file, stat, { maxBytes: 512 * 1024 });
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !Array.isArray(data.scopes)) throw new Error('同伴恢复记录格式不兼容');
      scopes = data.scopes.filter(scope => typeof scope?.id === 'string' && scope.id.length <= 100
        && typeof scope.threadId === 'string' && scope.threadId.length <= 100 && Array.isArray(scope.grants)).slice(0, 50)
        .map(scope => ({ id: scope.id, threadId: scope.threadId, grants: scope.grants.filter(grant => recoveryHash(grant?.hash)
          && displayName(grant.name) && typeof grant.participantId === 'string' && grant.participantId.length <= 100
          && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > Date.now() && grant.expiresAt <= Date.now() + DAY)
          .slice(0, 32).map(({ hash, name, participantId, expiresAt }) => ({ hash, name, participantId, expiresAt })) }));
      // Consume the clean-exit snapshot BEFORE trusting it. A crash or a failed
      // revoke cannot resurrect a previous on-disk ACL. Only clean exit saves.
      await fs.unlink(file);
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT' || opened) throw error; }
  return new GuestPermissions(scopes, file);
}
