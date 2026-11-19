import os from 'node:os';
import { lookup } from 'node:dns/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lanEntryHostname, lanInterfaces, privateIPv4, validLanHostname } from './lan-network.mjs';

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

function registerRecord({ hostname, instance, interfaceName, address, port }) {
  const args = ['-i', interfaceName, '-P', instance, '_codex-co2._tcp', 'local.', String(port), hostname + '.', address];
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

// The identity origin stays stable. A different entry name on each address lets
// an invitation reach the new listener while browsers still cache the old IP.
export async function publishLanBonjour(address, port, { platform = process.platform, networkInterfaces = os.networkInterfaces,
  getLocalHostName = localHostName, register = registerRecord, lookupAddresses = lookup, signal, timeoutMs = 3500 } = {}) {
  if (platform !== 'darwin' || !privateIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 || signal?.aborted) return null;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const matches = lanInterfaces(networkInterfaces()).filter(entry => entry.address === address);
  if (matches.length !== 1) return null;
  const computer = await bounded(getLocalHostName(timeoutMs), remaining(), null);
  if (typeof computer !== 'string' || signal?.aborted || !validLanHostname(computer.toLowerCase() + '.local')) return null;
  const label = computer.toLowerCase();
  const suffix = '-co2-' + port;
  const hostname = label.slice(0, 63 - suffix.length) + suffix + '.local';
  const entryHostname = lanEntryHostname(hostname, address);
  const names = [hostname, entryHostname];
  const records = [];
  let closing;
  function close() {
    signal?.removeEventListener('abort', close);
    return closing ??= Promise.all(records.map(record => record.close()));
  }
  try {
    for (const name of names) {
      // DNS-SD instances are single labels of at most 63 bytes. Put the role
      // and port first to keep the two services distinct even for long names.
      const role = name === hostname ? 'identity' : name.split('.')[0];
      const instance = `co2-${port}-${role}-${label}`.slice(0, 63);
      records.push(register({ hostname: name, instance, address, port, interfaceName: matches[0].name }));
    }
  } catch {
    await close(); return null;
  }
  signal?.addEventListener('abort', close, { once: true });
  const active = () => !closing && !signal?.aborted && records.every(record => record.active);
  async function isCurrent(budget = timeoutMs) {
    if (!active()) return false;
    // Check all A and AAAA answers for both names through the system resolver.
    const verified = await bounded(Promise.all(names.map(async name => {
      const answers = await lookupAddresses(name + '.', { all: true });
      return answers.length > 0 && answers.every(answer => answer.family === 4 && answer.address === address);
    })), budget, null);
    return active() && Boolean(verified?.every(Boolean));
  }
  const ready = await bounded(Promise.all(records.map(record => record.ready)), remaining(), null);
  if (ready?.every(Boolean) && await isCurrent(remaining())) return { hostname, entryHostname, isCurrent, close };
  await close();
  return null;
}
