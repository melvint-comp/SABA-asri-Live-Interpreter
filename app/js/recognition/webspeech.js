/**
 * webspeech.js — speech-to-text via the browser's built-in Web Speech API.
 *
 * Pros: words appear as you speak, nothing to download, very accurate.
 * Cons: only some browsers (Chrome, Safari), and the browser usually sends the
 *       audio to its maker's servers (Google for Chrome, Apple for Safari).
 *
 * Two listening styles:
 *   continuous = true   one long session (best on desktop Chrome)
 *   continuous = false  one phrase per session, restarted automatically.
 *                       Used on phones, where continuous mode is known to
 *                       repeat or pile up text on Android and iOS.
 *
 * Engine interface (shared with whisper.js):
 *   await engine.start({ language, onInterim, onFinal, onStatus, onFatal })
 *   await engine.stop()   // resolves once the last final result is delivered
 */
const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const isWebSpeechSupported = () => typeof SR === 'function';

/** Errors after which retrying is pointless, in plain words. */
const FATAL_ERRORS = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site and press the button again.',
  'service-not-allowed': 'This browser’s built-in speech recognition is turned off here.',
  'network': 'This browser’s built-in speech recognition couldn’t connect.',
  'audio-capture': 'No microphone was found.',
  'language-not-supported': 'This browser can’t recognise the selected language.',
};

export class WebSpeechEngine {
  id = 'webspeech';
  label = 'Built-in speech recognition';

  /** @param {{ continuous?: boolean }} opts */
  constructor({ continuous = true } = {}) {
    this.continuous = continuous;
  }

  start({ language, onInterim, onFinal, onStatus, onFatal }) {
    if (!isWebSpeechSupported()) throw new Error('This browser has no built-in speech recognition.');
    Object.assign(this, { language, onInterim, onFinal, onStatus, onFatal });
    this.codeIndex = 0;
    this.running = true;
    this.emptyRestarts = [];   // restarts that produced no speech (loop detection)
    this.pendingInterim = '';  // last partial text not yet confirmed as final

    const rec = (this.rec = new SR());
    rec.continuous = this.continuous;
    rec.interimResults = true;  // show partial guesses while you talk
    rec.maxAlternatives = 1;
    rec.lang = language.speech[0];

    rec.onresult = (e) => {
      this.emptyRestarts = [];
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim();
        if (!text) continue;
        if (e.results[i].isFinal) {
          this.pendingInterim = '';
          this.onFinal(text);
        } else {
          interim += (interim ? ' ' : '') + text;
        }
      }
      this.pendingInterim = interim;
      this.onInterim(interim);
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // harmless; 'end' restarts
      if (e.error === 'language-not-supported' && this.codeIndex + 1 < language.speech.length) {
        rec.lang = language.speech[++this.codeIndex]; // try the next code variant on restart
        return;
      }
      this._fail(FATAL_ERRORS[e.error] || `Speech recognition stopped (${e.error}).`);
    };

    rec.onend = () => {
      // Some browsers (notably iOS Safari) end a session without confirming the
      // last words. Don't lose them: treat the leftover partial text as final.
      if (this.pendingInterim) {
        this.onFinal(this.pendingInterim);
        this.pendingInterim = '';
      }
      this.onInterim('');
      if (!this.running) { this._resolveStop?.(); return; }
      // Sessions end after each phrase (phones) or after silence/~1 min (desktop).
      // Restart quietly — unless it keeps ending without hearing anything.
      const now = Date.now();
      this.emptyRestarts = this.emptyRestarts.filter((t) => now - t < 10_000).concat(now);
      if (this.emptyRestarts.length > 8) return this._fail('Speech recognition keeps stopping unexpectedly.');
      try { rec.start(); } catch (err) { this._fail(err.message); }
    };

    rec.start();
    onStatus('Listening… speak now.');
  }

  _fail(message) {
    if (!this.running) return;
    this.running = false;
    try { this.rec.abort(); } catch { /* already stopped */ }
    this.onFatal?.(new Error(message));
  }

  stop() {
    if (!this.rec) return Promise.resolve();
    const wasRunning = this.running;
    this.running = false;
    return new Promise((resolve) => {
      this._resolveStop = resolve;
      setTimeout(resolve, 2000); // never hang the UI if 'end' doesn't fire
      if (wasRunning) this.rec.stop(); // stop() (not abort) delivers pending final results
      else resolve();
    });
  }
}
