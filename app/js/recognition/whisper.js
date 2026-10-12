/**
 * whisper.js — speech-to-text with OpenAI's Whisper running *inside the page*.
 *
 * Pros: works in any modern browser (incl. Firefox), audio never leaves the
 *       device, works offline after the first model download.
 * Cons: one-off model download (41–249 MB), and text appears per phrase
 *       (after you pause) rather than word-by-word.
 *
 * Flow: Microphone → UtteranceSegmenter (cuts at pauses) → queue → worker
 *       (Whisper) → onFinal(text)
 */
import { Microphone } from '../audio/microphone.js';
import { UtteranceSegmenter } from '../audio/segmenter.js';
import { callWorker } from '../workers/ml-client.js';
import { SEGMENTER } from '../config.js';

/**
 * Whisper was trained on subtitled video, so on noise it sometimes "hears"
 * subtitle credits. These exact phrases are almost never real speech.
 */
const HALLUCINATIONS = [
  /^thanks? (you )?for watching[.!]*$/i,
  /^please subscribe[.!]*$/i,
  /amara\.org/i,
  /^sous-titr(es|age)/i,
  /^untertitel (im auftrag|der amara|von)/i,
  /^ご視聴ありがとうございました[。!！]*$/,
  /^(字幕|中文字幕)/,
  /^\[(music|musique|musik|音楽|音乐)\]$/i,
  /^[\s.…,!?♪*-]*$/,
];

export function isLikelyHallucination(text) {
  const t = text.trim();
  return HALLUCINATIONS.some((re) => re.test(t));
}

export class WhisperEngine {
  id = 'whisper';
  label = 'On-device speech recognition';

  /** @param {{ modelId: string }} opts */
  constructor({ modelId }) {
    this.modelId = modelId;
  }

  async start({ language, onInterim, onFinal, onStatus, onFatal }) {
    Object.assign(this, { language, onInterim, onFinal, onStatus, onFatal });
    this.queue = Promise.resolve();
    this.inFlight = 0;
    this.stopped = false;
    this.segmenter = new UtteranceSegmenter(SEGMENTER);
    this.mic = new Microphone({
      targetRate: SEGMENTER.sampleRate,
      onAudio: (chunk) => {
        for (const seg of this.segmenter.push(chunk)) this._enqueue(seg);
        this._indicate();
      },
    });

    // Start loading the model now (in parallel with mic permission) so the first
    // phrase doesn't wait on the download.
    const loading = callWorker('load', { model: this.modelId, for: 'transcribe' });
    loading.catch((err) => {
      console.warn('Whisper failed to load:', err);
      this.onFatal?.(new Error('On-device speech recognition couldn’t be downloaded. Check your internet connection and try again.'));
    });

    await this.mic.start();
    if (this.stopped) { await this.mic.stop(); return; } // stop() arrived while the permission prompt was open
    onStatus('Listening… pause briefly after each sentence.');
  }

  _indicate() {
    if (this.segmenter.isSpeaking) {
      this.onInterim('Hearing you…');
    } else if (this.inFlight) {
      this.onInterim('Writing it down…');
    } else {
      this.onInterim('');
    }
  }

  _enqueue(audio) {
    this.inFlight++;
    this._indicate();
    this.queue = this.queue
      .then(() => callWorker('transcribe', { model: this.modelId, audio, language: this.language.whisper }, [audio.buffer]))
      .then((text) => { if (text && !isLikelyHallucination(text)) this.onFinal(text); })
      .catch((err) => { console.warn('Transcription failed:', err); this.onStatus('Couldn’t understand that part — please try again.', 'warn'); })
      .finally(() => { this.inFlight--; this._indicate(); });
  }

  async stop() {
    this.stopped = true;
    if (!this.mic) return;
    await this.mic.stop();
    const last = this.segmenter.flush();
    if (last) this._enqueue(last);
    await this.queue; // deliver everything that was said before Stop
    this.onInterim('');
  }
}
