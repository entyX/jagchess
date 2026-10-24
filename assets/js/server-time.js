/* ═══════════════════════════════════════════════════════════════════════
   server-time.js — one clock both players agree on.

   A game's clocks are worked out from "when was the last move", and if two
   laptops disagree about what time it is, they disagree about how long a
   player has left — by however far apart their clocks are, which on school
   machines can be several seconds. That is what made clocks drift between
   the two sides of a duel, and what let one side flag the other early.

   So every time used by a game comes from here instead of Date.now(): the
   device's clock, corrected by how far it is from Firestore's. The offset
   is measured once by writing a server timestamp and reading it back, and
   the round trip is split down the middle.
   ═══════════════════════════════════════════════════════════════════════ */

import { db, doc, getDoc, setDoc } from './club-core.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const KEY = 'jag.serverOffset';
let offset = 0;
let measured = null;

try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  if (saved && Date.now() - saved.at < 30 * 60e3) offset = saved.offset;
} catch (_) { /* no storage: start at zero and measure */ }

/** Firestore's idea of now, in ms. */
export const serverNow = () => Date.now() + offset;

/**
 * Measures the offset, once per session (and again if asked). Resolves to
 * the offset in ms; never rejects — a failed probe just leaves the device
 * clock in charge, which is how things worked before.
 */
export function syncServerTime(uid, { force = false } = {}) {
  if (measured && !force) return measured;
  measured = (async () => {
    if (!uid) return offset;
    try {
      const ref = doc(db, 'users', uid);
      const t0 = Date.now();
      await setDoc(ref, { clockProbe: serverTimestamp() }, { merge: true });
      const snap = await getDoc(ref);
      const t1 = Date.now();
      const ts = snap.exists() && snap.data().clockProbe;
      if (ts && typeof ts.toMillis === 'function') {
        // the stamp was taken somewhere inside the round trip; the middle is the best guess
        offset = Math.round(ts.toMillis() - (t0 + t1) / 2);
        try { sessionStorage.setItem(KEY, JSON.stringify({ offset, at: Date.now() })); } catch (_) {}
      }
    } catch (e) {
      console.warn('Could not measure the server clock; using this device\'s', e);
    }
    return offset;
  })();
  return measured;
}
