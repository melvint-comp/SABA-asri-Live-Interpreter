/**
 * resample.js — streaming linear resampler (e.g. 48 kHz mic → 16 kHz for Whisper).
 *
 * Why not just `new AudioContext({ sampleRate: 16000 })`? Firefox refuses to
 * connect a microphone stream to a context whose rate differs from the device,
 * so we capture at the native rate and convert ourselves.
 *
 * Analogy: the input is a ruler marked every 1/48000 s; we want readings every
 * 1/16000 s. For each new reading we take the two nearest input marks and draw
 * a straight line between them. The class remembers where it stopped, so chunk
 * boundaries never click or drift.
 */
export class LinearResampler {
  constructor(inputRate, outputRate) {
    if (!(inputRate > 0 && outputRate > 0)) throw new Error('Sample rates must be positive');
    this.step = inputRate / outputRate; // input samples consumed per output sample
    this.pos = 0;   // next read position, relative to the start of the current chunk (may be in [-1, 0))
    this.last = 0;  // final sample of the previous chunk — the value at position -1
  }

  /** @param {Float32Array} input  @returns {Float32Array} */
  process(input) {
    if (this.step === 1) return Float32Array.from(input);
    const out = [];
    // We need input[i] and input[i+1]; if i+1 lies in the next chunk, wait for it.
    while (this.pos < input.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.last : input[i];
      const b = input[i + 1];
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= input.length;
    if (input.length) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}
