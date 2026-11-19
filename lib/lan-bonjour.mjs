import os from 'node:os';
import { lookup } from 'node:dns/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lanInterfaces, privateIPv4, validLanHostname } from './lan-network.mjs';

const run = promisify(execFile);
async function localHostName(timeoutMs) {
  const { stdout } = await run('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: timeoutMs, maxBuffer: 1024 });
  return stdout.trim();
}

// Only the service owns the pipe's write end. EOF also withdraws the record
// when the service crashes or is killed. Arguments are positional, never shell text.
const superviseRegistration = `
/usr/bin/dns-sd "$@" </dev/null &
registrar=$!
trap 'kill "$registrar" 2>/dev/null; wait "$registrar" 2>/dev/null' 0
trap 'exit 0' HUP INT TERM
exec 1>&- 2>&-
IFS= read -r ignored
`;

function registerRecord({ hostname, interfaceName, address, port }) {
  const label = hostname.slice(0, -'.local'.length);
  const args = ['-i', interfaceName, '-P', label, '_codex-co2._tcp', 'local.', String(port), hostname + '.', address];
  const child = spawn('/bin/sh', ['-c', superviseRegistration, 'co2-bonjour', ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  let finishReady;
  const ready = new Promise(resolve => { finishReady = resolve; });
  const exited = new Promise(resolve => child.once('close', resolve));
  let active = false, stopping = false, output = '';
  function close() {
    if (!stopping) {
      stopping = true;
      active = false;
      finishReady(false);
      child.stdin.end();
    }
    return exited;
  }
  child.stdin.on('error', close);
  child.on('error', close);
  child.stdout.on('end', close);
  child.stdout.on('data', bytes => {
    if (active || stopping) return;
    output = (output + bytes.toString('ascii')).slice(-4096);
    if (output.includes('Got a reply for record ' + hostname + '.: Name now registered and active')) {
      active = true;
      finishReady(true);
    }
  });
  return { ready, get active() { return active; }, close };
}

async function bounded(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(done => { timer = setTimeout(done, timeoutMs, fallback); })]);
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

// A Mac's generic .local name can include loopback, IPv6, and other interfaces.
// Use a distinct, stable name whose only record is the selected LAN IPv4.
export async function publishLanBonjour(address, port, { platform = process.platform, networkInterfaces = os.networkInterfaces,
  getLocalHostName = localHostName, register = registerRecord, lookupAddresses = lookup, signal, timeoutMs = 3500 } = {}) {
  if (platform !== 'darwin' || !privateIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 || signal?.aborted) return null;
  const matches = lanInterfaces(networkInterfaces()).filter(entry => entry.address === address);
  if (matches.length !== 1) return null;
  const computer = await bounded(getLocalHostName(timeoutMs), timeoutMs, null);
  if (typeof computer !== 'string' || signal?.aborted || !validLanHostname(computer.toLowerCase() + '.local')) return null;
  const suffix = '-co2-' + port;
  const hostname = computer.toLowerCase().slice(0, 63 - suffix.length) + suffix + '.local';
  let record;
  try { record = register({ hostname, address, port, interfaceName: matches[0].name }); }
  catch { return null; }
  async function close() {
    signal?.removeEventListener('abort', close);
    await record.close();
  }
  signal?.addEventListener('abort', close, { once: true });
  async function isCurrent() {
    if (!record.active || signal?.aborted) return false;
    // Include both A and AAAA in the same system lookup a browser can use.
    const answers = await bounded(lookupAddresses(hostname + '.', { all: true }), timeoutMs, []);
    return record.active && !signal?.aborted && answers.length > 0
      && answers.every(answer => answer.family === 4 && answer.address === address);
  }
  if (await bounded(record.ready, timeoutMs, false) && await isCurrent()) return { hostname, isCurrent, close };
  await close();
  return null;
}
