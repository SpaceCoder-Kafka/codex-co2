#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { SharingService } from '../lib/sharing-service.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  public: { type: 'boolean' }, relay: { type: 'string' }, 'registration-file': { type: 'string' }, 'no-desktop': { type: 'boolean' },
  'tunnel-token-file': { type: 'string' },
  'intranet-only': { type: 'boolean' }, 'lan-address': { type: 'string' },
  attach: { type: 'boolean' }, thread: { type: 'string' }, 'ipc-path': { type: 'string' }, 'index-path': { type: 'string' },
  open: { type: 'boolean' }, 'runtime-dir': { type: 'string' }, 'resource-root': { type: 'string' }, cli: { type: 'string' }, cloudflared: { type: 'string' },
  port: { type: 'string', default: '0' }, bind: { type: 'string', default: '127.0.0.1' }, origin: { type: 'string' }, help: { type: 'boolean' },
} });
const mode = positionals[0] ?? 'host';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = new SharingService({ mode, resourceRoot: values['resource-root'] ?? root, runtimeDir: values['runtime-dir'],
  publicMode: values.public, relayUrl: values.relay, registrationFile: values['registration-file'], desktop: !values['no-desktop'],
  tunnelTokenFile: values['tunnel-token-file'],
  intranetOnly: values['intranet-only'], lanAddress: values['lan-address'],
  attach: values.attach, threadId: values.thread, ipcPath: values['ipc-path'], indexPath: values['index-path'],
  bind: values.bind, port: Number(values.port), origin: values.origin, cliPath: values.cli, cloudflaredPath: values.cloudflared });
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => service.close().then(() => process.exit()));
async function main() {
  if (values.help) console.log('Fixed hostname: --public --origin https://YOUR_HOST --port 8787 --tunnel-token-file /absolute/private/token (configure Cloudflare ingress for the relay port only).');
  if (values.help) console.log('LAN only: host --attach --intranet-only [--lan-address PRIVATE_IPV4] uses direct unencrypted HTTP/WS without Cloudflare. Public/named-tunnel/external-relay options cannot be combined.');
  if (values.help || !['host', 'demo', 'relay'].includes(mode)) return console.log('share.mjs host|demo|relay [--public] [--open] [--runtime-dir /absolute/.coop] [--cli /absolute/codex] [--cloudflared /absolute/cloudflared]\nhost --attach [--thread UUID] [--ipc-path /absolute/ipc.sock] [--index-path /absolute/state_5.sqlite] connects to a running Desktop without starting Codex or logging in. The index is read only for conversation metadata.\n--no-desktop skips the Desktop bridge. --relay URL uses an existing relay.');
  if ((values.thread || values['ipc-path'] || values['index-path']) && !values.attach) throw new Error('--thread, --ipc-path and --index-path require --attach');
  if (values.open && (process.platform !== 'darwin' || mode === 'relay' || values['no-desktop'])) throw new Error('--open requires macOS host/demo mode and cannot be combined with --no-desktop.');
  const info = await service.start();
  console.log(JSON.stringify(info, null, 2));
  if (values.open) {
    const run = promisify(execFile);
    if (info.desktopLauncher) await run('/bin/sh', [info.desktopLauncher]);
    if (!service.closed) await run('/usr/bin/open', [info.ownerUrl]);
  }
  console.log('打开 ownerUrl 选择会话、生成邀请、批准加入并设置消息审批。Ctrl-C 关闭共享；不会重放未确认建议。');
}
main().catch(async error => { console.error(`ERROR: ${error.message}`); await service.close(); process.exitCode = 1; });
