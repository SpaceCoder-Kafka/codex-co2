#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { AppControl } from '../lib/app-control.mjs';
import { SharingService } from '../lib/sharing-service.mjs';
import { RpcClient } from '../lib/rpc.mjs';
import { processIdentity, binaryVersion } from '../lib/runtime.mjs';
import { DesktopIpc, desktopIpcPath } from '../lib/desktop-ipc.mjs';
import { BackgroundService, connectBackground } from '../lib/background-service.mjs';

const { values } = parseArgs({ options: {
  'runtime-dir': { type: 'string' }, 'resource-root': { type: 'string' }, cli: { type: 'string' }, cloudflared: { type: 'string' }, 'desktop-app': { type: 'string' },
  attach: { type: 'boolean' },
  'parent-ready': { type: 'boolean' },
  'intranet-only': { type: 'boolean' }, 'lan-address': { type: 'string' },
  daemon: { type: 'boolean' }, connect: { type: 'boolean' }, foreground: { type: 'boolean' },
} });
for (const key of ['runtime-dir', 'resource-root', 'cloudflared']) if (!path.isAbsolute(values[key] ?? '')) throw new Error('Desktop service requires absolute resource/runtime/binary paths');
if ((!values.attach || values.cli !== undefined) && !path.isAbsolute(values.cli ?? '')) throw new Error('Isolated Desktop service requires an absolute CLI path');
if (process.platform === 'win32' && !values.attach) throw new Error('Windows packages require an existing official Desktop; isolated backend startup is unsupported');
if ((values.daemon || values.connect || values.foreground) && (process.platform === 'win32' || !values.attach || values['parent-ready']
  || values.daemon && values.connect || values.foreground && !values.daemon)) throw new Error('Invalid background service mode');
if (values.connect) {
  // The bridge owns only this private control connection. Closing its stdio
  // never sends a service shutdown command.
  try { await connectBackground({ runtimeDir: values['runtime-dir'] }); process.exit(0); }
  catch { process.stderr.write('Background service is unavailable.\n'); process.exit(1); }
}
if (values['parent-ready']) {
  // The Windows manager assigns this child to its kill-on-close job before
  // releasing this gate. No runtime I/O or descendant process starts first.
  await new Promise((resolve, reject) => {
    let buffer = '';
    const finish = error => {
      clearTimeout(timer); process.stdin.off('data', data); process.stdin.off('end', ended); process.stdin.off('error', failed);
      process.stdin.pause(); error ? reject(error) : resolve();
    };
    const data = bytes => {
      buffer += bytes.toString('ascii');
      if (buffer.length > 64 || buffer.includes('\n') && buffer !== 'CO2_PARENT_READY\n') finish(new Error('Invalid manager lifecycle gate'));
      else if (buffer === 'CO2_PARENT_READY\n') finish();
    };
    const ended = () => finish(new Error('Manager lifecycle gate closed'));
    const failed = () => finish(new Error('Manager lifecycle gate failed'));
    const timer = setTimeout(() => finish(new Error('Manager lifecycle gate timed out')), 10000);
    process.stdin.on('data', data); process.stdin.once('end', ended); process.stdin.once('error', failed);
  });
}
if (!binaryVersion(values.cloudflared).startsWith('cloudflared version 2026.10.1 ')) throw new Error('Expected bundled cloudflared 2026.10.1');
const appPath = values['desktop-app'] ?? '/Applications/ChatGPT.app';
let service, control;
const makeService = ({ persistentLan = false } = {}) => new SharingService({ mode: 'host', resourceRoot: values['resource-root'], runtimeDir: values['runtime-dir'],
  cliPath: values.cli, cloudflaredPath: values.cloudflared, lazyPublic: true, appPath, attach: values.attach,
  ...(values.daemon ? { deferDesktop: true, recoverStaleLease: true, persistentLan } : {}),
  ...(process.platform === 'win32' ? { openThread: async threadId => {
    // Native navigation belongs to the main manager process, outside the
    // helper's kill-on-close job. Never launch the official Desktop here.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid Desktop conversation ID');
    service.emit('resource', { kind: 'desktop-thread', threadId });
  } } : {}),
  intranetOnly: values['intranet-only'], lanAddress: values['lan-address'] });
let loginRpc;
const safeError = message => Object.assign(new Error(message), { safeMessage: message });
const run = promisify(execFile);
const command = async (service, type) => {
    if (type === 'check-network') {
      if (service.getNetwork().intranetOnly) await service.checkConnection(); else await service.monitor?.check();
      return { ok: true };
    }
    if (type === 'revoke-all') { service.revokeAll(); return { ok: true }; }
    if (type === 'connect-current') {
      if (!values.attach) throw safeError('当前为隔离实验模式，请使用日常 Codex 接入模式。');
      const ipc = await DesktopIpc.connect(desktopIpcPath()); ipc.close(); return { ok: true };
    }
    if (values.attach && type === 'account') return { attached: true };
    if (values.attach && type === 'login') throw safeError('请直接在日常 Codex 中登录，然后重新连接助手。');
    if (values.attach && type === 'open-desktop') {
      if (process.platform === 'win32') service.emit('resource', { kind: 'desktop-open' });
      else await run('/usr/bin/open', [appPath]);
      return { ok: true };
    }
    if (type === 'account') {
      const rpc = await RpcClient.connect(service.p.socketPath);
      try { const { account } = await rpc.request('account/read', { refreshToken: false }); return { authenticated: account != null }; }
      finally { rpc.close(); }
    }
    if (type === 'login') {
      if (loginRpc) throw safeError('登录正在进行，请完成浏览器中的独立登录，或重启助手后重试。');
      const rpc = await RpcClient.connect(service.p.socketPath); loginRpc = rpc;
      rpc.on('notification', message => {
        if (message.method === 'account/login/completed') {
          control.send({ type: 'login-completed', success: message.params.success === true }); rpc.close(); loginRpc = null;
        }
      });
      try {
        const result = await rpc.request('account/login/start', { type: 'chatgpt' });
        const url = new URL(result.authUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname)) throw safeError('登录地址未通过检查，请在官方测试窗口中登录。');
        return { authUrl: url.href };
      } catch (error) { rpc.close(); loginRpc = null; throw error; }
    }
    if (type === 'open-desktop') {
      await fs.access(path.join(appPath, 'Contents/Info.plist')).catch(() => { throw safeError('请先安装官方 Codex Desktop，然后重试。'); });
      const profileArg = `--user-data-dir=${path.join(service.p.runtimeDir, 'desktop-profile')}`;
      const { stdout } = await run('/bin/ps', ['-axo', 'pid=,command=']);
      const existing = stdout.split('\n').find(line => line.includes(`${appPath}/Contents/MacOS/`) && line.includes(profileArg));
      if (existing) {
        const pid = Number(existing.trim().split(/\s+/)[0]);
        if (processIdentity(pid)) throw safeError('测试窗口已经打开。若它未连接，请关闭之前的测试窗口后再点击“打开 Codex”。');
      }
      await run('/bin/sh', [service.desktop.launcher]); return { ok: true };
    }
};
if (values.daemon) {
  control = new BackgroundService({ runtimeDir: values['runtime-dir'], foreground: values.foreground === true,
    ownedTunnelPath: values.cloudflared, serviceFactory: makeService, command });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void control.close().then(() => process.exit(0), () => process.exit(1)));
  control.once('closed', failure => process.exit(failure ? 1 : 0));
  try { if (!await control.start()) process.exit(0); }
  catch { process.stderr.write('Background sharing could not start safely.\n'); process.exit(1); }
} else {
service = makeService();
control = new AppControl({ input: process.stdin, output: process.stdout,
  start: () => service.start(),
  close: async () => { loginRpc?.close(); await service.close(); },
  command: type => command(service, type),
});
service.on('status', status => control.send({ type: 'status', ...status }));
service.on('resource', resource => control.send({ type: 'resource', ...resource }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void control.close());
control.once('closed', () => process.exit());
control.run();
if (values['parent-ready']) process.stdin.resume();
}
