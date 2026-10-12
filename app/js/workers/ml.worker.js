/**
 * ml.worker.js — runs the on-device AI models off the main thread, so the page
 * never freezes: Whisper (speech → text) and Opus-MT / M2M100 (translation).
 *
 * Everything works without internet once downloaded: transformers.js keeps the
 * model files and the ONNX Runtime WebAssembly in the browser's Cache Storage
 * ("transformers-cache") and always looks there before the network. The library
 * itself is self-hosted (app/vendor) and kept on the device by the service worker.
 *
 * Protocol (main → worker):
 *   { id, op: 'transcribe', model, audio: Float32Array (16 kHz mono), language }
 *   { id, op: 'translate',  model, kind: 'opus'|'m2m', text, from, to, prefix }
 *   { id, op: 'load',       model, for: 'transcribe'|'translate' }   download if needed + keep in memory
 *   { id, op: 'download',   model, for: 'transcribe'|'translate' }   store on device, then free memory
 *   { id, op: 'isCached',   model, for: 'transcribe'|'translate' }   → true/false/null (unknown), no network
 * Replies (worker → main):
 *   { id, result }            on success
 *   { id, error }             on failure
 *   { type: 'progress', op, model, info }   while models download/load
 */
import { TRANSFORMERS_URL } from '../config.js';

const TASKS = { transcribe: 'automatic-speech-recognition', translate: 'translation' };
const OPTIONS = {
  dtype: 'q8',      // 8-bit weights: ~4× smaller than fp32, small accuracy cost
  device: 'wasm',   // runs on every device; uses several CPU cores when the page is cross-origin isolated
};
/** Phones have little memory: keep at most this many translation models loaded at once. */
const MAX_TRANSLATORS = 2;

let lib = null;                 // the transformers.js module, imported on first use
const pipelines = new Map();    // `${task}|${model}` → Promise<pipeline>, in least-recently-used order

async function getLib() {
  if (!lib) {
    lib = await import(TRANSFORMERS_URL);
    lib.env.allowLocalModels = false;
  }
  return lib;
}

async function getPipeline(task, model, op) {
  const key = `${task}|${model}`;
  if (pipelines.has(key)) {
    const p = pipelines.get(key);
    pipelines.delete(key);
    pipelines.set(key, p); // mark as most recently used
    return p;
  }
  const p = (async () => {
    const { pipeline } = await getLib();
    return pipeline(task, model, {
      ...OPTIONS,
      progress_callback: (info) => self.postMessage({ type: 'progress', op, model, info }),
    });
  })();
  p.catch(() => pipelines.delete(key)); // let a failed load be retried
  pipelines.set(key, p);
  evictTranslators();
  return p;
}

/** Free memory held by translation models we haven't used recently (they stay downloaded). */
function evictTranslators() {
  const translators = [...pipelines.keys()].filter((k) => k.startsWith(`${TASKS.translate}|`));
  for (const key of translators.slice(0, Math.max(0, translators.length - MAX_TRANSLATORS))) {
    const p = pipelines.get(key);
    pipelines.delete(key);
    p.then((pipe) => pipe.dispose?.()).catch(() => {});
  }
}

const handlers = {
  async load({ model, for: op }) {
    await getPipeline(TASKS[op], model, op);
    return true;
  },

  /**
   * Store a model on the device without keeping it in memory: fetch every file
   * (cached by transformers.js), check it loads, then free it. One model at a
   * time, so downloading a big pack never exhausts a phone's memory.
   */
  async download({ model, for: op }) {
    const key = `${TASKS[op]}|${model}`;
    const alreadyLoaded = pipelines.has(key);
    const pipe = await getPipeline(TASKS[op], model, op);
    if (!alreadyLoaded) {
      pipelines.delete(key);
      await pipe.dispose?.();
    }
    return true;
  },

  /** true / false, or null if it couldn't be determined. Reads the device's cache only. */
  async isCached({ model, for: op }) {
    try {
      const { ModelRegistry } = await getLib();
      return await ModelRegistry.is_pipeline_cached(TASKS[op], model, { ...OPTIONS, local_files_only: true });
    } catch {
      return null;
    }
  },

  async transcribe({ model, audio, language }) {
    const asr = await getPipeline(TASKS.transcribe, model, 'transcribe');
    const longer = audio.length > 30 * 16000; // Whisper's window is 30 s
    const out = await asr(audio, { language, task: 'transcribe', ...(longer ? { chunk_length_s: 30 } : {}) });
    return (out.text || '').trim();
  },

  async translate({ model, kind, text, from, to, prefix = '' }) {
    const mt = await getPipeline(TASKS.translate, model, 'translate');
    const options = { max_new_tokens: 256 };
    if (kind === 'm2m') Object.assign(options, { src_lang: from, tgt_lang: to });
    const out = await mt(prefix + text, options);
    return (out[0]?.translation_text || '').trim();
  },
};

self.onmessage = async ({ data }) => {
  const { id, op, ...payload } = data;
  try {
    if (!handlers[op]) throw new Error(`Unknown op "${op}"`);
    self.postMessage({ id, result: await handlers[op](payload) });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
