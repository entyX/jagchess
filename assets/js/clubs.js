/* ═══════════════════════════════════════════════════════════════════════
   clubs.js — the "My clubs" hub: list memberships, join, create.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  auth, db, requireUser, signOut, myClubs, joinClub, BannedError,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit,
  clubRef, memberRef, banRef, slugify, makeCode, initials, esc, toast,
  confirmDialog, promptDialog, isStaff, ROLE_LABEL,
  CLUB_COLORS, CLUB_ICONS
} from './club-core.js';

const $ = (id) => document.getElementById(id);
const STARTER_BLOCKS = [
  { id: 'events',      type: 'events',      name: 'Events' },
  { id: 'puzzles',     type: 'puzzles',     name: 'Puzzles' },
  { id: 'newsletters', type: 'newsletters', name: 'Newsletters' },
  { id: 'leaderboard', type: 'leaderboard', name: 'Leaderboard' },
  { id: 'duels',       type: 'duels',       name: 'Duels' },
  { id: 'store',       type: 'store',       name: 'Store' },
  { id: 'donate',      type: 'donate',      name: 'Donate' }
];

const STARTER_LAYOUT = [
  { i: 'w1', type: 'welcome',      x: 0, y: 0, w: 8, h: 3 },
  { i: 'w2', type: 'quick-duel',   x: 8, y: 0, w: 4, h: 3 },
  { i: 'w3', type: 'events-next',  x: 0, y: 3, w: 7, h: 5 },
  { i: 'w4', type: 'leaderboard',  x: 7, y: 3, w: 5, h: 5 },
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
})();

/* ═══ the original club moves itself ═════════════════════════════════
   No button, no admin decision: the first time an authorised admin signs
   in, the club is created and the old data is copied across. Everything
   is merge-only and re-runnable, so a half-finished move simply resumes.
   ═══════════════════════════════════════════════════════════════════ */

const LEGACY = {
  slug: 'northcreekchess',
  name: 'North Creek Chess Club',
  admins: ['shaurya.sahdev7@gmail.com', '2025510@apps.nsd.org', 'northcreekchessclub@gmail.com']
};

/* Silent, admin-only, and invisible to members. Creates the club if it is
   somehow missing and finishes any unfinished copy in the background. */
async function ensureLegacyClub() {
  const email = (user.email || '').toLowerCase();
  if (!LEGACY.admins.includes(email)) return;

  try {
    const snap = await getDoc(clubRef(LEGACY.slug));
    const club = snap.exists() ? snap.data() : null;
    if (club && club.legacyImported) return;

    if (!club) {
      const code = makeCode();
      await setDoc(clubRef(LEGACY.slug), {
        name: LEGACY.name,
        slug: LEGACY.slug,
        description: 'The original JagChess club — puzzles, events, points and prizes.',
        icon: '♞',
        color: '#58cc02',
        visibility: 'private',
        ownerUid: user.uid,
        pendingAdmins: LEGACY.admins,
        blocks: STARTER_BLOCKS,
        layout: STARTER_LAYOUT,
        template: 'starter',
        legacySource: true,
        memberCount: 0,
        code,
        createdAt: Date.now()
      }, { merge: true });
      await setDoc(doc(db, 'clubCodes', code), { clubId: LEGACY.slug, createdAt: Date.now() });
      await joinClub(user, LEGACY.slug, { role: 'founder' });
      await renderClubs();
    }

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

  $('hub-empty').hidden = clubs.length > 0;
  grid.hidden = clubs.length === 0;

  grid.innerHTML = clubs.map((c) => `
    <div class="club-card-wrap">
      <a class="club-card" href="/clubs/${esc(c.slug || c.id)}">
        <div class="club-card-top">
          <span class="club-avatar" style="background:${esc(c.color || '#58cc02')}">${esc(c.icon || '♞')}</span>
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
  document.querySelectorAll('[data-open-create]').forEach((b) => (b.onclick = openCreate));
  document.querySelectorAll('[data-open-join]').forEach((b) => (b.onclick = openJoin));
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
    await deleteDoc(clubRef(club.id));
    await setDoc(doc(db, 'users', user.uid), { clubs: { [club.id]: null } }, { merge: true });
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

function openJoin() {
  $('join-modal').hidden = false;
  $('club-search').value = '';
  $('club-code').value = '';
  $('code-hint').textContent = 'Ask a club admin for the 6-character join code.';
  $('code-hint').className = 'code-hint';
  loadPublicClubs();
  setTimeout(() => $('club-search').focus(), 60);
}

function wireJoin() {
  $('open-join').onclick = openJoin;
  document.querySelectorAll('[data-close-join]').forEach((b) => (b.onclick = () => ($('join-modal').hidden = true)));
  $('join-modal').onclick = (e) => { if (e.target === $('join-modal')) $('join-modal').hidden = true; };

  $('club-search').oninput = () => renderJoinList($('club-search').value.trim().toLowerCase());

  $('club-code').oninput = (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  };
  $('club-code').onkeydown = (e) => { if (e.key === 'Enter') joinByCode(); };
  $('code-join').onclick = joinByCode;
}

async function loadPublicClubs() {
  const list = $('join-list');
  list.innerHTML = '<div class="empty-state">Loading clubs…</div>';
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
      list.innerHTML = '<div class="empty-state">Could not load clubs right now.</div>';
      return;
    }
  }
  renderJoinList('');
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
      <span class="club-avatar sm" style="background:${esc(c.color || '#58cc02')}">${esc(c.icon || '♞')}</span>
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

async function joinByCode() {
  const code = $('club-code').value.trim().toUpperCase();
  const hint = $('code-hint');
  if (code.length < 4) {
    hint.textContent = 'Enter the full join code.';
    hint.className = 'code-hint bad';
    return;
  }
  const btn = $('code-join');
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

    // One write, not two: the creator is not a member yet, so a follow-up
    // update to attach the code would be refused by the admin rule.
    step = 'creating the club';
    await setDoc(clubRef(slug), {
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
    });

    step = 'registering the join code';
    await setDoc(doc(db, 'clubCodes', draft.code), { clubId: slug, createdAt: Date.now() });

    step = 'adding you as admin';
    await joinClub(user, slug, { role: 'founder' });

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
