/**
 * recognition/index.js — picks a speech-to-text engine.
 *
 * 'auto' is offline-first:
 *   - if the on-device model (Whisper) is downloaded, use it — no internet needed,
 *     so a slow or missing connection can't interrupt anything;
 *   - otherwise, if the browser has built-in recognition and we're online, use
 *     that (words appear as you speak, but the browser sends audio to its maker);
 *   - otherwise fall back to Whisper (which downloads once, if online).
 * The controller also switches to Whisper if the built-in one fails at runtime.
 */
import { WebSpeechEngine, isWebSpeechSupported } from './webspeech.js';
import { WhisperEngine } from './whisper.js';
import { WHISPER_MODELS } from '../config.js';

/**
 * @param {'auto'|'webspeech'|'whisper'} choice
 * @param {string} whisperModelKey  key of WHISPER_MODELS
 * @param {{ phone?: boolean, speechOnDevice?: boolean, online?: boolean, builtIn?: boolean }} context
 *   phone: phones use phrase-by-phrase built-in recognition
 *   speechOnDevice: the Whisper model is already downloaded
 *   online: the device currently reports a network connection
 *   builtIn: the browser has built-in recognition (detected automatically)
 */
export function createRecognitionEngine(choice, whisperModelKey, {
  phone = false, speechOnDevice = false, online = true, builtIn: hasBuiltIn = isWebSpeechSupported(),
} = {}) {
  const whisper = () => new WhisperEngine({ modelId: (WHISPER_MODELS[whisperModelKey] || WHISPER_MODELS.base).id });
  const builtIn = () => new WebSpeechEngine({ continuous: !phone });
  if (choice === 'whisper') return whisper();
  if (choice === 'webspeech') return builtIn();
  if (speechOnDevice) return whisper();
  return hasBuiltIn && online ? builtIn() : whisper();
}

export { isWebSpeechSupported };
