/* ═══════════════════════════════════════════════════════════════════════
   hub-shell.js — the chrome every signed-in page outside a club shares:
   /clubs, /play, /tournaments and /leaderboard.

   It also builds the "global-only" ctx those pages hand to the duels and
   tournaments modules — the same shape a club page passes, with clubId left
   null. Every club-scoped branch in those modules keys off that null, so one
   set of code serves both sides of the site.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  auth, db, doc, getDoc, setDoc, requireUser, signOut, initials, esc, CLUB_COLORS
} from './club-core.js';
import { installProfileCards, openAccountSettings } from './profile-card.js';

export const HUB_TABS = [
  {
    id: 'clubs', href: '/clubs', label: 'My clubs',
    icon: '<circle cx="9" cy="8.4" r="3.2"/><path d="M2.6 19.4c0-3.3 2.9-5.6 6.4-5.6s6.4 2.3 6.4 5.6"/><path d="M16.6 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.2 19.4c0-2-.5-3.6-1.5-4.7"/>'
  },
  {
    id: 'play', href: '/play', label: 'Play a match',
    icon: '<path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/>'
  },
  {
    id: 'tournaments', href: '/tournaments', label: 'Tournaments',
    icon: '<path d="M3.2 5.6h5.2v4.2H3.2zM3.2 14.2h5.2v4.2H3.2z"/><path d="M10.8 9.9h4.6v4.2h-4.6z"/><path d="M8.4 7.7h2.4v6.4M8.4 16.3h2.4"/><path d="M15.4 12h5.4"/>'
  },
  {
    id: 'leaderboard', href: '/leaderboard', label: 'Leaderboard',
    icon: '<path d="M7.6 4.2h8.8v4.6a4.4 4.4 0 0 1-8.8 0Z"/><path d="M7.6 5.8H4.9v1a3 3 0 0 0 2.9 3M16.4 5.8h2.7v1a3 3 0 0 1-2.9 3"/><path d="M12 13.2v3.4M8.4 20.2h7.2l-.9-3.6H9.3Z"/>'
  },
  {
    id: 'library', href: '/library', label: 'Puzzle library',
    icon: '<rect x="3" y="3" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="3" width="7.4" height="7.4" rx="2"/><rect x="3" y="13.6" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="13.6" width="7.4" height="7.4" rx="2"/>'
  }
];

export function hubTabsHTML(active) {
  return `<nav class="hub-tabs">${HUB_TABS.map((t) => `
    <a class="hub-tab${t.id === active ? ' on' : ''}" href="${t.href}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
      <span>${esc(t.label)}</span>
    </a>`).join('')}</nav>`;
}

/**
 * Signs the visitor in, makes sure their public profile exists, and hands
 * back a ctx the duels and tournaments modules understand.
 *
 * @param {string} active  which hub tab to light up
 */
export async function bootHub(active) {
  const user = await requireUser();

  const email = (user.email || '').toLowerCase();
  const fallbackName = user.displayName || email.split('@')[0] || 'Player';

  const ref = doc(db, 'users', user.uid);
  let profile = {};
  try {
    const snap = await getDoc(ref);
    profile = (snap.exists() && snap.data()) || {};
  } catch (e) { console.warn('Could not read your profile', e); }

  const username = profile.username || fallbackName;
  const avatarColor = profile.avatarColor ||
    CLUB_COLORS[(username.charCodeAt(0) || 0) % CLUB_COLORS.length];

  /* The global side of a duel needs a name and a color to show; keeping the
     profile current here means every hub page repairs it. */
  try {
    await setDoc(ref, { email, username, avatarColor, lastSeenAt: Date.now() }, { merge: true });
  } catch (e) { console.warn('Could not update your profile', e); }

  paintChrome(user, username, avatarColor, active);

  /* clubId null is the whole signal: every club-scoped branch in the duels
     and tournaments modules folds away when it sees this. */
  const ctx = {
    clubId: null,
    club: { name: 'JagChess', blocks: [] },
    user,
    member: { ...profile, username, avatarColor, uid: user.uid },
    isAdmin: false,
    globalOnly: true,
    page: active,
    cleanup: null
  };

  /* Your name in the corner is the way into your own account, and anybody
     else's name anywhere on the page is the way into theirs. */
  installProfileCards(ctx);
  const me = document.querySelector('.hub-user');
  if (me) {
    me.classList.add('hub-user-btn');
    me.setAttribute('role', 'button');
    me.tabIndex = 0;
    me.title = 'Account settings';
    me.onclick = () => openAccountSettings(ctx);
    me.onkeydown = (e) => { if (e.key === 'Enter') openAccountSettings(ctx); };
  }
  return ctx;
}

function paintChrome(user, username, avatarColor, active) {
  const tabs = document.getElementById('hub-tabs-host');
  if (tabs) tabs.outerHTML = hubTabsHTML(active);

  const nameEl = document.getElementById('hub-name');
  const mailEl = document.getElementById('hub-email');
  const avEl = document.getElementById('hub-avatar');
  if (nameEl) nameEl.textContent = username;
  if (mailEl) mailEl.textContent = user.email || '';
  if (avEl) {
    avEl.textContent = initials(username);
    avEl.style.background = avatarColor;
  }

  const out = document.getElementById('logout');
  if (out) out.onclick = () => signOut(auth).then(() => (location.href = '/login'));
}

/* ── the hash router the global pages share ────────────────────────── */

/**
 * The club shell routes on the hash; so do the hub pages, so that a duel or a
 * tournament reached from either side lives at the same address.
 *
 * @param {(raw: string) => Promise<Function|void>} handler
 */
export function hashRouter(handler) {
  let cleanup = null;
  const run = async () => {
    if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
    const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
    cleanup = (await handler(raw)) || null;
  };
  window.addEventListener('hashchange', run);
  run();
  return () => { if (cleanup) cleanup(); window.removeEventListener('hashchange', run); };
}
