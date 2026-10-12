/**
 * Offline end-to-end test in a real (headless) Chrome.
 *
 *   npm run test:e2e
 *
 * Proves, with the web server completely SHUT DOWN (no network at all):
 *   - the app opens from the service worker's stored copy;
 *   - the page is cross-origin isolated (multi-threaded AI is possible);
 *   - "Download for offline use" stored the language pair;
 *   - speaking → on-device speech recognition → on-device translation → card,
 *     with zero requests to any online service.
 *
 * What's stubbed: the AI worker (real models are hundreds of MB and need
 * Hugging Face). The stub keeps a record of "downloaded" models in Cache
 * Storage, so — like the real thing — it survives the reload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startServer } from '../../serve.mjs';

const MOCK_WORKER = `
  const store = () => caches.open('mock-models');
  self.onmessage = async ({ data }) => {
    const { id, op, model } = data;
    const reply = (result) => self.postMessage({ id, result });
    if (op === 'isCached') return reply(!!(await (await store()).match('/' + model)));
    if (op === 'download' || op === 'load') {
      const total = 1000;
      for (const loaded of [250, 500, 1000]) {
        self.postMessage({ type: 'progress', op: data.for, model, info: { status: 'progress_total', loaded, total } });
        await new Promise((r) => setTimeout(r, 20));
      }
      await (await store()).put('/' + model, new Response('ok'));
      return reply(true);
    }
    if (op === 'transcribe') return reply('spoken words lang=' + data.language);
    if (op === 'translate') return reply('[' + data.model.split('/').pop() + '] ' + data.text);
    self.postMessage({ id, error: 'unexpected op ' + op });
  };`;

function writeSpeechWav(path, rate = 48000) {
  const pattern = [[0.6, 0], [1.4, 1], [1.5, 0]];
  const samples = [];
  for (const [secs, on] of pattern) for (let i = 0; i < secs * rate; i++) {
    const t = i / rate;
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * 150 * h * t) / h;
    samples.push(on ? 0.25 * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0);
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

test('offline: download a pair, shut the server down, and it still works', { timeout: 90_000 }, async (t) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'interp-offline-')), 'speech.wav');
  writeSpeechWav(wav);
  const server = await startServer(0, '127.0.0.1', { '/app/js/workers/ml.worker.js': MOCK_WORKER });
  const base = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  let serverOpen = true;
  const stopServer = () => new Promise((r) => { if (!serverOpen) return r(); serverOpen = false; server.closeAllConnections?.(); server.close(() => r()); });
  t.after(async () => { await browser.close(); await stopServer(); });

  const page = await browser.newPage();
  const problems = [];
  const onlineRequests = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) onlineRequests.push(r.url()); });

  // 1. First visit, online: the service worker stores the app.
  await page.goto(`${base}/?from=en&to=id`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0' }); // now controlled by the service worker
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'page is served by the service worker');
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true, 'cross-origin isolated → multi-threaded AI available');

  // 2. The pair isn't downloaded yet: one clear button, with the size.
  await page.waitForFunction(() => document.querySelector('#offline').dataset.state === 'missing');
  const label = await page.$eval('#download', (b) => b.textContent);
  assert.match(label, /^Download for offline use · \d+ MB$/);
  assert.equal(label, 'Download for offline use · 297 MB', 'Whisper base 77 + 2 × Opus-MT 110');

  // 3. Download it.
  await page.click('#download');
  await page.waitForFunction(() => document.querySelector('#offline').dataset.state === 'ready', { timeout: 20_000 });
  assert.equal(await page.$eval('#offline-text', (e) => e.textContent), '✓ English ↔ Indonesian works without internet on this device.');
  assert.equal(await page.$eval('#download', (b) => b.hidden), true);

  // 4. Shut the server down completely: from now on there is no network at all.
  await stopServer();
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#offline').dataset.state === 'ready', { timeout: 15_000 });
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  assert.equal(await page.$eval('.hero h1', (e) => e.textContent), 'Live Interpreter', 'the app opened with no server');
  assert.equal(await page.$eval('.logo', (img) => img.complete && img.naturalWidth > 0), true, 'logo came from the device');

  // 5. Speak → on-device recognition → on-device translation.
  onlineRequests.length = 0;
  await page.click('#record');
  try {
    await page.waitForFunction(() => document.querySelectorAll('#phrases .translated:not(.pending)').length >= 1, { timeout: 30_000 });
  } catch (err) {
    const debug = await page.evaluate(() => ({ status: document.querySelector('#status').textContent, live: document.querySelector('#live').textContent, cards: document.querySelector('#phrases').innerText }));
    console.log('DEBUG', debug, problems, onlineRequests);
    throw err;
  }
  await page.click('#record');
  const card = await page.$eval('#phrases li', (li) => ({
    original: li.querySelector('.original').textContent,
    translated: li.querySelector('.translated').textContent,
  }));
  assert.equal(card.original, 'spoken words lang=en', 'on-device speech recognition was used');
  assert.equal(card.translated, '[opus-mt-en-id] spoken words lang=en', 'on-device translation was used');
  assert.deepEqual(onlineRequests, [], 'no online service was contacted');

  // 6. A pair that was never downloaded explains itself instead of failing silently.
  await page.select('#target', 'ja');
  await page.waitForFunction(() => document.querySelector('#offline').dataset.state === 'offline');
  assert.match(await page.$eval('#offline-text', (e) => e.textContent), /You’re offline, and English ↔ Japanese isn’t downloaded/);
  assert.deepEqual(problems, []);
});
