import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AppControl } from '../lib/app-control.mjs';

function fixture(overrides = {}) {
  const input = new PassThrough(), output = new PassThrough(); const messages = [], commands = []; let closes = 0;
  output.on('data', data => data.toString().trim().split('\n').filter(Boolean).forEach(line => messages.push(JSON.parse(line))));
  const control = new AppControl({ input, output, start: async () => ({ ownerUrl: 'http://127.0.0.1:1/#owner=synthetic' }),
    command: async type => { commands.push(type); return { ok: true }; }, close: async () => { closes++; }, ...overrides }).run();
  return { input, output, messages, commands, control, get closes() { return closes; } };
}

test('private app protocol waits for readiness, accepts fragmented messages and rejects execution capabilities', async () => {
  const f = fixture(); await f.control.starting;
  f.input.write('{"type":"revoke-'); f.input.write('all","id":1}\n');
  f.input.write('{"type":"approve","id":2}\n{"type":"login","text":"untrusted input"}\nnull\n');
  await delay(20);
  assert.deepEqual(f.commands, ['revoke-all']);
  assert.equal(f.messages[0].type, 'ready');
  assert.ok(f.messages.filter(m => m.type === 'error').length >= 3);
  const ended = once(f.control, 'closed'); f.input.end(); await ended;
  assert.equal(f.closes, 1);
  await f.control.close(); assert.equal(f.closes, 1);
});

test('parent pipe EOF closes sharing even while startup is unresolved', async () => {
  let complete;
  const f = fixture({ start: () => new Promise(resolve => { complete = resolve; }) });
  const closed = once(f.control, 'closed'); f.input.end(); await closed;
  complete({ ownerUrl: 'private-capability' }); await f.control.starting;
  assert.equal(f.messages.some(m => m.type === 'ready'), false);
  assert.equal(f.closes, 1);
});

test('unexpected errors and oversized commands cannot leak diagnostics or execute input', async () => {
  const f = fixture({ command: async () => { throw new Error('sensitive-auth-token'); } });
  await f.control.starting;
  f.input.write('{"type":"login"}\n'); await delay(20);
  assert.ok(!JSON.stringify(f.messages).includes('sensitive-auth-token'));
  const closed = once(f.control, 'closed'); f.input.write('x'.repeat(16385)); await closed;
  assert.deepEqual(f.commands, []); assert.equal(f.closes, 1);
});
