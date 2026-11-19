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

test('Bonjour registration is scoped to the selected interface, and its name survives a DHCP move', async () => {
  const { options, registrations } = fixture();
  const first = await publishLanBonjour(address, port, options);
  assert.equal(first.hostname, 'desk-mac-co2-57471.local');
  assert.deepEqual(registrations[0].request, { hostname: first.hostname, interfaceName: 'en0', address, port });
  assert.equal(await first.isCurrent(), true);
  await first.close();
  assert.equal(await first.isCurrent(), false);
  const nextAddress = '192.168.139.3';
  const next = await publishLanBonjour(nextAddress, port, { ...options,
    lookupAddresses: async (name, flags) => {
      assert.equal(name, first.hostname + '.'); assert.deepEqual(flags, { all: true });
      return [{ address: nextAddress, family: 4 }];
    } });
  assert.equal(next.hostname, first.hostname);
  assert.equal(registrations[1].request.interfaceName, 'bridge100');
  await next.close();
  const other = await publishLanBonjour(address, port + 1, options);
  assert.notEqual(other.hostname, first.hostname);
  await other.close();
});

test('a loopback, second interface, IPv6 or stale answer withdraws the published invite', async () => {
  const { options, registrations } = fixture();
  let answers = [{ family: 4, address }];
  options.lookupAddresses = async () => answers;
  const publication = await publishLanBonjour(address, port, options);
  for (const invalidAnswers of [[], [{ family: 4, address: '192.168.139.3' }],
    [...answers, { family: 4, address: '127.0.0.1' }], [...answers, { family: 6, address: '::1' }]]) {
    answers = invalidAnswers;
    assert.equal(await publication.isCurrent(), false);
    assert.equal(await publishLanBonjour(address, port, options), null);
    assert.equal(registrations.at(-1).record.closed, true);
  }
  await publication.close();
});

test('registration failure, timeout and service cancellation retire owned records', async () => {
  const { options } = fixture();
  for (const ready of [Promise.resolve(false), new Promise(() => {})]) {
    let closed = false;
    const result = await publishLanBonjour(address, port, { ...options, timeoutMs: 10,
      register: () => ({ ready, active: false, close() { closed = true; } }) });
    assert.equal(closed, true); assert.equal(result, null);
  }
  const { options: cancellable, registrations } = fixture();
  const controller = new AbortController();
  const registered = await publishLanBonjour(address, port, { ...cancellable, signal: controller.signal });
  controller.abort();
  assert.equal(registrations[0].record.closed, true);
  assert.equal(await registered.isCurrent(), false);
  const { options: stalled, registrations: stalledRecords } = fixture({
    lookupAddresses: () => new Promise(() => {}), timeoutMs: 10,
  });
  assert.equal(await publishLanBonjour(address, port, stalled), null);
  assert.equal(stalledRecords[0].record.closed, true);
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
  await longName.close();
});
