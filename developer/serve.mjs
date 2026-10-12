#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for local development.
 *
 *   node developer/serve.mjs [port]      (default 8080, or $PORT)
 *
 * Why not open index.html directly? Browsers block ES modules, workers and the
 * microphone on file:// pages. http://localhost counts as a secure context.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

/**
 * @param {number} port  0 = pick a free port
 * @param {string} host
 * @param {Record<string, string>} overrides  url path → JS source to serve instead (used by e2e tests)
 */
export function startServer(port = 8080, host = '127.0.0.1', overrides = {}) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (Object.hasOwn(overrides, urlPath)) {
        res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(overrides[urlPath]);
        return;
      }
      let file = normalize(join(ROOT, urlPath));
      if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end('Forbidden'); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  const server = await startServer(port);
  console.log(`Live Interpreter running at http://localhost:${server.address().port}  (Ctrl+C to stop)`);
}
