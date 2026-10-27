/* ═══════════════════════════════════════════════════════════════════════
   club.js — the club shell: membership gate, sidebar, routing,
   editor mode, block management.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  auth, db, requireUser, currentUser, signOut, joinClub, syncPublicClub, syncMemberEmails,
  doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, clubCol,
  clubRef, memberRef, initials, esc, toast, confirmDialog, promptDialog, ROLE_LABEL,
  clubAvatar, myClubs, openMenu, query, limit
} from './club-core.js';
import { toggleTheme, currentTheme } from './theme.js';

import { BLOCK_TYPES, renderBlock } from './club-blocks.js';
import { renderDashboard } from './club-dash.js';
import {
  openDuelStage, closeDuelStage, closeDuelWaiting,
  watchChallenges, watchActiveDuels, gameOf, duelsHash
} from './club-duels.js';
import { openClubShare, canShareClub } from './club-share.js';
import { enableReorder } from './nav-reorder.js';
import { maybePromptAttendance, openGuestAttendance } from './club-attendance.js';
import { installProfileCards, openAccountSettings } from './profile-card.js';

const $ = (id) => document.getElementById(id);

/* ── being staff, and being treated as staff ───────────────────────────
   These used to be the same thing, and there was no way for an admin to
   see their own club the way their members see it — which is how a club
   ships a dashboard nobody but its admins can make sense of.

   So they are separated. `isStaff` is what your membership row says, and it
   never changes while you are on the page. `isAdmin` is whether you are
   being treated as staff *right now*, and student view turns it off — for
   every module at once, without any of them having to know the mode exists.
   Everything follows from that one switch: the admin pages vanish from the
   sidebar and stop being reachable by hash, every block draws its member
   side, and attendance, points and puzzles all work exactly as they do for
   a student, because as far as the code can tell you are one.
   ─────────────────────────────────────────────────────────────────── */

export const ctx = {
  clubId: null,
  club: null,
  user: null,
  member: null,
  isStaff: false,
  mode: 'admin',      // 'admin' | 'member' (staff only)
  /* Arranging the home page is something an admin chooses to do, not the
     state the page is always in — otherwise an admin never once sees the
     page their members see. */
  editing: false,
  page: 'dashboard',
  cleanup: null,
  get isAdmin() { return this.isStaff && this.mode !== 'member'; }
};

/* the duel you are currently in, if any — drives the header's resume chip */
let myGame = null;

/* ═══ boot ═══════════════════════════════════════════════════════════ */

(async function init() {
  const slug = decodeURIComponent(location.pathname.replace(/^\/clubs\/?/, '').replace(/\/$/, ''));
  if (!slug) { location.replace('/clubs'); return; }
  ctx.clubId = slug;

  const params = new URLSearchParams(location.search);

  /* The one thing on this page that does not need an account.
     A QR code taped to a table is scanned by whoever is in the room, and
     bouncing them to a login screen is how a club ends up with half a
     register. So the session is asked about rather than demanded: no
     session and a scanned check-in means the check-in opens, right here,
     over an empty page, and nothing else on the club is touched. */
  const scanned = params.get('att');
  const who = await currentUser();
  if (!who) {
    if (scanned && await openGuestAttendance(slug, scanned)) {
      $('club-boot').hidden = true;
      document.body.classList.add('att-guest');
      return;
    }
    return requireUser();          // no check-in to offer: the usual bounce
  }
  ctx.user = who;

  const snap = await getDoc(clubRef(slug));
  if (!snap.exists()) return showGate({ missing: true });
  ctx.club = { id: snap.id, ...snap.data() };
  document.title = (ctx.club.name || 'Club') + ' · JagChess';

  // Membership is never implied — you join a club deliberately.
  let mem = await getDoc(memberRef(slug, ctx.user.uid));

  /* …with one exception, and it is still deliberate: an invite link. Somebody
     an admin emailed from the club's pending list has already said yes once,
     on the registration form. Making them say it again on a join gate — after
     the link, after creating an account — is three doors where the invite
     promised one. `invite=1` is what marks the link as that kind. */
  if (!mem.exists() && params.get('invite') === '1') {
    if (await acceptInvite(slug, params.get('code'))) {
      mem = await getDoc(memberRef(slug, ctx.user.uid));
    }
  }

  if (!mem.exists()) return showGate({});
  ctx.member = mem.data();
  ctx.isStaff = ctx.member.role === 'admin' || ctx.member.role === 'founder';
  ctx.mode = 'admin';

  /* The membership row is the truth; the club map on your profile is only an
     index of it, and the two can fall out of step — deleting a club nulls the
     entry, and anything that recreated the club afterwards had no reason to
     put it back. When that happens the club works perfectly by address but is
     missing from My clubs, which reads the index. Being here proves you are a
     member, so the index is corrected on the spot. */
  syncClubIndex(slug, ctx.member.role);

  /* When you were last here, for the "active this week" count on Insights.
     A few times a day at most: it is a rough signal, not a log. */
  if (!ctx.member.lastSeenAt || Date.now() - ctx.member.lastSeenAt > 6 * 3600e3) {
    updateDoc(memberRef(slug, ctx.user.uid), { lastSeenAt: Date.now() }).catch(() => {});
  }

  $('club-boot').hidden = true;
  $('sidebar').hidden = false;
  $('app-main').hidden = false;

  paintIdentity();
  paintStats();
  buildNav();
  wireChrome();
  installProfileCards(ctx);
  document.body.classList.toggle('is-editor', ctx.isAdmin);
  paintSetup();

  // your own member row drives the header chips and your club rating, so it
  // stays live rather than being read once at boot
  onSnapshot(memberRef(slug, ctx.user.uid), (s) => {
    if (!s.exists()) return;
    ctx.member = s.data();
    ctx.isStaff = ctx.member.role === 'admin' || ctx.member.role === 'founder';
    paintIdentity();
    paintStats();
  });

  /* The Network reads a public mirror of this club, not the club itself —
     the club document carries the join code. Refreshing it here is what puts
     a club onto the Network at all, with no setup and nothing to turn on, and
     what keeps the name, the member count and the module list on its card
     honest. Any member does it, not just staff: waiting for an admin to open
     the club is exactly the kind of delay that leaves a club unlisted. */
  syncPublicClub(ctx.club);

  /* The other index a member repairs by turning up: the set of addresses
     already in the club, which is what stops the public registration form
     taking a sign-up from somebody who is standing in the room. */
  getDocs(clubCol(ctx.clubId, 'members'))
    .then((snap) => syncMemberEmails(ctx.clubId, snap.docs.map((d) => d.data())))
    .catch((e) => console.warn('Could not refresh the member address index', e));

  watchChallenges(ctx);
  watchActiveDuels((games) => {
    myGame = gameOf(games, ctx.user.uid);
    paintStats();
  });

  // live club doc — keeps blocks/layout in sync across tabs and admins
  onSnapshot(clubRef(slug), (s) => {
    if (!s.exists()) return;
    const next = { id: s.id, ...s.data() };
    const navChanged = JSON.stringify(next.blocks) !== JSON.stringify(ctx.club.blocks);
    ctx.club = next;
    paintIdentity();
    if (navChanged) buildNav();
    paintSetup();
  });

  if (params.get('welcome') === '1') {
    history.replaceState({}, '', location.pathname);
    import('./club-welcome.js')
      .then((m) => m.showClubWelcome(ctx))
      .catch((e) => { console.warn(e); toast('Your club is ready', 'ok'); });
  } else {
    // the first time anyone opens this club on this device, show them round
    import('./tour.js').then((m) => m.maybeRunClubTour(ctx)).catch(() => {});
  }

  route(location.hash.replace(/^#/, '') || 'dashboard');
  window.addEventListener('hashchange', () => route(location.hash.replace(/^#/, '') || 'dashboard'));

  /* A scanned attendance QR names its event; otherwise we look for whatever
     is running right now. Either way the check-in comes to you. */
  if (scanned) history.replaceState({}, '', location.pathname + location.hash);
  maybePromptAttendance(ctx, { goToEvents }, scanned || undefined);

  /* Staff get told once, on this device, when a release lands. It waits a
     beat so it never lands on top of an attendance prompt. */
  setTimeout(() => {
    import('./whats-new.js')
      .then((m) => m.maybeShowWhatsNew(ctx))
      .catch((e) => console.warn('Could not show the release note', e));
  }, 1400);
})();

/* Repairs the club map on the user profile from the membership row we just
   read. A merge write of one field, fire-and-forget: it is a self-heal, so it
   must never hold up opening the club or surface an error if it fails. */
async function syncClubIndex(clubId, role) {
  try {
    const snap = await getDoc(doc(db, 'users', ctx.user.uid));
    const map = (snap.exists() && snap.data().clubs) || {};
    if (map[clubId] === (role || 'student')) return;   // already agrees
    await setDoc(doc(db, 'users', ctx.user.uid), {
      clubs: { [clubId]: role || 'student' }
    }, { merge: true });
  } catch (e) {
    console.warn('Could not refresh your club list', e);
  }
}

/* ═══ jumping to the events page ═════════════════════════════════════ */

/* Events is a block, so its page id is whatever the club named it. */
function goToEvents() {
  const block = (ctx.club.blocks || []).find((b) => b.type === 'events');
  if (block) location.hash = block.id;
  else toast('This club has no events page yet.');
}

/* ═══ invites ════════════════════════════════════════════════════════ */

/* Joins on the strength of an invite link, and says whether it worked. A
   private club still needs its code on the link — an invite is a shortcut
   past the gate, never past the lock. Failure is quiet: the gate takes over
   and explains itself far better than a toast could. */
async function acceptInvite(slug, code) {
  const c = ctx.club;
  const invited = String(code || '').toUpperCase();
  const codeMatches = invited && c.code && invited === String(c.code).toUpperCase();
  if ((c.visibility || 'public') === 'private' && !codeMatches) return false;

  try {
    await joinClub(ctx.user, slug);
    // the code has done its job; it has no business sitting in history
    history.replaceState({}, '', location.pathname + location.hash);
    toast(`Welcome to ${c.name || 'the club'} ♞`, 'ok');
    window.jagTrack?.('invite_accepted', { club: slug });
    return true;
  } catch (e) {
    console.warn('Could not accept that invite', e);
    return false;
  }
}

/* ═══ gate (non-member / missing) ════════════════════════════════════ */

async function showGate({ missing }) {
  $('club-boot').hidden = true;
  const gate = $('club-gate');
  gate.hidden = false;

  if (missing) {
    $('gate-avatar').textContent = '∅';
    $('gate-avatar').style.background = '#8296a4';
    $('gate-name').textContent = 'Club not found';
    $('gate-desc').textContent = 'There is no club at this address. It may have been renamed or removed.';
    return;
  }

  const c = ctx.club;
  paintClubAvatar($('gate-avatar'), c);
  $('gate-name').textContent = c.name || c.id;

  // an invite link carries the join code, which is what unlocks a private club
  const invited = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
  const codeMatches = invited && c.code && invited === String(c.code).toUpperCase();

  if (c.visibility === 'private' && !codeMatches) {
    $('gate-desc').textContent = invited
      ? 'That invite link is out of date — the join code has been changed since it was made.'
      : 'This club is private. Ask an admin for an invite link or the join code.';
    $('gate-actions').innerHTML = '<a class="btn primary lg" href="/clubs">Enter a join code</a>';
    return;
  }

  $('gate-desc').textContent = codeMatches
    ? `You've been invited to ${c.name || 'this club'}.`
    : (c.description || 'You\'re not a member of this club yet.');
  $('gate-actions').innerHTML = '<button class="btn primary lg" id="gate-join">Join this club</button>';
  $('gate-join').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Joining…';
    try {
      await joinClub(ctx.user, ctx.clubId);
      // drop the code from the address so it is not left sitting in history
      location.replace(location.pathname);
    } catch (err) {
      toast(err.message || 'Could not join.', 'error');
      e.target.disabled = false;
      e.target.textContent = 'Join this club';
    }
  };
}

/* ═══ identity ═══════════════════════════════════════════════════════ */

function paintIdentity() {
  const c = ctx.club;
  paintClubAvatar($('club-icon'), c);
  $('club-name').textContent = c.name || c.id;
  $('club-name').title = c.name || c.id;
  const count = c.memberCount || 1;
  $('club-role').textContent = ctx.mode === 'member'
    ? 'Previewing as a student'
    : `${ROLE_LABEL[ctx.member.role] || 'Member'}, ${count} ${count === 1 ? 'member' : 'members'}`;
  $('mode-switch').classList.toggle('on', ctx.mode === 'member');

  const name = ctx.member.username || (ctx.user.email || '').split('@')[0];
  $('me-name').textContent = name;
  $('me-email').textContent = ctx.user.email || '';
  const av = $('me-avatar');
  av.textContent = initials(name);
  av.style.background = ctx.member.avatarColor || '#2e90fa';

  // a private club's link carries its join code, so only admins may hand it out
  $('invite-btn').hidden = !canShareClub(ctx);
}

/* ═══ header stats ═══════════════════════════════════════════════════
   Points and streak sit next to the club name rather than taking up a
   dashboard widget, so they read the same on every page.
   ─────────────────────────────────────────────────────────────────── */

function paintStats() {
  const m = ctx.member || {};
  $('topbar-stats').innerHTML = `
    ${myGame ? `<button class="chip duel-resume" id="resume-duel" title="You have a game in progress">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l10-6.5Z"/></svg>
      Back to your game
    </button>` : ''}
    <span class="chip gold">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.2 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.4l5.9-.8Z"/></svg>
      ${m.points || 0}<small>pts</small>
    </span>
    <span class="chip orange">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c3.6 0 6.2-2.4 6.2-5.8 0-3.9-3.4-5.6-2.9-9.4-2.2.5-3.3 2-3.6 3.7-.8-1-1-2.2-.8-3.5C8 7.2 5.8 10 5.8 13.4 5.8 17.4 8.6 21 12 21Z"/></svg>
      ${m.currentStreak || 0}<small>streak</small>
    </span>`;
  const resume = $('resume-duel');
  if (resume) resume.onclick = () => { location.hash = 'duel/' + myGame.id; };
}

/* ═══ navigation ═════════════════════════════════════════════════════ */

const ADMIN_PAGES = [
  { id: 'members', name: 'Members', icon: 'users' },
  { id: 'metrics', name: 'Insights', icon: 'chart' },
  { id: 'settings', name: 'Settings', icon: 'cog' }
];

/* Pages only staff can reach, whether by the sidebar or by typing a hash. */
const STAFF_ONLY = ['members', 'settings', 'metrics'];

const ICONS = {
  home: '<path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 9.4V20h13V9.4"/><path d="M9.8 20v-5.4h4.4V20"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.7 3.4-6.2 7.5-6.2s7.5 2.5 7.5 6.2"/>',
  users: '<circle cx="9" cy="8.4" r="3.2"/><path d="M2.6 19.4c0-3.3 2.9-5.6 6.4-5.6s6.4 2.3 6.4 5.6"/><path d="M16.6 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.2 19.4c0-2-.5-3.6-1.5-4.7"/>',
  cog: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v2.6M12 18.8v2.6M4.4 4.4l1.9 1.9M17.7 17.7l1.9 1.9M2.6 12h2.6M18.8 12h2.6M4.4 19.6l1.9-1.9M17.7 6.3l1.9-1.9"/>',
  calendar: '<rect x="3" y="4.8" width="18" height="16.2" rx="3.2"/><path d="M3 9.8h18M8 2.6v4.2M16 2.6v4.2"/>',
  puzzle: '<rect x="3" y="3" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="3" width="7.4" height="7.4" rx="2"/><rect x="3" y="13.6" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="13.6" width="7.4" height="7.4" rx="2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3.6 7 7.3 5.3a2 2 0 0 0 2.2 0L20.4 7"/>',
  trophy: '<path d="M7.6 4.2h8.8v4.6a4.4 4.4 0 0 1-8.8 0Z"/><path d="M7.6 5.8H4.9v1a3 3 0 0 0 2.9 3M16.4 5.8h2.7v1a3 3 0 0 1-2.9 3"/><path d="M12 13.2v3.4M8.4 20.2h7.2l-.9-3.6H9.3Z"/>',
  bag: '<path d="M5.4 8h13.2l-1.1 12.2H6.5Z"/><path d="M9 8V5.9a3 3 0 0 1 6 0V8"/>',
  heart: '<path d="M20.8 8.9c0 4.7-8.8 10.6-8.8 10.6S3.2 13.6 3.2 8.9a4.7 4.7 0 0 1 8.8-2 4.7 4.7 0 0 1 8.8 2Z"/>',
  swords: '<path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/>',
  tournament: '<path d="M7.6 4.2h8.8v4.6a4.4 4.4 0 0 1-8.8 0Z"/><path d="M7.6 5.8H4.9v1a3 3 0 0 0 2.9 3M16.4 5.8h2.7v1a3 3 0 0 1-2.9 3"/><path d="M12 13.2v3.4M8.4 20.2h7.2l-.9-3.6H9.3Z"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3.4" height="6.5" rx="1"/><rect x="10.3" y="6.5" width="3.4" height="11" rx="1"/><rect x="15.1" y="3.5" width="3.4" height="14" rx="1"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v5.3A2.2 2.2 0 0 0 7.2 20h9.6a2.2 2.2 0 0 0 2.2-2.2v-5.3"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
  logout: '<path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H12"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17.2h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  sparkle: '<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15a2 2 0 0 0-1.2-1.2L3.5 12 9 10.2A2 2 0 0 0 10.2 9Z"/>'
};

export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.home}</svg>`;

/* The two avatars the shell owns outright, rather than rendering into a
   string with the rest of a card. Same markup, same fallback. */
function paintClubAvatar(node, club) {
  if (!node) return;
  /* The marker class is ours, not the caller's, so it is stripped before
     asking again — otherwise every repaint would add another copy of it. */
  const base = (node.className || 'club-avatar')
    .split(/\s+/).filter((c) => c && c !== 'has-photo').join(' ');

  const box = document.createElement('div');
  box.innerHTML = clubAvatar(club, base);
  const made = box.firstElementChild;

  node.className = made.className;
  node.style.background = made.style.background || '';
  node.innerHTML = made.innerHTML;
}

function navButton(id, name, iconName, opts = {}) {
  const b = document.createElement('button');
  b.className = 'tab' + (ctx.page === id ? ' active' : '');
  b.dataset.page = id;
  b.dataset.icon = iconName;      // the stylesheet colours each kind of page by its icon
  const editing = opts.editable && ctx.isAdmin;
  b.innerHTML =
    (editing ? '<i class="tab-grip" data-grip title="Drag to reorder">⠿</i>' : '') +
    `${icon(iconName)}<span>${esc(name)}</span>` +
    (editing
      ? '<span class="tab-tools"><i data-rename title="Rename">✎</i><i data-remove title="Remove">✕</i></span>'
      : '');
  b.onclick = (e) => {
    if (e.target.closest('[data-grip]')) return;      // that was a drag, not a visit
    if (e.target.closest('[data-rename]')) { e.stopPropagation(); renameBlock(id); return; }
    if (e.target.closest('[data-remove]')) { e.stopPropagation(); removeBlock(id); return; }
    location.hash = id;
    $('app').classList.remove('nav-open');
  };
  return b;
}

/* ═══ reordering the pages ═══════════════════════════════════════════
   The drag itself lives in nav-reorder.js; what belongs here is only what
   the new order means — which blocks, in which order, saved on the club.
   ─────────────────────────────────────────────────────────────────── */

async function saveOrder(ids) {
  const blocks = (ctx.club.blocks || []).slice()
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const previous = ctx.club.blocks;
  ctx.club.blocks = blocks;
  try {
    await updateDoc(clubRef(ctx.clubId), { blocks });
    toast('Page order saved', 'ok');
  } catch (err) {
    console.error(err);
    ctx.club.blocks = previous;
    buildNav();
    toast('Could not save the new order', 'error');
  }
}

function buildNav() {
  const fixed = $('nav-fixed');
  const blocks = $('nav-blocks');
  const admin = $('nav-admin');
  fixed.innerHTML = '';
  blocks.innerHTML = '';
  admin.innerHTML = '';

  fixed.appendChild(navButton('dashboard', 'Home', 'home'));

  (ctx.club.blocks || []).forEach((b) => {
    const meta = BLOCK_TYPES[b.type];
    if (!meta) return;
    blocks.appendChild(navButton(b.id, blockName(b), meta.icon, { editable: ctx.isAdmin }));
  });

  if (ctx.isAdmin) enableReorder(blocks, { onReorder: saveOrder });

  $('nav-blocks-group').hidden = !(ctx.club.blocks || []).length && !ctx.isAdmin;
  $('add-block-btn').hidden = !ctx.isAdmin;
  $('nav-admin-group').hidden = !ctx.isAdmin;
  if (ctx.isAdmin) ADMIN_PAGES.forEach((p) => admin.appendChild(navButton(p.id, p.name, p.icon)));

  /* The switch itself answers to your row, not to the mode — otherwise
     student view would hide the way back out of it. */
  $('mode-switch').hidden = !ctx.isStaff;

  buildTabbar();
}

/* Clubs made before the Play page was renamed still carry its old default
   name. A name somebody chose is kept; only the untouched default changes. */
const blockName = (b) => (b.type === 'duels' && (!b.name || b.name === 'Duels'))
  ? 'Play' : (b.name || (BLOCK_TYPES[b.type] || {}).name);

/* ═══ the phone tab bar ══════════════════════════════════════════════
   Four places a member actually goes, plus everything else behind More.
   Which four depends on the pages the club has: a club without puzzles
   doesn't get a dead Puzzles tab.
   ─────────────────────────────────────────────────────────────────── */

const TABBAR_PREFERENCE = ['duels', 'puzzles', 'events', 'leaderboard', 'newsletters', 'tournaments'];
const TABBAR_LABEL = { duels: 'Play', puzzles: 'Puzzles', events: 'Events', leaderboard: 'Ranks', newsletters: 'News', tournaments: 'Arenas' };

function buildTabbar() {
  const bar = $('tabbar');
  const blocks = ctx.club.blocks || [];
  const picks = [];
  for (const type of TABBAR_PREFERENCE) {
    const b = blocks.find((x) => x.type === type);
    if (b) picks.push({ id: b.id, label: TABBAR_LABEL[type], icon: BLOCK_TYPES[type].icon });
    if (picks.length === 3) break;
  }
  const items = [{ id: 'dashboard', label: 'Home', icon: 'home' }, ...picks];
  bar.innerHTML = items.map((t) => `
    <button class="tabbar-btn${ctx.page === t.id ? ' on' : ''}" data-tab="${esc(t.id)}" data-icon="${esc(t.icon)}">
      ${icon(t.icon)}<span>${esc(t.label)}</span>
    </button>`).join('') + `
    <button class="tabbar-btn" data-tab="__more">${icon('more')}<span>More</span></button>`;
  bar.hidden = false;
  bar.onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    if (b.dataset.tab === '__more') { $('app').classList.add('nav-open'); return; }
    location.hash = b.dataset.tab;
  };
}

/* ═══ the setup checklist ════════════════════════════════════════════
   What a brand-new club still needs, in the order it's worth doing, for
   the people who can do it. Each step checks something real rather than
   remembering a click, so a club that already has events never sees
   "add an event". It goes away once everything is done, or when an
   admin dismisses it.
   ─────────────────────────────────────────────────────────────────── */

let setupCounts = null;
let setupLoading = false;

async function loadSetupCounts() {
  if (setupCounts || setupLoading) return;
  setupLoading = true;
  const has = async (name) => {
    try { return !(await getDocs(query(clubCol(ctx.clubId, name), limit(1)))).empty; }
    catch (_) { return false; }
  };
  const [events, puzzles, news] = await Promise.all([has('events'), has('puzzles'), has('announcements')]);
  setupCounts = { events, puzzles, news };
  setupLoading = false;
  paintSetup();
}

function setupSteps() {
  const c = ctx.club;
  const blockOf = (type) => ((c.blocks || []).find((b) => b.type === type) || {}).id;
  return [
    { id: 'invite', label: 'Invite your first members', done: (c.memberCount || 1) > 1, go: () => openClubShare(ctx) },
    { id: 'event', label: 'Schedule your first meeting', done: setupCounts.events,
      go: () => { location.hash = blockOf('events') || 'dashboard'; } },
    { id: 'puzzle', label: 'Post a puzzle', done: setupCounts.puzzles,
      go: () => { location.hash = blockOf('puzzles') || 'dashboard'; } },
    { id: 'home', label: 'Make the home page yours', done: !!(c.layout && c.layout.length && c.layoutCustomized),
      go: () => startEditing() }
  ];
}

function paintSetup() {
  const card = $('setup-card');
  if (!card) return;
  if (!ctx.isAdmin || ctx.club.setupDismissed) { card.hidden = true; return; }
  if (!setupCounts) { card.hidden = true; loadSetupCounts(); return; }

  const steps = setupSteps();
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) { card.hidden = true; return; }

  card.hidden = false;
  const next = steps.find((s) => !s.done);
  const open = card.classList.contains('open');
  card.innerHTML = `
    <div class="setup-head">
      <button class="setup-toggle" data-toggle aria-expanded="${open}">
        <b>Get your club going</b>
        <small>${done} of ${steps.length} done</small>
      </button>
      <button class="setup-x" data-dismiss title="Hide this checklist" aria-label="Hide this checklist">✕</button>
    </div>
    <div class="setup-bar"><i style="width:${Math.round((done / steps.length) * 100)}%"></i></div>
    <div class="setup-steps">
      ${steps.map((s) => `
        <button class="setup-step${s.done ? ' done' : ''}${s === next ? ' next' : ''}" data-step="${s.id}"${s.done ? ' disabled' : ''}>
          <span class="setup-tick">${s.done ? icon('check') : ''}</span>${esc(s.label)}
        </button>`).join('')}
    </div>`;
  card.querySelector('[data-toggle]').onclick = () => {
    card.classList.toggle('open');
    card.querySelector('[data-toggle]').setAttribute('aria-expanded', card.classList.contains('open'));
  };
  card.querySelector('[data-dismiss]').onclick = async () => {
    card.hidden = true;
    try { await updateDoc(clubRef(ctx.clubId), { setupDismissed: true }); } catch (_) {}
  };
  card.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => {
      const step = steps.find((s) => s.id === b.dataset.step);
      $('app').classList.remove('nav-open');
      if (step) step.go();
    };
  });
}

/* re-checked when a page that can complete a step is left */
export function refreshSetup() {
  setupCounts = null;
  paintSetup();
}

function markActive() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === ctx.page));
  document.querySelectorAll('.tabbar-btn').forEach((t) => t.classList.toggle('on', t.dataset.tab === ctx.page));
}

/* ═══ routing ════════════════════════════════════════════════════════ */

/* Duels and tournaments are always reachable, block or no block: a member who
   was challenged has to be able to answer, and somebody handed a tournament
   link has to be able to open it, even if nobody has added the page. */
const STANDALONE = ['profile', 'members', 'settings', 'metrics', 'duels', 'tournaments'];

/* The hash of this club's tournaments page — its block id when one has been
   added, the standalone route when it hasn't. */
export const tournamentsHash = () =>
  ((ctx.club.blocks || []).find((b) => b.type === 'tournaments') || {}).id || 'tournaments';

async function route(raw) {
  if (ctx.cleanup) { try { ctx.cleanup(); } catch (_) {} ctx.cleanup = null; }

  // a game opens as a layer over the duels page, so #duel/<id> survives a reload
  const duel = /^duel\/(.+)$/.exec(raw);
  // one tournament is its own screen, keyed off the tournaments page
  const tourn = /^tournament\/(.+)$/.exec(raw);
  /* The same three screens the hub has, for a club's own lichess teams. */
  const liGame = /^lichess\/([^/]+)\/game\/([^/]+)$/.exec(raw);
  const li = /^lichess\/([^/]+)$/.exec(raw);
  const liPlayer = /^lichess-player\/(.+)$/.exec(raw);
  const anyLi = liGame || li || liPlayer;
  const pageId = duel ? duelsHash(ctx)
    : (tourn || anyLi) ? tournamentsHash() : raw;

  ctx.page = pageId;
  markActive();

  const host = $('page-host');
  host.innerHTML = '';
  $('topbar-actions').innerHTML = '';
  if (pageId !== 'dashboard') ctx.editing = false;
  $('editor-bar').hidden = !(ctx.isAdmin && ctx.editing && pageId === 'dashboard');
  document.body.classList.toggle('is-customizing', ctx.isAdmin && ctx.editing && pageId === 'dashboard');
  $('app-main').scrollTop = 0;
  if (!duel) closeDuelStage();
  if (!liGame) {
    const { closeLichessGame } = await import('./lichess-board.js');
    closeLichessGame();
  }
  // a queue entry or an open challenge belongs to the screen that made it
  closeDuelWaiting();

  // admin-only pages are never reachable by typing the hash
  if (!ctx.isAdmin && STAFF_ONLY.includes(pageId)) {
    location.hash = 'dashboard';
    return;
  }

  // one tournament takes over the page rather than sitting inside the list
  if (tourn) {
    setTitle('Tournament', '');
    const { renderTournamentView } = await import('./tournaments-ui.js');
    ctx.cleanup = await renderTournamentView(ctx, host, tourn[1], { listHash: tournamentsHash() });
    return;
  }

  if (anyLi) {
    setTitle('Tournament', '');
    const ui = await import('./lichess-ui.js');
    const listHash = tournamentsHash();
    if (liPlayer) {
      ctx.cleanup = await ui.renderLichessPlayer(ctx, host, liPlayer[1], { listHash });
      return;
    }
    const id = (li || liGame)[1];
    ctx.cleanup = await ui.renderLichessTournament(ctx, host, id, { listHash });
    if (liGame) await ui.renderLichessGame(ctx, host, id, liGame[2], {});
    return;
  }

  const block = (ctx.club.blocks || []).find((b) => b.id === pageId);
  const meta = block ? BLOCK_TYPES[block.type] : null;

  if (pageId === 'dashboard') {
    setTitle(ctx.club.name || 'Home', ctx.editing
      ? 'What you arrange here is what every member sees first.'
      : (ctx.club.description || ''));
    if (ctx.isAdmin && !ctx.editing) {
      $('topbar-actions').innerHTML =
        `<button class="btn subtle sm" id="customize-btn">${icon('grid')}Customize</button>`;
      $('customize-btn').onclick = startEditing;
    }
    ctx.cleanup = await renderDashboard(ctx, host, { setTitle });
    return;
  }

  if (pageId === 'metrics') {
    setTitle('Insights', 'How the club is doing, and who is showing up.');
    const { renderMetrics } = await import('./club-metrics.js');
    ctx.cleanup = await renderMetrics(ctx, host);
    return;
  }

  if (!block && STANDALONE.indexOf(pageId) === -1) {
    location.hash = 'dashboard';
    return;
  }

  const type = block ? block.type : pageId;
  const fallbackName = {
    profile: 'Your profile', members: 'Members', settings: 'Settings',
    duels: 'Play', tournaments: 'Tournaments'
  };
  const name = block ? blockName(block) : fallbackName[pageId];
  const fallbackSub = BLOCK_TYPES[pageId] ? BLOCK_TYPES[pageId].sub : '';
  setTitle(name, block ? meta.sub : fallbackSub);

  ctx.cleanup = await renderBlock(type, ctx, host, { setTitle, topbar: $('topbar-actions') });

  if (duel) openDuelStage(ctx, duel[1]);
}

export function setTitle(title, sub) {
  $('page-title').textContent = title;
  $('page-sub').textContent = sub || '';
  $('page-sub').style.display = sub ? '' : 'none';
}

/* ═══ chrome ═════════════════════════════════════════════════════════ */

function wireChrome() {
  $('menu-btn').onclick = () => $('app').classList.add('nav-open');
  $('nav-scrim').onclick = () => $('app').classList.remove('nav-open');
  $('invite-btn').onclick = () => openClubShare(ctx);

  // the topbar gets its hairline only once there is something under it
  $('app-main').addEventListener('scroll', () => {
    $('app-main').classList.toggle('scrolled', $('app-main').scrollTop > 4);
  }, { passive: true });

  $('mode-switch').onclick = () => setMode(ctx.mode === 'member' ? 'admin' : 'member');
  $('editor-done').onclick = stopEditing;
  $('editor-reset').onclick = resetLayout;

  $('club-switch').onclick = openClubMenu;
  $('nav-user').onclick = openUserMenu;

  $('add-block-btn').onclick = openBlockPicker;
  document.querySelectorAll('[data-close-blocks]').forEach((b) => (b.onclick = () => ($('add-block-modal').hidden = true)));
  $('add-block-modal').onclick = (e) => { if (e.target === $('add-block-modal')) $('add-block-modal').hidden = true; };
  $('block-search').oninput = () => renderBlockPicker($('block-search').value.trim().toLowerCase());
}

function setMode(mode) {
  ctx.mode = mode;
  ctx.editing = false;
  document.body.classList.toggle('is-editor', ctx.isAdmin);
  document.body.classList.toggle('is-student-view', mode === 'member');
  buildNav();
  paintIdentity();
  paintStats();
  paintSetup();
  if (mode === 'member') toast('Previewing as a student. Switch it off to manage the club again.');

  /* Staff pages do not exist for a student, so student view cannot be
     entered while standing on one. Everything else survives the switch,
     which is the point: you see the page you were looking at, as they see it. */
  const stuck = !ctx.isAdmin && STAFF_ONLY.includes(ctx.page);
  if (stuck) location.hash = 'dashboard';
  else route(ctx.page);
}

/* ═══ customizing the home page ══════════════════════════════════════ */

function startEditing() {
  if (!ctx.isAdmin) return;
  ctx.editing = true;
  if (ctx.page === 'dashboard') route('dashboard');
  else location.hash = 'dashboard';
}

function stopEditing() {
  ctx.editing = false;
  route('dashboard');
  toast('Home page saved', 'ok');
}

/* ═══ the two menus ══════════════════════════════════════════════════ */

async function openClubMenu() {
  const anchor = $('club-switch');
  const menu = openMenu(anchor, `
    <div class="pop-menu-label">Your clubs</div>
    <div data-clubs><div class="pop-menu-label">Loading…</div></div>
    <hr>
    <a class="pop-item" data-act="all" href="/clubs">${icon('grid')}<span>All clubs</span></a>
    <a class="pop-item" data-act="new" href="/clubs?create=1">${icon('plus')}<span>Start a new club</span></a>`,
    { width: 272 });
  if (!menu) return;
  let clubs = [];
  try { clubs = await myClubs(ctx.user); } catch (e) { console.warn(e); }
  const slot = menu.querySelector('[data-clubs]');
  if (!slot) return;
  slot.innerHTML = clubs.map((c) => `
    <a class="pop-item${c.id === ctx.clubId ? ' current' : ''}" data-act="club" href="/clubs/${esc(c.id)}">
      ${clubAvatar(c, 'club-avatar')}
      <span>${esc(c.name || c.id)}</span>
      <small>${esc(ROLE_LABEL[c.role] || '')}</small>
    </a>`).join('') || '<div class="pop-menu-label">No other clubs yet</div>';
}

function openUserMenu() {
  const dark = currentTheme() === 'dark';
  openMenu($('nav-user'), `
    <button class="pop-item" data-act="profile">${icon('user')}<span>Your profile</span></button>
    <button class="pop-item" data-act="account">${icon('cog')}<span>Account settings</span></button>
    <button class="pop-item" data-act="theme">${icon(dark ? 'sun' : 'moon')}<span>${dark ? 'Light mode' : 'Dark mode'}</span></button>
    <button class="pop-item" data-act="tour">${icon('sparkle')}<span>Show me around</span></button>
    <a class="pop-item" data-act="help" href="/guide" target="_blank" rel="noopener">${icon('help')}<span>Help guide</span></a>
    <hr>
    <button class="pop-item danger" data-act="logout">${icon('logout')}<span>Log out</span></button>`,
  {
    place: 'above',
    onPick: (act) => {
      if (act === 'profile') { location.hash = 'profile'; $('app').classList.remove('nav-open'); }
      if (act === 'account') { $('app').classList.remove('nav-open'); openAccountSettings(ctx); }
      if (act === 'theme') toggleTheme();
      if (act === 'tour') startTour();
      if (act === 'logout') signOut(auth).then(() => (location.href = '/login'));
    }
  });
}

/* ═══ the guided tour ═══════════════════════════════════════════════ */

async function startTour() {
  $('app').classList.remove('nav-open');
  try {
    const { runClubTour } = await import('./tour.js');
    runClubTour(ctx);
  } catch (e) { console.error(e); }
}

/* ═══ block management ═══════════════════════════════════════════════ */

function openBlockPicker() {
  $('add-block-modal').hidden = false;
  $('block-search').value = '';
  renderBlockPicker('');
  setTimeout(() => $('block-search').focus(), 60);
}

function renderBlockPicker(term) {
  const used = new Set((ctx.club.blocks || []).map((b) => b.type));
  const rows = Object.entries(BLOCK_TYPES)
    .filter(([type, m]) =>
      !term || m.name.toLowerCase().includes(term) || m.desc.toLowerCase().includes(term) || type.includes(term));

  $('block-list').innerHTML = rows.map(([type, m]) => `
    <button class="block-opt" data-add="${type}">
      <span class="block-opt-icon" style="background:${m.tint}">${icon(m.icon)}</span>
      <span class="block-opt-body">
        <b>${esc(m.name)}${used.has(type) ? '<span class="block-used">added</span>' : ''}</b>
        <small>${esc(m.desc)}</small>
      </span>
      <span class="block-opt-add">+</span>
    </button>`).join('') || '<div class="empty-state">No blocks match that search.</div>';

  $('block-list').querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addBlock(b.dataset.add)));
}

async function addBlock(type) {
  const meta = BLOCK_TYPES[type];
  const blocks = (ctx.club.blocks || []).slice();
  let id = type;
  let n = 2;
  while (blocks.some((b) => b.id === id)) id = type + '-' + n++;

  blocks.push({ id, type, name: meta.name });
  await updateDoc(clubRef(ctx.clubId), { blocks });
  ctx.club.blocks = blocks;
  $('add-block-modal').hidden = true;
  buildNav();
  toast(meta.name + ' block added', 'ok');
  location.hash = id;
}

async function renameBlock(id) {
  const blocks = (ctx.club.blocks || []).slice();
  const b = blocks.find((x) => x.id === id);
  if (!b) return;
  const name = await promptDialog({
    title: 'Rename block', label: 'Block name', value: b.name, confirmText: 'Rename'
  });
  if (!name) return;
  b.name = name;
  await updateDoc(clubRef(ctx.clubId), { blocks });
  ctx.club.blocks = blocks;
  buildNav();
  if (ctx.page === id) setTitle(name, BLOCK_TYPES[b.type].sub);
}

async function removeBlock(id) {
  const blocks = (ctx.club.blocks || []).slice();
  const b = blocks.find((x) => x.id === id);
  if (!b) return;
  const ok = await confirmDialog({
    title: 'Remove this block?',
    body: `"${b.name}" disappears from the sidebar for everyone. The data behind it is kept, so adding the block back restores it.`,
    confirmText: 'Remove block',
    danger: true
  });
  if (!ok) return;
  const next = blocks.filter((x) => x.id !== id);
  await updateDoc(clubRef(ctx.clubId), { blocks: next });
  ctx.club.blocks = next;
  buildNav();
  if (ctx.page === id) location.hash = 'dashboard';
  toast('Block removed');
}

async function resetLayout() {
  const ok = await confirmDialog({
    title: 'Reset the dashboard?',
    body: 'Widgets go back to the default arrangement for this club.',
    confirmText: 'Reset layout',
    danger: true
  });
  if (!ok) return;
  await updateDoc(clubRef(ctx.clubId), { layout: null });
  ctx.club.layout = null;
  route('dashboard');
  toast('Layout reset');
}

export { setMode, startEditing };
