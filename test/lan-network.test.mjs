import test from 'node:test';
import assert from 'node:assert/strict';
import { privateIPv4, lanInterfaces, selectLanAddress, lanRequestAllowed } from '../lib/lan-network.mjs';

const entry = (address, overrides = {}) => ({ address, family: 'IPv4', internal: false, ...overrides });
const request = (remoteAddress = '192.168.1.42', headers = {}) => ({
  headers: { host: '192.168.1.2:8787', ...headers }, socket: { remoteAddress, localAddress: '192.168.1.2' },
});
const listener = { address: '192.168.1.2', port: 8787 };

test('LAN address membership accepts only canonical RFC1918 IPv4', () => {
  for (const address of ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255']) {
    assert.equal(privateIPv4(address), true, address);
  }
  for (const address of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0',
    '0.0.0.0', '127.0.0.1', '169.254.1.2', '100.64.0.1', '100.127.255.255', '8.8.8.8', '224.0.0.1', '255.255.255.255',
    '192.168.01.2', '010.0.0.1', '10.0.0.256', '10.0.0.-1', '10.0.0.1\n', ' 10.0.0.1', '10.0.0.1 ', '10.1', '167772161',
    '0x0a000001', '10.0.0.1:80', 'localhost', 'internal.example', '::1', 'fd00::1', '::ffff:10.0.0.1', '', null, undefined, 10]) {
    assert.equal(privateIPv4(address), false, String(address));
  }
});

test('interface candidates discard public, internal and unsupported entries, deduplicate and sort', () => {
  const interfaces = {
    z0: [entry('192.168.5.2'), entry('192.168.5.2'), entry('fd00::1', { family: 'IPv6' })],
    lo0: [entry('10.0.0.1', { internal: true }), entry('127.0.0.1', { internal: true })],
    en0: [entry('10.0.0.8'), entry('10.0.0.2', { family: 4 }), entry('8.8.8.8'), entry('169.254.1.2'), entry('100.64.1.2'),
      entry('10.0.0.9', { family: 'IPv6' }), entry('10.0.0.10', { internal: undefined }), null],
    missing: undefined,
  };
  assert.deepEqual(lanInterfaces(interfaces), [
    { name: 'en0', address: '10.0.0.2' }, { name: 'en0', address: '10.0.0.8' }, { name: 'z0', address: '192.168.5.2' },
  ]);
  assert.deepEqual(lanInterfaces({}), []);
  assert.deepEqual(lanInterfaces(null), []);
});

test('LAN selection never invents or retains an address that is not currently assigned', () => {
  const one = { en0: [entry('192.168.1.2')] };
  assert.equal(selectLanAddress(undefined, one), '192.168.1.2');
  assert.equal(selectLanAddress('', one), '192.168.1.2');
  assert.equal(selectLanAddress('192.168.1.2', one), '192.168.1.2');
  for (const address of ['192.168.1.3', '192.168.01.2', '0.0.0.0', '127.0.0.1', 'public.example', '8.8.8.8']) {
    assert.throws(() => selectLanAddress(address, one), /已不可用/, address);
  }
  assert.throws(() => selectLanAddress('192.168.1.2', {}), /未找到/);
  assert.throws(() => selectLanAddress(undefined, { en0: [entry('8.8.8.8')] }), /未找到/);
  const many = { en0: [entry('192.168.1.2')], utun0: [entry('10.0.0.2')] };
  assert.throws(() => selectLanAddress(undefined, many), /多个.*选择/);
  assert.equal(selectLanAddress('10.0.0.2', many), '10.0.0.2');
  assert.equal(selectLanAddress(undefined, { en0: [entry('10.0.0.2')], alias0: [entry('10.0.0.2')] }), '10.0.0.2');
});

test('direct LAN requests require an exact Host and a real private socket peer', () => {
  for (const peer of ['192.168.1.42', '10.4.3.2', '172.16.0.7', '::ffff:192.168.1.42', '::ffff:10.4.3.2']) {
    assert.equal(lanRequestAllowed(request(peer), listener), true, peer);
  }
  for (const peer of ['8.8.8.8', '127.0.0.1', '::1', '169.254.1.2', '100.64.1.2', 'fd00::1', '::ffff:8.8.8.8',
    '::ffff:127.0.0.1', '::ffff:192.168.01.2', '0:0:0:0:0:ffff:c0a8:12a', '192.168.1.42 ']) {
    assert.equal(lanRequestAllowed(request(peer), listener), false, String(peer));
  }
  for (const host of ['evil.example:8787', '127.0.0.1:8787', '192.168.1.2', '192.168.1.2:80', '192.168.1.2:08787',
    '192.168.1.2:8787.', '192.168.1.2:8787@evil.example', ['192.168.1.2:8787']]) {
    assert.equal(lanRequestAllowed(request('192.168.1.42', { host }), listener), false, String(host));
  }
  for (const options of [{ address: '0.0.0.0', port: 8787 }, { address: '192.168.1.2', port: 0 },
    { address: '192.168.1.2', port: 65536 }, { address: '192.168.1.2', port: '8787' }]) {
    assert.equal(lanRequestAllowed(request(), options), false);
  }
  assert.equal(lanRequestAllowed({ headers: request().headers }, listener), false);
  assert.equal(lanRequestAllowed(null, listener), false);
  assert.equal(lanRequestAllowed(request(), null), false);
  const missingPeer = request(); delete missingPeer.socket.remoteAddress;
  assert.equal(lanRequestAllowed(missingPeer, listener), false);
  for (const localAddress of ['192.168.1.3', '127.0.0.1', '0.0.0.0', '8.8.8.8', undefined]) {
    const wrongListener = request(); wrongListener.socket.localAddress = localAddress;
    assert.equal(lanRequestAllowed(wrongListener, listener), false, String(localAddress));
  }
  const mapped = request('::FFFF:10.4.3.2'); mapped.socket.localAddress = '::ffff:192.168.1.2';
  assert.equal(lanRequestAllowed(mapped, listener), true);
});

test('forwarding headers cannot claim LAN membership or permit reverse proxies', () => {
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'X-Forwarded-For',
    'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'via', 'client-ip', 'x-envoy-external-address']) {
    assert.equal(lanRequestAllowed(request('192.168.1.42', { [name]: '192.168.1.3' }), listener), false, name);
    assert.equal(lanRequestAllowed(request('8.8.8.8', { [name]: '192.168.1.3' }), listener), false, name);
  }
  assert.equal(lanRequestAllowed(request('192.168.1.42', { 'user-agent': 'Synthetic browser' }), listener), true);
});
