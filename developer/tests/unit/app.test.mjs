import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, getLanguage, DEFAULT_SETTINGS, WHISPER_MODELS } from '../../../app/js/config.js';
import { loadSettings, saveSettings, fromQuery, sanitize } from '../../../app/js/settings.js';
import { Interpreter, friendlyError } from '../../../app/js/interpreter.js';
import { isLikelyHallucination } from '../../../app/js/recognition/whisper.js';
import { describeProgress } from '../../../app/js/workers/ml-client.js';

// ---------- config ----------
test('config: exactly the six required languages, each with every engine code', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id).sort(), ['de', 'en', 'fr', 'id', 'ja', 'zh']);
  for (const l of LANGUAGES) {
    for (const k of ['name', 'native', 'whisper', 'translator', 'mymemory']) assert.ok(l[k], `${l.id}.${k}`);
    assert.ok(Array.isArray(l.speech) && l.speech.length, `${l.id}.speech`);
  }
  assert.throws(() => getLanguage('xx'), /Unknown language/);
  assert.equal(getLanguage('zh').speech[0], 'cmn-Hans-CN');
});

// ---------- settings ----------
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('settings: defaults, saved values, then URL overrides — invalid values ignored', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSettings({ search: '', storage }), { ...DEFAULT_SETTINGS });
  saveSettings({ ...DEFAULT_SETTINGS, source: 'ja', target: 'en' }, storage);
  assert.equal(loadSettings({ search: '', storage }).source, 'ja');
  const s = loadSettings({ search: '?from=de&to=id&asr=whisper&model=small&mt=mymemory&evil=1', storage });
  assert.deepEqual(s, { source: 'de', target: 'id', recognition: 'whisper', whisperModel: 'small', translation: 'mymemory' });
  assert.deepEqual(fromQuery('?from=klingon&asr=magic'), {});
  assert.deepEqual(sanitize({ whisperModel: '__proto__' }), {});
  assert.ok(Object.keys(WHISPER_MODELS).includes(DEFAULT_SETTINGS.whisperModel));
});

test('settings: only the two languages are remembered between visits', () => {
  const storage = memoryStorage();
  saveSettings({ ...DEFAULT_SETTINGS, source: 'zh', target: 'id', recognition: 'whisper', translation: 'mymemory' }, storage);
  assert.deepEqual(JSON.parse(storage.getItem('live-interpreter:settings')), { source: 'zh', target: 'id' });
  // Engine choices saved by an older version of the page are ignored too.
  storage.setItem('live-interpreter:settings', JSON.stringify({ source: 'fr', recognition: 'whisper', translation: 'mymemory' }));
  assert.deepEqual(loadSettings({ search: '', storage }), { ...DEFAULT_SETTINGS, source: 'fr' });
  // …but a URL can still choose engines for that visit (advanced use).
  assert.equal(loadSettings({ search: '?asr=whisper', storage }).recognition, 'whisper');
});

test('settings: corrupt or unavailable storage falls back to defaults', () => {
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadSettings({ search: '', storage: bad }), { ...DEFAULT_SETTINGS });
  assert.doesNotThrow(() => saveSettings(DEFAULT_SETTINGS, bad));
  assert.deepEqual(loadSettings({ search: '', storage: null }), { ...DEFAULT_SETTINGS });
});

// ---------- whisper hallucination filter ----------
test('hallucination filter catches subtitle credits but keeps real speech', () => {
  for (const t of ['Thanks for watching!', 'Sous-titres réalisés par la communauté d\'Amara.org', 'ご視聴ありがとうございました', '...', ' ♪ ']) {
    assert.ok(isLikelyHallucination(t), t);
  }
  for (const t of ['Thank you.', 'Where is the station?', '駅はどこですか', 'Terima kasih banyak', 'Wie spät ist es?']) {
    assert.ok(!isLikelyHallucination(t), t);
  }
});

// ---------- progress text ----------
test('describeProgress gives plain-language download messages', () => {
  const msg = describeProgress({ op: 'transcribe', model: 'onnx-community/whisper-base', info: { status: 'progress_total', progress: 42.7, loaded: 32_000_000, total: 77_000_000 } });
  assert.equal(msg, 'Getting speech recognition ready — one-time download: 32 of 77 MB');
  assert.equal(describeProgress({ op: 'transcribe', model: 'a/b', info: { status: 'initiate' } }), 'Getting speech recognition ready…');
  assert.equal(describeProgress({ op: 'transcribe', model: 'a/b', info: { status: 'done' } }), null);
});

// ---------- interpreter (controller) with fakes ----------
function makeView() {
  return {
    status: [], live: '', recording: false, transcript: [], translation: [],
    setStatus(m, kind) { this.status.push([m, kind]); },
    setLive(t) { this.live = t; },
    setRecording(on) { this.recording = on; },
    addPhrase(t) { this.transcript.push(t); return this.transcript.length - 1; },
    setTranslation(i, t, opts = {}) { this.translation[i] = opts.failed ? '[failed]' : opts.passthrough ? `=${t}` : t; },
  };
}
class FakeEngine {
  constructor(id, { failStart } = {}) { this.id = id; this.label = id; this.failStart = failStart; }
  async start(cb) { if (this.failStart) throw this.failStart; this.cb = cb; }
  async stop() { this.stopped = true; }
}
const settings = { ...DEFAULT_SETTINGS, source: 'en', target: 'ja' };

test('interpreter: final phrases are transcribed and translated in order', async () => {
  const view = makeView();
  const delays = { one: 30, two: 0 }; // first translation is slower — order must still hold
  const router = {
    prepared: 0, prepare() { this.prepared++; },
    translate: (t) => new Promise((r) => setTimeout(() => r({ text: `JA(${t})`, engine: 'x' }), delays[t])),
  };
  const engine = new FakeEngine('webspeech');
  const it = new Interpreter({ view, router, createEngine: () => engine });
  await it.start(settings);
  assert.equal(router.prepared, 1);
  assert.ok(view.recording && it.isRunning);
  engine.cb.onInterim('partial…');
  assert.equal(view.live, 'partial…');
  engine.cb.onFinal('one');
  engine.cb.onFinal('two');
  await it.stop();
  assert.ok(engine.stopped);
  assert.deepEqual(view.transcript, ['one', 'two']);
  assert.deepEqual(view.translation, ['JA(one)', 'JA(two)']);
  assert.equal(view.recording, false);
});

test('interpreter: translation failure is shown but recording continues', async () => {
  const view = makeView();
  const router = { prepare() {}, translate: async () => { throw new Error('boom'); } };
  const engine = new FakeEngine('webspeech');
  const it = new Interpreter({ view, router, createEngine: () => engine });
  await it.start(settings);
  engine.cb.onFinal('hello');
  await it.stop();
  assert.deepEqual(view.translation, ['[failed]']);
  assert.ok(view.status.some(([m, kind]) => kind === 'warn' && /Translation isn’t available/.test(m)));
});

test('interpreter: in auto mode a Web Speech failure falls back to Whisper', async () => {
  const view = makeView();
  const router = { prepare() {}, translate: async (t) => ({ text: t.toUpperCase() }) };
  const created = [];
  const createEngine = (choice) => { const e = new FakeEngine(choice === 'whisper' ? 'whisper' : 'webspeech'); created.push(e); return e; };
  const it = new Interpreter({ view, router, createEngine });
  await it.start({ ...settings, recognition: 'auto' });
  await created[0].cb.onFatal(new Error('network'));
  assert.equal(created.length, 2);
  assert.equal(created[1].id, 'whisper');
  assert.ok(it.isRunning);
  created[1].cb.onFinal('still works');
  await it.stop();
  assert.deepEqual(view.translation, ['STILL WORKS']);
});

test('interpreter: explicit engine failure stops cleanly with a friendly error', async () => {
  const view = makeView();
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const it = new Interpreter({ view, router: { prepare() {} }, createEngine: () => new FakeEngine('whisper', { failStart: denied }) });
  await it.start({ ...settings, recognition: 'whisper' });
  assert.equal(it.isRunning, false);
  assert.equal(view.recording, false);
  const [msg, kind] = view.status.at(-1);
  assert.equal(kind, 'error');
  assert.match(msg, /Microphone access was blocked/);
  assert.equal(friendlyError(new Error('x')), 'x');
});

// ---------- plain-language errors, device defaults ----------
import { friendlyTranslationError } from '../../../app/js/interpreter.js';
import { isPhoneOrTablet } from '../../../app/js/device.js';
import { createRecognitionEngine } from '../../../app/js/recognition/index.js';

test('translation errors are explained in plain words', () => {
  assert.match(friendlyTranslationError(new Error('MyMemory online translator: daily free quota used up')), /free translation limit/);
  assert.match(friendlyTranslationError(new TypeError('Failed to fetch')), /internet connection/);
  assert.match(friendlyTranslationError(new Error('weird')), /isn’t available right now/);
});

test('settings: per-device defaults (phones default to the small on-device model)', () => {
  const s = loadSettings({ search: '', storage: memoryStorage(), defaults: { ...DEFAULT_SETTINGS, whisperModel: 'tiny' } });
  assert.equal(s.whisperModel, 'tiny');
});

test('device detection: phones, iPads and desktops', () => {
  assert.equal(isPhoneOrTablet({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' }), true);
  assert.equal(isPhoneOrTablet({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true);
  assert.equal(isPhoneOrTablet({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true, 'iPadOS');
  assert.equal(isPhoneOrTablet({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), false);
  assert.equal(isPhoneOrTablet({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', userAgentData: { mobile: false } }), false);
  assert.equal(isPhoneOrTablet(undefined), false);
});

test('engine choice: phones get phrase-by-phrase built-in recognition', () => {
  assert.equal(createRecognitionEngine('webspeech', 'base', { phone: true }).continuous, false);
  assert.equal(createRecognitionEngine('webspeech', 'base', { phone: false }).continuous, true);
  assert.equal(createRecognitionEngine('whisper', 'tiny').modelId, 'onnx-community/whisper-tiny');
  assert.equal(createRecognitionEngine('auto', 'base').id, 'whisper', 'Node has no built-in speech → on-device');
});
