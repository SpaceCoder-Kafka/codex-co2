import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

// Every connection owns its request IDs. Never multiplex clients onto one initialized session.
export class RpcClient extends EventEmitter {
  constructor(ws, { timeoutMs = 10000, onEvent } = {}) {
    super();
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.onEvent = onEvent;
    ws.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); }
      catch { this.fail(new Error('Invalid JSON from app-server')); ws.terminate(); return; }
      this.onEvent?.(message);
      if (message.method) {
        this.emit(Object.hasOwn(message, 'id') ? 'serverRequest' : 'notification', message);
      } else {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? 'RPC error');
          error.code = message.error.code;
          request.reject(error);
        } else request.resolve(message.result);
      }
    });
    ws.on('error', error => this.fail(error));
    ws.on('close', () => { this.fail(new Error('app-server connection closed')); this.emit('closed'); });
  }

  static async connect(socketPath, options = {}) {
    const ws = new WebSocket('ws://codex-app-server/rpc', {
      createConnection: options.createConnection ?? (() => net.createConnection(socketPath)),
      perMessageDeflate: false,
      handshakeTimeout: options.timeoutMs ?? 10000,
    });
    const client = new RpcClient(ws, options);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { ws.off('open', opened); ws.off('error', failed); ws.off('close', closed); };
        const opened = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('Connection closed before WebSocket handshake'));
        ws.once('open', opened); ws.once('error', failed); ws.once('close', closed);
      });
      client.initialization = await client.request('initialize', {
        clientInfo: { name: options.name ?? 'codex_coop_probe', title: 'Codex Co² diagnostics', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      client.notify('initialized', {});
      return client;
    } catch (error) { client.close(); throw error; }
  }

  static async connectSsh(alias, options = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)) throw new Error('Invalid SSH alias');
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, 'codex app-server proxy'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // Drain SSH diagnostics without putting arbitrary remote shell output in the observation log.
    child.stderr.resume();
    child.once('error', error => stream.destroy(error));
    const cleanup = () => { stream.destroy(); child.kill(); };
    try {
      const client = await RpcClient.connect(null, { ...options, createConnection: () => {
        queueMicrotask(() => stream.emit('connect'));
        return stream;
      } });
      client.once('closed', cleanup);
      return client;
    } catch (error) { cleanup(); throw new Error(`SSH proxy ${alias}: ${error.message}. Check ssh ${alias} 'codex --version' first.`); }
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}; outcome unknown, not retried`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  notify(method, params) { this.ws.send(JSON.stringify({ method, params })); }
  respond(id, result) { this.ws.send(JSON.stringify({ id, result })); }
  fail(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error('Client closed')); this.ws.terminate(); }
}

// Only structural diagnostics are retained: never prompts, tool arguments, output or credentials.
export function eventMetadata(message) {
  const p = message.params ?? {};
  const entry = { at: new Date().toISOString(), method: message.method ?? 'response' };
  for (const [key, value] of Object.entries({
    threadId: p.threadId ?? p.thread?.id,
    turnId: p.turnId ?? p.turn?.id,
    itemId: p.itemId ?? p.item?.id,
    itemType: p.item?.type,
    status: p.turn?.status ?? p.status?.type,
  })) if (typeof value === 'string') entry[key] = value;
  if (message.method && Object.hasOwn(message, 'id')) entry.serverRequestId = message.id;
  if (typeof p.delta === 'string') entry.deltaBytes = Buffer.byteLength(p.delta);
  return entry;
}
