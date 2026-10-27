import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { InviteRecovery } from '../lib/invite-recovery.mjs';
import { clearRecoveryStore, openRecoveryStore } from '../lib/recovery-store.mjs';

const DAY = 86400000, HOUR = 3600000;
const origin = 'http://192.168.1.20:47870';
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const supported = { skip: process.platform === 'win32' ? 'Persistent background service is macOS-only' : false };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co2-recovery-')));
  const directory = path.join(root, '.coop'), file = path.join(directory, 'lan-recovery.json');
  await fs.mkdir(directory, { mode: 0o700 });
  let now = 1800000000000;
  const brokers = [];
  t.after(async () => { for (const broker of brokers) broker.close({ preserve: true }); await fs.rm(root, { recursive: true, force: true }); });
  const open = async (selectedOrigin = origin) => {
    const broker = new InviteRecovery({ now: () => now }); brokers.push(broker);
    await broker.enablePersistence(file, { origin: selectedOrigin }); return broker;
  };
  const room = (overrides = {}) => ({ roomId: randomUUID(), inviteToken: secret(), threadId: 'synthetic-thread',
    title: 'Synthetic selected conversation', ownerName: 'Synthetic host', requireApproval: true,
    intranetOnly: true, inviteLifetime: '1d', inviteExpiresAt: now + DAY,
    expiresAt: now + HOUR, state: 'online', origin, ...overrides });
  const request = source => ({ roomId: source.roomId, inviteToken: source.inviteToken,
    requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic visitor' });
  return { root, directory, file, open, room, request, now: () => now, advance: value => { now += value; } };
}

test('LAN restart restores a hash-only recovery entry with an unchanged recovery deadline', supported, async t => {
  const f = await fixture(t), broker = await f.open(), source = f.room();
  assert.equal(broker.registerRoom(source), true);
  await broker.enablePersistence(f.file, { origin });
  assert.equal(broker.status(source, origin).status, 'active', 'enabling the same store twice does not simulate a restart');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  const serialized = await fs.readFile(f.file, 'utf8');
  assert.equal(serialized.includes(source.inviteToken), false);
  assert.equal(serialized.includes(hash(source.inviteToken)), true);
  broker.close({ preserve: true });
  f.advance(HOUR);
  const second = await f.open();
  const state = second.status(source, origin);
  assert.equal(state.status, 'recoverable'); assert.equal(state.reason, 'interrupted');
  assert.equal(state.recoveryExpiresAt, f.now() - HOUR + 7 * DAY);
  assert.equal(second.status(source, 'http://192.168.1.21:47870').status, 'unavailable');
  second.close({ preserve: true }); f.advance(HOUR);
  const third = await f.open();
  assert.deepEqual(third.status(source, origin), state);
  f.advance(7 * DAY);
  assert.equal(third.status(source, origin).status, 'unavailable');
});

test('crash restoration uses the last checkpoint and respects the absolute invite deadline', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room();
  first.registerRoom(source);
  const checkpoint = await fs.readFile(f.file);
  first.close({ preserve: true });
  // An abrupt shutdown leaves the last active checkpoint, rather than the
  // graceful suspended snapshot. All data here is synthetic.
  await fs.writeFile(f.file, checkpoint, { mode: 0o600 });
  f.advance(2 * DAY);
  const restored = await f.open();
  assert.deepEqual(restored.status(source, origin), { type: 'recovery-status', status: 'recoverable',
    reason: 'expired', recoveryExpiresAt: source.inviteExpiresAt + 7 * DAY });
});

test('pending receipts survive restart, processing requires an explicit retry, and ACK follows durable save', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room();
  first.registerRoom(source); first.updateRoom(source.roomId, { state: 'revoked', endReason: 'interrupted' });
  const pending = f.request(source), processing = f.request(source);
  first.request(pending, origin); first.request(processing, origin);
  first.beginApproval(processing.requestId);
  const checkpoint = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(checkpoint.requests.find(item => item.requestId === processing.requestId).status, 'failed');
  const initial = first.watch(pending, origin);
  first.close({ preserve: true }); f.advance(HOUR);
  const restored = await f.open();
  assert.deepEqual(restored.watch(pending, origin), initial);
  assert.deepEqual(restored.request(pending, origin), initial, 'lost confirmation is idempotent across restart');
  assert.equal(restored.watch(processing, origin).status, 'failed');
  assert.equal(restored.approvalCurrent(processing.requestId), false);
  assert.ok(restored.beginApproval(processing.requestId));
  assert.equal(restored.watch({ ...pending, receiptToken: secret() }, origin).status, 'unavailable');
  let durableReject = false;
  restored.on('change', () => {
    durableReject ||= JSON.parse(readFileSync(f.file, 'utf8')).requests.find(item => item.requestId === pending.requestId)?.status === 'rejected';
  });
  assert.equal(restored.reject(pending.requestId), true); assert.equal(durableReject, true);
  f.advance(DAY - HOUR);
  assert.equal(restored.watch(processing, origin).status, 'expired');
});

test('approved URLs and unused or consumed admission grants never survive service restart', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room();
  first.registerRoom(source); first.updateRoom(source.roomId, { state: 'revoked', endReason: 'interrupted' });
  const requests = [f.request(source), f.request(source)];
  const target = f.room(); first.registerRoom(target);
  const inviteUrl = `${origin}/#room=${target.roomId}&invite=${target.inviteToken}&scope=synthetic-scope`;
  for (const request of requests) {
    first.request(request, origin); first.beginApproval(request.requestId);
    assert.equal(first.approve(request.requestId, { ...target, inviteUrl }), true);
  }
  assert.ok(first.consumeGrant(target.roomId, hash(requests[0].visitorToken)));
  const snapshot = await fs.readFile(f.file, 'utf8');
  for (const value of [source.inviteToken, target.inviteToken, inviteUrl, ...requests.flatMap(request => [request.receiptToken, request.visitorToken])]) {
    assert.equal(snapshot.includes(value), false);
  }
  assert.equal(snapshot.includes('targetRoomId'), false);
  first.close({ preserve: true });
  const restored = await f.open();
  for (const request of requests) {
    assert.equal(restored.watch(request, origin).status, 'unavailable');
    assert.equal(restored.watch(request, origin).inviteUrl, undefined);
    assert.equal(restored.beginApproval(request.requestId), null);
    assert.equal(restored.consumeGrant(target.roomId, hash(request.visitorToken)), null);
  }
});

test('denied and removed credentials and manually stopped invites remain revoked after restart', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room();
  first.registerRoom(source); first.updateRoom(source.roomId, { state: 'revoked', endReason: 'interrupted' });
  const denied = f.request(source), removed = f.request(source);
  first.request(denied, origin); first.reject(denied.requestId);
  first.request(removed, origin); first.revokeVisitor(source.threadId, hash(removed.visitorToken));
  first.close({ preserve: true });
  const second = await f.open();
  assert.equal(second.watch(denied, origin).status, 'rejected');
  assert.equal(second.watch(removed, origin).status, 'unavailable');
  for (const previous of [denied, removed]) assert.equal(second.request({ ...f.request(source), visitorToken: previous.visitorToken }, origin).status, 'unavailable');
  assert.equal(second.request(f.request(source), origin).status, 'pending', 'a new credential needs a new explicit approval');
  second.revokeThread(source.threadId); second.close({ preserve: true });
  const third = await f.open();
  assert.equal(third.status(source, origin).status, 'unavailable');
  third.updateRoom(source.roomId, { state: 'revoked', endReason: 'expired' });
  assert.equal(third.status(source, origin).status, 'unavailable');
});

test('clear and disabling persistence erase eligibility and permit an explicitly selected new origin', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room();
  first.registerRoom(source); first.close({ preserve: true });
  const second = await f.open(); second.disablePersistence();
  assert.equal(second.persistenceEnabled, false);
  const alternate = 'http://192.168.1.21:47870';
  await second.enablePersistence(f.file, { origin: alternate });
  assert.equal(second.status(source, origin).status, 'unavailable');
  const replacement = f.room({ origin: alternate }); second.registerRoom(replacement);
  second.clear(); second.close({ preserve: true });
  const restored = await f.open(alternate);
  assert.equal(restored.status(replacement, alternate).status, 'unavailable');
});

test('changing origin without clearing does not import old recovery credentials', supported, async t => {
  const f = await fixture(t), first = await f.open(); first.registerRoom(f.room()); first.close({ preserve: true });
  await assert.rejects(f.open('http://192.168.1.21:47870'), /损坏|格式/);
});

test('enabling persistence again checkpoints current rooms only after the previous store was explicitly cleared', supported, async t => {
  const f = await fixture(t), broker = await f.open(), old = f.room();
  broker.registerRoom(old); broker.disablePersistence();
  const current = f.room(); broker.registerRoom(current);
  await broker.enablePersistence(f.file, { origin });
  assert.equal(broker.status(current, origin).status, 'active');
  assert.equal(broker.status(old, origin).status, 'unavailable');
  broker.close({ preserve: true });
  const restored = await f.open();
  assert.equal(restored.status(current, origin).status, 'recoverable');
  assert.equal(restored.status(old, origin).status, 'unavailable');
});

test('an incomplete checkpoint disables all recovery instead of falling back to older grants', supported, async t => {
  const f = await fixture(t), broker = await f.open(), source = f.room();
  broker.registerRoom(source); broker.updateRoom(source.roomId, { state: 'revoked', endReason: 'interrupted' });
  const request = f.request(source); broker.request(request, origin);
  await fs.writeFile(`${f.file}.pending`, '{"version":1}', { mode: 0o600 });
  let failure;
  broker.on('persistence-error', error => { failure = error; });
  assert.throws(() => broker.reject(request.requestId), /停止恢复授权/);
  assert.ok(failure); assert.equal(broker.persistenceError, failure);
  assert.equal(broker.status(source, origin).status, 'unavailable');
  assert.equal(broker.watch(request, origin).status, 'unavailable');
  assert.equal(broker.consumeGrant(source.roomId, hash(request.visitorToken)), null);
  await assert.rejects(f.open(), /停止恢复授权/);
  assert.equal((await fs.stat(`${f.file}.pending`)).isFile(), true);
});

test('private store rejects unsafe permissions, symlinks and malformed or oversized data', supported, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '{}', { mode: 0o644 });
  assert.throws(() => openRecoveryStore(f.file), /停止恢复授权/);
  await fs.chmod(f.file, 0o600);
  await assert.rejects(f.open(), /损坏|格式/);
  await fs.unlink(f.file);
  const other = path.join(f.directory, 'other.json'); await fs.writeFile(other, '{}', { mode: 0o600 });
  await fs.symlink(other, f.file);
  assert.throws(() => openRecoveryStore(f.file));
  await fs.unlink(f.file);
  await fs.writeFile(f.file, ' '.repeat(8 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => openRecoveryStore(f.file), /停止恢复授权/);
});

test('unexpected state fields, duplicated identities, and plaintext credentials are rejected', supported, async t => {
  const f = await fixture(t), first = await f.open(), source = f.room(); first.registerRoom(source); first.close({ preserve: true });
  const original = JSON.parse(await fs.readFile(f.file, 'utf8'));
  for (const mutate of [
    data => { data.body = 'synthetic forbidden content'; },
    data => { data.rooms[0].inviteToken = source.inviteToken; },
    data => { data.rooms.push(data.rooms[0]); },
    data => { data.rooms[0].recoveryExpiresAt += DAY; },
    data => { data.rooms[0].inviteHash = 'invalid'; },
  ]) {
    const snapshot = structuredClone(original); mutate(snapshot);
    await fs.writeFile(f.file, JSON.stringify(snapshot), { mode: 0o600 });
    await assert.rejects(f.open(), /损坏|格式/);
  }
});

test('public origins cannot enable persistence and a live LAN store refuses other origins', supported, async t => {
  const f = await fixture(t), broker = await f.open();
  assert.equal(broker.registerRoom(f.room({ intranetOnly: false, origin: 'https://synthetic.example' })), false);
  assert.equal(broker.registerRoom(f.room({ origin: 'http://192.168.1.21:47870' })), false);
  const other = new InviteRecovery({ now: f.now }); t.after(() => other.close());
  await assert.rejects(other.enablePersistence(f.file, { origin: 'https://synthetic.example' }), /损坏|格式/);
});

test('disabled-start cleanup revokes a snapshot left by a crash before preference-off erasure', supported, async t => {
  const f = await fixture(t), broker = await f.open(), source = f.room();
  broker.registerRoom(source); broker.close({ preserve: true });
  await fs.writeFile(path.join(f.directory, 'background-settings.json'), '{"version":1,"enabled":false}\n', { mode: 0o600 });
  // Simulate interruption after the OFF preference committed but before the
  // running broker could clear its existing recovery snapshot.
  clearRecoveryStore(f.file);
  assert.equal((await f.open()).status(source, origin).status, 'unavailable');
});

test('disabled-start cleanup keeps the commit marker until snapshot removal is durable', supported, async t => {
  const f = await fixture(t), pending = `${f.file}.pending`;
  await fs.writeFile(f.file, 'synthetic-old-snapshot', { mode: 0o600 });
  await fs.writeFile(pending, '{"version":1}\n', { mode: 0o600 });
  const realSync = fsSync.fsyncSync;
  const fault = t.mock.method(fsSync, 'fsyncSync', () => { throw new Error('synthetic-fsync-failure'); });
  assert.throws(() => clearRecoveryStore(f.file), /停止恢复授权/);
  assert.equal(fsSync.existsSync(f.file), false);
  assert.equal(fsSync.existsSync(pending), true);
  fault.mock.restore();
  assert.equal(fsSync.fsyncSync, realSync);
  clearRecoveryStore(f.file);
  assert.equal(fsSync.existsSync(pending), false);
  assert.equal(openRecoveryStore(f.file).value, null);
});

test('disabled-start cleanup refuses symlinks and unsafe files without following or deleting them', supported, async t => {
  const f = await fixture(t), other = path.join(f.directory, 'unrelated.json');
  await fs.writeFile(other, 'synthetic-preserved-content', { mode: 0o600 });
  await fs.symlink(other, f.file);
  assert.throws(() => clearRecoveryStore(f.file), /停止恢复授权/);
  assert.equal(await fs.readFile(other, 'utf8'), 'synthetic-preserved-content');
  await fs.unlink(f.file);
  await fs.writeFile(f.file, '{}', { mode: 0o644 });
  assert.throws(() => clearRecoveryStore(f.file), /停止恢复授权/);
  assert.equal(fsSync.existsSync(f.file), true);
  await fs.chmod(f.file, 0o600);
  await fs.symlink(other, `${f.file}.pending`);
  assert.throws(() => clearRecoveryStore(f.file), /停止恢复授权/);
  assert.equal(fsSync.existsSync(f.file), true);
  assert.equal(await fs.readFile(other, 'utf8'), 'synthetic-preserved-content');
});
