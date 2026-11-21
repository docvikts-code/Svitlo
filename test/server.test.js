import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';

async function serve(t, fetchImpl) {
  const server = createAppServer({ fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('proxy forwards only official read endpoints and the required address header', async t => {
  let seen;
  const origin = await serve(t, async (url, options) => {
    seen = { url, options }; return Response.json({ 'hydra:member': [] });
  });
  const response = await fetch(`${origin}/api/a_gpv_g?group%5B%5D=2.1`, { headers: { 'X-debug-key': 'MTM2LzEzMzQvMQ==' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { 'hydra:member': [] });
  assert.equal(seen.url, 'https://api-poweron.toe.com.ua/api/a_gpv_g?group%5B%5D=2.1');
  assert.equal(seen.options.headers['X-debug-key'], 'MTM2LzEzMzQvMQ==');
  assert.equal(seen.options.headers.Cookie, undefined);
});

test('proxy rejects writes, unknown endpoints and arbitrary URL proxying', async t => {
  let calls = 0;
  const origin = await serve(t, async () => { calls++; return Response.json({}); });
  assert.equal((await fetch(`${origin}/api/pw_cities`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${origin}/api/pw_accounts_by_acc?account=123`)).status, 404);
  assert.equal((await fetch(`${origin}/proxy?url=http://example.com`)).status, 404);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal(calls, 0);
});

test('proxy preserves rate limits and reports network failure as an error', async t => {
  const limited = await serve(t, async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  const response = await fetch(`${limited}/api/pw_cities`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  const broken = await serve(t, async () => { throw new TypeError('network unavailable'); });
  assert.equal((await fetch(`${broken}/api/pw_cities`)).status, 502);
});
