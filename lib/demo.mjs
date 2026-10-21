import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from './rpc.mjs';
import { startResponsesFixture } from '../test/fixtures/responses-server.mjs';

// Public demonstrations contain only synthetic data and invoke no real model.
export async function startDemo(cliPath) {
  const root = await fs.mkdtemp('/tmp/coop-demo-');
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace'), socketPath = path.join(root, 'server.sock');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
  const fixture = await startResponsesFixture();
  await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-5.1-codex"\nmodel_provider = "demo"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[features]\nshell_snapshot = false\n[model_providers.demo]\nname = "Synthetic local demo"\nbase_url = "${fixture.origin}/v1"\nwire_api = "responses"\nenv_key = "COOP_SYNTHETIC_KEY"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`, { mode: 0o600 });
  const child = spawn(cliPath, ['app-server', '--listen', `unix://${socketPath}`], { cwd: workspace,
    env: { HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: root, COOP_SYNTHETIC_KEY: 'synthetic-only',
      HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin, NO_PROXY: 'localhost,127.0.0.1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let rpc; let spawnError;
  child.once('error', error => { spawnError = error; });
  const close = async () => {
    rpc?.close(); child.kill('SIGTERM');
    for (let i = 0; i < 30 && child.exitCode == null && child.signalCode == null; i++) await delay(100);
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await fixture.close(); await fs.rm(root, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode != null) throw new Error('Synthetic backend exited');
      if (await fs.stat(socketPath).then(s => s.isSocket(), () => false)) break;
      if (i === 99) throw new Error('Synthetic backend timeout');
      await delay(100);
    }
    rpc = await RpcClient.connect(socketPath);
    const thread = await rpc.request('thread/start', { cwd: workspace, model: 'gpt-5.1-codex', modelProvider: 'demo', sandbox: 'read-only', approvalPolicy: 'never' });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo seed timeout')), 10000);
      const listener = m => { if (m.method === 'turn/completed' && m.params.threadId === thread.thread.id) { clearTimeout(timer); rpc.off('notification', listener); resolve(); } };
      rpc.on('notification', listener);
    });
    await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: '这是虚构的协作演示会话，不包含私人聊天或业务数据。' }] });
    await done;
    await rpc.request('thread/name/set', { threadId: thread.thread.id, name: '协作链路演示 · 模拟模型' });
    return { socketPath, threadId: thread.thread.id, fixture, pid: child.pid, close };
  } catch (error) { await close(); throw error; }
}
