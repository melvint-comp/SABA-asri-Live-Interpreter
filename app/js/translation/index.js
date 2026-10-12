/**
 * translation/index.js — routes text to a translation engine.
 *
 * Engines fall into two groups for a given language pair:
 *   on-device: works right now with no internet (Chrome's built-in translator
 *              with its language pack installed, or the models from
 *              "Download for offline use");
 *   online:    needs the network (MyMemory, or Chrome's translator before its
 *              small one-time download).
 *
 * 'auto' is ONLINE-FIRST WITH A FAST ON-DEVICE FALLBACK:
 *   - Offline → on-device only.
 *   - Online, but the pair isn't downloaded → online only.
 *   - Online and downloaded → a race with a head start. Online starts first.
 *     If it hasn't answered within the time the on-device translator usually
 *     takes on this device (measured; ~1 s until known) — i.e. online is
 *     slower than offline would be — or if it fails, on-device starts too, and
 *     whichever finishes first is shown.
 *   - If online loses twice in a row, on-device goes first for 2 minutes, then
 *     online gets another chance.
 *
 * Analogy: you ask a colleague by phone, but if they haven't answered in the
 * time it takes you to look it up yourself, you look it up — and if the line
 * keeps being slow, you stop calling for a while.
 */
import { chromeTranslator } from './chrome-builtin.js';
import { myMemoryTranslator } from './mymemory.js';
import { createOnDeviceTranslator } from './on-device.js';
import { offlinePacks } from '../offline/packs.js';

export const onDeviceTranslator = createOnDeviceTranslator({ isReady: (a, b) => offlinePacks.isPairReady(a, b) });
export const TRANSLATION_ENGINES = [chromeTranslator, onDeviceTranslator, myMemoryTranslator];
const AUTO_ORDER = ['chrome', 'on-device', 'mymemory'];
/** An engine that can't say within this time whether it's usable is skipped (some browsers never answer). */
const AVAILABILITY_TIMEOUT_MS = 1500;
/** Availability answers are reused for this long, so sentences after the first never wait. */
const AVAILABILITY_TTL_MS = 30_000;

export const RACE = Object.freeze({
  defaultLocalMs: 1000,   // assumed on-device time until we've measured it
  minHeadStartMs: 300,    // online always gets at least this long…
  maxHeadStartMs: 2000,   // …and never more than this
  slowStreakLimit: 2,     // online losing this many times in a row…
  cooldownMs: 120_000,    // …makes on-device go first for this long
  smoothing: 0.3,         // weight of each new on-device timing in the running average
});

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Thrown when there's no internet and nothing usable is stored on the device. */
export class OfflineNotReadyError extends Error {
  constructor() {
    super('No internet connection, and this language pair isn’t downloaded for offline use.');
    this.code = 'offline-not-ready';
  }
}

export class TranslationRouter {
  /**
   * @param {{ engines?: object[], onStatus?: (msg: string) => void, isOnline?: () => boolean }} opts
   */
  constructor({
    engines = TRANSLATION_ENGINES,
    onStatus = () => {},
    isOnline = () => globalThis.navigator?.onLine !== false,
    availabilityTimeoutMs = AVAILABILITY_TIMEOUT_MS,
    race = RACE,
    now = () => Date.now(),
  } = {}) {
    this.engines = new Map(engines.map((e) => [e.id, e]));
    Object.assign(this, { onStatus, isOnline, availabilityTimeoutMs, race, now });
    this.known = new Map(); // 'engine|src|tgt|explicit' → { value: Promise<string>, at }
    this.dead = new Map(); // 'engine|src|tgt' → reason, for combos that failed permanently
    this.localMs = null;          // running average of on-device translation time
    this.slowStreak = 0;          // times in a row online lost the race
    this.localFirstUntil = 0;     // timestamp until which on-device goes first
  }

  /** How long online gets before on-device starts: the on-device time we expect. */
  headStartMs() {
    const expected = this.localMs ?? this.race.defaultLocalMs;
    return Math.min(this.race.maxHeadStartMs, Math.max(this.race.minHeadStartMs, expected));
  }

  /** Engines this browser supports, in priority order, for a given user choice. */
  candidates(choice) {
    const ids = choice === 'auto' ? AUTO_ORDER : [choice];
    return ids.map((id) => this.engines.get(id)).filter((e) => e && e.isSupported());
  }

  /** Forget remembered availability (call after a download, or when the connection changes). */
  invalidate() {
    this.known.clear();
  }

  /** Is this engine usable for the pair? Checked once, then remembered briefly; never waits long. */
  availability(engine, src, tgt, explicit) {
    if (!engine.availability) return Promise.resolve('needs-network');
    const key = `${engine.id}|${src.id}|${tgt.id}|${explicit}`;
    const hit = this.known.get(key);
    if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.value;
    const value = (async () => {
      try {
        return await withTimeout(engine.availability(src, tgt, { explicit }), this.availabilityTimeoutMs, 'unavailable');
      } catch {
        return 'unavailable';
      }
    })();
    this.known.set(key, { value, at: Date.now() });
    return value;
  }

  /** Split usable engines into on-device (ready now) and online (needs the network). */
  async groups(choice, src, tgt) {
    const explicit = choice !== 'auto';
    const engines = this.candidates(choice);
    const answers = await Promise.all(engines.map((e) => this.availability(e, src, tgt, explicit)));
    const local = engines.filter((_, i) => answers[i] === 'ready');
    const online = this.isOnline() ? engines.filter((_, i) => answers[i] === 'needs-network') : [];
    return { local, online };
  }

  /** All usable engines, on-device first (used for explicit choices and while on-device goes first). */
  async plan(choice, src, tgt) {
    const { local, online } = await this.groups(choice, src, tgt);
    return [...local, ...online];
  }

  /** Warm up engines. Call synchronously inside a click handler (see chrome-builtin.js). */
  prepare(choice, src, tgt) {
    if (src.id === tgt.id) return;
    for (const e of this.candidates(choice)) e.prepare?.(src, tgt, this.onStatus);
    this.plan(choice, src, tgt).catch(() => {}); // answer availability now, not on the first sentence
  }

  /**
   * Translate `text` from language `src` to `tgt` (objects from config.LANGUAGES).
   * @returns {Promise<{ text: string, engine: string | null }>}
   */
  async translate(text, src, tgt, choice = 'auto') {
    if (src.id === tgt.id || !text.trim()) return { text, engine: null };
    if (!this.candidates(choice).length) throw new Error(`No translation engine available for "${choice}" in this browser.`);
    const { local, online } = await this.groups(choice, src, tgt);
    if (!local.length && !online.length) throw new OfflineNotReadyError();

    const isLocal = new Set(local);
    if (choice !== 'auto' || !local.length) return this.chain([...local, ...online], text, src, tgt, isLocal);
    if (!online.length) return this.chain(local, text, src, tgt, isLocal);
    if (this.now() < this.localFirstUntil) return this.chain([...local, ...online], text, src, tgt, isLocal);
    return this.raceOnlineFirst(online, local, text, src, tgt);
  }

  /**
   * Online starts first; on-device starts when online fails or overruns its
   * head start. The first translation to arrive wins.
   */
  raceOnlineFirst(online, local, text, src, tgt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let localStarted = false;
      let pending = 1; // chains still running
      const errors = [];
      const finish = (result, winner) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._recordRace(winner);
        resolve(result);
      };
      const fail = (err) => {
        errors.push(err.message);
        if (--pending === 0 && !settled) {
          if (!localStarted) return startLocal();
          settled = true;
          reject(new Error(errors.join(' · ')));
        }
      };
      const startLocal = () => {
        if (localStarted || settled) return;
        localStarted = true;
        pending++;
        this.chain(local, text, src, tgt, new Set(local)).then((r) => finish(r, 'local'), fail);
      };
      const timer = setTimeout(startLocal, this.headStartMs());
      this.chain(online, text, src, tgt).then((r) => finish(r, 'online'), (err) => { startLocal(); fail(err); });
    });
  }

  _recordRace(winner) {
    if (winner === 'online') {
      this.slowStreak = 0;
      return;
    }
    this.slowStreak++;
    if (this.slowStreak >= this.race.slowStreakLimit) {
      this.slowStreak = 0;
      this.localFirstUntil = this.now() + this.race.cooldownMs;
      this.onStatus('The connection is slow, so translation is running on this device for now.');
    }
  }

  /**
   * Try engines one after another; the first good translation wins.
   * Engines in `isLocal` (on-device) are timed, to set online's head start.
   */
  async chain(engines, text, src, tgt, isLocal = new Set()) {
    const errors = [];
    for (const engine of engines) {
      const key = `${engine.id}|${src.id}|${tgt.id}`;
      if (this.dead.has(key)) { errors.push(`${engine.label}: ${this.dead.get(key)}`); continue; }
      const started = this.now();
      try {
        const out = await engine.translate(text, src, tgt, this.onStatus);
        if (out) {
          if (isLocal.has(engine)) this._recordLocalTime(this.now() - started);
          return { text: out, engine: engine.id };
        }
        errors.push(`${engine.label}: empty result`);
      } catch (err) {
        if (err.permanent) this.dead.set(key, err.message);
        errors.push(`${engine.label}: ${err.message}`);
      }
    }
    throw new Error(errors.join(' · '));
  }

  _recordLocalTime(ms) {
    const a = this.race.smoothing;
    this.localMs = this.localMs === null ? ms : (1 - a) * this.localMs + a * ms;
  }
}
