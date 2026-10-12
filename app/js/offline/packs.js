/**
 * packs.js — "Download for offline use".
 *
 * A language pack is everything needed to use one language pair with no
 * internet: the speech-recognition model plus the translation models for both
 * directions (see offlinePack() in config.js). Files are stored by the browser
 * and reused on every visit; this module only downloads what's missing and
 * keeps track of what's already on the device.
 *
 * Analogy: packing for a trip to a place with no shops. While there's still
 * internet you check the list, fetch only what you don't already have, and
 * from then on everything you need is in the bag.
 */
import { offlinePack, translationPlan, WHISPER_MODELS } from '../config.js';
import { callWorker, onModelProgress } from '../workers/ml-client.js';

const STORAGE_KEY = 'live-interpreter:on-device-models';
const CHECK_TIMEOUT_MS = 5000;

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class OfflinePacks {
  constructor({
    call = callWorker,
    subscribe = onModelProgress,
    storage = globalThis.navigator?.storage,
    memory = safeStorage(),
  } = {}) {
    Object.assign(this, { call, subscribe, storage, memory });
    this.onDevice = new Set(); // model ids confirmed (or recorded) to be stored on this device
    this.recorded = new Set(this._read());
  }

  _read() {
    try { return JSON.parse(this.memory?.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }
  _record(model, present) {
    present ? this.recorded.add(model) : this.recorded.delete(model);
    try { this.memory?.setItem(STORAGE_KEY, JSON.stringify([...this.recorded])); } catch { /* private mode */ }
  }

  /**
   * Ask the browser's cache (never the network) which models are fully stored.
   * If the check can't answer in time, fall back to what we recorded after the
   * last successful download.
   */
  async refresh(items) {
    await Promise.all(items.map(async ({ model, task }) => {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CHECK_TIMEOUT_MS); });
      const answer = await Promise.race([this.call('isCached', { model, for: task }).catch(() => null), timeout]);
      clearTimeout(timer);
      const present = answer === null ? this.recorded.has(model) : answer;
      present ? this.onDevice.add(model) : this.onDevice.delete(model);
      if (answer !== null) this._record(model, answer);
    }));
  }

  /** Synchronous checks used when choosing engines (valid after refresh()). */
  isPairReady(src, tgt) {
    return translationPlan(src, tgt).every((s) => this.onDevice.has(s.model));
  }
  isSpeechReady(whisperKey) {
    return this.onDevice.has((WHISPER_MODELS[whisperKey] || WHISPER_MODELS.base).id);
  }

  /** What a pair needs, and how much of it is still missing. */
  async status(a, b, whisperKey) {
    const pack = offlinePack(a, b, whisperKey);
    await this.refresh(pack.items);
    const missing = pack.items.filter((i) => !this.onDevice.has(i.model));
    return { ready: missing.length === 0, missing, missingMb: missing.reduce((n, i) => n + i.mb, 0), totalMb: pack.mb };
  }

  /**
   * Download every missing model for the pair, reporting overall progress 0–1.
   * Safe to call again after a failure: models that finished are kept.
   */
  async download(a, b, whisperKey, { onProgress = () => {} } = {}) {
    const { missing, missingMb } = await this.status(a, b, whisperKey);
    let doneMb = 0;
    let current = null;
    const report = (value) => onProgress(Math.max(0, Math.min(1, value)));
    const unsubscribe = this.subscribe(({ model, info }) => {
      if (!current || model !== current.model || info.status !== 'progress_total' || !info.total) return;
      report(missingMb ? (doneMb + (info.loaded / info.total) * current.mb) / missingMb : 1);
    });
    try {
      for (const item of missing) {
        current = item;
        await this.call('download', { model: item.model, for: item.task });
        this.onDevice.add(item.model);
        this._record(item.model, true);
        doneMb += item.mb;
        report(missingMb ? doneMb / missingMb : 1);
      }
    } finally {
      unsubscribe();
    }
    // Ask the browser not to clear these files when storage runs low.
    try { await this.storage?.persist?.(); } catch { /* not supported */ }
    report(1);
  }
}

export const offlinePacks = new OfflinePacks();
