/* ═══════════════════════════════════════════════════════════════════════
   session-hint.js — one bit in localStorage: "somebody is signed in here".

   Firebase Auth only answers asynchronously, which is a problem for the two
   pages that exist *for* signed-out visitors. Waiting for the real answer
   means the marketing site paints, and a second later yanks itself away —
   the worst version of a redirect. This hint is readable before the first
   pixel, so those pages can leave immediately and let the real check
   confirm it a moment later.

   It is a hint and never an authority: nothing is granted or refused on it.
   The only thing it decides is whether to redirect a page that a signed-in
   person had no business landing on anyway.

   Deliberately free of any Firebase import, so the landing page can read it
   from an inline script without pulling the SDK in first.
   ═══════════════════════════════════════════════════════════════════════ */

export const SESSION_HINT_KEY = 'jag.signedIn';

export const rememberSignedIn = () => {
  try { localStorage.setItem(SESSION_HINT_KEY, '1'); } catch { /* private mode */ }
};

export const forgetSignedIn = () => {
  try { localStorage.removeItem(SESSION_HINT_KEY); } catch { /* private mode */ }
};

export const looksSignedIn = () => {
  try { return localStorage.getItem(SESSION_HINT_KEY) === '1'; } catch { return false; }
};
