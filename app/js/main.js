/**
 * main.js — page entry point. Builds the controls, implements the "view" the
 * Interpreter reports to, and wires up the buttons. Only page/DOM code lives here.
 */
import { LANGUAGES, DEFAULT_SETTINGS, getLanguage } from './config.js';
import { loadSettings, saveSettings } from './settings.js';
import { Interpreter } from './interpreter.js';
import { TranslationRouter } from './translation/index.js';
import { isWebSpeechSupported } from './recognition/index.js';
import { onModelProgress, describeProgress } from './workers/ml-client.js';
import { isPhoneOrTablet, createWakeLock } from './device.js';
import { offlinePacks } from './offline/packs.js';

// Reaching this line means every module loaded: tell index.html's self-repair check.
document.documentElement.dataset.started = 'true';
try { sessionStorage.removeItem('live-interpreter:repaired'); } catch { /* storage blocked */ }

const $ = (id) => document.getElementById(id);
const el = {
  source: $('source'), target: $('target'), swap: $('swap'),
  record: $('record'), recordText: $('record-text'), recordLabel: $('record-label'),
  status: $('status'), live: $('live'), phrases: $('phrases'), empty: $('empty'),
  toolbar: $('toolbar'), copy: $('copy'), clear: $('clear'),
  offline: $('offline'), offlineText: $('offline-text'), download: $('download'), bar: $('download-bar'),
};
const lockedWhileRecording = [el.source, el.target, el.swap];

const phone = isPhoneOrTablet();
const tapWord = phone ? 'Tap' : 'Click';
const wakeLock = createWakeLock();

// ---------- build the controls ----------
const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
for (const l of LANGUAGES) {
  const text = l.native === l.name ? l.name : `${l.name} · ${l.native}`;
  el.source.append(option(l.id, text));
  el.target.append(option(l.id, text));
}

// Everything except the two languages is chosen automatically. (Advanced users
// can still override engines with URL parameters — see developer/README.md.)
// Phones get the smallest on-device model by default (less data, less memory).
const settings = loadSettings({ defaults: phone ? { ...DEFAULT_SETTINGS, whisperModel: 'tiny' } : DEFAULT_SETTINGS });
el.source.value = settings.source;
el.target.value = settings.target;
const readSettings = () => ({ ...settings, source: el.source.value, target: el.target.value });
for (const c of lockedWhileRecording) c.addEventListener('change', () => saveSettings(readSettings()));

// ---------- the view the Interpreter talks to ----------
const view = {
  setStatus(msg, kind = '') {
    el.status.textContent = msg;
    el.status.className = `status ${kind}`.trim();
  },
  setLive(text) {
    el.live.textContent = text;
    el.live.hidden = !text;
  },
  setRecording(on) {
    el.record.setAttribute('aria-pressed', String(on));
    el.recordText.textContent = on ? 'Stop listening' : 'Start listening';
    el.recordLabel.textContent = `${tapWord} to ${on ? 'stop' : 'start'}`;
    for (const c of lockedWhileRecording) c.disabled = on; // languages are fixed while listening
    el.download.disabled = on || downloading;
    on ? wakeLock.on() : wakeLock.off();
  },
  addPhrase(text) {
    const li = document.createElement('li');
    li.className = 'phrase';
    const original = Object.assign(document.createElement('p'), { className: 'original', textContent: text, lang: el.source.value });
    const translated = Object.assign(document.createElement('p'), { className: 'translated pending', textContent: 'Translating…' });
    translated.lang = el.target.value; // right font for Japanese vs Chinese, etc.
    li.append(original, translated);
    el.phrases.prepend(li); // newest first: no scrolling needed on phones
    el.empty.hidden = true;
    el.toolbar.hidden = false;
    return { li, original, translated };
  },
  setTranslation({ original, translated }, text, { passthrough = false, failed = false } = {}) {
    translated.classList.remove('pending');
    if (failed) {
      translated.classList.add('failed');
      translated.textContent = 'Couldn’t translate this one.';
      return;
    }
    translated.textContent = text;
    if (passthrough) { original.hidden = true; translated.lang = original.lang; } // same language: just show the words
  },
};

const router = new TranslationRouter({ onStatus: (m) => view.setStatus(m) });
const isOnline = () => navigator.onLine !== false;
// Read fresh at every start: downloads and the connection change over time.
const deviceContext = () => ({ phone, online: isOnline(), speechOnDevice: offlinePacks.isSpeechReady(settings.whisperModel) });
const interpreter = new Interpreter({ view, router, device: deviceContext });
onModelProgress((p) => {
  if (!interpreter.isRunning) return;
  const msg = describeProgress(p);
  if (msg) view.setStatus(msg);
});

// ---------- buttons ----------
el.record.addEventListener('click', async () => {
  el.record.disabled = true; // ignore double taps while starting/stopping
  try {
    if (interpreter.isRunning) await interpreter.stop();
    else await interpreter.start(readSettings());
  } finally {
    el.record.disabled = false;
  }
});

el.swap.addEventListener('click', () => {
  [el.source.value, el.target.value] = [el.target.value, el.source.value];
  saveSettings(readSettings());
});

// ---------- offline use ----------
// One button downloads everything a language pair needs (speech + translation,
// both directions). After that, the pair works with no internet at all.
let downloading = false;
let offlineCheck = 0; // ignore results from an older check

function pairName() {
  const a = getLanguage(el.source.value).name;
  const b = getLanguage(el.target.value).name;
  return a === b ? a : `${a} ↔ ${b}`;
}

function showOffline(state, text, button = '') {
  el.offline.dataset.state = state;
  el.offlineText.textContent = text;
  el.download.hidden = !button;
  el.download.textContent = button;
  el.download.disabled = downloading || interpreter.isRunning;
}

async function updateOffline() {
  router.invalidate(); // downloads or the connection may have changed what's usable
  if (downloading) return;
  const check = ++offlineCheck;
  const { ready, missingMb } = await offlinePacks.status(el.source.value, el.target.value, settings.whisperModel);
  if (check !== offlineCheck || downloading) return;
  if (ready) {
    showOffline('ready', `✓ ${pairName()} works without internet on this device.`);
  } else if (isOnline()) {
    showOffline('missing', `Slow or no internet? Download once and ${pairName()} keeps working without it.`, `Download for offline use · ${missingMb} MB`);
  } else {
    showOffline('offline', `You’re offline, and ${pairName()} isn’t downloaded on this device yet. Connect once to download it.`);
  }
}

function setBar(fraction) {
  const pct = Math.round(fraction * 100);
  el.bar.hidden = false;
  el.bar.firstElementChild.style.width = `${pct}%`;
  el.bar.setAttribute('aria-valuenow', String(pct));
  return pct;
}

el.download.addEventListener('click', async () => {
  downloading = true;
  for (const c of lockedWhileRecording) c.disabled = true; // keep the pair fixed while it downloads
  showOffline('downloading', `Downloading… 0% — keep this page open.`);
  setBar(0);
  try {
    await offlinePacks.download(el.source.value, el.target.value, settings.whisperModel, {
      onProgress: (f) => { el.offlineText.textContent = `Downloading… ${setBar(f)}% — keep this page open.`; },
    });
    downloading = false;
    el.bar.hidden = true;
    await updateOffline();
  } catch (err) {
    console.warn('Offline download failed:', err);
    downloading = false;
    el.bar.hidden = true;
    const { missingMb } = await offlinePacks.status(el.source.value, el.target.value, settings.whisperModel);
    showOffline('missing', 'The download stopped — the connection may have dropped. Parts already downloaded are kept.', `Continue download · ${missingMb} MB`);
  } finally {
    downloading = false;
    if (!interpreter.isRunning) for (const c of lockedWhileRecording) c.disabled = false;
  }
});

for (const c of [el.source, el.target]) c.addEventListener('change', updateOffline);
el.swap.addEventListener('click', updateOffline);
window.addEventListener('online', updateOffline);
window.addEventListener('offline', updateOffline);
updateOffline();

// The service worker is registered by index.html, so it works even if this script can't start.

el.clear.addEventListener('click', () => {
  el.phrases.replaceChildren();
  el.empty.hidden = false;
  el.toolbar.hidden = true;
});

el.copy.addEventListener('click', async () => {
  // Oldest first, as a readable transcript.
  const text = [...el.phrases.children].reverse().map((li) =>
    [...li.querySelectorAll('p')].filter((p) => !p.hidden).map((p) => p.textContent).join('\n'),
  ).join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    view.setStatus('Copied!');
  } catch {
    view.setStatus('Copying isn’t allowed here — press and hold the text to copy it instead.', 'warn');
  }
});

el.recordLabel.textContent = `${tapWord} to start`;

const canListen = isWebSpeechSupported() || !!navigator.mediaDevices?.getUserMedia;
if (!window.isSecureContext) {
  view.setStatus('The microphone only works on secure web pages. Please open https://melvint-comp.github.io/SABA-asri-Live-Interpreter/', 'error');
} else if (!canListen) {
  view.setStatus('This browser can’t use the microphone. Please try Chrome, Safari, Edge or Firefox.', 'error');
}
