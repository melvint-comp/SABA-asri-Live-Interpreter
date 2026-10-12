import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage } from '../../../app/js/config.js';
import {
  splitByBytes, decodeEntities, buildMyMemoryUrl, parseMyMemoryResponse, myMemoryTranslator,
} from '../../../app/js/translation/mymemory.js';
import { TranslationRouter } from '../../../app/js/translation/index.js';

const en = getLanguage('en');
const ja = getLanguage('ja');
const zh = getLanguage('zh');
const bytes = (s) => new TextEncoder().encode(s).length;

test('splitByBytes keeps short text whole', () => {
  assert.deepEqual(splitByBytes('Hello there. How are you?', 500), ['Hello there. How are you?']);
});

test('splitByBytes splits on sentences and respects the byte limit (ASCII)', () => {
  const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}.`).join(' ');
  const parts = splitByBytes(text, 120);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(bytes(p) <= 120, `${bytes(p)} bytes`);
  assert.equal(parts.join(' '), text);
});

test('splitByBytes handles CJK (3 bytes/char) without spaces', () => {
  const text = '今日はとても良い天気ですね。'.repeat(40); // 14 chars × 40 = 560 chars ≈ 1680 bytes
  const parts = splitByBytes(text, 500);
  for (const p of parts) assert.ok(bytes(p) <= 500, `${bytes(p)} bytes`);
  assert.equal(parts.join(''), text);
});

test('splitByBytes splits a single over-long sentence by words, then characters', () => {
  const words = 'word '.repeat(200).trim(); // ~1000 bytes, no sentence punctuation
  for (const p of splitByBytes(words, 100)) assert.ok(bytes(p) <= 100);
  const blob = 'x'.repeat(250);
  assert.deepEqual(splitByBytes(blob, 100).map((p) => p.length), [100, 100, 50]);
});

test('splitByBytes keeps leading punctuation', () => {
  assert.equal(splitByBytes('...well. Okay!', 500).join(' '), '...well. Okay!');
});

test('decodeEntities', () => {
  assert.equal(decodeEntities('It&#39;s &quot;fine&quot; &amp; ok &#x263A; &lt;b&gt;'), 'It\'s "fine" & ok ☺ <b>');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('buildMyMemoryUrl encodes text and language pair (Chinese uses zh-CN)', () => {
  const url = new URL(buildMyMemoryUrl('你好 & bye', zh.mymemory, en.mymemory, ''));
  assert.equal(url.origin + url.pathname, 'https://api.mymemory.translated.net/get');
  assert.equal(url.searchParams.get('q'), '你好 & bye');
  assert.equal(url.searchParams.get('langpair'), 'zh-CN|en');
  assert.equal(url.searchParams.has('de'), false);
  assert.equal(new URL(buildMyMemoryUrl('x', 'en', 'fr', 'me@example.com')).searchParams.get('de'), 'me@example.com');
});

test('parseMyMemoryResponse: success, errors and quota', () => {
  assert.equal(parseMyMemoryResponse({ responseStatus: 200, responseData: { translatedText: 'Bonjour &amp; salut' } }), 'Bonjour & salut');
  assert.throws(() => parseMyMemoryResponse({ responseStatus: '403', responseDetails: "'XX' IS AN INVALID TARGET LANGUAGE" }), /INVALID TARGET/);
  const quota = (() => { try { parseMyMemoryResponse({ responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }); } catch (e) { return e; } })();
  assert.match(quota.message, /quota/);
  assert.equal(quota.permanent, true);
  assert.throws(() => parseMyMemoryResponse({ responseStatus: 200, responseData: { translatedText: '' } }), /empty/);
});

test('myMemoryTranslator chunks long text, calls the API per chunk, and joins CJK without spaces', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(new URL(url).searchParams.get('q'));
    return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: `訳${calls.length}` } }) };
  };
  const text = Array.from({ length: 40 }, (_, i) => `Sentence ${i} is here.`).join(' ');
  const out = await myMemoryTranslator.translate(text, en, ja, undefined, { fetchFn });
  assert.ok(calls.length >= 2);
  assert.equal(out, calls.map((_, i) => `訳${i + 1}`).join(''));
});

// ---------- router ----------
const fakeEngine = (id, impl, supported = true) => ({
  id, label: id, isSupported: () => supported, calls: 0, prepared: 0,
  prepare() { this.prepared++; },
  async translate(text) { this.calls++; return impl(text); },
});

test('router: same language or empty text → passthrough without calling engines', async () => {
  const a = fakeEngine('chrome', () => 'X');
  const r = new TranslationRouter({ engines: [a] });
  assert.deepEqual(await r.translate('hello', en, en), { text: 'hello', engine: null });
  assert.deepEqual(await r.translate('  ', en, ja), { text: '  ', engine: null });
  assert.equal(a.calls, 0);
});

test('router: auto uses chrome first, falls back to mymemory on failure', async () => {
  const chrome = fakeEngine('chrome', () => { throw new Error('boom'); });
  const mm = fakeEngine('mymemory', (t) => `mm:${t}`);
  const r = new TranslationRouter({ engines: [chrome, mm] });
  assert.deepEqual(await r.translate('hi', en, ja), { text: 'mm:hi', engine: 'mymemory' });
  assert.equal(chrome.calls, 1);
});

test('router: permanent failures are remembered per pair and skipped next time', async () => {
  const chrome = fakeEngine('chrome', () => { throw Object.assign(new Error('pair unsupported'), { permanent: true }); });
  const mm = fakeEngine('mymemory', (t) => `mm:${t}`);
  const r = new TranslationRouter({ engines: [chrome, mm] });
  await r.translate('a', en, ja);
  await r.translate('b', en, ja);
  assert.equal(chrome.calls, 1, 'chrome not retried for en→ja');
  await r.translate('c', en, zh);
  assert.equal(chrome.calls, 2, 'but still tried for a different pair');
});

test('router: unsupported engines are skipped; an explicit choice uses only that engine', async () => {
  const chrome = fakeEngine('chrome', () => 'C', false);
  const mm = fakeEngine('mymemory', () => 'M');
  const r = new TranslationRouter({ engines: [chrome, mm] });
  assert.equal((await r.translate('x', en, ja)).engine, 'mymemory');
  assert.equal((await r.translate('x', en, ja, 'mymemory')).engine, 'mymemory');
  await assert.rejects(r.translate('x', en, ja, 'chrome'), /No translation engine/);
  r.prepare('auto', en, ja);
  assert.equal(chrome.prepared + mm.prepared, 1, 'only supported auto engines are prepared');
});

test('only commercially usable translation engines are shipped', async () => {
  const { TRANSLATION_ENGINES } = await import('../../../app/js/translation/index.js');
  assert.deepEqual(TRANSLATION_ENGINES.map((e) => e.id), ['chrome', 'on-device', 'mymemory'], 'NLLB-200 is CC-BY-NC (non-commercial) and must not return');
});

test('router: reports all errors when every engine fails', async () => {
  const r = new TranslationRouter({ engines: [fakeEngine('chrome', () => { throw new Error('e1'); }), fakeEngine('mymemory', () => { throw new Error('e2'); })] });
  await assert.rejects(r.translate('x', en, ja), /chrome: e1 · mymemory: e2/);
  const none = new TranslationRouter({ engines: [] });
  await assert.rejects(none.translate('x', en, ja), /No translation engine/);
});
