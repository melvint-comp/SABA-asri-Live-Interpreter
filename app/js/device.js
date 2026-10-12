/**
 * device.js — small facts about the device the page is running on.
 */

/** True on phones and tablets (incl. iPads, which pretend to be Macs). */
export function isPhoneOrTablet(nav = globalThis.navigator) {
  if (!nav) return false;
  if (typeof nav.userAgentData?.mobile === 'boolean' && nav.userAgentData.mobile) return true;
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && nav.maxTouchPoints > 1; // iPadOS
}

/**
 * Keep the screen awake while recording — on phones the microphone stops when
 * the screen locks. Silently does nothing where unsupported.
 */
export function createWakeLock(nav = globalThis.navigator, doc = globalThis.document) {
  let lock = null;
  let wanted = false;
  const acquire = async () => {
    try { lock = await nav?.wakeLock?.request('screen'); } catch { lock = null; }
  };
  // The browser drops the lock when the tab is hidden; take it back on return.
  doc?.addEventListener?.('visibilitychange', () => {
    if (wanted && doc.visibilityState === 'visible') acquire();
  });
  return {
    async on() { wanted = true; await acquire(); },
    async off() { wanted = false; try { await lock?.release(); } catch { /* already released */ } lock = null; },
  };
}
