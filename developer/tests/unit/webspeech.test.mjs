/**
 * Tests the built-in speech engine against a fake SpeechRecognition that
 * behaves like phone browsers do (one phrase per session, sometimes ending
 * without a final result).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeRecognition {
  static instances = [];
  constructor() { this.starts = 0; FakeRecognition.instances.push(this); }
  start() { this.starts++; this.active = true; }
  stop() { this.active = false; queueMicrotask(() => this.onend?.()); }
  abort() { this.active = false; queueMicrotask(() => this.onend?.()); }
  // helpers to simulate the browser
  say(text, isFinal) {
    const results = [Object.assign([{ transcript: text }], { isFinal })];
    this.onresult({ resultIndex: 0, results });
  }
  end() { this.active = false; this.onend(); }
}
globalThis.webkitSpeechRecognition = FakeRecognition;
const { WebSpeechEngine } = await import('../../../app/js/recognition/webspeech.js');
const { getLanguage } = await import('../../../app/js/config.js');

function run(engine, language = getLanguage('en')) {
  const log = { finals: [], interim: [], status: [], fatal: null };
  engine.start({
    language,
    onFinal: (t) => log.finals.push(t),
    onInterim: (t) => log.interim.push(t),
    onStatus: (m) => log.status.push(m),
    onFatal: (e) => { log.fatal = e; },
  });
  return { log, rec: FakeRecognition.instances.at(-1) };
}

test('phone mode: one phrase per session, restarts automatically', () => {
  const engine = new WebSpeechEngine({ continuous: false });
  const { log, rec } = run(engine);
  assert.equal(rec.continuous, false);
  assert.equal(rec.lang, 'en-US');
  rec.say('hello', false);
  rec.say('hello there', true);
  rec.end();
  assert.equal(rec.starts, 2, 'restarted after the phrase');
  rec.say('second phrase', true);
  rec.end();
  assert.deepEqual(log.finals, ['hello there', 'second phrase']);
  assert.equal(log.status[0], 'Listening… speak now.');
});

test('a session that ends with only partial text keeps those words (iOS behaviour)', () => {
  const { log, rec } = run(new WebSpeechEngine({ continuous: false }));
  rec.say('where is the station', false);
  rec.end();
  assert.deepEqual(log.finals, ['where is the station']);
  rec.end();
  assert.deepEqual(log.finals, ['where is the station'], 'not repeated on the next empty session');
});

test('stop() delivers the last words and resolves', async () => {
  const engine = new WebSpeechEngine();
  const { log, rec } = run(engine);
  rec.say('last words', false);
  await engine.stop();
  assert.deepEqual(log.finals, ['last words']);
  assert.equal(rec.active, false);
});

test('unsupported language code falls back to the next variant (Mandarin)', () => {
  const { log, rec } = run(new WebSpeechEngine(), getLanguage('zh'));
  assert.equal(rec.lang, 'cmn-Hans-CN');
  rec.onerror({ error: 'language-not-supported' });
  rec.end();
  assert.equal(rec.lang, 'zh-CN');
  assert.equal(log.fatal, null);
});

test('blocked microphone is reported once, in plain words, with no restart loop', () => {
  const { log, rec } = run(new WebSpeechEngine());
  rec.onerror({ error: 'not-allowed' });
  assert.match(log.fatal.message, /Microphone access was blocked/);
  const starts = rec.starts;
  rec.end();
  assert.equal(rec.starts, starts, 'does not restart after a fatal error');
});

test('endless empty restarts are detected and stopped', () => {
  const { log, rec } = run(new WebSpeechEngine({ continuous: false }));
  for (let i = 0; i < 12 && !log.fatal; i++) rec.end();
  assert.match(log.fatal.message, /keeps stopping/);
});
