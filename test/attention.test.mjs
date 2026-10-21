import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionFor } from '../lib/attention.mjs';

const room = () => ({ roomId: 'r1', threadId: 't1', title: 'private title', inviteUrl: 'private capability', state: 'online',
  guests: [{ id: 'g1', name: 'private name', status: 'pending' }],
  proposals: [{ id: 'p1', status: 'pending', text: 'private message' }], approvalPending: false });

test('attention groups unresolved work by room and kind without leaking content or capabilities', () => {
  const r = room(); r.guests.push({ id: 'g2', status: 'pending' });
  const items = attentionFor({ rooms: [r] });
  assert.deepEqual(items.map(({ id, members, count }) => ({ id, members, count })), [
    { id: 'r1:guest', members: ['g1', 'g2'], count: 2 }, { id: 'r1:proposal', members: ['p1'], count: 1 },
  ]);
  assert.ok(!JSON.stringify(items).includes('private'));
  r.guests[0].status = 'admitted'; r.guests[1].status = 'denied'; r.proposals[0].status = 'processing';
  assert.deepEqual(attentionFor({ rooms: [r] }), []);
  r.proposals[0].status = 'unknown'; r.approvalPending = true;
  assert.deepEqual(attentionFor({ rooms: [r] }).map(i => i.kind), ['tool', 'unknown']);
  r.proposals[0].status = 'accepted'; r.approvalPending = false;
  assert.deepEqual(attentionFor({ rooms: [r] }), []);
});

test('pending approvals survive policy changes; background/direct submissions do not notify', () => {
  const r = room(); r.guests = []; r.requireApproval = false;
  assert.deepEqual(attentionFor({ rooms: [r] }).map(i => i.kind), ['proposal']);
  r.proposals[0].status = 'processing';
  assert.deepEqual(attentionFor({ rooms: [r] }), []);
});

test('network loss coalesces room alerts and clears after recovery; paused rooms still need connection repair', () => {
  const r = room(); r.state = 'offline';
  assert.deepEqual(attentionFor({ rooms: [r] }).map(i => i.kind), ['offline']);
  assert.deepEqual(attentionFor({ rooms: [r], connection: { state: 'unavailable' } }).map(i => i.kind), ['connection']);
  r.state = 'revoked'; r.guests = []; r.proposals = [];
  assert.deepEqual(attentionFor({ rooms: [r], connection: { state: 'stopped' } }), []);
  r.endReason = 'paused';
  assert.deepEqual(attentionFor({ rooms: [r], connection: { state: 'stopped' } }).map(i => i.kind), ['connection']);
  assert.deepEqual(attentionFor({ rooms: [r], connection: { state: 'online' } }), []);
});

test('only unexpected stops and expiry notify; manual stop and successful re-sharing clear stopped alerts', () => {
  const r = room(); r.state = 'revoked';
  assert.deepEqual(attentionFor({ rooms: [r] }), []);
  r.endReason = 'expired';
  assert.deepEqual(attentionFor({ rooms: [r] }).map(i => i.kind), ['share-stopped']);
  r.endReason = undefined; r.lastError = 'private diagnostic';
  assert.ok(!JSON.stringify(attentionFor({ rooms: [r] })).includes('private'));
  const replacement = { ...room(), roomId: 'r2', guests: [], proposals: [] };
  assert.deepEqual(attentionFor({ rooms: [r, replacement] }), []);
});
