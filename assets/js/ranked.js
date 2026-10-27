/* ═══════════════════════════════════════════════════════════════════════
   ranked.js — the ranked season: a standing leaderboard built from the
   lichess tournaments a club (or the whole site) runs.

     clubs/{clubId}.ranked                    { mode: 'lichess' | 'wdl' }
     clubs/{clubId}/lichessLinks/{lichessId}  a lichess USERNAME → a member

   Nothing here is stored as a total. The board is worked out every time from
   the participants rows lichess-sync.js already keeps, so a tournament that
   finishes, a game that ends mid-arena, an archived event or a newly linked
   name all move the board on their own, with no recount to remember.

   Two ways to score, chosen by the club's staff:

     lichess   every lichess tournament point is a trophy — the arena's own
               scoring, streaks and berserks included;
     wdl       a win is 1 trophy, a draw ½, a loss 0, from the games we hold.

   Trophies belong to a JagChess member, and lichess only tells us lichess
   names. A name finds its member one of two ways:

     1. the member connected that lichess ACCOUNT (lichessAccounts/{uid});
     2. staff linked that lichess USERNAME to them, once, by hand — through
        Confirm points on the board or the lichess button on Members.

   A name with neither is held back as "unconfirmed" rather than guessed at.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDocs, setDoc, deleteDoc, updateDoc, onSnapshot,
  query, limit, clubCol, clubRef, esc, initials, toast
} from './club-core.js';

import {
  watchTournaments, listTournaments, tournRef, partsCol
} from './lichess-store.js';

/* ── paths ─────────────────────────────────────────────────────────── */

export const linksCol = (clubId) => clubCol(clubId, 'lichessLinks');
export const linkRef = (clubId, lichessId) => doc(db, 'clubs', clubId, 'lichessLinks', lichessId);
const accountsCol = () => collection(db, 'lichessAccounts');

/* ── settings ──────────────────────────────────────────────────────── */

export const MODES = {
  lichess: { label: 'Lichess points', short: 'Lichess pts', hint: 'Every lichess tournament point is a trophy — streaks and berserks included.' },
  wdl: { label: 'Win · Draw · Loss', short: 'W·D·L', hint: 'A win is 1 trophy, a draw ½ and a loss 0, from every game played.' }
};

export const modeOf = (ctx) =>
  (ctx && ctx.club && ctx.club.ranked && ctx.club.ranked.mode === 'wdl') ? 'wdl' : 'lichess';

export async function setMode(ctx, mode) {
  await updateDoc(clubRef(ctx.clubId), { ranked: { mode } });
  ctx.club.ranked = { mode };
}

/* ── archiving ─────────────────────────────────────────────────────── */

/**
 * Staff can take a tournament out of circulation: students stop seeing it,
 * and it stops counting. The sync never writes this field, so nothing it
 * learns from lichess later can put an archived event back.
 */
export const setArchived = (kind, id, hidden) => updateDoc(
  kind === 'lichess' ? tournRef(id) : doc(db, 'tournaments', id),
  { staffHidden: !!hidden, staffHiddenAt: hidden ? Date.now() : null }
);

/* Who gets to archive: a club's staff for a club's events, and a site
   administrator for the global ones (which the hub never offers). */
export const mayArchive = (ctx) => !!(ctx && ctx.clubId && ctx.isAdmin);

/* ── trophies ──────────────────────────────────────────────────────── */

export const trophyText = (n) => {
  const whole = Math.floor(n + 1e-9);
  const half = n - whole > 0.25;
  return half ? (whole ? `${whole}½` : '½') : String(whole);
};

export function trophiesFor(p, mode) {
  if (mode === 'wdl') {
    const c = p.calc || {};
    return (c.wins || 0) + 0.5 * (c.draws || 0);
  }
  return p.score || 0;
}

/** Medal classes the whole site shares: gold, silver, bronze, then the top ten. */
export const tierOf = (rank) =>
  rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : rank && rank <= 10 ? 'elite' : '';

export const TIER_NAME = { gold: 'Ranked champion', silver: 'Ranked runner-up', bronze: 'Ranked third', elite: 'Ranked top ten' };

/* Counting events: running ones count live, finished ones for good. */
const counts = (t) => !t.staffHidden && (t.status === 'finished' || t.status === 'started');

/**
 * The board itself, from plain data. Pure, so it can be fed by a live
 * subscription or by a one-off read without the two drifting apart.
 *
 * @param {object} input
 *   tournaments  the lichess tournaments that count
 *   parts        { [tournamentId]: participant rows }
 *   links        { [lichessId]: uid }   both kinds of link, merged
 *   people       { [uid]: { username, avatarColor, … } }
 *   mode         'lichess' | 'wdl'
 */
export function computeRanked({ tournaments, parts, links, people, mode }) {
  const byName = new Map();
  let games = 0;

  for (const t of tournaments) {
    const rows = parts[t.id] || [];
    const live = t.status === 'started';
    for (const p of rows) {
      const id = p.userId || String(p.username || '').toLowerCase();
      if (!id) continue;
      const c = p.calc || {};
      const n = byName.get(id) || {
        lichessId: id, name: p.username || id, trophies: 0, live: 0, events: 0,
        w: 0, d: 0, l: 0, gold: 0, silver: 0, bronze: 0, best: null, lastAt: 0
      };
      const got = trophiesFor(p, mode);
      n.trophies += got;
      if (live) n.live += got;
      n.events += 1;
      n.w += c.wins || 0; n.d += c.draws || 0; n.l += c.losses || 0;
      games += c.games || 0;
      if (!live && p.rank) {
        if (p.rank === 1) n.gold++;
        else if (p.rank === 2) n.silver++;
        else if (p.rank === 3) n.bronze++;
        n.best = n.best ? Math.min(n.best, p.rank) : p.rank;
      }
      if ((t.startsAt || 0) > n.lastAt) { n.lastAt = t.startsAt || 0; n.name = p.username || n.name; }
      byName.set(id, n);
    }
  }

  /* Names fold into members. One member can have several lichess names —
     a school account and a home one — and their trophies add up. */
  const byUid = new Map();
  const unlinked = [];
  for (const n of byName.values()) {
    const uid = links[n.lichessId];
    if (!uid) { unlinked.push(n); continue; }
    const r = byUid.get(uid) || {
      uid, person: people[uid] || null, names: [], trophies: 0, live: 0, events: 0,
      w: 0, d: 0, l: 0, gold: 0, silver: 0, bronze: 0, best: null
    };
    r.names.push(n.name);
    for (const k of ['trophies', 'live', 'events', 'w', 'd', 'l', 'gold', 'silver', 'bronze']) r[k] += n[k];
    r.best = n.best && (!r.best || n.best < r.best) ? n.best : r.best;
    byUid.set(uid, r);
  }

  const order = (a, b) => b.trophies - a.trophies || b.gold - a.gold
    || b.silver - a.silver || b.w - a.w || (a.best || 99) - (b.best || 99);
  const rows = [...byUid.values()].sort(order);
  /* Tied trophies share a rank, the way a results table should read. */
  rows.forEach((r, i) => {
    r.rank = i && rows[i - 1].trophies === r.trophies ? rows[i - 1].rank : i + 1;
  });
  unlinked.sort(order);

  return {
    mode,
    rows,
    unlinked,
    tournaments: tournaments.length,
    liveCount: tournaments.filter((t) => t.status === 'started').length,
    games: Math.round(games / 2)
  };
}

/* ── where the people and the links come from ──────────────────────── */

async function readAccounts() {
  const out = {};
  try {
    const s = await getDocs(query(accountsCol(), limit(1000)));
    s.docs.forEach((d) => {
      const a = d.data();
      const id = String(a.lichessId || a.username || '').toLowerCase();
      if (id) out[id] = d.id;
    });
  } catch (e) { console.warn('Could not read lichess accounts', e); }
  return out;
}

/* The latest board per scope, for anything that wants a rank without paying
   for a second subscription — the profile card, mostly. */
const latest = new Map();
const scopeOf = (ctx) => (ctx && ctx.clubId) || 'global';
export const lastRanked = (ctx) => latest.get(scopeOf(ctx)) || null;

/**
 * The live board. Calls back every time anything under it moves.
 *
 * @returns {Function} stop
 */
export function watchRanked(ctx, cb) {
  const clubId = ctx.clubId || null;
  let tournaments = [];
  let accounts = {};
  let manual = {};
  let people = {};
  const parts = {};
  const partStops = new Map();
  let ready = false;

  const emit = () => {
    if (!ready) return;
    const links = { ...accounts, ...manual };
    const out = computeRanked({ tournaments, parts, links, people, mode: modeOf(ctx) });
    out.links = links;
    out.people = people;
    out.allTournaments = tournaments;
    latest.set(scopeOf(ctx), out);
    cb(out);
  };

  const follow = (rows) => {
    tournaments = rows.filter(counts);
    const want = new Set(tournaments.map((t) => t.id));
    for (const [id, stop] of partStops) {
      if (!want.has(id)) { stop(); partStops.delete(id); delete parts[id]; }
    }
    for (const t of tournaments) {
      if (partStops.has(t.id)) continue;
      partStops.set(t.id, onSnapshot(partsCol(t.id), (s) => {
        parts[t.id] = s.docs.map((d) => ({ userId: d.id, ...d.data() }));
        emit();
      }, (e) => console.warn('Ranked participants listener stopped', e)));
    }
    emit();
  };

  const stops = [watchTournaments(ctx, follow)];

  if (clubId) {
    stops.push(onSnapshot(linksCol(clubId), (s) => {
      manual = {};
      s.docs.forEach((d) => { if (d.data().uid) manual[d.id] = d.data().uid; });
      emit();
    }, (e) => console.warn('Lichess link listener stopped', e)));
    stops.push(onSnapshot(clubCol(clubId, 'members'), (s) => {
      people = {};
      s.docs.forEach((d) => { people[d.id] = { uid: d.id, ...d.data() }; });
      emit();
    }, (e) => console.warn('Ranked member listener stopped', e)));
  } else {
    getDocs(query(collection(db, 'users'), limit(500))).then((s) => {
      s.docs.forEach((d) => { people[d.id] = { uid: d.id, ...d.data() }; });
      emit();
    }).catch((e) => console.warn('Could not read players for the ranked board', e));
  }

  readAccounts().then((a) => { accounts = a; ready = true; emit(); });

  /* The mode lives on the club document, which club.js keeps live on ctx;
     a cheap re-check means a staff change of mode lands without a reload. */
  let lastMode = modeOf(ctx);
  const modeTick = setInterval(() => {
    if (modeOf(ctx) !== lastMode) { lastMode = modeOf(ctx); emit(); }
  }, 1500);

  return () => {
    clearInterval(modeTick);
    stops.forEach((s) => { try { s(); } catch (_) {} });
    partStops.forEach((s) => { try { s(); } catch (_) {} });
  };
}

/** One read of the whole board, for pages that are not showing it. */
export async function loadRanked(ctx) {
  const have = lastRanked(ctx);
  if (have) return have;
  const clubId = ctx.clubId || null;
  const all = await listTournaments(ctx).catch(() => []);
  const tournaments = all.filter(counts);
  const parts = {};
  await Promise.all(tournaments.map(async (t) => {
    const s = await getDocs(partsCol(t.id)).catch(() => null);
    parts[t.id] = s ? s.docs.map((d) => ({ userId: d.id, ...d.data() })) : [];
  }));
  const accounts = await readAccounts();
  const manual = {};
  const people = {};
  if (!clubId) {
    const us = await getDocs(query(collection(db, 'users'), limit(500))).catch(() => null);
    if (us) us.docs.forEach((d) => { people[d.id] = { uid: d.id, ...d.data() }; });
  } else {
    const [ls, ms] = await Promise.all([
      getDocs(linksCol(clubId)).catch(() => null),
      getDocs(clubCol(clubId, 'members')).catch(() => null)
    ]);
    if (ls) ls.docs.forEach((d) => { if (d.data().uid) manual[d.id] = d.data().uid; });
    if (ms) ms.docs.forEach((d) => { people[d.id] = { uid: d.id, ...d.data() }; });
  }
  const links = { ...accounts, ...manual };
  const out = computeRanked({ tournaments, parts, links, people, mode: modeOf(ctx) });
  out.links = links;
  out.people = people;
  latest.set(scopeOf(ctx), out);
  return out;
}

/* ── linking a lichess USERNAME to a member ────────────────────────── */

export async function linkUsername(ctx, lichessName, member) {
  const id = String(lichessName || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(id)) throw new Error('That does not look like a lichess username.');
  await setDoc(linkRef(ctx.clubId, id), {
    lichessId: id,
    name: String(lichessName).trim(),
    uid: member.uid,
    username: member.username || '',
    by: { uid: ctx.user.uid, username: (ctx.member && ctx.member.username) || '' },
    at: Date.now()
  });
}

export const unlinkUsername = (ctx, lichessId) => deleteDoc(linkRef(ctx.clubId, lichessId));

/* ── shared bits of markup ─────────────────────────────────────────── */

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

export const TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.6 4.2h8.8v4.6a4.4 4.4 0 0 1-8.8 0Z"/><path d="M7.6 5.8H4.9v1a3 3 0 0 0 2.9 3M16.4 5.8h2.7v1a3 3 0 0 1-2.9 3"/><path d="M12 13.2v3.4M8.4 20.2h7.2l-.9-3.6H9.3Z"/></svg>';
export const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4"/></svg>';
export const CROWN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 8.2 8 11.6l4-6.4 4 6.4 4.5-3.4-1.8 9.6H5.3Z"/><rect x="5.3" y="18.6" width="13.4" height="2" rx="1"/></svg>';

export const personAvatar = (p, size = 34, cls = '') =>
  `<span class="rk-av ${cls}" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.7)}px;background:${esc((p && p.avatarColor) || '#7b8394')}">${esc(initials((p && p.username) || '?'))}</span>`;

/* A searchable member picker: a text box over a list that filters as you
   type. Used by both linking modals, which is why it lives here. */
function memberPicker(host, members, onPick, chosen) {
  host.innerHTML = `
    <input class="rk-pick-search" placeholder="Search members by name or email" autocomplete="off" />
    <div class="rk-pick-list"></div>`;
  const input = host.querySelector('input');
  const list = host.querySelector('.rk-pick-list');
  let pick = chosen || null;
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    const rows = members
      .filter((m) => !q || String(m.username || '').toLowerCase().includes(q) || String(m.email || '').toLowerCase().includes(q))
      .slice(0, 40);
    list.innerHTML = rows.length ? rows.map((m) => `
      <button type="button" class="rk-pick-row ${pick && pick.uid === m.uid ? 'on' : ''}" data-uid="${esc(m.uid)}">
        ${personAvatar(m, 28)}
        <span><b>${esc(m.username || 'Member')}</b><small>${esc(m.email || '')}</small></span>
        <i class="rk-pick-check">✓</i>
      </button>`).join('') : '<div class="rk-pick-empty">No member matches that.</div>';
    list.querySelectorAll('[data-uid]').forEach((b) => {
      b.onclick = () => { pick = members.find((m) => m.uid === b.dataset.uid); paint(); onPick(pick); };
    });
  };
  input.oninput = paint;
  paint();
  setTimeout(() => input.focus(), 60);
}

/**
 * Confirm points: the staff answer to "who is this lichess player?". Once it
 * is answered it is remembered, so the same name never needs it again.
 */
export function openConfirmPoints(ctx, entry, board) {
  const members = Object.values((board && board.people) || {})
    .filter((m) => m.uid && !m.deleted)
    .sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')));
  let pick = null;
  const mode = (board && board.mode) || modeOf(ctx);

  const m = el(`<div class="modal"><div class="modal-card rk-modal">
    <button class="icon-btn modal-close" data-x title="Close">✕</button>
    <div class="rk-modal-head">
      <span class="rk-modal-ico">${TROPHY_SVG}</span>
      <div>
        <h3>Confirm points</h3>
        <p class="modal-meta" style="margin:0">Who is this lichess player in the club?</p>
      </div>
    </div>
    <div class="rk-confirm-who">
      <div class="rk-confirm-li">
        <small>Lichess username</small>
        <b>${esc(entry.name)}</b>
        <a href="https://lichess.org/@/${esc(entry.name)}" target="_blank" rel="noopener">Profile ↗</a>
      </div>
      <div class="rk-confirm-arrow">→</div>
      <div class="rk-confirm-jag" data-target><small>JagChess member</small><b class="muted">Pick below</b></div>
    </div>
    <div class="rk-picker" data-picker></div>
    <div class="rk-confirm-gain">
      <span>${TROPHY_SVG}</span>
      <div><b>${trophyText(entry.trophies)} ${entry.trophies === 1 ? 'trophy' : 'trophies'}</b>
        <small>from ${entry.events} tournament${entry.events === 1 ? '' : 's'} · ${MODES[mode].short}${entry.w + entry.d + entry.l ? ` · ${entry.w}W ${entry.d}D ${entry.l}L` : ''}</small></div>
    </div>
    <p class="field-hint" style="margin:0">JagChess remembers this pairing. Future tournaments by ${esc(entry.name)} count for this member automatically.</p>
    <div class="li-modal-foot">
      <button class="btn subtle" data-x>Cancel</button>
      <button class="btn primary" data-go disabled>Confirm points</button>
    </div>
  </div></div>`);
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  m.onclick = (e) => { if (e.target === m) close(); };

  memberPicker(m.querySelector('[data-picker]'), members, (p) => {
    pick = p;
    m.querySelector('[data-target]').innerHTML =
      `<small>JagChess member</small><b>${personAvatar(p, 22)} ${esc(p.username || 'Member')}</b>`;
    m.querySelector('[data-go]').disabled = false;
  });

  m.querySelector('[data-go]').onclick = async (e) => {
    if (!pick) return;
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      await linkUsername(ctx, entry.name, pick);
      close();
      toast(`${trophyText(entry.trophies)} trophies confirmed for ${pick.username || 'that member'}`, 'ok');
    } catch (err) {
      console.error(err);
      toast(err.code === 'permission-denied' ? 'Only club staff can confirm points.' : (err.message || 'Could not save that link'), 'error');
      e.target.disabled = false;
      e.target.textContent = 'Confirm points';
    }
  };
}

/**
 * The Members-page version: start from the member and say which lichess
 * usernames are theirs, before any Confirm points is ever needed.
 */
export async function openLinkUsernames(ctx, member) {
  const m = el(`<div class="modal"><div class="modal-card rk-modal">
    <button class="icon-btn modal-close" data-x title="Close">✕</button>
    <div class="rk-modal-head">
      ${personAvatar(member, 44)}
      <div>
        <h3>Lichess usernames</h3>
        <p class="modal-meta" style="margin:0">Which lichess players are <b>${esc(member.username || 'this member')}</b>?</p>
      </div>
    </div>
    <div class="rk-links" data-links><div class="rk-pick-empty">Loading…</div></div>
    <div class="rk-link-add">
      <input data-name placeholder="Lichess username" autocomplete="off" list="rk-known-names" />
      <datalist id="rk-known-names"></datalist>
      <button class="btn primary" data-add>${LINK_SVG}Link</button>
    </div>
    <p class="field-hint" style="margin:0">This links a lichess <b>username</b>, not an account — nobody has to log in.
      Their ranked trophies from that name count for them from now on.</p>
  </div></div>`);
  document.body.appendChild(m);
  const close = () => { stop(); m.remove(); };
  m.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  m.onclick = (e) => { if (e.target === m) close(); };

  let account = null;
  let rows = [];
  let unlinkedNames = [];
  const paint = () => {
    const box = m.querySelector('[data-links]');
    const mine = rows.filter((r) => r.uid === member.uid);
    box.innerHTML = `
      ${account ? `<div class="rk-link-row acct"><span class="rk-li-dot"></span><b>${esc(account.username)}</b><small>Connected lichess account</small></div>` : ''}
      ${mine.map((r) => `<div class="rk-link-row"><span class="rk-li-dot"></span><b>${esc(r.name || r.lichessId)}</b>
        <small>linked by ${esc((r.by && r.by.username) || 'staff')}</small>
        <button class="btn subtle sm" data-drop="${esc(r.lichessId)}">Unlink</button></div>`).join('')}
      ${!account && !mine.length ? '<div class="rk-pick-empty">No lichess usernames linked yet.</div>' : ''}`;
    box.querySelectorAll('[data-drop]').forEach((b) => {
      b.onclick = async () => {
        try { await unlinkUsername(ctx, b.dataset.drop); toast('Unlinked'); }
        catch (e) { toast('Could not unlink that', 'error'); }
      };
    });
    m.querySelector('#rk-known-names').innerHTML = unlinkedNames
      .map((n) => `<option value="${esc(n.name)}">${esc(trophyText(n.trophies))} trophies waiting</option>`).join('');
  };

  const stop = onSnapshot(linksCol(ctx.clubId), (s) => {
    rows = s.docs.map((d) => ({ lichessId: d.id, ...d.data() }));
    paint();
  }, () => {});
  getDocs(query(accountsCol(), limit(1000))).then((s) => {
    const a = s.docs.find((d) => d.id === member.uid);
    account = a ? a.data() : null;
    paint();
  }).catch(() => {});
  loadRanked(ctx).then((b) => { unlinkedNames = b.unlinked || []; paint(); }).catch(() => {});

  const add = async () => {
    const input = m.querySelector('[data-name]');
    const name = input.value.trim();
    if (!name) return;
    const taken = rows.find((r) => r.lichessId === name.toLowerCase());
    if (taken && taken.uid !== member.uid) {
      toast(`${name} is already linked to ${taken.username || 'another member'} — unlink it there first`, 'error');
      return;
    }
    try {
      await linkUsername(ctx, name, member);
      input.value = '';
      toast(`${name} linked to ${member.username || 'this member'}`, 'ok');
    } catch (e) {
      toast(e.code === 'permission-denied' ? 'Only club staff can link usernames.' : (e.message || 'Could not link that'), 'error');
    }
  };
  m.querySelector('[data-add]').onclick = add;
  m.querySelector('[data-name]').onkeydown = (e) => { if (e.key === 'Enter') add(); };
}

/* ── the board, drawn ──────────────────────────────────────────────── */

/**
 * A three-step podium, second · first · third. Every podium on the site —
 * the ranked board, a finished arena, a finished lichess event — is this.
 *
 * @param {Array<{uid?, person, value, sub?}>} top  first, second, third
 */
export function podiumHTML(top, opts = {}) {
  const step = (r, place) => {
    if (!r) return `<div class="rk-step p${place} empty"><div class="rk-step-block"><span>${place}</span></div></div>`;
    const tag = r.uid ? 'button' : 'div';
    return `<${tag} class="rk-step p${place}" ${r.uid ? `data-profile="${esc(r.uid)}"` : ''}>
      ${place === 1 ? `<span class="rk-crown">${CROWN_SVG}</span>` : ''}
      <span class="rk-step-av">${personAvatar(r.person, place === 1 ? 64 : 52, 'ring ' + tierOf(place))}</span>
      <b class="rk-step-name">${esc((r.person && r.person.username) || 'Player')}</b>
      ${r.value ? `<span class="rk-step-tro">${r.value}</span>` : ''}
      ${r.sub ? `<small class="rk-step-sub">${r.sub}</small>` : ''}
      <div class="rk-step-block"><span>${place}</span></div>
    </${tag}>`;
  };
  return `<div class="rk-podium ${opts.cls || ''}">${step(top[1], 2)}${step(top[0], 1)}${step(top[2], 3)}</div>`;
}

/**
 * The ranked leaderboard as markup: a three-step podium for the top three,
 * then the field. Shared by the Tournaments home and the Leaderboard tab.
 */
export function rankedBoardHTML(board, ctx, opts = {}) {
  if (!board) {
    return `<div class="rk-board"><div class="rk-loading"><span></span><span></span><span></span></div></div>`;
  }
  const me = ctx.user.uid;
  const top = board.rows.slice(0, 3);
  const rest = board.rows.slice(3, opts.limit || 200);
  const showConfirm = ctx.clubId && ctx.isAdmin && board.unlinked.length;

  const toStep = (r) => r && ({
    uid: r.uid,
    person: r.person || { username: r.names[0] },
    value: `${TROPHY_SVG}${trophyText(r.trophies)}`,
    sub: `${r.events} event${r.events === 1 ? '' : 's'}${r.w + r.d + r.l ? ` · ${r.w}-${r.d}-${r.l}` : ''}`
  });

  const row = (r) => {
    const p = r.person || {};
    const tier = tierOf(r.rank);
    const played = r.w + r.d + r.l;
    return `<button class="rk-row ${tier} ${r.uid === me ? 'me' : ''}" data-profile="${esc(r.uid)}">
      <span class="rk-rank ${tier}">${r.rank}</span>
      ${personAvatar(p, 34)}
      <span class="rk-who">
        <b>${esc(p.username || r.names[0] || 'Player')}${r.uid === me ? '<span class="lb-me-badge">You</span>' : ''}</b>
        <small>${r.events} event${r.events === 1 ? '' : 's'}${played ? ` · ${r.w}W ${r.d}D ${r.l}L` : ''}${r.gold ? ` · ${r.gold}× 1st` : ''}</small>
      </span>
      ${r.live ? `<span class="rk-live-gain" title="From tournaments running right now">+${trophyText(r.live)}</span>` : ''}
      <span class="rk-tro">${TROPHY_SVG}${trophyText(r.trophies)}</span>
    </button>`;
  };

  return `
    <div class="rk-board">
      ${board.rows.length ? `
        ${podiumHTML(top.map(toStep))}
        ${rest.length ? `<div class="rk-rows">${rest.map(row).join('')}</div>` : ''}`
      : `<div class="rk-empty">
          <span class="rk-empty-ico">${TROPHY_SVG}</span>
          <b>No ranked trophies yet</b>
          <small>${board.tournaments
            ? (board.unlinked.length
              ? `${board.unlinked.length} lichess player${board.unlinked.length === 1 ? ' has' : 's have'} trophies waiting to be matched to a member.`
              : 'Nobody has scored in a counted tournament yet.')
            : 'Trophies arrive as soon as the first lichess tournament starts.'}</small>
        </div>`}
      ${showConfirm ? `
        <div class="rk-unconfirmed">
          <div class="rk-unconfirmed-head">
            <b>Unconfirmed points</b>
            <small>Lichess players we cannot match to a member yet. Confirm once and JagChess remembers.</small>
          </div>
          ${board.unlinked.slice(0, opts.unlinkedLimit || 12).map((u) => `
            <div class="rk-un-row">
              <span class="rk-li-dot"></span>
              <span class="rk-who"><b>${esc(u.name)}</b><small>${u.events} event${u.events === 1 ? '' : 's'}</small></span>
              <span class="rk-tro dim">${TROPHY_SVG}${trophyText(u.trophies)}</span>
              <button class="btn primary sm" data-confirm="${esc(u.lichessId)}">Confirm points</button>
            </div>`).join('')}
        </div>` : (board.unlinked.length && !ctx.isAdmin ? `
        <p class="rk-note">${board.unlinked.length} lichess player${board.unlinked.length === 1 ? ' is' : 's are'} not on the board yet —
          connect your lichess account in Account settings and your trophies count automatically.</p>` : '')}
    </div>`;
}

/** Wires what rankedBoardHTML drew. Profile clicks are handled site-wide. */
export function wireRankedBoard(host, ctx, board) {
  host.querySelectorAll('[data-confirm]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const u = board.unlinked.find((x) => x.lichessId === b.dataset.confirm);
      if (u) openConfirmPoints(ctx, u, board);
    };
  });
}
