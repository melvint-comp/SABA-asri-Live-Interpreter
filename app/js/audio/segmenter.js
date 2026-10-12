/**
 * segmenter.js — cuts a continuous 16 kHz audio stream into utterances.
 *
 * Whisper is not a streaming model: it wants a finished clip. To make it feel
 * "live" we listen like a stenographer — wait for someone to start talking,
 * keep writing while they talk, and hand over the page when they pause.
 *
 * How "talking" is detected (a simple energy VAD):
 *   - Split audio into 30 ms frames and measure each frame's loudness (RMS).
 *   - Keep a running estimate of the room's background noise level.
 *   - A frame is speech if it's louder than both an absolute floor and
 *     `noiseRatio` × the background level.
 *   - An utterance ends after `maxSilenceMs` of non-speech, or is force-cut at
 *     `maxSegmentMs` so long monologues still stream out.
 *
 * Pure logic, no browser APIs — fully unit-testable in Node.
 */
export class UtteranceSegmenter {
  constructor(opts = {}) {
    const o = {
      sampleRate: 16000, frameMs: 30, minThreshold: 0.008, noiseRatio: 3,
      minSpeechMs: 300, maxSilenceMs: 700, maxSegmentMs: 15000, preRollMs: 300,
      ...opts,
    };
    this.opts = o;
    this.frameSize = Math.round((o.sampleRate * o.frameMs) / 1000);
    this.maxSilenceFrames = Math.ceil(o.maxSilenceMs / o.frameMs);
    this.minSpeechFrames = Math.ceil(o.minSpeechMs / o.frameMs);
    this.maxSegmentFrames = Math.floor(o.maxSegmentMs / o.frameMs);
    this.preRollFrames = Math.ceil(o.preRollMs / o.frameMs);

    this.noiseFloor = o.minThreshold / o.noiseRatio; // starts so that threshold == minThreshold
    this.pending = new Float32Array(0); // samples not yet forming a full frame
    this.preRoll = [];                  // recent non-speech frames (ring buffer)
    this.reset();
  }

  reset() {
    this.active = false;  // inside an utterance?
    this.frames = [];     // frames of the current utterance
    this.speechFrames = 0;
    this.silenceRun = 0;
  }

  /** True while an utterance is being collected (useful for a UI indicator). */
  get isSpeaking() { return this.active; }

  /** Seconds of audio in the utterance being collected. */
  get currentSeconds() { return (this.frames.length * this.frameSize) / this.opts.sampleRate; }

  /** Current speech threshold (RMS). */
  get threshold() { return Math.max(this.opts.minThreshold, this.noiseFloor * this.opts.noiseRatio); }

  /**
   * Feed audio. Returns any utterances that completed during this chunk.
   * @param {Float32Array} samples
   * @returns {Float32Array[]}
   */
  push(samples) {
    const done = [];
    const buf = new Float32Array(this.pending.length + samples.length);
    buf.set(this.pending);
    buf.set(samples, this.pending.length);

    let offset = 0;
    for (; offset + this.frameSize <= buf.length; offset += this.frameSize) {
      const seg = this._onFrame(buf.slice(offset, offset + this.frameSize));
      if (seg) done.push(seg);
    }
    this.pending = buf.slice(offset);
    return done;
  }

  /** End of stream: return the utterance in progress (if it holds real speech). */
  flush() {
    if (this.pending.length && this.active) this.frames.push(this.pending);
    this.pending = new Float32Array(0);
    const seg = this.active && this.speechFrames >= this.minSpeechFrames ? this._concat(this.frames) : null;
    this.reset();
    this.preRoll = [];
    return seg;
  }

  _onFrame(frame) {
    const level = rms(frame);
    const isSpeech = level > this.threshold;

    if (!this.active) {
      if (isSpeech) {
        this.active = true;
        this.frames = [...this.preRoll, frame];
        this.preRoll = [];
        this.speechFrames = 1;
        this.silenceRun = 0;
      } else {
        // Learn the background level slowly (exponential moving average).
        this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * level;
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      }
      return null;
    }

    this.frames.push(frame);
    if (isSpeech) { this.speechFrames++; this.silenceRun = 0; } else { this.silenceRun++; }

    if (this.silenceRun >= this.maxSilenceFrames) {
      // Utterance over. Trim most of the trailing silence; keep a short tail.
      const keep = this.frames.length - this.silenceRun + Math.min(this.silenceRun, 5);
      const seg = this.speechFrames >= this.minSpeechFrames ? this._concat(this.frames.slice(0, keep)) : null;
      this.reset();
      return seg;
    }
    if (this.frames.length >= this.maxSegmentFrames) {
      // Force a cut but stay "active": the speaker is still talking.
      const seg = this._concat(this.frames);
      this.frames = [];
      this.speechFrames = 0;
      this.silenceRun = 0;
      return seg;
    }
    return null;
  }

  _concat(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }
}

/** Root-mean-square loudness of a frame (0 = silence, ~0.7 = full-scale sine). */
export function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}
