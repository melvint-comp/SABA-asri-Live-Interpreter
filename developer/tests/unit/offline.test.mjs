/**
 * Offline mode: which models translate what, what a language pack contains,
 * that only commercially licensed models are used, offline-first routing,
 * the download manager, and the service worker's file list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LANGUAGES, getLanguage, translationPlan, offlinePack, OPUS_MODELS, M2M_MODEL, WHISPER_MODELS, MODEL_MB,
} from '../../../app/js/config.js';
import { TranslationRouter, OfflineNotReadyError } from '../../../app/js/translation/index.js';
import { createOnDeviceTranslator } from '../../../app/js/translation/on-device.js';
import { myMemoryTranslator } from '../../../app/js/translation/mymemory.js';
import { OfflinePacks } from '../../../app/js/offline/packs.js';
import { createRecognitionEngine } from '../../../app/js/recognition/index.js';
import { friendlyError, friendlyTranslationError } from '../../../app/js/interpreter.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ids = LANGUAGES.map((l) => l.id);
const L = (id) => getLanguage(id);

// ---------- which model translates what ----------
test('every one of the 30 directions has an on-device plan', () => {
  for (const a of ids) for (const b of ids) {
    const plan = translationPlan(a, b);
    if (a === b) { assert.deepEqual(plan, []); continue; }
    assert.ok(plan.length >= 1 && plan.length <= 2, `${a}→${b}`);
    assert.equal(plan[0].from, a, `${a}→${b} starts from the source`);
    assert.equal(plan.at(-1).to, b, `${a}→${b} ends in the target`);
    if (plan.length === 2) assert.equal(plan[0].to, 'en', 'two steps always go through English');
  }
});

test('into Japanese uses M2M100 directly; everything else uses small Opus-MT models', () => {
  for (const a of ids.filter((x) => x !== 'ja')) {
    assert.deepEqual(translationPlan(a, 'ja').map((s) => s.model), [M2M_MODEL]);
  }
  assert.deepEqual(translationPlan('ja', 'en').map((s) => s.model), ['Xenova/opus-mt-ja-en']);
  assert.deepEqual(translationPlan('fr', 'id').map((s) => s.model), ['Xenova/opus-mt-fr-en', 'Xenova/opus-mt-en-id']);
});

test('English → Chinese asks for Simplified Chinese', () => {
  assert.equal(translationPlan('en', 'zh')[0].prefix, '>>cmn_Hans<< ');
  assert.equal(translationPlan('id', 'zh')[1].prefix, '>>cmn_Hans<< ');
  assert.equal(translationPlan('en', 'fr')[0].prefix, '');
});

test('only commercially licensed models are used (no NLLB, no unknown models)', () => {
  // Opus-MT: Apache-2.0 or CC-BY-4.0; M2M100: MIT; Whisper: MIT (checked Oct 2026, see developer/README.md).
  const allowed = new Set([...Object.values(OPUS_MODELS), M2M_MODEL, ...Object.values(WHISPER_MODELS).map((m) => m.id)]);
  for (const a of ids) for (const b of ids) {
    for (const item of offlinePack(a, b, 'base').items) {
      assert.ok(allowed.has(item.model), `${item.model} is not on the reviewed list`);
      assert.doesNotMatch(item.model, /nllb/i, 'NLLB-200 is non-commercial');
    }
  }
  assert.ok(!OPUS_MODELS['en-ja'] && !Object.values(OPUS_MODELS).some((m) => /jap$/.test(m)), 'opus-mt-en-jap (unclear target language) must not be used');
});

test('a language pack has speech + both directions, without duplicates', () => {
  const p = offlinePack('en', 'id', 'tiny');
  assert.deepEqual(p.items.map((i) => i.model), ['onnx-community/whisper-tiny', 'Xenova/opus-mt-en-id', 'Xenova/opus-mt-id-en']);
  assert.equal(p.mb, 41 + 2 * MODEL_MB.opus);
  const fj = offlinePack('fr', 'ja', 'base');
  assert.deepEqual(fj.items.map((i) => i.model).sort(), ['Xenova/m2m100_418M', 'Xenova/opus-mt-en-fr', 'Xenova/opus-mt-ja-en', 'onnx-community/whisper-base'].sort());
  assert.equal(offlinePack('de', 'de', 'base').items.length, 1, 'same language: speech only');
});

// ---------- on-device translator ----------
test('on-device translator chains steps through English and passes the right options', async () => {
  const calls = [];
  const call = async (op, payload) => { calls.push([op, payload]); return `${payload.to}(${payload.text})`; };
  const t = createOnDeviceTranslator({ call, isReady: () => true });
  assert.equal(await t.translate('bonjour', L('fr'), L('zh')), 'zh(en(bonjour))');
  assert.deepEqual(calls.map(([, p]) => [p.model, p.prefix]), [['Xenova/opus-mt-fr-en', ''], ['Xenova/opus-mt-en-zh', '>>cmn_Hans<< ']]);
  calls.length = 0;
  await t.translate('hello', L('en'), L('ja'));
  assert.deepEqual(calls[0][1], { model: M2M_MODEL, kind: 'm2m', from: 'en', to: 'ja', text: 'hello' });
});

test('on-device translator never starts a surprise download', () => {
  const loads = [];
  const t = createOnDeviceTranslator({ call: async (op, p) => loads.push(p.model), isReady: () => false });
  assert.equal(t.availability(L('en'), L('fr')), 'unavailable', 'auto mode skips it until downloaded');
  assert.equal(t.availability(L('en'), L('fr'), { explicit: true }), 'needs-network');
  t.prepare(L('en'), L('fr'));
  assert.equal(loads.length, 0, 'prepare() must not download');
  const ready = createOnDeviceTranslator({ call: async (op, p) => loads.push(p.model), isReady: () => true });
  ready.prepare(L('en'), L('fr'));
  assert.deepEqual(loads, ['Xenova/opus-mt-en-fr'], 'warms the model up when it is downloaded');
});

// ---------- offline-first router ----------
const engine = (id, availability, out = id) => ({
  id, label: id, calls: 0, isSupported: () => true,
  availability: async () => availability,
  async translate() { this.calls++; if (out instanceof Error) throw out; return out; },
});

// Engines that answer after a delay, for the online-vs-on-device race.
const timed = (id, availability, ms, out = `${id}-result`) => ({
  id, label: id, calls: 0, isSupported: () => true,
  availability: async () => availability,
  async translate() {
    this.calls++;
    await new Promise((r) => setTimeout(r, ms));
    if (out instanceof Error) throw out;
    return out;
  },
});
const FAST_RACE = { defaultLocalMs: 60, minHeadStartMs: 20, maxHeadStartMs: 200, slowStreakLimit: 2, cooldownMs: 10_000, smoothing: 0.3 };

test('race: a quick online answer is used, and on-device never starts', async () => {
  const online = timed('mymemory', 'needs-network', 5);
  const local = timed('on-device', 'ready', 5);
  const r = new TranslationRouter({ engines: [local, online], isOnline: () => true, race: FAST_RACE });
  assert.deepEqual(await r.translate('x', L('en'), L('id')), { text: 'mymemory-result', engine: 'mymemory' });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(local.calls, 0, 'on-device was not needed');
});

test('race: when online is slower than on-device would be, on-device wins', async () => {
  const online = timed('mymemory', 'needs-network', 400);
  const local = timed('on-device', 'ready', 30);
  const r = new TranslationRouter({ engines: [local, online], isOnline: () => true, race: FAST_RACE });
  const t0 = Date.now();
  assert.equal((await r.translate('x', L('en'), L('id'))).engine, 'on-device');
  const took = Date.now() - t0;
  assert.ok(took < 200, `answered in ${took} ms instead of waiting ~400 ms for online`);
  assert.ok(r.localMs !== null && r.localMs >= 25, 'on-device time was measured');
});

test('race: if online fails, on-device starts at once (no waiting for the head start)', async () => {
  const online = timed('mymemory', 'needs-network', 1, new Error('network error'));
  const local = timed('on-device', 'ready', 10);
  const r = new TranslationRouter({ engines: [local, online], isOnline: () => true, race: { ...FAST_RACE, minHeadStartMs: 500, maxHeadStartMs: 500, defaultLocalMs: 500 } });
  const t0 = Date.now();
  assert.equal((await r.translate('x', L('en'), L('id'))).engine, 'on-device');
  assert.ok(Date.now() - t0 < 200);
});

test('race: after online loses twice, on-device goes first for a while, then online is tried again', async () => {
  let clock = 1_000_000;
  const statuses = [];
  const online = timed('mymemory', 'needs-network', 300);
  const local = timed('on-device', 'ready', 10);
  const r = new TranslationRouter({ engines: [local, online], isOnline: () => true, race: FAST_RACE, now: () => clock, onStatus: (m) => statuses.push(m) });
  await r.translate('a', L('en'), L('id'));
  await r.translate('b', L('en'), L('id'));
  assert.equal(online.calls, 2);
  assert.match(statuses.at(-1), /connection is slow/);
  await r.translate('c', L('en'), L('id'));
  assert.equal(online.calls, 2, 'during the cool-down, online is not asked');
  clock += FAST_RACE.cooldownMs + 1;
  await r.translate('d', L('en'), L('id'));
  assert.equal(online.calls, 3, 'after the cool-down, online gets another chance');
});

test('race: online only when the pair is not downloaded; on-device only when offline', async () => {
  const online = timed('mymemory', 'needs-network', 5);
  const notDownloaded = timed('on-device', 'unavailable', 5);
  const r1 = new TranslationRouter({ engines: [notDownloaded, online], isOnline: () => true, race: FAST_RACE });
  assert.equal((await r1.translate('x', L('en'), L('id'))).engine, 'mymemory');
  const local = timed('on-device', 'ready', 5);
  const r2 = new TranslationRouter({ engines: [local, timed('mymemory', 'needs-network', 5)], isOnline: () => false, race: FAST_RACE });
  assert.equal((await r2.translate('x', L('en'), L('id'))).engine, 'on-device');
});

test('race: if both fail, the person gets one combined error', async () => {
  const r = new TranslationRouter({
    engines: [timed('on-device', 'ready', 5, new Error('out of memory')), timed('mymemory', 'needs-network', 5, new Error('quota'))],
    isOnline: () => true, race: FAST_RACE,
  });
  await assert.rejects(r.translate('x', L('en'), L('id')), /quota.*out of memory|out of memory.*quota/);
});

test('router: offline it only uses downloaded engines, and explains when there are none', async () => {
  const onDevice = engine('on-device', 'unavailable');
  const mm = engine('mymemory', 'needs-network');
  const r = new TranslationRouter({ engines: [onDevice, mm], isOnline: () => false });
  await assert.rejects(r.translate('x', L('en'), L('id')), (e) => e instanceof OfflineNotReadyError && e.code === 'offline-not-ready');
  assert.equal(mm.calls, 0, 'never tries the online service while offline');
  const ready = new TranslationRouter({ engines: [engine('on-device', 'ready'), mm], isOnline: () => false });
  assert.equal((await ready.translate('x', L('en'), L('id'))).engine, 'on-device');
});

test('router: if the downloaded engine fails, it falls back to online when there is a connection', async () => {
  const r = new TranslationRouter({ engines: [engine('on-device', 'ready', new Error('out of memory')), engine('mymemory', 'needs-network')], isOnline: () => true });
  assert.equal((await r.translate('x', L('en'), L('fr'))).engine, 'mymemory');
});

test('router: an engine that never says whether it is available is skipped, not waited on', async () => {
  const hanging = { id: 'chrome', label: 'chrome', isSupported: () => true, availability: () => new Promise(() => {}), translate: async () => 'X' };
  const r = new TranslationRouter({ engines: [hanging, engine('on-device', 'ready')], isOnline: () => false, availabilityTimeoutMs: 50 });
  const t0 = Date.now();
  assert.equal((await r.translate('x', L('en'), L('id'))).engine, 'on-device');
  assert.ok(Date.now() - t0 < 1000);
  const t1 = Date.now();
  await r.translate('y', L('en'), L('id'));
  assert.ok(Date.now() - t1 < 25, 'the second sentence does not wait again');
});

test('MyMemory gives up on a slow connection with a clear message', async () => {
  const slow = async () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); };
  await assert.rejects(myMemoryTranslator.translate('hello', L('en'), L('fr'), undefined, { fetchFn: slow }), /too long \(slow connection\)/);
  assert.equal(myMemoryTranslator.availability(), 'needs-network');
});

// ---------- download manager ----------
function fakeWorker({ cached = new Set(), fail = null, answer } = {}) {
  const listeners = new Set();
  const log = [];
  return {
    log,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    call: async (op, { model }) => {
      log.push(`${op}:${model}`);
      if (op === 'isCached') return answer !== undefined ? answer : cached.has(model);
      if (op === 'download') {
        if (model === fail) throw new Error('connection lost');
        for (const loaded of [25, 50, 100]) listeners.forEach((fn) => fn({ model, info: { status: 'progress_total', loaded, total: 100 } }));
        cached.add(model);
        return true;
      }
      throw new Error(`unexpected ${op}`);
    },
  };
}
const memoryStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('packs: reports what is missing and downloads only that', async () => {
  const w = fakeWorker({ cached: new Set(['onnx-community/whisper-tiny']) });
  let persisted = false;
  const packs = new OfflinePacks({ call: w.call, subscribe: w.subscribe, storage: { persist: async () => { persisted = true; } }, memory: memoryStore() });
  const before = await packs.status('en', 'id', 'tiny');
  assert.equal(before.ready, false);
  assert.equal(before.missingMb, 2 * MODEL_MB.opus);
  const progress = [];
  await packs.download('en', 'id', 'tiny', { onProgress: (f) => progress.push(f) });
  assert.deepEqual(w.log.filter((l) => l.startsWith('download')), ['download:Xenova/opus-mt-en-id', 'download:Xenova/opus-mt-id-en']);
  assert.ok(progress.every((f, i) => i === 0 || f >= progress[i - 1]), 'progress never goes backwards');
  assert.equal(progress.at(-1), 1);
  assert.ok(persisted, 'asks the browser to keep the files');
  assert.ok(packs.isPairReady('en', 'id') && packs.isPairReady('id', 'en') && packs.isSpeechReady('tiny'));
  assert.equal((await packs.status('en', 'id', 'tiny')).ready, true);
});

test('packs: an interrupted download keeps the finished parts', async () => {
  const w = fakeWorker({ fail: 'Xenova/opus-mt-id-en' });
  const packs = new OfflinePacks({ call: w.call, subscribe: w.subscribe, storage: null, memory: memoryStore() });
  await assert.rejects(packs.download('en', 'id', 'tiny'), /connection lost/);
  const after = await packs.status('en', 'id', 'tiny');
  assert.deepEqual(after.missing.map((i) => i.model), ['Xenova/opus-mt-id-en']);
});

test('packs: if the cache check cannot answer, the record of past downloads is used', async () => {
  const memory = memoryStore();
  const first = new OfflinePacks({ ...fakeWorker(), memory, storage: null });
  const w = fakeWorker();
  first.call = w.call; first.subscribe = w.subscribe;
  await first.download('en', 'fr', 'tiny');
  const unknown = fakeWorker({ answer: null }); // e.g. the check failed on a slow connection
  const second = new OfflinePacks({ call: unknown.call, subscribe: unknown.subscribe, storage: null, memory });
  assert.equal((await second.status('en', 'fr', 'tiny')).ready, true);
  const gone = fakeWorker({ answer: false }); // the browser cleared its storage
  const third = new OfflinePacks({ call: gone.call, subscribe: gone.subscribe, storage: null, memory });
  assert.equal((await third.status('en', 'fr', 'tiny')).ready, false, 'a definite "not cached" wins over the record');
});

// ---------- speech engine choice ----------
test('speech: on-device whenever downloaded; browser speech only online', () => {
  const pick = (ctx) => createRecognitionEngine('auto', 'tiny', { builtIn: true, ...ctx }).id;
  assert.equal(pick({ speechOnDevice: true, online: true }), 'whisper', 'downloaded beats online');
  assert.equal(pick({ speechOnDevice: false, online: true }), 'webspeech');
  assert.equal(pick({ speechOnDevice: false, online: false }), 'whisper', 'offline never picks browser speech');
  assert.equal(createRecognitionEngine('auto', 'tiny', { builtIn: false, online: true }).id, 'whisper', 'no built-in (e.g. Firefox)');
});

test('offline errors are explained in plain words', () => {
  assert.match(friendlyTranslationError(new OfflineNotReadyError()), /Download for offline use/);
  assert.match(friendlyTranslationError(new Error('MyMemory (online): the online translator took too long (slow connection)')), /too slow/);
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    assert.match(friendlyError(new TypeError('Failed to fetch')), /isn’t downloaded on this device yet/);
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator;
  }
  assert.equal(createRecognitionEngine('auto', 'base', { online: false }).id, 'whisper');
});

// ---------- service worker ----------
test('service worker stores every file the app needs, and its version matches index.html', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]);
  const needed = walk(join(ROOT, 'app'))
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .filter((f) => !/(LICENSE|README\.txt|OFL\.txt|share\.png)$/.test(f)); // docs and link-preview image aren't needed offline
  for (const f of needed) assert.ok(listed.has(f), `sw.js APP_FILES is missing ${f}`);
  for (const f of listed) {
    if (f === './') continue;
    assert.doesNotThrow(() => readFileSync(join(ROOT, f)), `sw.js lists ${f}, which doesn't exist`);
  }
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/\?v=([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tags, [version, version], 'bump sw.js VERSION and both ?v= tags in index.html together');
});
