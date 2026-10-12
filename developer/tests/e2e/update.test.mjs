/**
 * Update safety, in a real (headless) Chrome.
 *
 * GitHub Pages lets browsers reuse files for 10 minutes. After an update, a
 * normal reload re-checks the page but reuses saved scripts, so the new page
 * can run with an OLD module and fail to start (this really happened: empty
 * language menus, "does not provide an export named ..."). index.html must
 * repair this by itself: register the service worker and reload once through
 * it, which serves one complete version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

// An "old version" of the site: its config.js lacks the exports the new code needs.
const OLD_INDEX = '<!doctype html><title>old</title><script type="module" src="app/js/config.js"></script>';
const OLD_CONFIG = "export const LANGUAGES = []; export function getLanguage() {}";

test('after an update, stale saved scripts are repaired automatically', { timeout: 60_000 }, async (t) => {
  let phase = 'old';
  // Behaves like GitHub Pages: everything may be reused for 10 minutes.
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const headers = { 'Cache-Control': 'max-age=600' };
    if (phase === 'old' && (path === '/' || path === '/index.html')) return res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end(OLD_INDEX);
    if (phase === 'old' && path === '/app/js/config.js') return res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(OLD_CONFIG);
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    try { res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();

  await page.goto(`${base}/`, { waitUntil: 'networkidle0' }); // visitor sees the old version
  phase = 'new';                                              // the site is updated
  await page.reload({ waitUntil: 'load' });                   // visitor presses Reload

  // The repair reloads once through the service worker; the app must then start.
  await page.waitForFunction(() => document.documentElement.dataset.started === 'true' && document.querySelectorAll('#source option').length === 6, { timeout: 20_000 });
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'served by the service worker after the repair');
  assert.equal(await page.$$eval('#target option', (o) => o.length), 6);
});
