/**
 * chrome-builtin.js — Chrome's built-in, on-device Translator API.
 *
 * Available in desktop Chrome 138+ (and recent Edge). Free, private (runs on
 * your machine) and fast. The first use of a language pair downloads a small
 * model, which the browser only allows right after a click — so the app calls
 * `prepare()` inside the Record button's click handler. Once a pair's model is
 * installed, it works with no internet at all.
 */
const pairs = new Map(); // 'src|tgt' → Promise<Translator>

export const isChromeTranslatorSupported = () => typeof globalThis.Translator?.create === 'function';

function getTranslator(src, tgt, onStatus) {
  const key = `${src}|${tgt}`;
  if (!pairs.has(key)) {
    const p = (async () => {
      const availability = await globalThis.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
      if (availability === 'unavailable') {
        throw Object.assign(new Error(`pair ${src}→${tgt} not supported`), { permanent: true });
      }
      if (availability !== 'available' && globalThis.navigator?.onLine === false) {
        throw new Error('needs a one-time download, and there is no internet'); // retried when back online
      }
      return globalThis.Translator.create({
        sourceLanguage: src,
        targetLanguage: tgt,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) =>
            onStatus?.(`Getting the translator ready — one-time download: ${Math.round(e.loaded * 100)}%`));
        },
      });
    })();
    p.catch(() => pairs.delete(key)); // allow a retry (e.g. after the next click)
    pairs.set(key, p);
  }
  return pairs.get(key);
}

export const chromeTranslator = {
  id: 'chrome',
  label: 'Chrome’s built-in translator',
  isSupported: isChromeTranslatorSupported,
  /** 'ready' if the language pair is installed in Chrome (works offline). */
  async availability(src, tgt) {
    const a = await globalThis.Translator.availability({ sourceLanguage: src.translator, targetLanguage: tgt.translator });
    if (a === 'available') return 'ready';
    if (a === 'downloadable' || a === 'downloading') return 'needs-network';
    return 'unavailable';
  },
  /** Call synchronously from a click handler so a model download is permitted. */
  prepare(src, tgt, onStatus) {
    getTranslator(src.translator, tgt.translator, onStatus).catch(() => {});
  },
  async translate(text, src, tgt, onStatus) {
    const translator = await getTranslator(src.translator, tgt.translator, onStatus);
    return (await translator.translate(text)).trim();
  },
};
