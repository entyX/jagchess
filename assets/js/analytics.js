/* ═══════════════════════════════════════════════════════════════════════
   analytics.js — Google Analytics for JagChess.

   Analytics is the one Firebase product that does nothing until the page
   asks for it. Firestore, Auth and Hosting all work without it ever being
   touched, which is why the console can show real traffic and an empty
   Analytics card at the same time: the project was linked to a GA4
   property, but no page had ever loaded the SDK.

   Loading this file is the whole fix. Once it runs, gtag collects
   page_view, session_start, first_visit and user_engagement on its own —
   the events every dashboard card is built from. Everything below that is
   for the events gtag cannot guess at.

   Every page gets this as `<script type="module">`, straight after
   firebase-config.js.

   Firing your own event, from anywhere:

       window.jagTrack?.('tournament_created', { format: 'arena' });

   Always through the global, never `import { track } from './analytics.js'`.
   Some blocklists drop firebase-analytics.js by name, and a static import
   of a script that 404s takes the importing module down with it — which
   would mean an ad blocker could break signing in. Reached through the
   global, analytics that fails to load is analytics that is simply absent,
   and the optional call does nothing.
   ═══════════════════════════════════════════════════════════════════════ */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  initializeAnalytics, isSupported, logEvent, setUserId
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-analytics.js';

const cfg = window.FIREBASE_CONFIG;

let analytics = null;

/* Bringing up the SDK takes a moment, and the events worth having — the
   sign-up, the click that came straight off the landing page — are the
   ones most likely to happen inside it. They wait here instead. */
const pending = [];

/* ── debug mode ────────────────────────────────────────────────────────
   Collection is never conditional: an ordinary visit to the live site is
   counted with none of this involved. All debug mode decides is whether a
   session is *also* mirrored into DebugView, which is the only place you
   can watch events arrive in real time — the dashboard cards are daily
   aggregates and lag about a day behind.

   Add ?ga_debug=1 to any URL and the tab opts in until it closes, so you
   can click through the site and watch the events land. ?ga_debug=0 turns
   it off again.

   Worth knowing: debug_mode changes visibility, not collection. A flagged
   session is still filed as ordinary traffic in the reports. That is why
   localhost is skipped outright in start() rather than merely flagged —
   dropping the events is the only thing that actually keeps a development
   session out of the real numbers.
   ──────────────────────────────────────────────────────────────────── */

const DEBUG_KEY = 'jag-ga-debug';
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function debugMode() {
  try {
    const asked = new URLSearchParams(location.search).get('ga_debug');
    if (asked !== null) {
      if (asked === '0') sessionStorage.removeItem(DEBUG_KEY);
      else sessionStorage.setItem(DEBUG_KEY, '1');
    }
    return sessionStorage.getItem(DEBUG_KEY) === '1';
  } catch (_) { return false; } // private mode: no opt-in available
}

const debug = debugMode();
const say = (...args) => { if (debug || LOCAL) console.info('[analytics]', ...args); };

/* ── public API ────────────────────────────────────────────────────────
   Defined before the first await, so a handler that fires the instant the
   page is interactive still finds them. */

export function track(name, params = {}) {
  if (!analytics) { pending.push(['event', name, params]); return; }
  try {
    logEvent(analytics, name, params);
    say('event', name, params);
  } catch (e) { say('dropped', name, e); }
}

/* Ties a session to the signed-in account, so Analytics can tell a person
   returning tomorrow from a new visitor — which is the whole basis of the
   retention reports. Pass null on sign-out. */
export function identify(uid) {
  if (analytics) {
    try { setUserId(analytics, uid || null); } catch (e) { say('identify failed', e); }
  } else {
    pending.push(['identify', uid]);
  }
}

window.jagTrack = track;
window.jagIdentify = identify;

/* ── startup ──────────────────────────────────────────────────────── */

async function start() {
  if (window.__jagAnalyticsStarted) return;
  window.__jagAnalyticsStarted = true;

  if (!cfg || !cfg.measurementId) {
    say('no measurementId in FIREBASE_CONFIG — nothing to report to');
    return;
  }

  /* Development opts in deliberately or not at all — see above. */
  if (LOCAL && !debug) {
    say('skipped on localhost — add ?ga_debug=1 to send events to DebugView');
    return;
  }

  /* False where the browser cannot support gtag at all: cookies turned
     off, or an embedded webview. Not the same as being blocked. */
  let ok = false;
  try { ok = await isSupported(); } catch (_) {}
  if (!ok) { say('not supported in this browser'); return; }

  try {
    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    analytics = initializeAnalytics(app, { config: { debug_mode: debug } });
  } catch (e) {
    say('failed to start', e);
    return;
  }

  say('ready as', cfg.measurementId, debug ? '(DebugView on)' : '');

  for (const [kind, a, b] of pending.splice(0)) {
    if (kind === 'event') track(a, b);
    else identify(a);
  }

  if (debug) warnIfBlocked();
}

/* Ad blockers, Brave shields, Safari's tracking prevention and most
   pi-holes drop googletagmanager.com outright, and they do it silently —
   the SDK starts up perfectly and the events simply never leave. If the
   tag script had run it would have left google_tag_manager behind, so its
   absence a few seconds in is the tell.

   Only checked in debug mode: on a real visit a blocked tag is just a
   visitor we do not get to count, and there is nobody to tell. */
function warnIfBlocked() {
  setTimeout(() => {
    if (window.google_tag_manager) { say('gtag.js loaded — events are leaving the browser'); return; }
    console.warn(
      '[analytics] gtag.js never loaded. Something is blocking ' +
      'googletagmanager.com — usually an ad blocker, Brave shields or ' +
      'Safari tracking prevention. Events are being collected and thrown ' +
      'away. Retry in a private window with extensions disabled.'
    );
  }, 4000);
}

start();
