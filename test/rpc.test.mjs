import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { RpcClient, eventMetadata } from '../lib/rpc.mjs';

async function fixture(t, receive) {
  const root = await fs.mkdtemp('/tmp/coop-rpc-');
  const socket = `${root}/rpc.sock`;
  const httpServer = http.createServer();
  const server = new WebSocketServer({ server: httpServer });
  server.on('connection', ws => ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method !== 'initialized') receive(ws, message);
  }));
  httpServer.listen(socket);
  await once(httpServer, 'listening');
  const client = await RpcClient.connect(socket);
  t.after(async () => {
    client.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return client;
}

test('server request IDs do not consume client requests; out-of-order responses correlate', async t => {
  const received = [];
  const client = await fixture(t, (ws, message) => {
    if (!message.method) return;
    received.push(message);
    if (received.length === 2) {
      ws.send(JSON.stringify({ id: received[0].id, method: 'item/commandExecution/requestApproval', params: { threadId: 'test' } }));
      for (const request of [...received].reverse()) ws.send(JSON.stringify({ id: request.id, result: request.method }));
    }
  });
  const approvals = [];
  client.on('serverRequest', message => approvals.push(message));
  assert.deepEqual(await Promise.all([client.request('first'), client.request('second')]), ['first', 'second']);
  assert.equal(approvals.length, 1);
});

test('timeout is not retried; a late response cannot settle a later request', async t => {
  let calls = 0;
  const client = await fixture(t, (ws, message) => {
    calls++;
    const timer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: message.id, result: message.method }));
    }, message.method === 'slow' ? 70 : 90);
    t.after(() => clearTimeout(timer));
  });
  await assert.rejects(client.request('slow', {}, 20), /outcome unknown, not retried/);
  assert.equal(await client.request('later'), 'later');
  assert.equal(calls, 2);
});

test('closing a connection rejects all pending calls immediately', async t => {
  const client = await fixture(t, () => {});
  const result = assert.rejects(client.request('never'), /closed/i);
  client.close();
  await result;
  assert.equal(client.pending.size, 0);
});

test('diagnostics retain structural IDs but omit prompts, tokens and tool output', () => {
  const result = eventMetadata({ id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'secret', access_token: 'secret',
    delta: 'secret', item: { type: 'commandExecution', output: 'secret' },
  } });
  assert.equal(result.threadId, 'thread');
  assert.equal(result.serverRequestId, 7);
  assert.equal(result.deltaBytes, 6);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
