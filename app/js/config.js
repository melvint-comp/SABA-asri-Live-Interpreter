/**
 * config.js — the single source of truth for languages and engine settings.
 *
 * Every engine speaks a slightly different "language-code dialect", so each
 * language lists the code each engine expects. To add a language, add one
 * entry here; nothing else in the app needs to change.
 *
 *  speech     → Web Speech API (BCP-47). First entry is tried first; later
 *               entries are fallbacks if the browser rejects the first.
 *  whisper    → Whisper language code (ISO-639-1).
 *  translator → Chrome built-in Translator API (BCP-47 short code).
 *  mymemory   → MyMemory REST API.
 *  m2m        → M2M100 language code (on-device translation into Japanese).
 */
export const LANGUAGES = Object.freeze([
  { id: 'en', name: 'English',    native: 'English',          speech: ['en-US', 'en-GB'],        whisper: 'en', translator: 'en', mymemory: 'en', m2m: 'en' },
  { id: 'fr', name: 'French',     native: 'Français',         speech: ['fr-FR'],                 whisper: 'fr', translator: 'fr', mymemory: 'fr', m2m: 'fr' },
  { id: 'de', name: 'German',     native: 'Deutsch',          speech: ['de-DE'],                 whisper: 'de', translator: 'de', mymemory: 'de', m2m: 'de' },
  { id: 'zh', name: 'Mandarin',   native: '中文',              speech: ['cmn-Hans-CN', 'zh-CN'],  whisper: 'zh', translator: 'zh', mymemory: 'zh-CN', m2m: 'zh' },
  { id: 'ja', name: 'Japanese',   native: '日本語',            speech: ['ja-JP'],                 whisper: 'ja', translator: 'ja', mymemory: 'ja', m2m: 'ja' },
  { id: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', speech: ['id-ID'],                 whisper: 'id', translator: 'id', mymemory: 'id', m2m: 'id' },
]);

/** Look up a language by id; throws on unknown ids so typos fail loudly. */
export function getLanguage(id) {
  const lang = LANGUAGES.find((l) => l.id === id);
  if (!lang) throw new Error(`Unknown language id "${id}"`);
  return lang;
}

/**
 * transformers.js (Apache-2.0) is self-hosted in app/vendor so the app never
 * depends on reaching a CDN; the service worker keeps it on the device.
 */
export const TRANSFORMERS_URL = new URL('../vendor/transformers/transformers-4.3.1.min.js', import.meta.url).href;

/** Whisper checkpoints (multilingual, MIT). `mb` is the q8 download, cached after first use. */
export const WHISPER_MODELS = Object.freeze({
  tiny:  { id: 'onnx-community/whisper-tiny',  mb: 41,  label: 'Quick — 41 MB download (good for phones)' },
  base:  { id: 'onnx-community/whisper-base',  mb: 77,  label: 'Balanced — 77 MB download' },
  small: { id: 'onnx-community/whisper-small', mb: 249, label: 'Most accurate — 249 MB download (computers)' },
});

/**
 * On-device translation models — all licensed for commercial use.
 *
 *  - Opus-MT (Helsinki-NLP, Apache-2.0 / CC-BY-4.0 — attribution in README):
 *    small and fast (~77M parameters, ~110 MB each). One model per direction,
 *    with English as the hub: French → Japanese... see translationPlan().
 *  - M2M100 418M (Meta, MIT): one larger model (~635 MB) that translates
 *    directly between all six languages. Used only for translating INTO
 *    Japanese, because no good small English→Japanese model exists.
 *
 * Every model is the ONNX conversion published by Xenova (transformers.js).
 */
export const OPUS_MODELS = Object.freeze({
  'fr-en': 'Xenova/opus-mt-fr-en', 'en-fr': 'Xenova/opus-mt-en-fr',
  'de-en': 'Xenova/opus-mt-de-en', 'en-de': 'Xenova/opus-mt-en-de',
  'zh-en': 'Xenova/opus-mt-zh-en', 'en-zh': 'Xenova/opus-mt-en-zh',
  'id-en': 'Xenova/opus-mt-id-en', 'en-id': 'Xenova/opus-mt-en-id',
  'ja-en': 'Xenova/opus-mt-ja-en',
});
/** Some Opus-MT models serve several scripts and need the target named first. */
export const OPUS_PREFIX = Object.freeze({ 'en-zh': '>>cmn_Hans<< ' }); // Simplified Chinese
export const M2M_MODEL = 'Xenova/m2m100_418M';
export const MODEL_MB = Object.freeze({ opus: 110, m2m: 635 });

/**
 * The steps needed to translate src → tgt on the device. Each step is one
 * model call; two steps means going through English.
 * @returns {{ model: string, kind: 'opus'|'m2m', from: string, to: string, prefix?: string }[]}
 */
export function translationPlan(src, tgt) {
  if (src === tgt) return [];
  if (tgt === 'ja') return [{ model: M2M_MODEL, kind: 'm2m', from: src, to: tgt }];
  const step = (from, to) => {
    const model = OPUS_MODELS[`${from}-${to}`];
    if (!model) throw new Error(`No on-device model for ${from} → ${to}`);
    return { model, kind: 'opus', from, to, prefix: OPUS_PREFIX[`${from}-${to}`] || '' };
  };
  if (src === 'en' || tgt === 'en') return [step(src, tgt)];
  return [step(src, 'en'), step('en', tgt)];
}

/** Every model needed to use a language pair offline, in both directions, plus speech recognition. */
export function offlinePack(a, b, whisperKey) {
  const whisper = WHISPER_MODELS[whisperKey] || WHISPER_MODELS.base;
  const items = new Map([[whisper.id, { model: whisper.id, task: 'transcribe', mb: whisper.mb }]]);
  for (const step of [...translationPlan(a, b), ...translationPlan(b, a)]) {
    if (!items.has(step.model)) items.set(step.model, { model: step.model, task: 'translate', mb: MODEL_MB[step.kind] });
  }
  const list = [...items.values()];
  return { items: list, mb: list.reduce((n, i) => n + i.mb, 0) };
}

/** Online translation (MyMemory) gives up after this long, so a bad connection never stalls the app. */
export const ONLINE_TIMEOUT_MS = 8000;


export const MYMEMORY = Object.freeze({
  endpoint: 'https://api.mymemory.translated.net/get',
  /** API limit is 500 *bytes* of query per request. */
  maxQueryBytes: 500,
  /**
   * Optional contact e-mail. Anonymous use is limited to ~5,000 chars/day per IP;
   * adding an e-mail raises it to ~50,000 chars/day. Leave empty to stay anonymous.
   */
  email: '',
});

/** Voice-activity segmenter used by the Whisper engine (see audio/segmenter.js). */
export const SEGMENTER = Object.freeze({
  sampleRate: 16000,     // Whisper expects 16 kHz mono
  frameMs: 30,           // analysis frame
  minThreshold: 0.008,   // absolute RMS floor that counts as "speech"
  noiseRatio: 3,         // speech must be this many × louder than the running noise floor
  minSpeechMs: 300,      // ignore blips shorter than this
  maxSilenceMs: 700,     // a pause this long ends an utterance
  maxSegmentMs: 15000,   // force a cut so long monologues still stream out
  preRollMs: 300,        // keep a little audio from before speech started
});

export const DEFAULT_SETTINGS = Object.freeze({
  source: 'en',
  target: 'fr',
  recognition: 'auto',   // 'auto' | 'webspeech' | 'whisper'
  whisperModel: 'base',  // key of WHISPER_MODELS
  translation: 'auto',   // 'auto' | 'chrome' | 'on-device' | 'mymemory'
});
