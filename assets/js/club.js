/* ═══════════════════════════════════════════════════════════════════════
   club.js — the club shell: membership gate, sidebar, routing,
   editor mode, block management.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  auth, db, requireUser, signOut, joinClub,
  doc, getDoc, setDoc, updateDoc, onSnapshot,
  clubRef, memberRef, initials, esc, toast, confirmDialog, promptDialog, ROLE_LABEL
} from './club-core.js';

import { BLOCK_TYPES, renderBlock } from './club-blocks.js';
import { renderDashboard } from './club-dash.js';
import {
  openDuelStage, closeDuelStage, closeDuelWaiting,
  watchChallenges, watchActiveDuels, gameOf, duelsHash
} from './club-duels.js';
import { openClubShare, canShareClub } from './club-share.js';
import { maybePromptAttendance } from './club-attendance.js';

const $ = (id) => document.getElementById(id);

export const ctx = {
  clubId: null,
  club: null,
  user: null,
  member: null,
  isAdmin: false,
  mode: 'admin',      // 'admin' | 'editor' (admins only)
  page: 'dashboard',
  cleanup: null
};

/* the duel you are currently in, if any — drives the header's resume chip */
let myGame = null;

/* ═══ boot ═══════════════════════════════════════════════════════════ */

(async function init() {
  const slug = decodeURIComponent(location.pathname.replace(/^\/clubs\/?/, '').replace(/\/$/, ''));
  if (!slug) { location.replace('/clubs'); return; }
  ctx.clubId = slug;

  ctx.user = await requireUser();

  const snap = await getDoc(clubRef(slug));
  if (!snap.exists()) return showGate({ missing: true });
  ctx.club = { id: snap.id, ...snap.data() };
  document.title = (ctx.club.name || 'Club') + ' · JagChess';

  // Membership is never implied — you join a club deliberately.
  const mem = await getDoc(memberRef(slug, ctx.user.uid));
  if (!mem.exists()) return showGate({});
  ctx.member = mem.data();
  ctx.isAdmin = ctx.member.role === 'admin' || ctx.member.role === 'founder';
  ctx.mode = 'admin';

  $('club-boot').hidden = true;
  $('sidebar').hidden = false;
  $('app-main').hidden = false;

  paintIdentity();
  paintStats();
  buildNav();
  wireChrome();

  // your own member row drives the header chips and your club rating, so it
  // stays live rather than being read once at boot
  onSnapshot(memberRef(slug, ctx.user.uid), (s) => {
    if (!s.exists()) return;
    ctx.member = s.data();
    ctx.isAdmin = ctx.member.role === 'admin' || ctx.member.role === 'founder';
    paintIdentity();
    paintStats();
  });

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
  });

  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === '1') {
    toast('Club created — you\'re the founder ♞', 'ok');
    history.replaceState({}, '', location.pathname);
  }

  route(location.hash.replace(/^#/, '') || 'dashboard');
  window.addEventListener('hashchange', () => route(location.hash.replace(/^#/, '') || 'dashboard'));

  /* A scanned attendance QR names its event; otherwise we look for whatever
     is running right now. Either way the check-in comes to you. */
  const scanned = params.get('att');
  if (scanned) history.replaceState({}, '', location.pathname + location.hash);
  maybePromptAttendance(ctx, { goToEvents }, scanned || undefined);
})();

/* ═══ jumping to the events page ═════════════════════════════════════ */

/* Events is a block, so its page id is whatever the club named it. */
function goToEvents() {
  const block = (ctx.club.blocks || []).find((b) => b.type === 'events');
  if (block) location.hash = block.id;
  else toast('This club has no events page yet.');
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
  $('gate-avatar').textContent = c.icon || '♞';
  $('gate-avatar').style.background = c.color || '#58cc02';
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
  $('club-icon').textContent = c.icon || '♞';
  $('club-icon').style.background = c.color || '#58cc02';
  $('club-name').textContent = c.name || c.id;
  $('club-name').title = c.name || c.id;
  $('club-role').textContent = ROLE_LABEL[ctx.member.role] || 'Member';

  const name = ctx.member.username || (ctx.user.email || '').split('@')[0];
  $('me-name').textContent = name;
  $('me-email').textContent = ctx.user.email || '';
  const av = $('me-avatar');
  av.textContent = initials(name);
  av.style.background = ctx.member.avatarColor || '#1cb0f6';

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

const FIXED_PAGES = [
  { id: 'dashboard', name: 'Dashboard', icon: 'home' },
  { id: 'profile', name: 'Profile', icon: 'user' }
];

const ADMIN_PAGES = [
  { id: 'members', name: 'Members', icon: 'users' },
  { id: 'settings', name: 'Club settings', icon: 'cog' }
];

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
  swords: '<path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/>'
};

export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.home}</svg>`;

function navButton(id, name, iconName, opts = {}) {
  const b = document.createElement('button');
  b.className = 'tab' + (ctx.page === id ? ' active' : '');
  b.dataset.page = id;
  b.innerHTML = `${icon(iconName)}<span>${esc(name)}</span>` +
    (opts.editable && ctx.mode === 'editor'
      ? '<span class="tab-tools"><i data-rename title="Rename">✎</i><i data-remove title="Remove">✕</i></span>'
      : '');
  b.onclick = (e) => {
    if (e.target.closest('[data-rename]')) { e.stopPropagation(); renameBlock(id); return; }
    if (e.target.closest('[data-remove]')) { e.stopPropagation(); removeBlock(id); return; }
    location.hash = id;
    $('app').classList.remove('nav-open');
  };
  return b;
}

function buildNav() {
  const fixed = $('nav-fixed');
  const blocks = $('nav-blocks');
  const admin = $('nav-admin');
  fixed.innerHTML = '';
  blocks.innerHTML = '';
  admin.innerHTML = '';

  fixed.appendChild(navButton('dashboard', 'Dashboard', 'home'));

  (ctx.club.blocks || []).forEach((b) => {
    const meta = BLOCK_TYPES[b.type];
    if (!meta) return;
    blocks.appendChild(navButton(b.id, b.name || meta.name, meta.icon, { editable: ctx.isAdmin }));
  });

  fixed.appendChild(navButton('profile', 'Profile', 'user'));

  $('nav-blocks-group').hidden = !(ctx.club.blocks || []).length && !ctx.isAdmin;
  $('add-block-btn').hidden = !ctx.isAdmin;
  $('nav-admin-group').hidden = !ctx.isAdmin;
  if (ctx.isAdmin) ADMIN_PAGES.forEach((p) => admin.appendChild(navButton(p.id, p.name, p.icon)));

  $('mode-switch').hidden = !ctx.isAdmin;
}

function markActive() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === ctx.page));
}

/* ═══ routing ════════════════════════════════════════════════════════ */

/* Duels are always reachable, block or no block: a member who was challenged
   has to be able to answer even if nobody has added the page to the sidebar. */
const STANDALONE = ['profile', 'members', 'settings', 'duels'];

async function route(raw) {
  if (ctx.cleanup) { try { ctx.cleanup(); } catch (_) {} ctx.cleanup = null; }

  // a game opens as a layer over the duels page, so #duel/<id> survives a reload
  const duel = /^duel\/(.+)$/.exec(raw);
  const pageId = duel ? duelsHash(ctx) : raw;

  ctx.page = pageId;
  markActive();

  const host = $('page-host');
  host.innerHTML = '';
  $('topbar-actions').innerHTML = '';
  $('editor-bar').hidden = !(ctx.mode === 'editor' && pageId === 'dashboard');
  if (!duel) closeDuelStage();
  // a queue entry or an open challenge belongs to the screen that made it
  closeDuelWaiting();

  // admin-only pages are never reachable by typing the hash
  if (!ctx.isAdmin && (pageId === 'members' || pageId === 'settings')) {
    location.hash = 'dashboard';
    return;
  }

  const block = (ctx.club.blocks || []).find((b) => b.id === pageId);
  const meta = block ? BLOCK_TYPES[block.type] : null;

  if (pageId === 'dashboard') {
    setTitle('Dashboard', ctx.mode === 'editor' ? 'Arrange the widgets your members see.' : (ctx.club.description || ''));
    ctx.cleanup = await renderDashboard(ctx, host, { setTitle });
    return;
  }

  if (!block && STANDALONE.indexOf(pageId) === -1) {
    location.hash = 'dashboard';
    return;
  }

  const type = block ? block.type : pageId;
  const fallbackName = { profile: 'Profile', members: 'Members', settings: 'Club settings', duels: 'Duels' };
  const name = block ? (block.name || meta.name) : fallbackName[pageId];
  setTitle(name, block ? meta.sub : (pageId === 'duels' ? BLOCK_TYPES.duels.sub : ''));

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
  $('logout').onclick = () => signOut(auth).then(() => (location.href = '/login'));
  $('invite-btn').onclick = () => openClubShare(ctx);

  $('mode-switch').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setMode(b.dataset.mode);
  };
  $('editor-done').onclick = () => setMode('admin');
  $('editor-reset').onclick = resetLayout;

  $('add-block-btn').onclick = openBlockPicker;
  document.querySelectorAll('[data-close-blocks]').forEach((b) => (b.onclick = () => ($('add-block-modal').hidden = true)));
  $('add-block-modal').onclick = (e) => { if (e.target === $('add-block-modal')) $('add-block-modal').hidden = true; };
  $('block-search').oninput = () => renderBlockPicker($('block-search').value.trim().toLowerCase());
}

function setMode(mode) {
  ctx.mode = mode;
  document.body.classList.toggle('is-editor', mode === 'editor');
  $('mode-switch').querySelectorAll('.mode-opt').forEach((o) => o.classList.toggle('on', o.dataset.mode === mode));
  buildNav();
  route(ctx.page);
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

export { setMode };
