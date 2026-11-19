import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const helper = fileURLToPath(new URL('../bin/receiver-import.mjs', import.meta.url));

async function request(action, link) {
  const child = spawn(process.execPath, [helper, action, os.tmpdir()], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(link);
  const [code] = await done;
  assert.equal(stderr, '');
  return { code, result: JSON.parse(stdout) };
}

test('native handoff inspects only the origin before confirmation and keeps claim failures private', async t => {
  const ticket = 'b'.repeat(64), requests = [];
  const host = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(410).end();
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => host.close(resolve)));
  const origin = 'http://127.0.0.1:' + host.address().port;
  const link = 'codex-co2://import?' + new URLSearchParams({ origin, ticket });
  assert.deepEqual(await request('inspect', link), { code: 0, result: { origin } });
  const invalid = await request('inspect', link + '&extra=invalid');
  assert.equal(invalid.code, 1);
  assert.equal(JSON.stringify(invalid).includes(ticket), false);
  assert.deepEqual(requests, []);
  const expired = await request('import', link);
  assert.equal(expired.code, 1);
  assert.equal(typeof expired.result.error, 'string');
  assert.equal(JSON.stringify(expired).includes(ticket), false);
  assert.deepEqual(requests, [{ path: '/guest-import/claim', authorization: 'Co2Import ' + ticket }]);
});
