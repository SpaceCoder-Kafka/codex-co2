import os from 'node:os';
import { isIPv4 } from 'node:net';
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Intentionally narrower than all non-public addresses: LAN sharing accepts
// only canonical RFC1918 IPv4, never an arbitrary hostname, tunnel or wildcard.
export function privateIPv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

// Only the machine's own canonical, single-label Bonjour hostname is eligible
// as an additional browser origin. It never selects the listening interface.
export function validLanHostname(value) {
  return typeof value === 'string' && value !== 'localhost.local'
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(value);
}

const run = promisify(execFile);
async function macLocalHostName(timeoutMs) {
  const { stdout } = await run('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: timeoutMs, maxBuffer: 1024 });
  return stdout.trim();
}

export async function resolveLanHostname(address, { platform = process.platform, getLocalHostName = macLocalHostName,
  lookupAddresses = lookup, networkInterfaces = os.networkInterfaces, timeoutMs = 1500 } = {}) {
  if (platform !== 'darwin' || !privateIPv4(address)) return null;
  // macOS can list all of its own interfaces (including loopback and virtual
  // bridges) when resolving its Bonjour name locally. An off-machine answer
  // cannot establish that identity. Only the selected address ever listens.
  async function resolve() {
    const owned = new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
      .filter(entry => ['IPv4', 4].includes(entry.family)).map(entry => entry.address)));
    if (!owned.has(address)) return null;
    const name = (await getLocalHostName(timeoutMs)).toLowerCase() + '.local';
    if (!validLanHostname(name)) return null;
    const answers = await lookupAddresses(name + '.', { family: 4, all: true });
    return answers.some(answer => answer.address === address) && answers.every(answer => answer.family === 4 && owned.has(answer.address)) ? name : null;
  }
  let timer;
  try {
    return await Promise.race([resolve(), new Promise(done => { timer = setTimeout(done, timeoutMs, null); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const ipv4Number = address => address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);

function usableHostAddress(address, netmask) {
  if (!isIPv4(netmask)) return false;
  const hostMask = ~ipv4Number(netmask) >>> 0;
  // A contiguous netmask leaves a suffix of ones after inversion.
  if ((hostMask & (hostMask + 1)) !== 0) return false;
  if (hostMask <= 1) return true; // Both /31 endpoints and a /32 host are usable.
  const host = (ipv4Number(address) & hostMask) >>> 0;
  return host !== 0 && host !== hostMask;
}

export function lanInterfaces(interfaces = os.networkInterfaces()) {
  const candidates = new Map();
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.internal !== false || !['IPv4', 4].includes(entry.family)
        || !privateIPv4(entry.address) || !usableHostAddress(entry.address, entry.netmask)) continue;
      candidates.set(`${name}\0${entry.address}`, { name, address: entry.address });
    }
  }
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return [...candidates.values()].sort((a, b) => compare(a.name, b.name) || compare(a.address, b.address));
}

export function selectLanAddress(address, interfaces = os.networkInterfaces()) {
  const candidates = lanInterfaces(interfaces);
  if (!candidates.length) throw new Error('未找到可用的内网 IPv4 地址，请先连接公司内网。');
  if (address !== undefined && address !== null && address !== '') {
    if (!privateIPv4(address) || !candidates.some(candidate => candidate.address === address)) {
      throw new Error('所选内网地址已不可用，请重新选择当前网络地址。');
    }
    return address;
  }
  const addresses = [...new Set(candidates.map(candidate => candidate.address))];
  if (addresses.length !== 1) throw new Error('检测到多个内网地址，请选择用于共享的网络地址。');
  return addresses[0];
}

const proxyHeader = /^(?:forwarded|x-forwarded(?:-.*)?|x-original-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|via|client-ip|x-cluster-client-ip|fastly-client-ip|x-envoy-external-address|x-proxyuser-ip|x-azure-clientip)$/i;
const socketIPv4 = value => typeof value === 'string' && /^::ffff:/i.test(value) ? value.slice(7) : value;

export function lanRequestAllowed(req, options = {}) {
  const { address, port, hostname } = options ?? {};
  if (!privateIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 || !req?.headers || !req.socket) return false;
  // These headers do not establish network membership. Direct LAN mode rejects
  // proxy traffic instead of accepting a claimed original private address.
  if (Object.keys(req.headers).some(name => proxyHeader.test(name))) return false;
  if (req.headers.host !== `${address}:${port}` && !(validLanHostname(hostname) && req.headers.host === `${hostname}:${port}`)) return false;
  if (socketIPv4(req.socket.localAddress) !== address) return false;
  // Routed RFC1918 peers may join across company subnets. This does not detect
  // a gateway deliberately performing SNAT or forwarding external connections.
  return privateIPv4(socketIPv4(req.socket.remoteAddress));
}
