/**
 * mymemory.js — MyMemory (translated.net) free translation REST API.
 *
 * Works in every browser and needs no key. Limits: 500 bytes per request and
 * roughly 5,000 characters/day per IP (≈50,000 with a contact e-mail set in
 * config.js). Quality is variable: MyMemory is a *translation memory*, so for
 * very common short phrases it sometimes returns a poor crowd-sourced match.
 */
import { MYMEMORY, ONLINE_TIMEOUT_MS } from '../config.js';

const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/**
 * Split text into pieces of at most `maxBytes` UTF-8 bytes, preferring sentence
 * boundaries, then word boundaries, then (for CJK or giant words) characters.
 */
export function splitByBytes(text, maxBytes) {
  const pieces = [];
  let current = '';
  const pushUnit = (unit) => {
    if (utf8Bytes(current + unit) <= maxBytes) { current += unit; return; }
    if (current) { pieces.push(current); current = ''; }
    if (utf8Bytes(unit) <= maxBytes) { current = unit; return; }
    // A single unit is still too big: fall back to words, then characters.
    const finer = /\s/.test(unit.trim()) ? unit.split(/(?<=\s)/) : Array.from(unit);
    for (const f of finer) pushUnit(f);
  };
  // Sentence-ish units, keeping their punctuation and trailing spaces (handles 。！？ too).
  for (const unit of text.match(/[^.!?。！？]*[.!?。！？]+\s*|[^.!?。！？]+/g) || []) pushUnit(unit);
  if (current) pieces.push(current);
  return pieces.map((p) => p.trim()).filter(Boolean);
}

/** MyMemory sometimes returns HTML entities (e.g. &#39;). */
export function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export function buildMyMemoryUrl(text, srcCode, tgtCode, email = MYMEMORY.email) {
  const params = new URLSearchParams({ q: text, langpair: `${srcCode}|${tgtCode}` });
  if (email) params.set('de', email);
  return `${MYMEMORY.endpoint}?${params}`;
}

/** Parse a MyMemory JSON response; throws a helpful error on any failure. */
export function parseMyMemoryResponse(json) {
  const status = Number(json?.responseStatus);
  const text = json?.responseData?.translatedText ?? '';
  if (json?.quotaFinished || status === 429 || /MYMEMORY WARNING/i.test(text)) {
    throw Object.assign(new Error('daily free quota used up (try again tomorrow, or set an e-mail in config.js)'), { permanent: true });
  }
  if (status !== 200) throw new Error(json?.responseDetails || `HTTP-like status ${json?.responseStatus}`);
  if (!text) throw new Error('empty translation');
  return decodeEntities(text).trim();
}

export const myMemoryTranslator = {
  id: 'mymemory',
  label: 'MyMemory online translator',
  isSupported: () => typeof fetch === 'function',
  availability: () => 'needs-network',
  async translate(text, src, tgt, _onStatus, { fetchFn = globalThis.fetch } = {}) {
    const out = [];
    for (const piece of splitByBytes(text, MYMEMORY.maxQueryBytes)) {
      // Give up quickly on a bad connection rather than leaving the person waiting.
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ONLINE_TIMEOUT_MS) : undefined;
      let res;
      try {
        res = await fetchFn(buildMyMemoryUrl(piece, src.mymemory, tgt.mymemory), { signal });
      } catch (err) {
        throw new Error(err?.name === 'TimeoutError' ? 'the online translator took too long (slow connection)' : `network error (${err?.message || err})`);
      }
      if (!res.ok) throw new Error(`network error ${res.status}`);
      out.push(parseMyMemoryResponse(await res.json()));
    }
    const joiner = ['zh', 'ja'].includes(tgt.id) ? '' : ' ';
    return out.join(joiner);
  },
};
