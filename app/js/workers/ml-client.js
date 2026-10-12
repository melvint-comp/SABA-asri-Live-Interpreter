/**
 * ml-client.js — tiny promise-based RPC wrapper around ml.worker.js.
 *
 * One shared worker serves every recording, so a model loaded once is reused.
 */
let worker = null;
let nextId = 1;
const pending = new Map();           // id → { resolve, reject }
const progressListeners = new Set();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ml.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      progressListeners.forEach((fn) => fn(data));
      return;
    }
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
  };
  worker.onerror = (e) => {
    const err = new Error(`AI worker crashed: ${e.message || 'unknown error'}`);
    pending.forEach((job) => job.reject(err));
    pending.clear();
    worker = null; // next call starts a fresh worker
  };
  return worker;
}

/** Call a worker operation. `transfer` lists buffers to move (not copy). */
export function callWorker(op, payload, transfer = []) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, ...payload }, transfer);
  });
}

/** Subscribe to model download/load progress. Returns an unsubscribe function. */
export function onModelProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

/** Turn a transformers.js progress event into a short, plain-language message (or null). */
export function describeProgress({ op, info }) {
  const what = op === 'translate' ? 'translation' : 'speech recognition';
  // transformers.js v4 emits an aggregate 'progress_total' event across all model files.
  if (info.status === 'progress_total' && info.total) {
    const mb = (b) => Math.round(b / 1e6);
    return `Getting ${what} ready — one-time download: ${mb(info.loaded)} of ${mb(info.total)} MB`;
  }
  if (info.status === 'initiate' || info.status === 'download') return `Getting ${what} ready…`;
  if (info.status === 'ready' && op !== 'translate') return 'Listening… pause briefly after each sentence.';
  return null;
}
