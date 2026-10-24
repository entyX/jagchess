/* ═══════════════════════════════════════════════════════════════════════
   signed-out-only.js — the doorman for the two public pages.

   The marketing site and the JagChess Network are what someone sees BEFORE
   they have an account. Once they have one there is nothing for them there:
   they don't need selling on JagChess, and they don't need to register for a
   club they can simply walk into. Signing in means going to your clubs.

   So both pages send a signed-in visitor straight to the hub. Import this
   module for its side effect; it needs no arguments and returns nothing.

   The redirect uses `replace`, not `href`: a page you were never meant to be
   on should not be sitting in your history waiting for the back button.
   ═══════════════════════════════════════════════════════════════════════ */

import { auth, onAuthStateChanged } from './club-core.js';
import { rememberSignedIn, forgetSignedIn } from './session-hint.js';

const HOME = '/clubs';

onAuthStateChanged(auth, (user) => {
  if (user) {
    rememberSignedIn();
    location.replace(HOME);
    return;
  }
  /* No session after all. If the fast-path hint in the page head said
     otherwise it was stale — clear it, so the next visit does not bounce
     through the hub on the way to a page it could have shown at once. */
  forgetSignedIn();
});
