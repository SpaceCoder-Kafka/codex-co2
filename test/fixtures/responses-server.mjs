import http from 'node:http';

// The fixture serves only synthetic Responses streams. It also acts as a deny
// proxy for every non-loopback destination inherited by the test backend.
export async function startResponsesFixture() {
  const requests = [];
  const blockedDestinations = [];
  const sockets = new Set();
  const holds = [];
  const releaseAll = new Set();
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/') || req.method !== 'POST' || !req.url.endsWith('/responses')) {
      blockedDestinations.push(req.url);
      res.writeHead(502).end('External network disabled by test fixture');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400).end('Expected JSON');
      return;
    }
    requests.push(payload);
    const number = requests.length;
    const id = `synthetic-response-${number}`;
    const itemId = `synthetic-message-${number}`;
    const answer = `Synthetic answer ${number}`;
    const item = { type: 'message', role: 'assistant', id: itemId, content: [{ type: 'output_text', text: answer }] };
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send({ type: 'response.created', response: { id } });
    const hold = holds.shift();
    if (hold) {
      hold.arrive();
      await hold.released;
      releaseAll.delete(hold.release);
    }
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    // Keep the stream open long enough to exercise native event delivery rather
    // than merely comparing history after a turn has already finished.
    await new Promise(resolve => setTimeout(resolve, 60));
    send({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: answer });
    await new Promise(resolve => setTimeout(resolve, 60));
    // Streaming assertions can explicitly keep the response open until the
    // consumer has observed a delta. Fixed delays cannot guarantee this when
    // the host batches snapshots or a concurrent test stalls the event loop.
    if (hold) { await hold.completed; releaseAll.delete(hold.complete); }
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  server.on('connect', (req, socket) => {
    blockedDestinations.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, requests, blockedDestinations,
    holdNextResponse({ holdCompletion = false } = {}) {
      let arrive, release, complete = () => {};
      const arrived = new Promise(resolve => { arrive = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      const completed = holdCompletion ? new Promise(resolve => { complete = resolve; }) : Promise.resolve();
      holds.push({ arrive, release, released, complete, completed });
      releaseAll.add(release);
      if (holdCompletion) releaseAll.add(complete);
      return { arrived, release, complete };
    },
    async close() {
      for (const release of releaseAll) release();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
