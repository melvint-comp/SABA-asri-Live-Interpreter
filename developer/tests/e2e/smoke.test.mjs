/**
 * End-to-end smoke test in a real (headless) Chrome.
 *
 *   npm install          # once — downloads puppeteer + Chrome
 *   npm run test:e2e
 *
 * What it proves: the page loads without errors; the microphone → AudioWorklet
 * → resampler → segmenter → worker → translation → textbox pipeline works with
 * real browser APIs, fed by a synthetic "speech" WAV through Chrome's fake mic.
 *
 * What it stubs (to stay fast, offline and deterministic):
 *   - the AI worker (no 77 MB Whisper download) — replaced by a mock that
 *     reports the duration of each audio segment it receives;
 *   - the MyMemory HTTP API — answered by request interception.
 * The real Whisper code path is the same; only the model call is faked.
 *
 * Optional env: PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startServer } from '../../serve.mjs';

/** Speech-like test signal: 150 Hz buzz with harmonics and syllable-rate wobble. */
function writeSpeechLikeWav(path, { rate = 48000, pattern = [[0.6, 0], [1.6, 1], [1.2, 0], [1.1, 1], [1.5, 0]] } = {}) {
  const samples = [];
  for (const [secs, on] of pattern) {
    for (let i = 0; i < secs * rate; i++) {
      const t = i / rate;
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * 150 * h * t) / h;
      samples.push(on ? 0.25 * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const MOCK_WORKER = `
  let n = 0;
  self.onmessage = ({ data }) => {
    const { id, op } = data;
    if (op === 'load') return self.postMessage({ id, result: true });
    if (op === 'transcribe') {
      n++;
      const secs = (data.audio.length / 16000).toFixed(1);
      return self.postMessage({ id, result: 'segment ' + n + ' lang=' + data.language + ' model=' + data.model.split('/').pop() + ' secs=' + secs });
    }
    self.postMessage({ id, error: 'unexpected op ' + op });
  };`;

async function launch(t, wav) {
  const server = await startServer(0, '127.0.0.1', { '/app/js/workers/ml.worker.js': MOCK_WORKER });
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',      // auto-allow the mic prompt
      '--use-fake-device-for-media-stream',  // fake mic…
      `--use-file-for-fake-audio-capture=${wav}`, // …that plays our WAV in a loop
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  t.after(async () => { await browser.close(); server.close(); });
  return { browser, base: `http://localhost:${server.address().port}` };
}

async function preparePage(browser) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  const translated = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname === 'api.mymemory.translated.net') {
      const q = url.searchParams.get('q');
      translated.push({ q, langpair: url.searchParams.get('langpair') });
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: `FR[${q}]` } }),
      });
    }
    req.continue();
  });
  return { page, problems, translated };
}

const readCards = (page) => page.$$eval('#phrases li', (lis) => lis.map((li) => ({
  original: li.querySelector('.original').textContent,
  translated: li.querySelector('.translated').textContent,
  lang: li.querySelector('.translated').lang,
})).reverse()); // DOM is newest-first; return oldest-first

const wav = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'interp-e2e-'));
  const path = join(dir, 'speech.wav');
  writeSpeechLikeWav(path);
  return path;
})();

test('desktop: record → segment → transcribe → translate', { timeout: 60_000 }, async (t) => {
  const { browser, base } = await launch(t, wav);
  const { page, problems, translated } = await preparePage(browser);
  await page.goto(`${base}/?from=en&to=fr&asr=whisper&mt=mymemory`, { waitUntil: 'networkidle0' });

  // Controls are built from config.js
  assert.equal(await page.$$eval('#source option', (o) => o.length), 6);
  assert.equal(await page.$eval('#source', (s) => s.value), 'en');
  assert.equal(await page.$eval('#target', (s) => s.value), 'fr');
  assert.equal(await page.$eval('#status', (s) => s.textContent), '', 'no warnings on a healthy page');
  assert.equal(await page.$eval('#empty', (e) => e.hidden), false);

  await page.click('#record');
  assert.equal(await page.$eval('#record', (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.$eval('#record-label', (e) => e.textContent), 'Click to stop');
  assert.equal(await page.$eval('#source', (s) => s.disabled), true, 'language locked while listening');

  // Two phrases are in the WAV; wait for both translations.
  await page.waitForFunction(() => [...document.querySelectorAll('#phrases .translated')].filter((p) => p.textContent.startsWith('FR[')).length >= 2, { timeout: 30_000 });
  await page.click('#record');
  await page.waitForFunction(() => document.querySelector('#record').getAttribute('aria-pressed') === 'false');

  const cards = await readCards(page);
  console.log(cards);
  assert.ok(cards.length >= 2);
  assert.match(cards[0].original, /^segment 1 lang=en model=whisper-base secs=\d+\.\d$/);
  // Phrase 1 is 1.6 s of sound; with pre-roll/tail the segment should be ~1.6–2.3 s.
  const secs = Number(cards[0].original.split('secs=')[1]);
  assert.ok(secs > 1.4 && secs < 2.4, `segment length ${secs}s`);
  assert.equal(cards[0].translated, `FR[${cards[0].original}]`);
  assert.equal(cards[0].lang, 'fr');
  assert.equal(translated[0].langpair, 'en|fr');
  assert.match(await page.$eval('#status', (s) => s.textContent), /Stopped/);
  assert.equal(await page.$eval('#toolbar', (e) => e.hidden), false);

  await page.click('#clear');
  assert.equal(await page.$$eval('#phrases li', (l) => l.length), 0);
  assert.deepEqual(problems, []);
});

test('phone: fits the screen, simple layout, defaults to the small model, records', { timeout: 60_000 }, async (t) => {
  const { browser, base } = await launch(t, wav);
  const { page, problems } = await preparePage(browser);
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36');
  await page.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(`${base}/?from=ja&to=en&asr=whisper&mt=mymemory`, { waitUntil: 'networkidle0' });

  // No technical settings on the page — just languages, the button and results.
  assert.equal(await page.$$eval('select', (s) => s.length), 2, 'only the two language pickers');
  assert.equal(await page.$('details'), null, 'no settings panel');
  // The SABA asri logo is shown and actually loaded (not a broken image).
  const logo = await page.$eval('.hero .logo', (img) => ({ alt: img.alt, w: img.naturalWidth, shown: img.getBoundingClientRect().width }));
  assert.equal(logo.alt, 'SABA asri Turtles Conservation');
  assert.ok(logo.w > 0 && logo.shown >= 200, `logo loaded and visible (${JSON.stringify(logo)})`);
  assert.equal(await page.$eval('#record-label', (e) => e.textContent), 'Tap to start');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  const mic = await page.$eval('#record', (b) => b.getBoundingClientRect().width);
  assert.ok(mic >= 88, 'big, easy-to-tap button');

  await page.tap('#record');
  await page.waitForFunction(() => document.querySelectorAll('#phrases .translated:not(.pending)').length >= 1, { timeout: 30_000 });
  await page.tap('#record');
  const cards = await readCards(page);
  assert.match(cards[0].original, /lang=ja model=whisper-tiny /, 'phones use the Quick (tiny) model');
  assert.equal(cards[0].lang, 'en');
  assert.deepEqual(problems, []);
});

test('opening the file directly shows a friendly explanation', { timeout: 30_000 }, async (t) => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const indexPath = new URL('../../../index.html', import.meta.url).href; // file:// URL
  await page.goto(indexPath, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.$eval('#file-warning', (e) => e.hidden), false);
  assert.equal(await page.$eval('#app', (e) => e.hidden), true);
  assert.equal(await page.$eval('#file-warning a', (a) => a.href), 'https://melvint-comp.github.io/SABA-asri-Live-Interpreter/');
});

test('layout: even spacing and a reachable button on every screen size', { timeout: 60_000 }, async (t) => {
  const server = await startServer(0);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.close(); });
  const sizes = [[320, 568, true], [390, 844, true], [844, 390, true], [768, 1024, true], [1366, 768, false], [1920, 1080, false]];
  for (const [width, height, isMobile] of sizes) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, isMobile, hasTouch: isMobile });
    await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'networkidle0' });
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const panel = r('.panel'), hero = r('.hero'), mic = r('#record'), logo = r('.logo');
      const cs = getComputedStyle(document.querySelector('.panel'));
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        gapL: panel.left, gapR: innerWidth - panel.right,
        padTop: cs.paddingTop, padLeft: cs.paddingLeft,
        overlap: hero.bottom - panel.top,
        micBottom: mic.bottom, logoW: logo.width,
        heroBg: getComputedStyle(document.querySelector('.hero')).backgroundColor,
      };
    });
    const at = `${width}×${height}`;
    assert.ok(m.overflowX <= 0, `${at}: page scrolls sideways`);
    assert.ok(Math.abs(m.gapL - m.gapR) <= 1, `${at}: panel is off-centre (${m.gapL} vs ${m.gapR})`);
    assert.ok(m.gapL >= 16, `${at}: side margin too small (${m.gapL})`);
    assert.equal(m.padTop, m.padLeft, `${at}: uneven panel padding`);
    assert.ok(m.overlap > 20, `${at}: panel should ride over the header wave`);
    assert.ok(m.micBottom <= height, `${at}: microphone button is below the screen (${m.micBottom}px)`);
    assert.ok(m.logoW >= 120, `${at}: logo too small (${m.logoW}px)`);
    assert.equal(m.heroBg, 'rgb(0, 0, 0)', `${at}: header must be pure black to match the logo artwork's own background`);
    await page.close();
  }
});
