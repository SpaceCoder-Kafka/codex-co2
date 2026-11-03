import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { GuestUploads, uploadMessage, attachmentInput, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../lib/guest-uploads.mjs';
import { protectedAttachmentPath } from '../lib/attachment-paths.mjs';
import { fileRefs, readFilePreview } from '../lib/thread-files.mjs';
import { SharedRoom, secret } from '../lib/host.mjs';
import { startRelay } from '../lib/relay.mjs';
import { ScopedThread } from '../lib/scoped-thread.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co2-upload-')), runtime = path.join(dir, '.coop');
  const store = new GuestUploads(runtime, randomUUID());
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, runtime, dir };
}
function upload(store, guest, name, bytes) {
  const id = randomUUID();
  store.receive(guest, { type: 'upload-start', uploadId: id, name, size: bytes.length });
  let index = 0;
  for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) store.receive(guest,
    { type: 'upload-chunk', uploadId: id, index: index++, data: bytes.subarray(start, start+UPLOAD_CHUNK_BYTES).toString('base64') });
  const result = store.receive(guest, { type: 'upload-finish', uploadId: id, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(result.status, 'ready'); return id;
}
test('upload protocol rejects paths, extra capabilities, invalid sizes, noncanonical chunks and unknown messages', t => {
  const { store, runtime } = fixture(t), start = { type: 'upload-start', uploadId: randomUUID(), name: 'example.txt', size: 1 };
  for (const fields of [{ name: '../secret' }, { name: '..\\secret' }, { name: 'a\n.txt' }, { size: -1 }, { size: MAX_UPLOAD_BYTES+1 },
    { path: '/synthetic/secret' }, { threadId: randomUUID() }, { mime: 'text/plain' }, { uploadId: 'other' }]) {
    assert.equal(uploadMessage({ ...start, ...fields }), false);
    assert.throws(() => store.receive('A', { ...start, ...fields }));
  }
  assert.equal(fs.existsSync(runtime), false);
  for (const data of ['A', '!!!!', 'YQ=', 'YQ==\n', 'A'.repeat(UPLOAD_CHUNK_BYTES*4/3+4)]) assert.equal(uploadMessage({ type: 'upload-chunk', uploadId: start.uploadId, index: 0, data }), false);
  assert.throws(() => attachmentInput('x', [{ path: '/synthetic/secret', image: true }]));
});
test('images, ordinary files, audio and video preserve bytes, mint only scoped paths, and remain downloadable after dispatch', async t => {
  const { store, runtime } = fixture(t);
  const cases = [['截图.png', png, true], ['source.ts', Buffer.from('const x = 1;'), false], ['document.pdf', Buffer.from('%PDF-1.7\nsynthetic'), false],
    ['archive.zip', Buffer.from('PK\x03\x04synthetic'), false], ['recording.wav', Buffer.from('RIFFsyntheticWAVE'), false], ['movie.mp4', Buffer.from('synthetic video'), false], ['empty.txt', Buffer.alloc(0), false]];
  for (const [name, bytes, image] of cases) {
    const id = upload(store, 'A', name, bytes);
    assert.throws(() => store.claim('B', [id]), /失效/);
    const refs = store.claim('A', [id]), ref = refs[0];
    assert.equal(ref.image, image); assert.equal(Object.isFrozen(ref), true); ref.verify();
    assert.ok(ref.path.startsWith(runtime+path.sep)); assert.deepEqual(fs.readFileSync(ref.path), bytes);
    assert.equal(protectedAttachmentPath(ref.path), false);
    if (process.platform !== 'win32') { assert.equal(fs.statSync(ref.path).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(ref.path)).mode & 0o777, 0o700); }
    const input = attachmentInput('', refs); assert.ok(input[0].text.includes(ref.path)); assert.equal(input.length, image ? 2 : 1);
    const file = fileRefs('user', [{ type: 'localFile', path: ref.path }], 'synthetic-key')[0];
    assert.ok(file); assert.deepEqual((await readFilePreview(file, { representation: 'original' })).bytes, bytes);
    assert.throws(() => store.claim('A', [id]), /失效/);
    ref.retain(); store.dropGuest('A'); assert.equal(fs.existsSync(ref.path), true);
  }
  store.close(); assert.equal(store.items.size, cases.length);
  for (const name of ['auth.json', 'server.json', 'home/auth.json']) assert.equal(protectedAttachmentPath(path.join(runtime, name)), true);
});
test('sequence, checksum, image signature and premature finish failures remove partial files', t => {
  const { store } = fixture(t);
  for (const kind of ['sequence', 'oversize', 'checksum', 'premature', 'image']) {
    const id = randomUUID(); store.receive('A', { type: 'upload-start', uploadId: id, name: kind === 'image' ? 'fake.png' : 'x.txt', size: 3 });
    const file = store.items.get(id).path;
    assert.throws(() => {
      if (kind !== 'premature') store.receive('A', { type: 'upload-chunk', uploadId: id, index: kind === 'sequence' ? 1 : 0,
        data: Buffer.from(kind === 'oversize' ? 'four' : 'abc').toString('base64') });
      store.receive('A', { type: 'upload-finish', uploadId: id, ...(kind === 'checksum' ? { sha256: '0'.repeat(64) } : {}) });
    });
    assert.equal(fs.existsSync(file), false); assert.equal(store.items.size, 0);
  }
});
test('ownership, quotas, expiry, cancellation, tampering and pre-dispatch revocation are enforced', t => {
  const { store } = fixture(t), id = randomUUID();
  store.receive('A', { type: 'upload-start', uploadId: id, name: 'partial.bin', size: MAX_UPLOAD_BYTES });
  assert.throws(() => store.receive('A', { type: 'upload-start', uploadId: randomUUID(), name: 'second.bin', size: 1 }), /配额/);
  assert.throws(() => store.receive('B', { type: 'upload-cancel', uploadId: id }), /无权/);
  store.prune(Date.now()+11*60000); assert.equal(store.items.size, 0);
  const ready = upload(store, 'A', 'file.txt', Buffer.from('original'));
  assert.throws(() => store.claim('A', [ready, ready]));
  const [ref] = store.claim('A', [ready]); fs.writeFileSync(ref.path, 'modified'); assert.throws(() => ref.verify(), /改变/);
  store.dropGuest('A'); assert.equal(fs.existsSync(ref.path), false); assert.throws(() => ref.verify(), /失效/);
  const cancelled = upload(store, 'B', 'file.txt', Buffer.from('other'));
  store.receive('B', { type: 'upload-cancel', uploadId: cancelled }); assert.equal(store.items.size, 0);
});
test('runtime symlinks and permissive runtime directories cannot receive guest bytes', t => {
  if (process.platform === 'win32') return t.skip('POSIX permission fixture');
  const { store, runtime, dir } = fixture(t);
  fs.mkdirSync(runtime, { mode: 0o755 });
  assert.throws(() => upload(store, 'A', 'x', Buffer.from('a')), /private/);
  fs.rmdirSync(runtime); const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, runtime);
  assert.throws(() => upload(store, 'A', 'x', Buffer.from('a')), /private/); assert.deepEqual(fs.readdirSync(outside), []);
});

test('declared bytes reserve bounded disk space across rooms before any chunk is accepted', t => {
  const { store, runtime } = fixture(t);
  const other = new GuestUploads(runtime, randomUUID()); t.after(() => other.close());
  for (const target of [store, other]) {
    for (let i=0; i<8; i++) target.receive('guest-'+i, { type: 'upload-start', uploadId: randomUUID(), name: 'large.bin', size: MAX_UPLOAD_BYTES });
    assert.throws(() => target.receive('ninth', { type: 'upload-start', uploadId: randomUUID(), name: 'extra.bin', size: 1 }), /配额|存储/);
  }
  const third = new GuestUploads(runtime, randomUUID()); t.after(() => third.close());
  assert.throws(() => third.receive('guest', { type: 'upload-start', uploadId: randomUUID(), name: 'over.bin', size: 1 }), /存储/);
  assert.equal(third.items.size, 0);
});

const until = async predicate => { for (let i=0; i<500; i++) { const result = predicate(); if (result) return result; await delay(10); } throw new Error('Synthetic upload scenario timed out'); };
class Rpc extends EventEmitter {
  calls = [];
  async request(method, params) {
    if (method === 'turn/start') { this.calls.push(params); if (this.hold) await this.hold; if (this.fail) throw new Error('Synthetic lost response'); return { turn: { id: randomUUID() } }; }
    return { thread: { id: 'synthetic-thread', name: 'Synthetic upload thread', status: { type: 'idle' }, turns: [] } };
  }
  close() {}
}
async function live(t, requireApproval = false) {
  const { runtime } = fixture(t), rpc = new Rpc(), registrationSecret = secret();
  const relay = await startRelay({ registrationSecret });
  const room = await new SharedRoom({ relayUrl: relay.url, registrationSecret, threadId: 'synthetic-thread', runtimeDir: runtime, requireApproval, rpcFactory: async () => rpc }).start();
  t.after(async () => { room.close(); await relay.close(); });
  async function join(admit = true) {
    const ws = new WebSocket(relay.url.replace(/^http/, 'ws')+'/guest', { origin: relay.url }), messages = [];
    ws.on('message', b => messages.push(JSON.parse(b))); await once(ws, 'open'); t.after(() => ws.terminate());
    ws.send(JSON.stringify({ type: 'join', roomId: room.roomId, inviteToken: room.inviteToken, name: 'Synthetic guest' }));
    const pending = await until(() => messages.find(m => m.type === 'pending')); await until(() => room.guests.has(pending.guestId));
    if (admit) { room.admit(pending.guestId, true); await until(() => messages.some(m => m.payload?.type === 'upload-policy')); }
    return { ws, messages, id: pending.guestId,
      send: m => ws.send(JSON.stringify(m)),
      async upload(name, bytes) {
        const id = randomUUID();
        async function exchange(m, status, index) {
          ws.send(JSON.stringify({ ...m, uploadId: id }));
          return until(() => messages.map(m => m.payload).find(m => m?.uploadId === id && m.status === status && (index === undefined || m.index === index)));
        }
        await exchange({ type: 'upload-start', name, size: bytes.length }, 'uploading', 0);
        let index=0;
        for (let start=0; start<bytes.length; start+=UPLOAD_CHUNK_BYTES) await exchange({ type: 'upload-chunk', index, data: bytes.subarray(start,start+UPLOAD_CHUNK_BYTES).toString('base64') }, 'uploading', ++index);
        await exchange({ type: 'upload-finish' }, 'ready'); return id;
      } };
  }
  return { rpc, room, relay, join };
}
test('real relay transports a multi-chunk file beyond the old message rate, then dispatches once with no paths in guest acknowledgements', async t => {
  const { rpc, room, join } = await live(t), guest = await join();
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES*122+5, 65), id = await guest.upload('large.bin', bytes);
  const requestId = randomUUID(), proposal = { type: 'proposal', requestId, text: '', attachmentIds: [id] };
  guest.send(proposal); await until(() => room.proposals.get(`${guest.id}:${requestId}`)?.status === 'accepted');
  assert.equal(rpc.calls.length, 1); assert.deepEqual(fs.readFileSync(room.uploads.items.get(id).path), bytes);
  assert.ok(rpc.calls[0].input[0].text.includes('large.bin')); guest.send(proposal); await delay(30); assert.equal(rpc.calls.length, 1);
  const statuses = guest.messages.filter(m => m.payload?.type === 'upload-status'); assert.ok(statuses.length > 120);
  assert.ok(statuses.every(m => !JSON.stringify(m).includes('.coop')));
  assert.ok(!JSON.stringify(room.view()).includes('guest-uploads'));
});
test('file proposals follow local approval, reject foreign IDs and deletion, and keep native approvals unavailable', async t => {
  const { rpc, room, join } = await live(t, true), a = await join(), b = await join();
  const id = await a.upload('picture.png', png), forgedId = randomUUID();
  b.send({ type: 'proposal', requestId: forgedId, text: 'foreign', attachmentIds: [id] });
  await until(() => b.messages.some(m => m.payload?.requestId === forgedId && m.payload.status === 'rejected')); assert.equal(rpc.calls.length, 0);
  const requestId = randomUUID(); a.send({ type: 'proposal', requestId, text: 'Inspect picture', attachmentIds: [id] });
  await until(() => room.proposals.has(`${a.id}:${requestId}`)); room.setRequireApproval(false); assert.equal(rpc.calls.length, 0);
  await room.decide(`${a.id}:${requestId}`, true); assert.equal(rpc.calls.length, 1); assert.equal(rpc.calls[0].input[1].type, 'localImage');
  const rejectedId = await a.upload('notes.txt', Buffer.from('private synthetic'));
  room.setRequireApproval(true); const rejectRequest = randomUUID(); a.send({ type: 'proposal', requestId: rejectRequest, text: '', attachmentIds: [rejectedId] });
  await until(() => room.proposals.has(`${a.id}:${rejectRequest}`)); const file = room.uploads.items.get(rejectedId).path;
  await room.decide(`${a.id}:${rejectRequest}`, false); assert.equal(fs.existsSync(file), false); assert.equal(rpc.calls.length, 1);
});
test('guest departure removes unsubmitted uploads; uncertain dispatch retains bytes and never replays', async t => {
  const { rpc, room, join } = await live(t), a = await join();
  const id = await a.upload('pending.txt', Buffer.from('pending')), file = room.uploads.items.get(id).path;
  a.ws.close(); await until(() => !room.guests.has(a.id)); assert.equal(fs.existsSync(file), false);
  const b = await join(), unknown = await b.upload('audio.wav', Buffer.from('RIFF synthetic WAVE')); rpc.fail = true;
  const requestId = randomUUID(), proposal = { type: 'proposal', requestId, text: '', attachmentIds: [unknown] };
  b.send(proposal); await until(() => room.proposals.get(`${b.id}:${requestId}`)?.status === 'unknown');
  b.send(proposal); await delay(30); assert.equal(rpc.calls.length, 1); const retained = room.uploads.items.get(unknown).path;
  room.close(); assert.equal(fs.existsSync(retained), true);
});
test('pending admission and malformed upload fields are rejected by the relay before the host can write', async t => {
  const { room, join } = await live(t), a = await join(false);
  const closed = once(a.ws, 'close'); a.send({ type: 'upload-start', uploadId: randomUUID(), name: 'no.txt', size: 1 }); await closed;
  assert.equal(room.uploads.items.size, 0);
  const b = await join(), rejected = once(b.ws, 'close'); b.send({ type: 'upload-start', uploadId: randomUUID(), name: 'no.txt', size: 1, path: '/synthetic/secret' }); await rejected;
  assert.equal(room.uploads.items.size, 0);
});

test('revocation while a previous message is in flight prevents queued attachments from dispatching', async t => {
  const { rpc, room, join } = await live(t), guest = await join();
  const id = await guest.upload('queued.txt', Buffer.from('queued synthetic')), file = room.uploads.items.get(id).path;
  let release; rpc.hold = new Promise(resolve => { release = resolve; });
  guest.send({ type: 'proposal', requestId: randomUUID(), text: 'Hold first input' }); await until(() => rpc.calls.length === 1);
  const requestId = randomUUID(); guest.send({ type: 'proposal', requestId, text: '', attachmentIds: [id] });
  await until(() => room.proposals.has(`${guest.id}:${requestId}`)); room.removeGuest(guest.id); release();
  await until(() => room.proposals.get(`${guest.id}:${requestId}`)?.status === 'rejected');
  assert.equal(rpc.calls.length, 1); assert.equal(fs.existsSync(file), false);
});

test('inaccessible execution environments disable uploads and never accept guest bytes', async t => {
  const { rpc, room, join } = await live(t); rpc.canUploadAttachments = () => false;
  const guest = await join(), policy = guest.messages.find(m => m.payload?.type === 'upload-policy');
  assert.equal(policy.payload.enabled, false);
  const id = randomUUID(); guest.send({ type: 'upload-start', uploadId: id, name: 'blocked.txt', size: 1 });
  await until(() => guest.messages.some(m => m.payload?.uploadId === id && m.payload.status === 'failed'));
  assert.equal(room.uploads.items.size, 0); assert.equal(rpc.calls.length, 0);
});

test('duplicate image-file display correlation requires the same structured path and keeps video and original download scope', async t => {
  const { store } = fixture(t);
  const first = upload(store,'guest','same.png',png), second = upload(store,'guest','same.png',png), video = upload(store,'guest','movie.mp4',Buffer.from('synthetic video'));
  const paths = [first,second,video].map(id=>store.items.get(id).path), rpc = new EventEmitter();
  rpc.request = async () => ({ thread: { id:'synthetic-thread',status:{type:'idle'},turns:[{id:'synthetic-turn',status:'completed',items:[{
    id:'synthetic-user',type:'userMessage',content:[{type:'text',text:'Synthetic image and video'}, {type:'localImage',path:paths[0]}, ...paths.map(path=>({type:'localFile',path}))],
  }]}] } });
  const thread = new ScopedThread({rpc,threadId:'synthetic-thread'}); await thread.start(); t.after(()=>thread.close());
  const item=thread.snapshot.items[0]; assert.equal(item.files[0].previewImageId,item.images[0].id);
  assert.equal(item.files[1].previewImageId,undefined,'another file with the same basename must remain visible');
  assert.equal(item.files[2].kind,'video'); assert.equal(item.files[2].previewImageId,undefined);
  for(const file of item.files)assert.equal(thread.hasFile(file.id),true);
  assert.ok(!JSON.stringify(item).includes('guest-uploads/'));
});
