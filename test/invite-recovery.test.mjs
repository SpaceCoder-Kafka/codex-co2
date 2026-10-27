import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { InviteRecovery } from '../lib/invite-recovery.mjs';

const DAY = 86400000;
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const origin = 'https://synthetic.example';
function fixture(t, options = {}) {
  let now = 1800000000000;
  const broker = new InviteRecovery({ now: () => now, ...options });
  t.after(() => broker.close());
  const room = (overrides = {}) => ({ roomId: randomUUID(), inviteToken: secret(), threadId: 'synthetic-thread',
    title: 'Synthetic private title', ownerName: 'Synthetic owner', requireApproval: true, origin,
    expiresAt: now + 60000, state: 'online', ...overrides });
  const source = room();
  assert.equal(broker.registerRoom(source), true);
  const end = (reason = 'expired') => broker.updateRoom(source.roomId, { state: 'revoked', endReason: reason });
  const input = (overrides = {}) => ({ type: 'request', roomId: source.roomId, inviteToken: source.inviteToken,
    requestId: randomUUID(), receiptToken: secret(), visitorToken: secret(), name: 'Synthetic guest', ...overrides });
  const target = (overrides = {}) => {
    const next = room(overrides);
    assert.equal(broker.registerRoom(next), true);
    return { ...next, inviteUrl: `${next.origin}/#room=${next.roomId}&invite=${next.inviteToken}&scope=synthetic-scope` };
  };
  return { broker, source, room, end, input, target, advance: ms => { now += ms; }, now: () => now };
}

test('recovery status verifies invitation and origin before revealing only lifecycle state', t => {
  const f = fixture(t), { broker, source } = f;
  assert.equal(broker.status(source, origin).status, 'active');
  broker.updateRoom(source.roomId, { state: 'offline' });
  assert.equal(broker.status(source, origin).status, 'temporarily-offline');
  assert.equal(broker.request(f.input(), origin).status, 'unavailable');
  f.end('interrupted');
  const state = broker.status(source, origin);
  assert.deepEqual(state, { type: 'recovery-status', status: 'recoverable', reason: 'interrupted', recoveryExpiresAt: f.now() + 7 * DAY });
  assert.equal(JSON.stringify(state).includes(source.threadId), false);
  assert.equal(JSON.stringify(state).includes(source.title), false);
  for (const candidate of [{ ...source, inviteToken: secret() }, { ...source, roomId: randomUUID() }]) {
    assert.deepEqual(broker.status(candidate, origin), { type: 'recovery-status', status: 'unavailable' });
  }
  assert.equal(broker.status(source, 'https://different.example').status, 'unavailable');
  f.advance(7 * DAY);
  assert.equal(broker.status(source, origin).status, 'unavailable');
});

test('natural expiry keeps a fixed seven-day recovery window and clips late requests', t => {
  const f = fixture(t);
  f.advance(60000);
  assert.equal(f.broker.status(f.source, origin).reason, 'expired');
  const deadline = f.broker.status(f.source, origin).recoveryExpiresAt;
  f.advance(6.5 * DAY);
  const request = f.input();
  assert.equal(f.broker.request(request, origin).expiresAt, deadline);
  f.broker.updateRoom(f.source.roomId, { state: 'revoked', endReason: 'expired' });
  assert.equal(f.broker.status(f.source, origin).recoveryExpiresAt, deadline, 'later notifications cannot extend the window');
  f.advance(.5 * DAY);
  assert.equal(f.broker.watch(request, origin).status, 'expired');
  assert.equal(f.broker.beginApproval(request.requestId), null);
});

test('request retransmission is idempotent while receipt, visitor, name and source stay bound', t => {
  const f = fixture(t); f.end();
  const request = f.input(), first = f.broker.request(request, origin);
  assert.equal(first.status, 'pending');
  assert.equal(first.expiresAt, f.now() + DAY);
  assert.deepEqual(f.broker.request(request, origin), first);
  assert.equal(f.broker.list().length, 1);
  for (const patch of [{ receiptToken: secret() }, { visitorToken: secret() }, { name: 'Someone else' }]) {
    assert.equal(f.broker.request({ ...request, ...patch }, origin).status, 'unavailable');
  }
  assert.equal(f.broker.watch({ ...request, receiptToken: secret() }, origin).status, 'unavailable');
  assert.equal(f.broker.watch(request, 'https://different.example').status, 'unavailable');
  const safe = JSON.stringify(f.broker.list());
  for (const credential of [request.inviteToken, request.receiptToken, request.visitorToken, hash(request.visitorToken)]) assert.equal(safe.includes(credential), false);
});

test('approval binds only the selected requester to one target and watch never reinstalls a consumed grant', t => {
  const f = fixture(t); f.end();
  const first = f.input(), second = f.input();
  f.broker.request(first, origin); f.broker.request(second, origin);
  const snapshot = f.broker.beginApproval(first.requestId);
  assert.equal(snapshot.threadId, f.source.threadId);
  assert.equal(snapshot.visitorHash, hash(first.visitorToken));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(f.broker.beginApproval(first.requestId), null);
  const target = f.target();
  assert.equal(f.broker.approve(first.requestId, target), true);
  assert.equal(f.broker.approve(first.requestId, target), false);
  assert.equal(f.broker.watch(first, origin).inviteUrl, target.inviteUrl);
  assert.equal(f.broker.watch(second, origin).inviteUrl, undefined);
  assert.equal(f.broker.consumeGrant(target.roomId, hash(second.visitorToken)), null);
  assert.equal(f.broker.consumeGrant(randomUUID(), hash(first.visitorToken)), null);
  assert.equal(f.broker.consumeGrant(target.roomId, hash(first.visitorToken)).name, first.name);
  assert.equal(f.broker.watch(first, origin).status, 'approved');
  assert.equal(f.broker.consumeGrant(target.roomId, hash(first.visitorToken)), null);
});

test('approval cannot cross a conversation, origin or target invitation credential', t => {
  const f = fixture(t); f.end();
  const request = f.input(); f.broker.request(request, origin); f.broker.beginApproval(request.requestId);
  for (const target of [f.target({ threadId: 'other-thread' }), f.target({ origin: 'https://different.example' })]) {
    assert.equal(f.broker.approve(request.requestId, target), false);
  }
  const target = f.target();
  assert.equal(f.broker.approve(request.requestId, { ...target, inviteUrl: target.inviteUrl.replace(target.inviteToken, secret()) }), false);
  assert.equal(f.broker.approve(request.requestId, { ...target, inviteUrl: target.inviteUrl + '&role=owner' }), false);
  assert.equal(f.broker.approve(request.requestId, target), true);
});

test('failed creation stays failed until another explicit manager approval', t => {
  const f = fixture(t); f.end();
  const request = f.input(); f.broker.request(request, origin);
  f.broker.beginApproval(request.requestId);
  assert.equal(f.broker.fail(request.requestId), true);
  assert.equal(f.broker.watch(request, origin).status, 'failed');
  const target = f.target();
  assert.equal(f.broker.approve(request.requestId, target), false);
  assert.equal(f.broker.approvalCurrent(request.requestId), false);
  assert.ok(f.broker.beginApproval(request.requestId));
  assert.equal(f.broker.approve(request.requestId, target), true);
});

test('manual stop cancels processing and all old invitations for the same conversation', t => {
  const f = fixture(t); f.end();
  const request = f.input(); f.broker.request(request, origin); f.broker.beginApproval(request.requestId);
  const next = f.target();
  f.broker.revokeThread(f.source.threadId);
  assert.equal(f.broker.approvalCurrent(request.requestId), false);
  assert.equal(f.broker.approve(request.requestId, next), false);
  assert.equal(f.broker.watch(request, origin).status, 'unavailable');
  assert.equal(f.broker.status(f.source, origin).status, 'unavailable');
  assert.equal(f.broker.status(next, origin).status, 'unavailable');
  assert.equal(f.broker.consumeGrant(next.roomId, hash(request.visitorToken)), null);
  f.broker.updateRoom(f.source.roomId, { state: 'revoked', endReason: 'expired' });
  f.broker.updateRoom(next.roomId, { state: 'revoked', endReason: 'interrupted' });
  assert.equal(f.broker.status(f.source, origin).status, 'unavailable', 'late expiry cannot reverse an owner stop');
  assert.equal(f.broker.status(next, origin).status, 'unavailable');
});

test('rejecting a pending application or removing an approved visitor prevents credential reuse', t => {
  const f = fixture(t); f.end();
  const denied = f.input(); f.broker.request(denied, origin);
  assert.equal(f.broker.reject(denied.requestId), true);
  assert.equal(f.broker.watch(denied, origin).status, 'rejected');
  assert.equal(f.broker.beginApproval(denied.requestId), null);
  assert.equal(f.broker.request(f.input({ visitorToken: denied.visitorToken }), origin).status, 'unavailable');
  const approved = f.input(); f.broker.request(approved, origin); f.broker.beginApproval(approved.requestId);
  const next = f.target(); f.broker.approve(approved.requestId, next);
  f.broker.revokeVisitor(f.source.threadId, hash(approved.visitorToken));
  assert.equal(f.broker.watch(approved, origin).inviteUrl, undefined);
  assert.equal(f.broker.consumeGrant(next.roomId, hash(approved.visitorToken)), null);
  assert.equal(f.broker.request(f.input({ visitorToken: approved.visitorToken }), origin).status, 'unavailable');
  assert.equal(f.broker.request(f.input(), origin).status, 'pending', 'same display name is not an authenticated identity');
});

test('approved result and unused admission cannot outlive the target lease or survive clear', t => {
  const f = fixture(t); f.end();
  const request = f.input(); f.broker.request(request, origin); f.broker.beginApproval(request.requestId);
  const target = f.target({ expiresAt: f.now() + 1000 }); f.broker.approve(request.requestId, target);
  assert.equal(f.broker.watch(request, origin).expiresAt, target.expiresAt);
  f.advance(1000);
  assert.equal(f.broker.watch(request, origin).status, 'expired');
  assert.equal(f.broker.consumeGrant(target.roomId, hash(request.visitorToken)), null);
  f.broker.clear();
  assert.equal(f.broker.status(f.source, origin).status, 'unavailable');
  assert.equal(f.broker.watch(request, origin).status, 'unavailable');
  assert.deepEqual(f.broker.list(), []);
});

test('target interruption removes approved results without silently authorizing another target', t => {
  const f = fixture(t); f.end();
  const request = f.input(); f.broker.request(request, origin); f.broker.beginApproval(request.requestId);
  const target = f.target(); f.broker.approve(request.requestId, target);
  f.broker.updateRoom(target.roomId, { state: 'revoked', endReason: 'interrupted' });
  assert.equal(f.broker.watch(request, origin).status, 'unavailable');
  assert.equal(f.broker.beginApproval(request.requestId), null);
  assert.equal(f.broker.consumeGrant(target.roomId, hash(request.visitorToken)), null);
});

test('request cooling and finite capacities reject new work without deleting pending requests', t => {
  const f = fixture(t, { requestsPerMinute: 1, maxRequests: 2, maxPerRoom: 2, maxRooms: 2 }); f.end();
  const first = f.input();
  assert.equal(f.broker.request(first, origin).status, 'pending');
  assert.equal(f.broker.request(f.input(), origin).code, 'rate-limited');
  assert.equal(f.broker.request(first, origin).status, 'pending', 'lost ACK retries are not counted as new applications');
  f.advance(60001);
  assert.equal(f.broker.request(f.input(), origin).status, 'pending');
  f.advance(60001);
  assert.equal(f.broker.request(f.input(), origin).code, 'capacity-reached');
  const target = f.target();
  assert.equal(f.broker.registerRoom(f.room()), false);
  assert.equal(f.broker.status(target, origin).status, 'active');
  assert.equal(f.broker.watch(first, origin).status, 'pending');
});
