import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GuestPermissions, openGuestPermissions } from '../lib/guest-permissions.mjs';

const hash = createHash('sha256').update('synthetic-personal-secret').digest('base64url');
const identity = { name: 'Synthetic B', participantId: 'synthetic-participant' };
test('permission requires the original thread scope and an unexpired approval; names confer no authority', () => {
  const permissions = new GuestPermissions(), scope = permissions.begin('one');
  permissions.allow(scope, hash, identity, Date.now() + 60000);
  assert.equal(permissions.get(scope, hash).name, identity.name);
  assert.equal(permissions.get(permissions.begin('other', true), hash), undefined);
  assert.equal(permissions.begin('one', true), scope);
  permissions.forget(scope, hash); assert.equal(permissions.get(scope, hash), undefined);
  permissions.allow(scope, hash, identity, Date.now() - 1); assert.equal(permissions.get(scope, hash), undefined);
  permissions.allow(scope, hash, identity, Date.now() + 60000);
  const fresh = permissions.begin('one'); assert.notEqual(fresh, scope); assert.equal(permissions.get(fresh, hash), undefined);
  permissions.allow(fresh, hash, identity, Date.now() + 60000); permissions.revoke(fresh);
  assert.equal(permissions.get(fresh, hash), undefined);
});

test('clean exit snapshots contain only hashes; consumed snapshots cannot resurrect revoked permissions after a crash', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-permissions-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'permissions.json'), first = await openGuestPermissions(file);
  const scope = first.begin('synthetic-thread'); first.allow(scope, hash, identity, Date.now() + 60000);
  await first.save(); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('synthetic-personal-secret'));
  const restarted = await openGuestPermissions(file); assert.ok(restarted.get(scope, hash));
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  restarted.revoke(scope);
  const afterCrash = await openGuestPermissions(file); assert.equal(afterCrash.get(scope, hash), undefined);
  await restarted.save(); const afterCleanExit = await openGuestPermissions(file);
  assert.equal(afterCleanExit.get(scope, hash), undefined);
});

test('permissions reject symlinks and public files before granting any saved access', async t => {
  const dir = await fs.mkdtemp('/tmp/co2-permissions-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target'), link = path.join(dir, 'link');
  await fs.writeFile(target, '{"version":1,"scopes":[]}', { mode: 0o644 }); await fs.symlink(target, link);
  await assert.rejects(openGuestPermissions(link)); await assert.rejects(openGuestPermissions(target), /私有/);
  assert.ok((await fs.readFile(target, 'utf8')).includes('version'));
});
