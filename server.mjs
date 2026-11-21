import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const upstream = 'https://api-poweron.toe.com.ua';
const allowed = new Set(['/api/pw_cities', '/api/pw_streets',
  '/api/pw-accounts/building-names', '/api/pw-accounts/building-groups', '/api/a_gpv_g']);
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/svitlo-ternopil.html', ['svitlo-ternopil.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

// Only these public read endpoints can be forwarded. No arbitrary host or credentials.
export function createAppServer({ fetchImpl = fetch, webDir = fileURLToPath(new URL('./www/', import.meta.url)) } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      return json(response, 405, { error: 'Method not allowed' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!allowed.has(url.pathname) || request.method !== 'GET') return json(response, 404, { error: 'Endpoint not allowed' });
      if (url.search.length > 4000) return json(response, 414, { error: 'Query too long' });
      const headers = { Accept: 'application/ld+json, application/json' };
      const debugKey = request.headers['x-debug-key'];
      if (debugKey) {
        if (typeof debugKey !== 'string' || debugKey.length > 1024 || !/^[A-Za-z0-9+/=]+$/.test(debugKey)) {
          return json(response, 400, { error: 'Invalid address key' });
        }
        headers['X-debug-key'] = debugKey;
      }
      try {
        const result = await fetchImpl(`${upstream}${url.pathname}${url.search}`, {
          headers, signal: AbortSignal.timeout(25000), redirect: 'error',
        });
        if (!result.ok) {
          const retry = result.headers.get('retry-after');
          if (retry) response.setHeader('Retry-After', retry);
          return json(response, result.status, { error: 'Сервіс обленерго тимчасово недоступний' });
        }
        const data = await result.json();
        return json(response, 200, data);
      } catch (error) {
        return json(response, error.name === 'TimeoutError' ? 504 : 502, { error: 'Не вдалося отримати дані обленерго' });
      }
    }
    const entry = files.get(url.pathname);
    if (!entry) return json(response, 404, { error: 'Not found' });
    try {
      const content = await readFile(resolve(webDir, entry[0]));
      response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { return json(response, 404, { error: 'Виконайте npm run build перед запуском сервера' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createAppServer().listen(port, host, () => console.log(`Svitlo: http://${host}:${port}`));
}
