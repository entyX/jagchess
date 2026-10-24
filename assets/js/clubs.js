/* ═══════════════════════════════════════════════════════════════════════
   clubs.js — the "My clubs" hub: list memberships, join, create.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  auth, db, requireUser, signOut, myClubs, joinClub, deleteClubDeep, BannedError,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit,
  clubRef, memberRef, banRef, slugify, makeCode, initials, esc, toast,
  confirmDialog, promptDialog, isStaff, ROLE_LABEL,
  syncPublicClub, syncAllPublicClubs, unindexMemberEmail,
  CLUB_COLORS, CLUB_ICONS, clubAvatar
} from './club-core.js';

import { hubTabsHTML } from './hub-shell.js';

const $ = (id) => document.getElementById(id);
const STARTER_BLOCKS = [
  { id: 'events',      type: 'events',      name: 'Events' },
  { id: 'puzzles',     type: 'puzzles',     name: 'Puzzles' },
  { id: 'newsletters', type: 'newsletters', name: 'Newsletters' },
  { id: 'leaderboard', type: 'leaderboard', name: 'Leaderboard' },
  { id: 'duels',       type: 'duels',       name: 'Duels' },
  { id: 'tournaments', type: 'tournaments', name: 'Tournaments' },
  { id: 'store',       type: 'store',       name: 'Store' },
  { id: 'donate',      type: 'donate',      name: 'Donate' }
];

const STARTER_LAYOUT = [
  { i: 'w1', type: 'welcome',      x: 0, y: 0, w: 8, h: 3 },
  { i: 'w2', type: 'quick-duel',   x: 8, y: 0, w: 4, h: 3 },
  { i: 'w3', type: 'events-next',  x: 0, y: 3, w: 5, h: 5 },
  { i: 'w4', type: 'leaderboard',  x: 5, y: 3, w: 4, h: 5 },
  { i: 'w8', type: 'tournaments',  x: 9, y: 3, w: 3, h: 5 },
  { i: 'w5', type: 'puzzle-daily', x: 0, y: 8, w: 4, h: 3 },
  { i: 'w6', type: 'news-latest',  x: 4, y: 8, w: 4, h: 3 },
  { i: 'w7', type: 'tip',          x: 8, y: 8, w: 4, h: 3 }
];

const BLANK_LAYOUT = [
  { i: 'w1', type: 'welcome', x: 0, y: 0, w: 12, h: 3 }
];

let user = null;
let bannedFrom = {};   // clubId → true, kept on the user profile for cheap filtering

/* ═══ boot ═══════════════════════════════════════════════════════════ */

(async function init() {
  user = await requireUser();

  const email = user.email || '';
  const name = user.displayName || email.split('@')[0] || 'Player';
  $('hub-name').textContent = name;
  $('hub-email').textContent = email;
  const av = $('hub-avatar');
  av.textContent = initials(name);
  av.style.background = CLUB_COLORS[(name.charCodeAt(0) || 0) % CLUB_COLORS.length];

  // the same tabs the other signed-in pages outside a club carry
  const tabsHost = $('hub-tabs-host');
  if (tabsHost) tabsHost.outerHTML = hubTabsHTML('clubs');

  await setDoc(doc(db, 'users', user.uid), {
    email: email.toLowerCase(),
    displayName: name,
    lastSeenAt: Date.now()
  }, { merge: true });

  const me = await getDoc(doc(db, 'users', user.uid));
  bannedFrom = (me.exists() && me.data().bannedFrom) || {};

  // the club address preview follows whichever domain you're actually on
  document.querySelectorAll('[data-host]').forEach((n) => (n.textContent = location.host + '/clubs/'));

  $('logout').onclick = () => signOut(auth).then(() => (location.href = '/login'));

  wireJoin();
  wireCreate();
  await renderClubs();
  await ensureLegacyClub();

  /* Opening the hub brings the whole JagChess Network directory up to date —
     every public club listed, every club that went private taken down. It is
     nobody's job in particular, which is exactly why it is done by whoever
     turns up, and why it is left to run on its own after the page is up. */
  syncAllPublicClubs();
})();

/* ═══ the original club moves itself ═════════════════════════════════
   No button, no admin decision: the first time an authorized admin signs
   in, the club is created and the old data is copied across. Everything
   is merge-only and re-runnable, so a half-finished move simply resumes.
   ═══════════════════════════════════════════════════════════════════ */

const LEGACY = {
  slug: 'northcreekchess',
  name: 'North Creek Chess Club',
  admins: ['shaurya.sahdev7@gmail.com', '2025510@apps.nsd.org', 'northcreekchessclub@gmail.com']
};

/* Silent, admin-only, and invisible to members. Finishes an unfinished copy.
 *
 * It deliberately does NOT create the club. It used to, and that made deleting
 * the original club impossible: every visit to this page put it straight back,
 * so an admin would delete it, reload, and find it sitting there again. A
 * migration's job is to move data that exists, not to resurrect a club
 * somebody deliberately removed — and the move itself finished long ago.
 * If the club is gone, there is nothing to migrate, and a new one is a click
 * away like any other. */
async function ensureLegacyClub() {
  const email = (user.email || '').toLowerCase();
  if (!LEGACY.admins.includes(email)) return;

  try {
    const snap = await getDoc(clubRef(LEGACY.slug));
    if (!snap.exists()) return;              // deleted, or never existed — leave it alone
    if (snap.data().legacyImported) return;  // already done

    const { importLegacy } = await import('./club-import.js');
    await importLegacy(LEGACY.slug);
  } catch (e) {
    console.warn('Background club sync skipped:', e);
  }
}

/* ═══ my clubs ═══════════════════════════════════════════════════════ */

async function renderClubs() {
  const grid = $('club-grid');
  const clubs = await myClubs(user);

  $('hub-count').textContent = clubs.length
    ? `You're in ${clubs.length} club${clubs.length === 1 ? '' : 's'}.`
    : 'Join a club with a code, or start your own.';

  /* Nobody's clubs is not a shorter list — it is a different screen, so the
     title, the join button and the grid all step aside for the directory. */
  const none = clubs.length === 0;
  $('hub-head').classList.toggle('bare', none);
  $('hub-head-text').hidden = none;
  $('open-join').hidden = none;
  $('hub-discover').hidden = !none;
  grid.hidden = none;
  if (none) { grid.innerHTML = ''; openDiscover(); return; }

  grid.innerHTML = clubs.map((c) => `
    <div class="club-card-wrap">
      <a class="club-card" href="/clubs/${esc(c.slug || c.id)}">
        <div class="club-card-top">
          ${clubAvatar(c, 'club-avatar')}
          <span class="role-pill ${esc(c.role)}">${esc(ROLE_LABEL[c.role] || 'Student')}</span>
        </div>
        <div class="club-card-name">${esc(c.name || c.id)}</div>
        <div class="club-card-desc">${esc(c.description || 'No description yet.')}</div>
        <div class="club-card-foot">
          <span class="club-card-meta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.4" r="3.2"/><path d="M2.6 19.4c0-3.3 2.9-5.6 6.4-5.6s6.4 2.3 6.4 5.6"/><path d="M16.6 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.2 19.4c0-2-.5-3.6-1.5-4.7"/></svg>
            ${c.memberCount || 1} member${(c.memberCount || 1) === 1 ? '' : 's'}
          </span>
          <span class="club-card-go">Open →</span>
        </div>
      </a>
      <button class="card-menu-btn" data-menu="${esc(c.id)}" aria-label="Club options" aria-haspopup="menu">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>
      </button>
      <div class="card-menu" data-menu-for="${esc(c.id)}">
        ${isStaff(c.role) ? `
          <button data-act="rename">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15.5 15.4 4.1a2.3 2.3 0 0 1 3.2 3.2L7.2 18.7 3 20l1.3-4.2Z"/></svg>
            Rename club
          </button>
          <button data-act="delete" class="danger">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5h15M9.5 6.5V4.8h5v1.7M6.5 6.5 7.4 20h9.2l.9-13.5"/></svg>
            Delete club
          </button>`
        : `
          <button data-act="leave" class="danger">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H12"/></svg>
            Leave this club
          </button>`}
      </div>
    </div>`).join('');

  wireCardMenus(clubs);
}

/* ═══ per-card menu ══════════════════════════════════════════════════ */

function closeMenus() {
  document.querySelectorAll('.card-menu.open').forEach((m) => m.classList.remove('open'));
}

function wireCardMenus(clubs) {
  document.querySelectorAll('[data-menu]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.querySelector(`[data-menu-for="${btn.dataset.menu}"]`);
      const open = menu.classList.contains('open');
      closeMenus();
      if (!open) menu.classList.add('open');
    };
  });

  document.querySelectorAll('[data-menu-for]').forEach((menu) => {
    const club = clubs.find((c) => c.id === menu.dataset.menuFor);
    menu.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenus();
      if (b.dataset.act === 'rename') return renameClub(club);
      if (b.dataset.act === 'delete') return deleteClub(club);
      if (b.dataset.act === 'leave') return leaveClub(club);
    };
  });
}

document.addEventListener('click', closeMenus);

async function renameClub(club) {
  const name = await promptDialog({
    title: 'Rename club',
    label: 'Club name',
    value: club.name || '',
    confirmText: 'Rename'
  });
  if (!name || name === club.name) return;
  try {
    await updateDoc(clubRef(club.id), { name });
    toast('Club renamed', 'ok');
    await renderClubs();
  } catch (e) {
    console.error(e);
    toast(e.code === 'permission-denied' ? 'Only club staff can rename it.' : 'Could not rename the club', 'error');
  }
}

async function deleteClub(club) {
  const ok = await confirmDialog({
    title: `Delete ${club.name}?`,
    body: `Every member loses access immediately and the address /clubs/${club.slug || club.id} stops working. This cannot be undone.`,
    confirmText: 'Delete club',
    danger: true
  });
  if (!ok) return;
  try {
    toast('Deleting the club…');
    await deleteClubDeep(user, club);
    toast('Club deleted');
    await renderClubs();
  } catch (e) {
    console.error(e);
    toast(e.code === 'permission-denied' ? 'Only club staff can delete it.' : 'Could not delete the club', 'error');
  }
}

async function leaveClub(club) {
  const ok = await confirmDialog({
    title: `Leave ${club.name}?`,
    body: 'You will lose access to its pages. Your points stay saved if you rejoin later.',
    confirmText: 'Leave club',
    danger: true
  });
  if (!ok) return;
  try {
    /* Before the membership row, not after: writing the address index needs
       the membership that is about to be deleted. */
    await unindexMemberEmail(club.id, user.email);
    await deleteDoc(memberRef(club.id, user.uid));
    await setDoc(doc(db, 'users', user.uid), { clubs: { [club.id]: null } }, { merge: true });
    toast('You left the club');
    await renderClubs();
  } catch (e) {
    console.error(e);
    toast('Could not leave the club', 'error');
  }
}

/* ═══ join ═══════════════════════════════════════════════════════════ */

let publicClubs = [];
let publicLoadFailed = false;

async function openJoin() {
  $('join-modal').hidden = false;
  $('club-search').value = '';
  $('club-code').value = '';
  $('code-hint').textContent = 'Ask a club admin for the 6-character join code.';
  $('code-hint').className = 'code-hint';
  setTimeout(() => $('club-search').focus(), 60);

  const list = $('join-list');
  if (!publicClubs.length) list.innerHTML = '<div class="empty-state">Loading clubs…</div>';
  await loadPublicClubs();
  if (publicLoadFailed) { list.innerHTML = '<div class="empty-state">Could not load clubs right now.</div>'; return; }
  renderJoinList('');
}

function wireJoin() {
  $('open-join').onclick = openJoin;
  document.querySelectorAll('[data-close-join]').forEach((b) => (b.onclick = () => ($('join-modal').hidden = true)));
  $('join-modal').onclick = (e) => { if (e.target === $('join-modal')) $('join-modal').hidden = true; };

  $('club-search').oninput = () => renderJoinList($('club-search').value.trim().toLowerCase());

  $('club-code').oninput = (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  };
  $('club-code').onkeydown = (e) => { if (e.key === 'Enter') joinByCode(MODAL_CODE); };
  $('code-join').onclick = () => joinByCode(MODAL_CODE);
}

/* Fetched once and shared: the join modal and the directory screen are two
   views of the same forty clubs, and whichever asks first pays for both. */
async function loadPublicClubs() {
  if (publicClubs.length) return true;
  publicLoadFailed = false;
  try {
    const snap = await getDocs(query(
      collection(db, 'clubs'),
      where('visibility', '==', 'public'),
      orderBy('memberCount', 'desc'),
      limit(40)
    ));
    publicClubs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // orderBy + where may need an index on a brand-new project; fall back
    console.warn('Falling back to unsorted club list:', err);
    try {
      const snap = await getDocs(query(collection(db, 'clubs'), limit(40)));
      publicClubs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.visibility !== 'private')
        .sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
    } catch (e2) {
      console.error('Could not load the public club directory:', e2);
      publicLoadFailed = true;
      return false;
    }
  }
  return true;
}

function renderJoinList(term) {
  const list = $('join-list');
  // a club you are banned from is not offered to you at all
  const visible = publicClubs.filter((c) => !bannedFrom[c.id]);
  const rows = term
    ? visible.filter((c) => (c.name || '').toLowerCase().includes(term) || (c.slug || '').includes(term))
    : visible.slice(0, 8);

  $('join-list-label').textContent = term ? 'Search results' : 'Trending clubs';
  $('join-empty').hidden = rows.length > 0;

  list.innerHTML = rows.map((c) => `
    <div class="join-row">
      ${clubAvatar(c, 'club-avatar sm')}
      <div class="join-row-info">
        <div class="join-row-name">${esc(c.name || c.id)}</div>
        <div class="join-row-meta">${c.memberCount || 1} member${(c.memberCount || 1) === 1 ? '' : 's'} · /${esc(c.slug || c.id)}</div>
      </div>
      <button class="btn primary sm" data-join="${esc(c.id)}">Join</button>
    </div>`).join('');

  list.querySelectorAll('[data-join]').forEach((b) => {
    b.onclick = () => doJoin(b.dataset.join, b);
  });
}

async function doJoin(clubId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Joining…'; }
  try {
    const res = await joinClub(user, clubId);
    location.href = '/clubs/' + res.slug;
  } catch (err) {
    if (err instanceof BannedError) { openBanned(err.record); }
    else {
      console.error(err);
      toast(err.message || 'Could not join that club.', 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Join'; }
  }
}

/* ═══ discover — the whole screen when you belong to nothing ═════════
   One row of public clubs, a search box over them, and the join code
   underneath. "see more" hands out another row at a time rather than
   dropping forty clubs on somebody who has not joined their first.
   ══════════════════════════════════════════════════════════════ */

const DISCOVER_ROW = 4;
let discoverShown = DISCOVER_ROW;
let discoverTerm = '';
let discoverWired = false;

async function openDiscover() {
  if (!discoverWired) { wireDiscover(); discoverWired = true; }
  if (!publicClubs.length) {
    $('discover-grid').hidden = false;
    $('discover-grid').innerHTML = Array.from({ length: DISCOVER_ROW },
      () => '<div class="discover-card skel" aria-hidden="true"></div>').join('');
  }
  await loadPublicClubs();
  renderDiscover();
}

function wireDiscover() {
  const search = $('discover-search');
  search.oninput = () => {
    discoverTerm = search.value.trim().toLowerCase();
    discoverShown = DISCOVER_ROW;   // a new search starts from one row again
    renderDiscover();
  };

  $('discover-more').onclick = () => {
    discoverShown += DISCOVER_ROW;
    renderDiscover();
  };

  const code = $('discover-code');
  code.oninput = () => {
    code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    $('discover-code-join').hidden = code.value.length < 4;
  };
  code.onkeydown = (e) => { if (e.key === 'Enter') joinByCode(DISCOVER_CODE); };
  $('discover-code-join').onclick = () => joinByCode(DISCOVER_CODE);
}

function renderDiscover() {
  const grid = $('discover-grid');
  const empty = $('discover-empty');

  // a club you are banned from is not offered to you at all
  const visible = publicClubs.filter((c) => !bannedFrom[c.id]);
  const rows = discoverTerm
    ? visible.filter((c) => (c.name || '').toLowerCase().includes(discoverTerm) || (c.slug || '').includes(discoverTerm))
    : visible;
  const page = rows.slice(0, discoverShown);

  grid.hidden = page.length === 0;
  empty.hidden = page.length > 0;
  empty.textContent = publicLoadFailed
    ? 'Could not load clubs right now.'
    : discoverTerm
      ? 'No public clubs match that search.'
      : 'No public clubs are listed yet — start the first one, or join with a code.';
  $('discover-more').hidden = rows.length <= page.length;

  grid.innerHTML = page.map((c) => `
    <button class="discover-card" data-join="${esc(c.id)}">
      ${clubAvatar(c, 'club-avatar sm')}
      <span class="discover-card-name">${esc(c.name || c.id)}</span>
      <span class="discover-card-meta">${c.memberCount || 1} member${(c.memberCount || 1) === 1 ? '' : 's'}</span>
      <span class="discover-card-go">Join →</span>
    </button>`).join('');

  /* The card is the button, so its label cannot be swapped for "Joining…"
     without throwing the rest of the card away — it dims in place instead. */
  grid.querySelectorAll('[data-join]').forEach((b) => {
    b.onclick = () => {
      b.classList.add('busy');
      doJoin(b.dataset.join).finally(() => b.classList.remove('busy'));
    };
  });
}

/* ═══ banned notice + appeal ═════════════════════════════════════════ */

function openBanned(rec) {
  $('join-modal').hidden = true;
  const existing = rec.appeal;
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `
    <div class="modal-card ban-card">
      <div class="ban-ico">🚫</div>
      <h3>You're banned from ${esc(rec.name || 'this club')}</h3>
      ${rec.reason ? `<div class="ban-reason"><span>Reason given</span><p>${esc(rec.reason)}</p></div>` : ''}
      ${existing
        ? `<p class="ban-note">You submitted an appeal on ${fmtWhen(existing.submittedAt)}. A club admin will review it.</p>`
        : `<p class="ban-note">If you think this was a mistake, you can send the club's admins an appeal.</p>`}
      <div class="ban-appeal" ${existing ? 'hidden' : ''}>
        <label for="ban-appeal-text">Your appeal</label>
        <textarea id="ban-appeal-text" rows="4" placeholder="Explain why you think the ban should be lifted…"></textarea>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn subtle" data-x>Close</button>
        ${existing ? '' : '<button class="btn primary" data-send>Submit appeal</button>'}
      </div>
    </div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('[data-x]').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };

  const send = m.querySelector('[data-send]');
  if (send) send.onclick = async () => {
    const text = m.querySelector('#ban-appeal-text').value.trim();
    if (!text) { toast('Write your appeal first', 'error'); return; }
    send.disabled = true; send.textContent = 'Sending…';
    try {
      await updateDoc(banRef(rec.clubId, user.uid), {
        appeal: { text, submittedAt: Date.now(), status: 'open' }
      });
      close();
      toast('Appeal sent to the club admins', 'ok');
    } catch (e) {
      console.error(e);
      toast('Could not send the appeal', 'error');
      send.disabled = false; send.textContent = 'Submit appeal';
    }
  };
}

const fmtWhen = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/* The code box exists twice — in the join modal and on the directory screen —
   and both do exactly the same thing, so they share the one function and
   bring their own three elements. */
const MODAL_CODE    = { input: 'club-code',    hint: 'code-hint',          btn: 'code-join' };
const DISCOVER_CODE = { input: 'discover-code', hint: 'discover-code-hint', btn: 'discover-code-join' };

async function joinByCode(ui) {
  const code = $(ui.input).value.trim().toUpperCase();
  const hint = $(ui.hint);
  if (code.length < 4) {
    hint.textContent = 'Enter the full join code.';
    hint.className = 'code-hint bad';
    return;
  }
  const btn = $(ui.btn);
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const snap = await getDoc(doc(db, 'clubCodes', code));
    if (!snap.exists()) {
      hint.textContent = "That code doesn't match any club.";
      hint.className = 'code-hint bad';
      return;
    }
    const res = await joinClub(user, snap.data().clubId);
    location.href = '/clubs/' + res.slug;
  } catch (err) {
    if (err instanceof BannedError) { openBanned(err.record); return; }
    console.error(err);
    hint.textContent = err.message || 'Could not join with that code.';
    hint.className = 'code-hint bad';
  } finally {
    btn.disabled = false; btn.textContent = 'Join';
  }
}

/* ═══ create ═════════════════════════════════════════════════════════ */

const draft = {
  icon: '♞',
  color: '#58cc02',
  visibility: 'public',
  code: makeCode(),
  template: 'starter',
  admins: []
};

let slugCheckTimer = null;

function openCreate() {
  $('create-modal').hidden = false;
  $('create-error').textContent = '';
  setTimeout(() => $('new-name').focus(), 60);
}

function wireCreate() {
  $('open-create').onclick = openCreate;
  document.querySelectorAll('[data-close-create]').forEach((b) => (b.onclick = () => ($('create-modal').hidden = true)));
  $('create-modal').onclick = (e) => { if (e.target === $('create-modal')) $('create-modal').hidden = true; };

  $('icon-picker').innerHTML = CLUB_ICONS
    .map((i, n) => `<button type="button" class="icon-opt${n === 0 ? ' on' : ''}" data-icon="${i}">${i}</button>`).join('');
  $('icon-picker').onclick = (e) => {
    const b = e.target.closest('[data-icon]');
    if (!b) return;
    draft.icon = b.dataset.icon;
    $('icon-picker').querySelectorAll('.icon-opt').forEach((o) => o.classList.toggle('on', o === b));
  };

  $('color-picker').innerHTML = CLUB_COLORS
    .map((c, n) => `<button type="button" class="color-opt${n === 0 ? ' on' : ''}" style="background:${c}" data-color="${c}"></button>`).join('');
  $('color-picker').onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    draft.color = b.dataset.color;
    $('color-picker').querySelectorAll('.color-opt').forEach((o) => o.classList.toggle('on', o === b));
  };

  $('visibility-choice').onclick = (e) => {
    const b = e.target.closest('[data-vis]');
    if (!b) return;
    draft.visibility = b.dataset.vis;
    $('visibility-choice').querySelectorAll('.seg-opt').forEach((o) => o.classList.toggle('on', o === b));
  };

  $('template-picker').onclick = (e) => {
    const b = e.target.closest('[data-template]');
    if (!b) return;
    draft.template = b.dataset.template;
    $('template-picker').querySelectorAll('.template-opt').forEach((o) => o.classList.toggle('on', o === b));
  };

  $('code-display').textContent = draft.code;
  $('code-regen').onclick = () => {
    draft.code = makeCode();
    $('code-display').textContent = draft.code;
  };
  $('code-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(draft.code);
      toast('Join code copied');
    } catch { toast('Copy failed — select it manually', 'error'); }
  };

  $('new-name').oninput = () => {
    const slug = slugify($('new-name').value) || 'your-club';
    $('slug-preview').textContent = slug;
    clearTimeout(slugCheckTimer);
    $('slug-state').textContent = '';
    $('slug-state').className = 'slug-state';
    if (!$('new-name').value.trim()) return;
    slugCheckTimer = setTimeout(() => checkSlug(slug), 400);
  };

  wireAdminChips();
  $('create-submit').onclick = createClub;
}

async function checkSlug(slug) {
  const el = $('slug-state');
  el.textContent = 'checking…';
  el.className = 'slug-state';
  try {
    const snap = await getDoc(clubRef(slug));
    if (snap.exists()) {
      el.textContent = 'taken';
      el.className = 'slug-state bad';
    } else {
      el.textContent = 'available';
      el.className = 'slug-state ok';
    }
  } catch { el.textContent = ''; }
}

function wireAdminChips() {
  const wrap = $('admin-chips');
  const input = $('admin-email-input');

  const render = () => {
    wrap.querySelectorAll('.email-chip').forEach((c) => c.remove());
    draft.admins.forEach((mail, i) => {
      const chip = document.createElement('span');
      chip.className = 'email-chip';
      chip.innerHTML = `${esc(mail)}<button type="button" data-rm="${i}" aria-label="Remove">×</button>`;
      wrap.insertBefore(chip, input);
    });
  };

  const add = () => {
    const raw = input.value.trim().toLowerCase().replace(/,$/, '');
    if (!raw) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) { toast('That doesn\'t look like an email', 'error'); return; }
    if (!draft.admins.includes(raw)) draft.admins.push(raw);
    input.value = '';
    render();
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    if (e.key === 'Backspace' && !input.value && draft.admins.length) { draft.admins.pop(); render(); }
  };
  input.onblur = add;
  wrap.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { draft.admins.splice(+rm.dataset.rm, 1); render(); return; }
    input.focus();
  };
}

/* Everything a previous club at this address could have left behind. The
   member rows are the ones that actually break things — a stale row makes the
   founder's own join a no-op — but stale events and puzzles are just as
   confusing to look at. Failures here are swallowed: a club that exists with
   a bit of litter beats no club at all. */
async function clearLeftovers(slug) {
  const names = ['events', 'puzzles', 'announcements', 'shopItems', 'shopOrders',
    'attendanceForms', 'attendanceResponses', 'puzzleAttempts', 'bans', 'applications'];
  /* Published check-ins are root documents keyed by club, so they outlive the
     events they belong to and have to be named to be cleared. */
  try {
    const open = await getDocs(query(collection(db, 'publicAttendance'),
      where('clubId', '==', slug), limit(200)));
    await Promise.all(open.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  } catch (e) { console.warn('Could not clear the old check-ins', e); }
  try {
    for (const name of names) {
      const snap = await getDocs(collection(db, 'clubs', slug, name));
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    }
    const members = await getDocs(collection(db, 'clubs', slug, 'members'));
    await Promise.all(members.docs
      .filter((d) => d.id !== user.uid)
      .map((d) => deleteDoc(d.ref).catch(() => {})));
    // the counter was written as 0 and the founder's join bumped it to 1
    await updateDoc(clubRef(slug), { memberCount: 1 }).catch(() => {});
  } catch (e) {
    console.warn('Could not clear leftovers at /clubs/' + slug, e);
  }
}

async function createClub() {
  const err = $('create-error');
  const name = $('new-name').value.trim();
  err.textContent = '';

  if (!name) { err.textContent = 'Give your club a name.'; return; }
  const slug = slugify(name);
  if (!slug) { err.textContent = 'That name needs at least one letter or number.'; return; }

  const btn = $('create-submit');
  btn.disabled = true; btn.textContent = 'Creating…';
  let step = 'checking the address';

  try {
    if ((await getDoc(clubRef(slug))).exists()) {
      err.textContent = 'That web address is taken — try a slightly different name.';
      return;
    }

    const blocks = draft.template === 'starter' ? STARTER_BLOCKS : [];
    const layout = draft.template === 'starter' ? STARTER_LAYOUT : BLANK_LAYOUT;

    /* Built once and kept, because the public listing written further down
       has to be a field-for-field copy of this document — a second Date.now()
       would be a different club as far as the rules are concerned. */
    const clubDoc = {
      name,
      slug,
      description: $('new-desc').value.trim(),
      icon: draft.icon,
      color: draft.color,
      visibility: draft.visibility,
      ownerUid: user.uid,
      pendingAdmins: draft.admins,
      blocks,
      layout,
      template: draft.template,
      memberCount: 0,
      code: draft.code,
      createdAt: Date.now()
    };

    // One write, not two: the creator is not a member yet, so a follow-up
    // update to attach the code would be refused by the admin rule.
    step = 'creating the club';
    await setDoc(clubRef(slug), clubDoc);

    step = 'registering the join code';
    await setDoc(doc(db, 'clubCodes', draft.code), { clubId: slug, createdAt: Date.now() });

    step = 'adding you as admin';
    await joinClub(user, slug, { role: 'founder' });

    /* A club deleted before deletes cleaned up properly can have left events,
       puzzles, members and bans sitting under this address. The club document
       is new, so anything down there belongs to whatever used to be here —
       and inheriting it is what makes a brand-new club look like the old one
       came back. This runs after the founder seat exists, because clearing it
       needs the permissions that seat carries. */
    step = 'clearing the old address';
    await clearLeftovers(slug);

    /* A public club belongs on the JagChess Network from the minute it
       exists. This has to come after the founder seat, because writing the
       listing is a staff action. It never throws — a club that is created
       but not yet listed is fixed by its next admin visit. */
    step = 'listing the club';
    // clearLeftovers has just settled the counter at 1, the founder's seat
    await syncPublicClub({ id: slug, ...clubDoc, memberCount: 1 }, { known: null });

    location.href = '/clubs/' + slug + '?welcome=1';
  } catch (e) {
    console.error('Club creation failed while ' + step + ':', e);
    err.textContent = e.code === 'permission-denied'
      ? `Permission denied while ${step}.`
      : (e.message || 'Could not create the club.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create club';
  }
}
