import test from 'node:test';
import assert from 'node:assert/strict';
import { publishLanBonjour } from '../lib/lan-bonjour.mjs';

const address = '192.168.44.29', port = 57471;
function interfaces() {
  const entry = ip => ({ address: ip, family: 'IPv4', netmask: '255.255.255.0', internal: false });
  return { en0: [entry(address)], bridge100: [entry('192.168.139.3')] };
}
function fixture(overrides = {}) {
  const registrations = [];
  const options = {
    platform: 'darwin', networkInterfaces: interfaces, getLocalHostName: async () => 'Desk-Mac',
    lookupAddresses: async () => [{ family: 4, address }],
    register(request) {
      const record = { active: true, closed: false, ready: Promise.resolve(true),
        close() { this.active = false; this.closed = true; } };
      registrations.push({ request, record });
      return record;
    },
    ...overrides,
  };
  return { options, registrations };
}

test('both Bonjour names are scoped to the selected IPv4; only the entry hostname changes after a move', async () => {
  const { options, registrations } = fixture();
  const first = await publishLanBonjour(address, port, options);
  assert.equal(first.hostname, 'desk-mac-co2-57471.local');
  assert.equal(first.entryHostname, 'v4-c0a82c1d.' + first.hostname);
  assert.deepEqual(registrations.map(({ request }) => request.hostname), [first.hostname, first.entryHostname]);
  for (const { request } of registrations) {
    assert.equal(request.interfaceName, 'en0'); assert.equal(request.address, address); assert.equal(request.port, port);
  }
  assert.equal(await first.isCurrent(), true);
  await first.close();
  assert.equal(await first.isCurrent(), false);
  const nextAddress = '192.168.139.3', queried = new Set();
  const next = await publishLanBonjour(nextAddress, port, { ...options,
    lookupAddresses: async (name, flags) => {
      queried.add(name); assert.deepEqual(flags, { all: true });
      return [{ address: nextAddress, family: 4 }];
    } });
  assert.equal(next.hostname, first.hostname);
  assert.equal(next.entryHostname, 'v4-c0a88b03.' + first.hostname);
  assert.deepEqual(queried, new Set([next.hostname + '.', next.entryHostname + '.']));
  assert.ok(registrations.slice(2).every(({ request }) => request.interfaceName === 'bridge100'));
  await next.close();
  const other = await publishLanBonjour(address, port + 1, options);
  assert.notEqual(other.hostname, first.hostname); assert.notEqual(other.entryHostname, first.entryHostname);
  await other.close();
  assert.ok(registrations.every(({ record }) => record.closed));
});

test('a loopback, second interface, IPv6 or stale answer for either name prevents its use', async () => {
  const { options, registrations } = fixture();
  const answers = [{ family: 4, address }];
  const publication = await publishLanBonjour(address, port, options);
  for (const name of [publication.hostname, publication.entryHostname]) {
    for (const invalid of [[], [{ family: 4, address: '192.168.139.3' }],
      [...answers, { family: 4, address: '127.0.0.1' }], [...answers, { family: 6, address: '::1' }]]) {
      options.lookupAddresses = async queried => queried === name + '.' ? invalid : answers;
      assert.equal(await publishLanBonjour(address, port, options), null);
      assert.ok(registrations.slice(-2).every(({ record }) => record.closed));
    }
  }
  // A registrar can exit while its owner's old addresses remain in resolver caches.
  registrations[1].record.active = false;
  assert.equal(await publication.isCurrent(), false);
  await publication.close();
});

test('partial startup, lookup timeout and service cancellation withdraw both owned records', async () => {
  for (const failedIndex of [0, 1]) {
    for (const ready of [Promise.resolve(false), new Promise(() => {})]) {
      const { options, registrations } = fixture();
      const result = await publishLanBonjour(address, port, { ...options, timeoutMs: 20,
        register(request) {
          const index = registrations.length;
          const record = options.register(request);
          if (index === failedIndex) record.ready = ready;
          return record;
        } });
      assert.equal(result, null); assert.equal(registrations.length, 2);
      assert.ok(registrations.every(({ record }) => record.closed));
    }
  }
  const { options, registrations } = fixture();
  assert.equal(await publishLanBonjour(address, port, { ...options, register(request) {
    if (registrations.length) throw new Error('Could not spawn second registrar');
    return options.register(request);
  } }), null);
  assert.equal(registrations[0].record.closed, true);
  const controller = new AbortController();
  const published = await publishLanBonjour(address, port, { ...options, signal: controller.signal });
  controller.abort();
  assert.ok(registrations.slice(-2).every(({ record }) => record.closed));
  assert.equal(await published.isCurrent(), false);
  await published.close();
  const { options: stalled, registrations: stalledRecords } = fixture({
    lookupAddresses: () => new Promise(() => {}), timeoutMs: 20,
  });
  assert.equal(await publishLanBonjour(address, port, stalled), null);
  assert.ok(stalledRecords.every(({ record }) => record.closed));
});

test('only a unique eligible interface and valid macOS computer name can be published', async () => {
  const { options, registrations } = fixture();
  for (const [ip, selectedPort, changes] of [
    [address, port, { platform: 'win32' }], ['127.0.0.1', port, {}], ['10.99.0.1', port, {}], [address, 0, {}],
    [address, port, { getLocalHostName: async () => 'bad.example' }],
    [address, port, { getLocalHostName: async () => { throw Error('name unset'); } }],
    [address, port, { networkInterfaces: () => ({ ...interfaces(), en1: interfaces().en0 }) }],
  ]) assert.equal(await publishLanBonjour(ip, selectedPort, { ...options, ...changes }), null);
  assert.deepEqual(registrations, []);
  const longName = await publishLanBonjour(address, port, { ...options, getLocalHostName: async () => 'a'.repeat(63) });
  assert.equal(longName.hostname.split('.')[0].length, 63);
  const instances = registrations.map(({ request }) => request.instance);
  assert.equal(new Set(instances).size, 2);
  assert.ok(instances.every(label => Buffer.byteLength(label) <= 63 && label.includes(String(port))));
  await longName.close();
});
