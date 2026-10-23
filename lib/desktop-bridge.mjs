import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { secret } from './host.mjs';

// Privileged OWNER transport only. This listener is never exposed by the public tunnel.
export async function startDesktopBridge({ socketPath, codexHome, runtimeDir, appPath = '/Applications/ChatGPT.app' }) {
  if (process.platform === 'win32') throw new Error('Windows requires existing official Desktop attachment; the isolated macOS launcher is unsupported');
  const profile = path.join(runtimeDir, 'desktop-profile');
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.chmod(profile, 0o700);
  const capabilityPath = `/desktop/${secret()}`;
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const upstreams = new Set();
  let launcher, launcherText;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== capabilityPath || req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}`) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', downstream => {
    const upstream = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => net.connect(socketPath), perMessageDeflate: false });
    upstreams.add(upstream);
    const waiting = []; let bytes = 0;
    const finish = () => { downstream.terminate(); upstream.terminate(); upstreams.delete(upstream); };
    downstream.on('message', data => {
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount + data.length > 16 * 1024 * 1024) return finish();
        upstream.send(data, { binary: false });
      } else { bytes += data.length; if (bytes > 1024 * 1024) return finish(); waiting.push(data); }
    });
    upstream.on('open', () => { for (const data of waiting) upstream.send(data, { binary: false }); waiting.length = 0; });
    upstream.on('message', data => {
      if (downstream.readyState !== WebSocket.OPEN) return;
      if (downstream.bufferedAmount + data.length > 16 * 1024 * 1024) return finish();
      downstream.send(data, { binary: false });
    });
    downstream.on('close', finish); downstream.on('error', finish); upstream.on('close', finish); upstream.on('error', finish);
  });
  let closePromise;
  const close = () => closePromise ??= (async () => {
    for (const ws of wss.clients) ws.terminate();
    for (const ws of upstreams) ws.terminate();
    await new Promise(r => wss.close(r));
    if (server.listening) await new Promise(r => server.close(r));
    if (launcherText && await fs.readFile(launcher, 'utf8').catch(() => null) === launcherText) await fs.unlink(launcher);
  })();
  try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `ws://127.0.0.1:${server.address().port}${capabilityPath}`;
  launcher = path.join(runtimeDir, 'Open-Test-Desktop.command');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // This is a user-invoked launcher. It does not patch the app or change the everyday profile.
  launcherText = `#!/bin/sh\nexec /usr/bin/open -n --env ${quote(`CODEX_HOME=${codexHome}`)} --env ${quote(`CODEX_ELECTRON_USER_DATA_PATH=${profile}`)} --env ${quote(`CODEX_APP_SERVER_WS_URL=${url}`)} ${quote(appPath)} --args ${quote(`--user-data-dir=${profile}`)}\n`;
  await fs.writeFile(launcher, launcherText, { mode: 0o700 });
  await fs.chmod(launcher, 0o700);
  return { launcher, url, close };
  } catch (error) { await close(); throw error; }
}
