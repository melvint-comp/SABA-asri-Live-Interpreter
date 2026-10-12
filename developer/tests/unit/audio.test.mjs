import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearResampler } from '../../../app/js/audio/resample.js';
import { UtteranceSegmenter, rms } from '../../../app/js/audio/segmenter.js';

const SR = 16000;
const tone = (seconds, amp = 0.3, freq = 220, rate = SR) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
const silence = (seconds, rate = SR) => new Float32Array(Math.round(seconds * rate));
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
/** Feed audio in small, irregular chunks like a real microphone would. */
function feed(seg, audio) {
  const out = [];
  for (let i = 0, step = 1000; i < audio.length; i += step, step = step === 1000 ? 1371 : 1000) {
    out.push(...seg.push(audio.subarray(i, i + step)));
  }
  return out;
}

test('rms of a full-scale sine is ~0.707 and of silence is 0', () => {
  assert.ok(Math.abs(rms(tone(0.1, 1)) - Math.SQRT1_2) < 0.01);
  assert.equal(rms(silence(0.1)), 0);
});

test('resampler: 48k → 16k produces one third of the samples, preserves the signal', () => {
  const r = new LinearResampler(48000, 16000);
  const input = tone(1, 0.5, 440, 48000);
  // Process in odd-sized chunks to exercise the cross-chunk state.
  const parts = [];
  for (let i = 0; i < input.length; i += 4097) parts.push(r.process(input.subarray(i, i + 4097)));
  const out = concat(...parts);
  assert.ok(Math.abs(out.length - 16000) <= 1, `got ${out.length}`);
  const expected = tone(1, 0.5, 440, 16000);
  let maxErr = 0;
  for (let i = 0; i < out.length - 1; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - expected[i]));
  assert.ok(maxErr < 0.01, `max error ${maxErr}`);
});

test('resampler: 44.1k → 16k (non-integer ratio) has the right length and no discontinuity', () => {
  const r = new LinearResampler(44100, 16000);
  const input = tone(2, 0.5, 300, 44100);
  const parts = [];
  for (let i = 0; i < input.length; i += 512) parts.push(r.process(input.subarray(i, i + 512)));
  const out = concat(...parts);
  assert.ok(Math.abs(out.length - 32000) <= 1, `got ${out.length}`);
  const expected = tone(2, 0.5, 300, 16000);
  let maxErr = 0;
  for (let i = 0; i < out.length - 1; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - expected[i]));
  assert.ok(maxErr < 0.01, `max error ${maxErr}`);
});

test('resampler: same rate is a passthrough; bad rates throw', () => {
  const x = tone(0.01);
  assert.deepEqual(new LinearResampler(16000, 16000).process(x), x);
  assert.throws(() => new LinearResampler(0, 16000));
});

test('segmenter: two phrases separated by a pause become two utterances', () => {
  const seg = new UtteranceSegmenter();
  const audio = concat(silence(0.5), tone(1.2), silence(1.0), tone(0.8), silence(1.0));
  const out = feed(seg, audio);
  assert.equal(out.length, 2);
  // Each utterance ≈ speech + pre-roll (≤0.3 s) + short tail (≤0.15 s).
  assert.ok(out[0].length / SR > 1.2 && out[0].length / SR < 1.7, `first ${out[0].length / SR}s`);
  assert.ok(out[1].length / SR > 0.8 && out[1].length / SR < 1.3, `second ${out[1].length / SR}s`);
  assert.equal(seg.flush(), null);
});

test('segmenter: a short pause (< maxSilenceMs) does not split a phrase', () => {
  const seg = new UtteranceSegmenter();
  const out = feed(seg, concat(tone(0.6), silence(0.3), tone(0.6), silence(1.0)));
  assert.equal(out.length, 1);
});

test('segmenter: blips shorter than minSpeechMs are discarded', () => {
  const seg = new UtteranceSegmenter();
  const out = feed(seg, concat(silence(0.5), tone(0.1), silence(1.0)));
  assert.equal(out.length, 0);
});

test('segmenter: pure silence and steady background noise produce nothing', () => {
  const seg = new UtteranceSegmenter();
  let s = 1;
  const noise = Float32Array.from({ length: SR * 3 }, () => { s = (s * 16807) % 2147483647; return ((s / 2147483647) - 0.5) * 0.004; });
  assert.equal(feed(seg, concat(silence(1), noise)).length, 0);
  assert.equal(seg.flush(), null);
});

test('segmenter: long monologue is force-cut at maxSegmentMs and keeps going', () => {
  const seg = new UtteranceSegmenter({ maxSegmentMs: 3000 });
  const out = feed(seg, tone(7.5));
  assert.equal(out.length, 2);
  for (const u of out) assert.ok(Math.abs(u.length / SR - 3) < 0.05);
  const rest = seg.flush();
  assert.ok(rest && Math.abs(rest.length / SR - 1.5) < 0.1, 'remaining speech is returned by flush()');
});

test('segmenter: flush() returns speech still in progress when recording stops', () => {
  const seg = new UtteranceSegmenter();
  assert.equal(feed(seg, concat(silence(0.3), tone(1.0))).length, 0);
  assert.ok(seg.isSpeaking);
  const last = seg.flush();
  assert.ok(last && last.length / SR >= 1.0);
  assert.equal(seg.isSpeaking, false);
});
