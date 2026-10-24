/* ═══════════════════════════════════════════════════════════════════════
   network.js — the JagChess Network: every public club, open to the world.

   This page is for people who do not have an account, and only for them —
   signing in takes you to your clubs, and `signed-out-only` sees to that.
   Everything here follows from having no session to work with:

     · it reads `publicClubs`, the world-readable mirror of a public club,
       never `clubs` itself — that document carries the join code
     · a club's panel is its registration form, which lands in the club's
       Members tab as a pending member for an admin to invite
     · and beside it, the shortcut past all of that: an account, which turns
       every club on this page into one click instead of a wait

   Nothing here needs to know who is looking, because the answer is always
   "nobody yet".
   ═══════════════════════════════════════════════════════════════════════ */

import './signed-out-only.js';

import {
  db, collection, getDoc, getDocs, addDoc, query, orderBy, limit,
  applicationCol, memberEmailRef, emailKey, esc, toast, fmtDate, clubAvatar
} from './club-core.js';

import {
  renderForm, wireForm, readForm, allQuestions, normalizeForm
} from './registration-form.js';

const $ = (id) => document.getElementById(id);

let clubs = [];        // every public club, as listed
let sort = 'members';
let term = '';
let openSlug = null;   // the club whose modal is up, so ?club= stays honest

/* ═══ boot ═══════════════════════════════════════════════════════════
   Called from the very bottom of the file, not from here: the helpers it
   reaches on its first synchronous pass are `const`s further down, and a
   const is not there yet while the module is still being evaluated.
   ─────────────────────────────────────────────────────────────────── */

function init() {
  $('year').textContent = String(new Date().getFullYear());
  wireChrome();
  wireSearch();
  wireModal();
  loadClubs();
}

function wireChrome() {
  const burger = $('nav-burger');
  const sheet = $('nav-sheet');
  burger.onclick = () => {
    const open = sheet.hidden;
    sheet.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  };
  sheet.querySelectorAll('a').forEach((a) => (a.onclick = () => {
    sheet.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }));

  $('net-sort').onclick = (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    sort = b.dataset.sort;
    $('net-sort').querySelectorAll('.net-sort-opt').forEach((o) => o.classList.toggle('on', o === b));
    paintGrid();
  };
}

function wireSearch() {
  const q = $('net-q');
  const clear = $('net-q-clear');
  q.oninput = () => {
    term = q.value.trim().toLowerCase();
    clear.hidden = !q.value;
    paintGrid();
  };
  clear.onclick = () => { q.value = ''; term = ''; clear.hidden = true; q.focus(); paintGrid(); };
  q.onkeydown = (e) => { if (e.key === 'Escape') clear.onclick(); };
}

/* ═══ the listing ════════════════════════════════════════════════════ */

async function loadClubs() {
  const grid = $('net-grid');
  grid.innerHTML = skeletons(6);
  try {
    let snap;
    try {
      snap = await getDocs(query(collection(db, 'publicClubs'), orderBy('memberCount', 'desc'), limit(120)));
    } catch (e) {
      // a brand-new project has no index for that order; the list is small
      console.warn('Falling back to an unsorted listing:', e);
      snap = await getDocs(query(collection(db, 'publicClubs'), limit(120)));
    }
    clubs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.visibility !== 'private');
  } catch (e) {
    console.error(e);
    grid.innerHTML = '';
    $('net-empty').hidden = false;
    $('net-empty-title').textContent = 'The Network is not answering';
    $('net-empty-sub').textContent = 'Something went wrong loading the club list. Refresh the page to try again.';
    return;
  }

  paintStats();
  paintGrid();

  // a QR code or a shared link opens straight onto one club
  const wanted = new URLSearchParams(location.search).get('club');
  if (wanted && !openSlug) openClub(wanted);
}

const skeletons = (n) =>
  Array.from({ length: n }, () => '<div class="net-card is-loading"><span></span><span></span><span></span></div>').join('');

function paintStats() {
  const members = clubs.reduce((n, c) => n + (c.memberCount || 0), 0);
  const modules = clubs.reduce((n, c) => n + ((c.blocks || []).length), 0);
  $('stat-clubs').textContent = clubs.length;
  $('stat-members').textContent = members;
  $('stat-modules').textContent = modules;
  $('net-stats').hidden = clubs.length === 0;
}

const matches = (c) => {
  if (!term) return true;
  return [c.name, c.slug, c.description].some((f) => String(f || '').toLowerCase().includes(term));
};

function sorted(rows) {
  const copy = rows.slice();
  if (sort === 'name') return copy.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (sort === 'new') return copy.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return copy.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
}

function paintGrid() {
  const rows = sorted(clubs.filter(matches));
  const grid = $('net-grid');

  $('net-list-title').textContent = term
    ? `${rows.length} club${rows.length === 1 ? '' : 's'} matching “${term}”`
    : 'Public clubs';

  $('net-empty').hidden = rows.length > 0;
  if (!rows.length && clubs.length) {
    $('net-empty-title').textContent = 'No clubs match that search';
    $('net-empty-sub').textContent = 'Try a shorter word, or clear the search to see everything on the Network.';
  }
  if (!clubs.length) {
    $('net-empty').hidden = false;
    $('net-empty-title').textContent = 'No public clubs yet';
    $('net-empty-sub').textContent = 'Every club here chose to be listed. Start one of your own and it can be the first.';
  }

  grid.innerHTML = rows.map(cardHTML).join('');
  grid.querySelectorAll('[data-club]').forEach((card) => {
    card.onclick = () => openClub(card.dataset.club);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClub(card.dataset.club); }
    };
  });
}

const moduleChips = (c, max) => {
  const blocks = (c.blocks || []).filter((b) => b && b.name);
  const shown = blocks.slice(0, max);
  const rest = blocks.length - shown.length;
  return shown.map((b) => `<span class="net-chip">${esc(b.name)}</span>`).join('') +
    (rest > 0 ? `<span class="net-chip more">+${rest}</span>` : '');
};

export function cardHTML(c) {
  const count = c.memberCount || 0;
  return `
    <article class="net-card" data-club="${esc(c.id)}" tabindex="0" role="button"
             aria-label="Open ${esc(c.name || c.id)}">
      <div class="net-card-top">
        ${clubAvatar(c, 'net-card-avatar')}
        <div class="net-card-id">
          <h3>${esc(c.name || c.id)}</h3>
          <span class="net-card-slug">/clubs/${esc(c.slug || c.id)}</span>
        </div>
      </div>
      <p class="net-card-desc">${esc(c.description || 'A chess club on JagChess.')}</p>
      <div class="net-card-chips">${moduleChips(c, 3)}</div>
      <div class="net-card-foot">
        <span class="net-card-count">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.4" r="3.2"/><path d="M2.6 19.4c0-3.3 2.9-5.6 6.4-5.6s6.4 2.3 6.4 5.6"/><path d="M16.6 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.2 19.4c0-2-.5-3.6-1.5-4.7"/></svg>
          ${count} member${count === 1 ? '' : 's'}
        </span>
        <span class="net-card-go">Sign up →</span>
      </div>
    </article>`;
}

/* ═══ one club ═══════════════════════════════════════════════════════ */

function wireModal() {
  const m = $('club-modal');
  $('cm-close').onclick = closeClub;
  m.onclick = (e) => { if (e.target === m) closeClub(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !m.hidden) closeClub();
  });
  window.addEventListener('popstate', () => {
    const wanted = new URLSearchParams(location.search).get('club');
    if (wanted) openClub(wanted, { silent: true });
    else closeClub({ silent: true });
  });
}

function closeClub(opts = {}) {
  $('club-modal').hidden = true;
  document.body.style.overflow = '';
  openSlug = null;
  if (!opts.silent && new URLSearchParams(location.search).get('club')) {
    history.pushState({}, '', location.pathname);
  }
}

function openClub(id, opts = {}) {
  const club = clubs.find((c) => c.id === id || c.slug === id);
  if (!club) {
    if (!opts.silent) toast('That club is not on the Network.', 'error');
    return;
  }
  openSlug = club.id;

  const m = $('club-modal');
  $('cm-grid').innerHTML = modalHTML(club);
  m.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!opts.keepScroll) m.scrollTop = 0;

  const url = location.pathname + '?club=' + encodeURIComponent(club.slug || club.id);
  if (!opts.silent && location.pathname + location.search !== url) history.pushState({}, '', url);

  wirePanel(club);
  window.jagTrack?.('network_club_opened', { club: club.id });
}

const founded = (ms) => (ms ? fmtDate(ms, { month: 'short', year: 'numeric' }) : '—');

export function modalHTML(c) {
  const count = c.memberCount || 0;
  const blocks = (c.blocks || []).filter((b) => b && b.name);

  return `
    <div class="cm-left">
      <div class="cm-head">
        ${clubAvatar(c, 'cm-avatar')}
        <div>
          <h2 id="cm-name">${esc(c.name || c.id)}</h2>
          <span class="cm-slug">${esc(location.host)}/clubs/${esc(c.slug || c.id)}</span>
        </div>
      </div>

      <span class="cm-badge">Public club · open to new members</span>

      <p class="cm-desc">${esc(c.description || 'This club has not written a description yet — but its doors are open.')}</p>

      <div class="cm-stats">
        <div class="cm-stat"><b>${count}</b><span>member${count === 1 ? '' : 's'}</span></div>
        <div class="cm-stat"><b>${blocks.length}</b><span>module${blocks.length === 1 ? '' : 's'}</span></div>
        <div class="cm-stat"><b>${esc(founded(c.createdAt))}</b><span>on JagChess</span></div>
      </div>

      ${blocks.length ? `
      <div class="cm-section">
        <h4>What's inside</h4>
        <div class="net-card-chips">${moduleChips(c, 12)}</div>
      </div>` : ''}

      <div class="cm-section">
        <h4>How joining works</h4>
        <ol class="cm-steps">
          <li><b>With an account</b> — press Join and you are in, straight away.</li>
          <li><b>Without one</b> — fill in the form and the club's admins get your details.</li>
          <li><b>They invite you</b> — an email arrives with a link that takes you in.</li>
        </ol>
      </div>

      <div class="cm-pitch">
        <span class="cm-pitch-mark" aria-hidden="true">⚡</span>
        <div>
          <b>Log in or create an account to join instantly.</b>
          <p>An account gets you into ${esc(c.name || 'this club')} — and every other public club
             on the Network — with one click, no registration form at all.</p>
          <div class="cm-pitch-actions">
            <a class="btn3d sm" href="/login?mode=signup&next=${encodeURIComponent(joinNext(c))}">Create an account</a>
            <a class="btn3d ghost sm" href="/login?next=${encodeURIComponent(joinNext(c))}">Log in</a>
          </div>
        </div>
      </div>
    </div>

    <div class="cm-right">
      <div id="cm-panel">${formPanelHTML(c)}</div>
    </div>`;
}

/* Where signing in should drop you: straight into the club you were looking
   at, joined, rather than back onto a page of cards. */
const joinNext = (c) => '/clubs/' + (c.slug || c.id) + '?invite=1';

function formPanelHTML(c) {
  const custom = normalizeForm(c.registrationForm);
  return `
    <div class="cm-panel">
      <h3>Sign up for ${esc(c.name || 'this club')}</h3>
      <p class="cm-panel-sub">No account? Register your interest here. You won't be a member yet —
        the club's admins get your answers and can email you an invite.</p>
      <form class="rf-form" id="cm-form" novalidate>
        ${renderForm(custom)}
        <p class="rf-form-error" id="cm-form-error" hidden></p>
        <button class="btn3d lg block" type="submit" id="cm-submit">Send my registration</button>
        <p class="cm-panel-foot">Your answers go to ${esc(c.name || 'the club')}'s admins only.</p>
      </form>
    </div>`;
}

function wirePanel(c) {
  const form = $('cm-form');
  if (!form) return;
  wireForm(form);
  form.onsubmit = (e) => { e.preventDefault(); submitApplication(c, form); };
}

/* Says so on the email field itself, where the answer belongs. */
function failEmail(form, message) {
  const err = form.querySelector('[data-err="email"]');
  if (err) { err.textContent = message; err.hidden = false; }
  const field = form.querySelector('[data-field="email"]');
  if (field) {
    field.classList.add('bad');
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

async function submitApplication(c, form) {
  const custom = normalizeForm(c.registrationForm);
  const { ok, values, firstBad } = readForm(form, custom);
  const errBox = $('cm-form-error');

  if (!ok) {
    errBox.textContent = 'Some answers still need filling in.';
    errBox.hidden = false;
    const field = form.querySelector('[data-field="' + CSS.escape(firstBad) + '"]');
    if (field) field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  errBox.hidden = true;

  const btn = $('cm-submit');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  /* Someone already in the club has nothing to register for — they just need
     to sign in. The club publishes a hash of each member's address for
     exactly this question; see memberEmails in club-core. */
  try {
    const key = await emailKey(values.email);
    if (key && (await getDoc(memberEmailRef(c.id, key))).exists()) {
      failEmail(form, 'This account has already joined the club — log in instead.');
      errBox.innerHTML = 'That address is already a member of ' + esc(c.name || 'this club') +
        '. <a href="/login">Log in</a> and the club is waiting for you.';
      errBox.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Send my registration';
      return;
    }
  } catch (e) {
    // a failed lookup must never block a genuine sign-up
    console.warn('Could not check that address against the club', e);
  }

  /* The questions ride along with the answers. A club that edits its form
     next week must still be able to read what this person was actually
     asked — an answer without its question is not a record of anything. */
  const payload = {
    clubId: c.id,
    status: 'pending',
    firstName: String(values.firstName || '').slice(0, 60),
    lastName: String(values.lastName || '').slice(0, 60),
    email: String(values.email || '').toLowerCase().slice(0, 140),
    answers: values,
    questions: allQuestions(custom).map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: !!q.required,
      ...(q.type === 'slider' ? { min: q.min, max: q.max, step: q.step } : {})
    })),
    submittedAt: Date.now()
  };

  try {
    await addDoc(applicationCol(c.id), payload);
    window.jagTrack?.('network_application', { club: c.id });
    closeClub();
    openRegistered(c, payload);
  } catch (e) {
    console.error(e);
    errBox.textContent = e.code === 'permission-denied'
      ? 'This club has stopped taking sign-ups through the Network.'
      : 'Could not send that — check your connection and try again.';
    errBox.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Send my registration';
  }
}

/* The club's own modal is finished with by this point, so it closes and this
   takes its place: small, and about one thing. Two ways forward, in the order
   they will actually happen — wait for the invite, or stop waiting. */
export function openRegistered(c, app) {
  const next = encodeURIComponent(joinNext(c));
  const wrap = document.createElement('div');
  wrap.className = 'net-modal net-done-modal';
  wrap.innerHTML = `
    <div class="net-done-card" role="dialog" aria-modal="true" aria-labelledby="done-title">
      <button class="net-modal-close" data-x aria-label="Close">✕</button>
      <span class="net-done-mark" aria-hidden="true">✓</span>
      <h2 id="done-title">You're on the list, ${esc(app.firstName)}</h2>
      <p class="net-done-sub">
        <b>Check your email soon</b> — ${esc(c.name || 'the club')}'s admins can see your
        registration now, and an invite link will arrive at <b>${esc(app.email)}</b>.
      </p>
      <div class="net-done-or"><span>or don't wait</span></div>
      <p class="net-done-alt">Create an account and join ${esc(c.name || 'the club')} today —
        no invite needed, and every other public club opens too.</p>
      <a class="btn3d block" href="/login?mode=signup&next=${next}">Create an account and join today</a>
      <button class="btn3d ghost block" data-x>Back to the clubs</button>
    </div>`;

  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  const close = () => { wrap.remove(); document.body.style.overflow = ''; };
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
}

/* Everything above is defined by the time this runs — see init's note. The
   guard is what lets the two render functions be imported on their own. */
if (document.getElementById('net-grid')) init();
