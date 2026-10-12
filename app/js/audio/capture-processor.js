/**
 * capture-processor.js — AudioWorklet that forwards raw microphone samples.
 *
 * Runs on the browser's real-time audio thread. It receives 128-sample blocks,
 * batches them (~85 ms at 48 kHz) to keep message traffic low, and posts copies
 * to the main thread. It never modifies or outputs audio.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(4096);
    this.filled = 0;
    this.port.onmessage = (e) => { if (e.data === 'flush') this.flush(); };
  }

  flush() {
    if (this.filled) this.port.postMessage(this.batch.slice(0, this.filled));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const n = Math.min(channel.length - i, this.batch.length - this.filled);
        this.batch.set(channel.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === this.batch.length) this.flush();
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
