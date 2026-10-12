/**
 * microphone.js — captures mic audio as 16 kHz mono Float32 chunks.
 *
 * Pipeline: getUserMedia → MediaStreamSource → AudioWorklet (capture-processor)
 *           → main thread → LinearResampler → onAudio(chunk)
 */
import { LinearResampler } from './resample.js';

export class Microphone {
  /** @param {{ targetRate?: number, onAudio: (chunk: Float32Array) => void }} opts */
  constructor({ targetRate = 16000, onAudio }) {
    this.targetRate = targetRate;
    this.onAudio = onAudio;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser can’t use the microphone on this page. Open the site’s https:// link instead.');
    }
    // Create the AudioContext *before* the first await: phones (iOS especially)
    // only allow audio to start during the tap that triggered it.
    this.ctx = new AudioContext();
    this.ctx.resume().catch(() => {});
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      await this.ctx.close();
      this.ctx = null;
      throw err;
    }
    await this.ctx.audioWorklet.addModule(new URL('./capture-processor.js', import.meta.url));
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const resampler = new LinearResampler(this.ctx.sampleRate, this.targetRate);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor');
    this.node.port.onmessage = (e) => this.onAudio(resampler.process(e.data));

    // A muted sink keeps the graph "pulled" in every browser without making sound.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  async stop() {
    if (!this.node) return; // not (fully) started — start() cleans up after itself
    this.node.port.postMessage('flush');             // ask for the last partial batch…
    await new Promise((r) => setTimeout(r, 60));     // …and give it a moment to arrive
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
    this.ctx = null;
    this.node = null;
  }
}
