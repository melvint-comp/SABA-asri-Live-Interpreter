/**
 * settings.js — load/save user choices.
 *
 * Priority: URL query (shareable links, e.g. ?from=ja&to=en&asr=whisper)
 *           > saved in this browser (localStorage) > defaults in config.js.
 * Invalid values are ignored rather than trusted.
 *
 * Only the two languages are remembered between visits. Engine choices are
 * automatic; the URL parameters asr/model/mt are an advanced override that
 * applies to that visit only (there is no on-page settings panel to undo them).
 */
import { DEFAULT_SETTINGS, LANGUAGES, WHISPER_MODELS } from './config.js';

const STORAGE_KEY = 'live-interpreter:settings';
const REMEMBERED = ['source', 'target'];
const URL_KEYS = { from: 'source', to: 'target', asr: 'recognition', model: 'whisperModel', mt: 'translation' };

const VALID = {
  source: (v) => LANGUAGES.some((l) => l.id === v),
  target: (v) => LANGUAGES.some((l) => l.id === v),
  recognition: (v) => ['auto', 'webspeech', 'whisper'].includes(v),
  whisperModel: (v) => Object.hasOwn(WHISPER_MODELS, v),
  translation: (v) => ['auto', 'chrome', 'on-device', 'mymemory'].includes(v),
};

/** Keep only known keys with valid values. */
export function sanitize(obj) {
  const out = {};
  for (const [k, ok] of Object.entries(VALID)) if (obj && typeof obj[k] === 'string' && ok(obj[k])) out[k] = obj[k];
  return out;
}

export function fromQuery(search) {
  const params = new URLSearchParams(search);
  const raw = {};
  for (const [param, key] of Object.entries(URL_KEYS)) if (params.has(param)) raw[key] = params.get(param);
  return sanitize(raw);
}

export function loadSettings({ search = globalThis.location?.search ?? '', storage = safeStorage(), defaults = DEFAULT_SETTINGS } = {}) {
  let saved = {};
  try { saved = pick(sanitize(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')), REMEMBERED); } catch { /* corrupt or blocked */ }
  return { ...defaults, ...saved, ...fromQuery(search) };
}

export function saveSettings(settings, storage = safeStorage()) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(pick(sanitize(settings), REMEMBERED))); } catch { /* private mode etc. */ }
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
