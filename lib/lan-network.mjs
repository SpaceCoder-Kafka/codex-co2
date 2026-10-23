import os from 'node:os';

// Intentionally narrower than all non-public addresses: LAN sharing accepts
// only canonical RFC1918 IPv4, never an arbitrary hostname, tunnel or wildcard.
export function privateIPv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function lanInterfaces(interfaces = os.networkInterfaces()) {
  const candidates = new Map();
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.internal !== false || !['IPv4', 4].includes(entry.family) || !privateIPv4(entry.address)) continue;
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
  const { address, port } = options ?? {};
  if (!privateIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 || !req?.headers || !req.socket) return false;
  // These headers do not establish network membership. Direct LAN mode rejects
  // proxy traffic instead of accepting a claimed original private address.
  if (Object.keys(req.headers).some(name => proxyHeader.test(name))) return false;
  if (req.headers.host !== `${address}:${port}`) return false;
  if (socketIPv4(req.socket.localAddress) !== address) return false;
  // Routed RFC1918 peers may join across company subnets. This does not detect
  // a gateway deliberately performing SNAT or forwarding external connections.
  return privateIPv4(socketIPv4(req.socket.remoteAddress));
}
