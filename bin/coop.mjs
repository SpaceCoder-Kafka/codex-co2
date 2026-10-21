#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient, eventMetadata } from '../lib/rpc.mjs';
import { paths, prepare, resolveCli, readJson, start, stop, ownsProcess, accountIdentity, compareIdentity, isolatedEnv } from '../lib/runtime.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  cli: { type: 'string' }, thread: { type: 'string' }, watch: { type: 'boolean' }, seconds: { type: 'string', default: '60' },
  ssh: { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '22' },
  user: { type: 'string' }, alias: { type: 'string', default: 'codex-coop' }, install: { type: 'boolean' },
  help: { type: 'boolean' },
  'legacy-root': { type: 'string', multiple: true },
} });
const p = paths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const print = value => console.log(JSON.stringify(value, null, 2));
const usage = `Commands: doctor | migrate | start | stop | login | probe [--thread ID] [--watch --seconds 60]
          ssh-remove (cleanup of the retired experiment only)
Sharing: npm run host -- --public (A Desktop, B browser, optional owner message approval)
Options: --cli /absolute/path/to/codex-0.163.0
Only 'login' opens the isolated authentication flow. Probe never sends a prompt or approves a tool.`;

async function probe() {
  const state = await readJson(p.stateFile);
  if (!ownsProcess(state, p)) throw new Error('No matching owned backend. Run npm start.');
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error('--seconds must be 1..3600');
  if (values.watch && !values.thread) throw new Error('--watch requires --thread ID');
  const events = [];
  let summary;
  const connectionOptions = { onEvent: message => {
    if (message.method) {
      const event = eventMetadata(message);
      if (event.threadId && event.threadId !== values.thread) return;
      events.push(event);
      if (values.watch) console.log(JSON.stringify(event));
    }
  } };
  let client;
  try {
    client = values.ssh ? await RpcClient.connectSsh(values.ssh, connectionOptions) : await RpcClient.connect(p.socketPath, connectionOptions);
    const identityBefore = await accountIdentity(client, p);
    const baseline = await compareIdentity(p, identityBefore);
    const threads = await client.request('thread/list', { limit: 30 });
    let thread, effective;
    const configuration = resumed => ({ model: resumed.model, modelProvider: resumed.modelProvider,
      reasoningEffort: resumed.reasoningEffort, cwd: resumed.cwd, sandbox: resumed.sandbox, approvalPolicy: resumed.approvalPolicy });
    if (values.thread) {
      thread = (await client.request('thread/read', { threadId: values.thread, includeTurns: true })).thread;
      if (values.watch) {
        const resumed = await client.request('thread/resume', { threadId: values.thread });
        effective = configuration(resumed);
      }
    }
    print({ backendPid: state.pid, socketPath: p.socketPath, transport: values.ssh ? `ssh:${values.ssh}` : 'unix', identity: identityBefore, baseline,
      thread: thread ? { id: thread.id, cwd: thread.cwd, turnIds: thread.turns?.map(t => t.id) } : null,
      effective,
      threads: threads.data?.map(t => ({ id: t.id, name: t.name ?? null, cwd: t.cwd })),
      note: values.watch ? 'Observer subscribed; does not submit inputs or answer approvals. Ctrl-C ends observation.' : 'Read-only snapshot; not proof of live Desktop synchronization.' });
    if (values.watch) {
      const abort = new AbortController();
      const interrupted = () => abort.abort();
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      try { await delay(seconds * 1000, undefined, { signal: abort.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
      finally { process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); }
    }
    const identityAfter = await accountIdentity(client, p);
    const comparison = await compareIdentity(p, identityAfter);
    const effectiveAfter = values.watch ? configuration(await client.request('thread/resume', { threadId: values.thread })) : null;
    const configUnchanged = effective ? JSON.stringify(effective) === JSON.stringify(effectiveAfter) : null;
    summary = { at: new Date().toISOString(), kind: 'probe-summary', backendPid: state.pid,
      transport: values.ssh ? `ssh:${values.ssh}` : 'unix',
      threadId: values.thread ?? null, eventCount: events.length,
      accountBefore: identityBefore, accountAfter: identityAfter, baselineRecorded: comparison.baselineRecorded,
      accountUnchanged: comparison.unchanged, configBefore: effective ?? null, configAfter: effectiveAfter,
      configUnchanged, runtimeUnchanged: ownsProcess(state, p) };
    if (comparison.unchanged === false || baseline.unchanged === false || configUnchanged === false || !summary.runtimeUnchanged) process.exitCode = 2;
    print(summary);
  } finally {
    client?.close();
    summary ??= { at: new Date().toISOString(), kind: 'probe-failed', backendPid: state.pid,
      threadId: values.thread ?? null, eventCount: events.length, reason: 'RPC or connection failure; see terminal error' };
    await fs.appendFile(p.eventsFile, [...events, summary].map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  }
}

async function main() {
  const command = positionals[0];
  if (values.help || !command) return console.log(usage);
  if (command === 'ssh-setup') throw new Error('SSH sharing is retired: it grants host-level access. Use npm run host -- --public for a scoped browser invitation.');
  if (command === 'stop') return print(await stop(p));
  if (command === 'migrate') {
    const { migrateRuntime } = await import('../lib/migration.mjs');
    return print(await migrateRuntime(p, { legacyRoots: values['legacy-root'] }));
  }
  if (command === 'probe') return probe();
  if (command === 'ssh-remove') {
    const { removeSsh } = await import('../lib/ssh.mjs');
    return print(await removeSsh(p));
  }
  const { cliPath, version } = resolveCli(values.cli);
  if (command === 'doctor') {
    const state = await readJson(p.stateFile);
    const relocated = typeof state?.socketPath === 'string' && state.socketPath !== p.socketPath;
    let backend;
    if (ownsProcess(state, p)) {
      const client = await RpcClient.connect(p.socketPath);
      try { backend = { pid: state.pid, identity: await accountIdentity(client, p) }; } finally { client.close(); }
    }
    return print({ node: process.version, cliPath, version, root: p.root, codexHome: p.codexHome, socketPath: p.socketPath,
      backend: backend ?? null,
      relocatedRuntime: relocated ? { recordedSocketPath: state.socketPath, recordedBackendRunning: ownsProcess(state, { ...p, socketPath: state.socketPath }) } : null,
      desktopAcceptance: 'Manual acceptance required: A official Desktop plus B browser. See README.md for current verification limits.',
      next: relocated ? 'Close the previous test Desktop and services, then npm run migrate. Inspect the isolated runtime state before migration.' : !backend ? 'npm start' : !backend.identity.authenticated ? 'npm run login (isolated account; existing Desktop login is not copied)' : 'npm run host -- --public --open; use the local owner page to invite a guest to one selected thread' });
  }
  if (command === 'start') return print(await start(p, cliPath));
  if (command === 'login') {
    await prepare(p);
    const child = spawn(cliPath, ['login'], { cwd: p.workspace, env: isolatedEnv(p), stdio: 'inherit' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }); });
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}
main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
