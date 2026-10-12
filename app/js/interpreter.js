/**
 * interpreter.js — the conductor. Connects one speech-to-text engine to the
 * translation router and reports everything to a "view".
 *
 *   mic ──► recognition engine ──finished phrase──► translation router ──► view
 *                    └──live partial text──────────────────────────────► view
 *
 * Translations run one at a time, in order, so phrases never get mixed up.
 *
 * The view is any object with these methods (main.js implements it with the
 * page; tests implement it with plain arrays):
 *   setStatus(message, kind?)       kind: '' | 'warn' | 'error'
 *   setLive(text)                   words still being recognised
 *   setRecording(isOn)
 *   addPhrase(text) → handle        a finished phrase
 *   setTranslation(handle, text, { passthrough?, failed? })
 */
import { getLanguage } from './config.js';
import { createRecognitionEngine } from './recognition/index.js';

export class Interpreter {
  /**
   * device: object or function returning { phone, speechOnDevice, online } —
   * read fresh at every start, because the connection and downloads change.
   */
  constructor({ view, router, createEngine = createRecognitionEngine, device = {} }) {
    Object.assign(this, { view, router, createEngine, device });
    this.state = 'idle'; // 'idle' | 'running' | 'stopping'
  }

  get isRunning() { return this.state === 'running'; }

  /** Must be called directly from a tap/click handler (browsers require it for mic & downloads). */
  async start(settings) {
    if (this.state !== 'idle') return;
    this.settings = settings;
    this.src = getLanguage(settings.source);
    this.tgt = getLanguage(settings.target);
    this.translations = Promise.resolve();
    this.router.prepare(settings.translation, this.src, this.tgt); // synchronous: keeps the tap's permission
    this.state = 'running';
    this.view.setRecording(true);
    this.view.setStatus('Starting…');
    try {
      await this._startEngine(this.createEngine(settings.recognition, settings.whisperModel, this._context()));
    } catch (err) {
      await this._abort(friendlyError(err));
    }
  }

  async stop() {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    this.view.setStatus('Finishing up…');
    try { await this.engine?.stop(); } catch { /* engine already gone */ }
    await this.translations;
    this.state = 'idle';
    this.view.setLive('');
    this.view.setRecording(false);
    this.view.setStatus('Stopped.');
  }

  _context() {
    return typeof this.device === 'function' ? this.device() : this.device;
  }

  async _startEngine(engine) {
    this.engine = engine;
    await engine.start({
      language: this.src,
      onInterim: (t) => this.view.setLive(t),
      onFinal: (t) => this._onFinal(t),
      onStatus: (m, kind) => this.view.setStatus(m, kind),
      onFatal: (err) => this._onFatal(err),
    });
  }

  async _onFatal(err) {
    if (this.state !== 'running') return;
    // In 'auto' mode, a broken built-in recogniser falls back to on-device Whisper.
    if (this.settings.recognition === 'auto' && this.engine?.id === 'webspeech' && !/blocked|microphone/i.test(err.message)) {
      this.view.setStatus('Built-in speech recognition isn’t working here, so we switched to on-device recognition. The first time, this needs a one-time download.', 'warn');
      try {
        await this._startEngine(this.createEngine('whisper', this.settings.whisperModel, this._context()));
        return;
      } catch (err2) {
        err = err2;
      }
    }
    await this._abort(friendlyError(err));
  }

  async _abort(message) {
    try { await this.engine?.stop(); } catch { /* ignore */ }
    this.state = 'idle';
    this.view.setLive('');
    this.view.setRecording(false);
    this.view.setStatus(message, 'error');
  }

  _onFinal(text) {
    const handle = this.view.addPhrase(text);
    const { src, tgt } = this;
    const choice = this.settings.translation;
    this.translations = this.translations.then(async () => {
      try {
        const { text: out, engine } = await this.router.translate(text, src, tgt, choice);
        this.view.setTranslation(handle, out, { passthrough: engine === null });
      } catch (err) {
        console.warn('Translation failed:', err);
        this.view.setTranslation(handle, null, { failed: true });
        this.view.setStatus(friendlyTranslationError(err), 'warn');
      }
    });
  }
}

/** Map low-level browser errors to messages a person can act on. */
export function friendlyError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked. Allow the microphone for this site (usually via the icon next to the web address), then press the microphone button again.';
  }
  if (name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError') return 'The microphone is being used by another app. Close it and try again.';
  if (isOffline() && /fetch|network|load|download/i.test(err?.message || '')) {
    return 'There’s no internet, and speech recognition isn’t downloaded on this device yet. When you’re next online, tap “Download for offline use”.';
  }
  return err?.message || String(err);
}

const isOffline = () => globalThis.navigator?.onLine === false;

export function friendlyTranslationError(err) {
  const msg = err?.message || '';
  if (err?.code === 'offline-not-ready') {
    return 'No internet, and this language pair isn’t downloaded yet. When you’re next online, tap “Download for offline use”.';
  }
  if (/too long|slow connection/i.test(msg)) return 'The connection is too slow for online translation. Download this language pair to translate without internet.';
  if (/quota/i.test(msg)) return 'Today’s free translation limit has been reached. It resets tomorrow. On a computer, Google Chrome can translate without this limit.';
  if (/fetch|network|offline/i.test(msg) || globalThis.navigator?.onLine === false) {
    return 'Couldn’t reach the translation service. Check your internet connection.';
  }
  return 'Translation isn’t available right now. Please try again in a moment.';
}
