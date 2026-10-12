/**
 * on-device.js — translation that runs entirely on the phone or computer.
 *
 * No internet needed once the models are downloaded (see offline/packs.js).
 * Uses small Opus-MT models with English as the hub, and M2M100 for
 * translating into Japanese (see translationPlan() in config.js).
 */
import { translationPlan } from '../config.js';
import { callWorker } from '../workers/ml-client.js';

/**
 * @param {{ call?: Function, isReady?: (src: string, tgt: string) => boolean }} deps
 *   isReady: are all models for this direction already stored on the device?
 */
export function createOnDeviceTranslator({ call = callWorker, isReady = () => false } = {}) {
  return {
    id: 'on-device',
    label: 'On-device translation',
    isSupported: () => typeof Worker === 'function',
    /**
     * 'ready' when downloaded. Otherwise only usable if the person picked this
     * engine on purpose — we never start a 100+ MB download in the middle of a
     * conversation without being asked.
     */
    availability(src, tgt, { explicit = false } = {}) {
      if (isReady(src.id, tgt.id)) return 'ready';
      return explicit ? 'needs-network' : 'unavailable';
    },
    /** Load the models into memory at the moment Record is pressed, so the first sentence is quick. */
    prepare(src, tgt) {
      if (!isReady(src.id, tgt.id)) return;
      for (const step of translationPlan(src.id, tgt.id)) {
        call('load', { model: step.model, for: 'translate' }).catch(() => {});
      }
    },
    async translate(text, src, tgt) {
      let out = text;
      for (const step of translationPlan(src.id, tgt.id)) {
        out = await call('translate', { ...step, text: out });
        if (!out) throw new Error('empty result');
      }
      return out;
    },
  };
}
