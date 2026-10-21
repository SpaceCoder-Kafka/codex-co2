import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicHealth } from '../lib/public-health.mjs';

test('public monitoring tolerates transient failure, marks sustained failure and recovers without replacing an origin', async () => {
  const states = [], origins = []; let ok = false, checks = 0;
  const monitor = new PublicHealth({ origin: 'https://synthetic.invalid', checkHealth: async origin => { origins.push(origin); return { ok }; },
    onStatus: state => states.push(state.state), onCheck: () => checks++ });
  for (let i = 0; i < 3; i++) await monitor.check();
  ok = true; await monitor.check();
  assert.deepEqual(states, ['recovering', 'recovering', 'unavailable', 'online']);
  assert.equal(checks, 4); assert.equal(new Set(origins).size, 1);
  await monitor.close(); await monitor.check(); assert.equal(checks, 4);
});

test('overlapping probes coalesce and shutdown aborts an outstanding request without publishing failure', async () => {
  let calls = 0; const states = [];
  const monitor = new PublicHealth({ origin: 'https://synthetic.invalid', onStatus: value => states.push(value),
    checkHealth: (_origin, { signal }) => { calls++; return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })); } });
  const first = monitor.check(), second = monitor.check();
  assert.equal(first, second); assert.equal(calls, 1);
  await monitor.close(); await first; assert.deepEqual(states, []);
});
