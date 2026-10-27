/* ═══════════════════════════════════════════════════════════════════════
   tournaments-ui.js — the Tournaments page, inside a club and out on the hub.

   Three screens, all driven from the same ctx shape the duels module uses:

     renderTournaments()      the list: upcoming, live, finished
     openTournamentCreate()   the form
     renderTournamentView()   one tournament, live

   The list shows two kinds of event side by side, sorted together:

     • a JagChess ARENA, run by this site in the entrants' own browsers;
     • a LICHESS tournament, run by lichess and mirrored here through its
       official API — see lichess-ui.js and lichess-sync.js.

   They are deliberately not merged into one data model. An arena is ours to
   pair and score; a lichess tournament is lichess's, and pretending other-
   wise would mean inventing numbers. What they share is this page.

   The view is also the engine's heartbeat. There is no server, so while you
   have a tournament open your tab does the pairing and the result-processing
   — all of it idempotent, so any number of tabs doing it at once converges on
   the same state. See tournaments-core.js.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  esc, toast, confirmDialog, initials, fmtDate, fmtTime, updateDoc
} from './club-core.js';

import { readRating, displayRating } from './glicko2.js';
import { TIME_CONTROLS, tcLabel, tcCategory, loadMyRatings } from './club-duels.js';

import * as li from './lichess-ui.js';
import { listTeams, watchTournaments as watchLichess } from './lichess-store.js';
import { openLichessCreate } from './lichess-create.js';
import {
  watchRanked, rankedBoardHTML, wireRankedBoard, modeOf, setMode as setRankedMode, MODES,
  mayArchive, setArchived, podiumHTML, personAvatar, TROPHY_SVG
} from './ranked.js';
import { noteMyRank } from './profile-card.js';

import {
  RETIRED_FORMATS, DURATIONS, tcFromId, phaseOf, arenaEndsAt,
  isOpenForEntry, isRetiredFormat, formatName, canManage,
  createTournament, cancelTournament,
  joinTournament, pauseInTournament, withdrawFromTournament, beat,
  findArenaOpponent, pairArena, applyTournamentGame, finishTournament,
  standingsFor, onFire, tPlayerRef, watchTournament, watchPlayers,
  watchTournamentGames, watchTournamentList
} from './tournaments-core.js';

/* ── small shared bits ─────────────────────────────────────────────── */

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

const avatarHTML = (p, size) =>
  `<span class="lb-avatar" style="background:${esc((p && p.avatarColor) || '#2e90fa')};width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px">${esc(initials((p && p.username) || '?'))}</span>`;

/* "2d 4h", "3h 12m", "48:12", "9s" — the unit shrinks as the moment nears. */
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}s`;
}

const startLabel = (t) => `${fmtDate(t.startsAt)} · ${fmtTime(t.startsAt)}`;

const formatPill = (t) => isRetiredFormat(t.format)
  ? `<span class="tn-pill retired">${esc(formatName(t.format))} · discontinued</span>`
  : `<span class="tn-pill ${t.format}">${esc(formatName(t.format))}</span>`;

const termPills = (t) => `
  ${formatPill(t)}
  <span class="tn-pill">${tcLabel(t.tc)} ${tcCategory(t.tc)}</span>
  <span class="tn-pill ${t.rated ? 'rated' : ''}">${t.rated ? 'Rated' : 'Casual'}</span>
  ${t.berserk ? '<span class="tn-pill berserk">Berserk</span>' : ''}`;

const PHASE_LABEL = {
  scheduled: 'Upcoming', running: 'Live now', ending: 'Finishing',
  finished: 'Finished', cancelled: 'Cancelled', retired: 'Discontinued'
};

const tournamentHash = (id) => 'tournament/' + id;

/* ═══════════════════════════════════════════════════════════════════ */
/*  THE HOME SCREEN                                                    */
/* ═══════════════════════════════════════════════════════════════════ */

/* Two very different phase vocabularies, reduced to the one question the
   list asks: is this still to come, or is it over? */
const openish = (kind, phase) => kind === 'lichess'
  ? (phase === 'scheduled' || phase === 'starting' || phase === 'running')
  : (phase === 'scheduled' || phase === 'running' || phase === 'ending');

const isLive = (r) => r.phase === 'running' || r.phase === 'ending' || r.phase === 'starting';

const endedAt = (r) => (r.kind === 'lichess'
  ? (r.t.finishedSeenAt || r.t.finishesAt || r.t.startsAt || 0)
  : (r.t.finishedAt || r.t.startsAt || 0));

const TAB_KEY = 'jag-tn-tab';

const ARCHIVE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M10 12.5h4"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.4h4.4"/></svg>';

/**
 * The Tournaments page. Its front door is the ranked season — the standing
 * board on the left, and on the right whatever is happening: live events
 * when there are any, the latest results when there are not. Upcoming and
 * History are a tab away, and look like what they are: a schedule and a
 * trophy cabinet.
 */
export async function renderTournaments(ctx, host, api) {
  const mayHost = ctx.clubId ? ctx.isAdmin : true;
  /* Configuring which lichess teams a page watches decides what everyone
     else sees, so it belongs to whoever runs the place: a club's own staff
     inside a club, and the site administrator at /admin outside one. The
     hub's Tournaments page therefore has no setup tab. */
  const maySetUp = !!ctx.clubId && ctx.isAdmin;
  const staff = mayArchive(ctx);
  let all = [];
  let lichess = [];
  let board = null;
  let tab = 'ranked';
  try { tab = sessionStorage.getItem(TAB_KEY + (ctx.clubId || '')) || 'ranked'; } catch (_) {}
  if (tab === 'setup' && !maySetUp) tab = 'ranked';
  let source = 'all';
  let setupCleanup = null;

  const seasonName = ctx.clubId ? ((ctx.club && ctx.club.name) || 'Club') : 'JagChess';

  host.innerHTML = `
    <div class="tz">
      <section class="tz-hero">
        <div class="tz-hero-glow"></div>
        <div class="tz-hero-main">
          <span class="tz-eyebrow">${TROPHY_SVG}Ranked season</span>
          <h2>${esc(seasonName)} <span>Ranked</span></h2>
          <p class="tz-hero-sub" id="tz-mode-sub"></p>
          <div class="tz-hero-stats" id="tz-stats"></div>
        </div>
        <div class="tz-hero-side">
          ${staff ? `
            <div class="tz-mode">
              <small>Trophies from</small>
              <div class="duel-seg" id="tz-mode">
                <button type="button" class="duel-seg-opt" data-m="lichess">Lichess points</button>
                <button type="button" class="duel-seg-opt" data-m="wdl">W · D · L</button>
              </div>
            </div>` : ''}
          ${mayHost ? '<button class="btn primary" id="tn-new">＋ New tournament</button>' : ''}
        </div>
      </section>

      <div class="tz-nav">
        <div class="tz-tabs" id="tz-tabs">
          <button class="tz-tab" data-t="ranked">${TROPHY_SVG}Ranked</button>
          <button class="tz-tab" data-t="open"><span class="tz-tab-dot" id="tz-live-dot" hidden></span>Live &amp; upcoming<span class="tz-count" id="tz-open-n"></span></button>
          <button class="tz-tab" data-t="history">History<span class="tz-count" id="tz-hist-n"></span></button>
          ${maySetUp ? '<button class="tz-tab" data-t="setup">Lichess setup</button>' : ''}
        </div>
        <div class="duel-seg tn-source" id="tn-source" hidden>
          <button type="button" class="duel-seg-opt on" data-s="all">All</button>
          <button type="button" class="duel-seg-opt" data-s="jag">JagChess</button>
          <button type="button" class="duel-seg-opt" data-s="lichess">Lichess</button>
        </div>
      </div>

      <div id="tz-body"></div>
    </div>`;

  const q = (s) => host.querySelector(s);

  if (mayHost) q('#tn-new').onclick = () => openNewMenu(ctx, q('#tn-new'));

  if (q('#tz-mode')) q('#tz-mode').onclick = async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b || b.dataset.m === modeOf(ctx)) return;
    try {
      await setRankedMode(ctx, b.dataset.m);
      paintHero();
      toast(`Ranked now scores by ${MODES[b.dataset.m].label}`, 'ok');
    } catch (err) {
      console.error(err);
      toast('Could not change the scoring', 'error');
    }
  };

  q('#tn-source').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    source = b.dataset.s;
    host.querySelectorAll('#tn-source [data-s]').forEach((x) => x.classList.toggle('on', x.dataset.s === source));
    paintBody();
  };

  q('#tz-tabs').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    tab = b.dataset.t;
    try { sessionStorage.setItem(TAB_KEY + (ctx.clubId || ''), tab); } catch (_) {}
    paintBody();
  };

  /* The admin panel is a whole module with its own subscriptions, so it is
     mounted and unmounted rather than repainted with the list. */
  async function mountSetup(box) {
    box.innerHTML = '<div class="empty-state">Loading…</div>';
    const { renderLichessAdmin } = await import('./lichess-admin.js');
    if (tab !== 'setup') return;
    box.innerHTML = '';
    setupCleanup = renderLichessAdmin(ctx, box, { ownSync: false });
  }

  const unmountSetup = () => {
    if (!setupCleanup) return;
    try { setupCleanup(); } catch (_) {}
    setupCleanup = null;
  };

  /* ── the rows every view is cut from ─────────────────────────────── */

  function rows(now = Date.now()) {
    const jag = (source === 'lichess' ? [] : all).map((t) => ({ kind: 'jag', t, phase: phaseOf(t, now) }));
    const lic = (source === 'jag' ? [] : lichess).map((t) => ({ kind: 'lichess', t, phase: li.phaseOf(t, now) }));
    /* An archived event is gone for students, and kept — marked — for staff,
       who are the ones who can bring it back. */
    return [...jag, ...lic].filter((r) => staff || !r.t.staffHidden);
  }

  const openRows = (now) => rows(now)
    .filter((r) => openish(r.kind, r.phase))
    .sort((a, b) => (isLive(a) ? 0 : 1) - (isLive(b) ? 0 : 1) || (a.t.startsAt || 0) - (b.t.startsAt || 0));

  const historyRows = (now) => rows(now)
    .filter((r) => !openish(r.kind, r.phase) && r.phase !== 'cancelled')
    .sort((a, b) => endedAt(b) - endedAt(a));

  /* ── a person, from whichever side of the integration named them ─── */

  function who(kind, p) {
    if (kind === 'jag') return { uid: p.uid, person: p };
    const id = String(p.username || '').toLowerCase();
    const uid = board && board.links && board.links[id];
    const person = uid && board.people[uid];
    return uid && person
      ? { uid, person: { ...person, username: person.username || p.username }, alias: p.username }
      : { uid: null, person: { username: p.username, avatarColor: '#8a8f99' } };
  }

  const podiumOf = (r) => (r.kind === 'lichess' ? (r.t.podium || []) : (r.t.podiumResult || []));

  /* ── the pieces ──────────────────────────────────────────────────── */

  const termsHTML = (r) => {
    const t = r.t;
    if (r.kind === 'lichess') {
      return `<span class="tz-term li">Lichess ${t.kind === 'swiss' ? 'Swiss' : 'Arena'}</span>
        <span class="tz-term">${esc(li.clockLabel(t.clock))} ${esc(li.speedOf(t.clock))}</span>
        ${t.rated ? '<span class="tz-term rated">Rated</span>' : ''}`;
    }
    return `<span class="tz-term jag">${esc(formatName(t.format))}</span>
      <span class="tz-term">${tcLabel(t.tc)} ${tcCategory(t.tc)}</span>
      ${t.rated ? '<span class="tz-term rated">Rated</span>' : ''}`;
  };

  const openAttrs = (r) => r.kind === 'lichess'
    ? `data-open-lichess="${esc(r.t.id)}"` : `data-open="${esc(r.t.id)}"`;

  const archiveBtn = (r) => staff
    ? `<button class="tz-icon-btn" data-archive="${r.kind}:${esc(r.t.id)}" data-hidden="${r.t.staffHidden ? 1 : 0}"
        title="${r.t.staffHidden ? 'Restore — show to students and count it again' : 'Archive — hide from students and the ranked board'}">
        ${r.t.staffHidden ? RESTORE_SVG : ARCHIVE_SVG}</button>` : '';

  const count = (r) => r.kind === 'lichess' ? (r.t.nbPlayers || 0) : (r.t.playerCount || 0);

  /** One finished event, as a ticket with its podium on it. */
  function ticketHTML(r) {
    const t = r.t;
    const d = new Date(t.startsAt || endedAt(r));
    const pod = podiumOf(r).slice(0, 3);
    return `
      <div class="tz-ticket ${t.staffHidden ? 'archived' : ''}" ${openAttrs(r)} role="button" tabindex="0">
        <div class="tz-date">
          <span>${d.toLocaleDateString(undefined, { month: 'short' })}</span>
          <b>${d.getDate()}</b>
          <small>${d.getFullYear()}</small>
        </div>
        <div class="tz-ticket-main">
          <div class="tz-ticket-top">
            <b class="tz-ticket-name">${esc(t.name)}</b>
            ${t.staffHidden ? '<span class="tz-archived-pill">Archived</span>' : ''}
            ${r.phase === 'retired' ? '<span class="tz-archived-pill">Discontinued</span>' : ''}
            ${r.phase === 'unavailable' ? '<span class="tz-archived-pill">Unavailable</span>' : ''}
          </div>
          <div class="tz-terms">${termsHTML(r)}<span class="tz-term ghost">${count(r)} player${count(r) === 1 ? '' : 's'}</span></div>
        </div>
        <div class="tz-ticket-pod">${pod.length ? pod.map((p, i) => {
          const w = who(r.kind, p);
          return `<span class="tz-medal m${i + 1}" ${w.uid ? `data-profile="${esc(w.uid)}"` : ''} title="${['1st', '2nd', '3rd'][i]} · ${esc(w.person.username)}${p.score != null ? ' · ' + p.score + ' pts' : ''}">
            ${personAvatar(w.person, i === 0 ? 34 : 28, 'ring ' + ['gold', 'silver', 'bronze'][i])}
            <em>${esc(w.person.username)}</em>
          </span>`;
        }).join('') : '<span class="tz-nopod">No podium recorded</span>'}</div>
        ${archiveBtn(r)}
        <span class="tz-chev">›</span>
      </div>`;
  }

  /** One live or upcoming event, big. */
  function liveCardHTML(r, now) {
    const t = r.t;
    const live = isLive(r);
    const ends = r.kind === 'lichess' ? t.finishesAt : arenaEndsAt(t);
    const label = r.kind === 'lichess' ? li.PHASE_LABEL[r.phase] : PHASE_LABEL[r.phase];
    return `
      <div class="tz-live ${live ? 'on' : 'soon'} ${t.staffHidden ? 'archived' : ''}" ${openAttrs(r)} role="button" tabindex="0">
        <div class="tz-live-top">
          <span class="tn-status ${r.phase}">${live ? '<span class="tn-live-dot"></span>' : ''}${esc(label)}</span>
          ${t.staffHidden ? '<span class="tz-archived-pill">Archived</span>' : ''}
          ${archiveBtn(r)}
        </div>
        <b class="tz-live-name">${esc(t.name)}</b>
        <div class="tz-terms">${termsHTML(r)}</div>
        <div class="tz-live-foot">
          <div class="tz-live-clock">
            <b data-until="${live ? (ends || 0) : (t.startsAt || 0)}">${live
              ? (ends ? countdown(ends - now) : '—')
              : countdown((t.startsAt || 0) - now)}</b>
            <small>${live ? (ends ? 'left' : (t.kind === 'swiss' ? `round ${t.round || 0}/${t.nbRounds || '?'}` : 'running')) : 'until it starts'}</small>
          </div>
          <div class="tz-live-count"><b>${count(r)}</b><small>player${count(r) === 1 ? '' : 's'}</small></div>
          <span class="btn ${live ? 'primary' : 'subtle'} sm">${live ? 'Watch · Play' : 'Details'}</span>
        </div>
      </div>`;
  }

  /* ── painting ────────────────────────────────────────────────────── */

  function paintHero() {
    const mode = modeOf(ctx);
    q('#tz-mode-sub').textContent = ctx.clubId
      ? `${MODES[mode].label} · ${MODES[mode].hint}`
      : 'Global lichess tournaments. Every lichess point is a trophy.';
    if (q('#tz-mode')) {
      q('#tz-mode').querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    }
    const s = (n, label) => `<div class="tz-stat"><b>${n}</b><small>${label}</small></div>`;
    q('#tz-stats').innerHTML = board
      ? s(board.tournaments, board.tournaments === 1 ? 'event counted' : 'events counted')
        + s(board.rows.length, board.rows.length === 1 ? 'ranked player' : 'ranked players')
        + s(board.games, board.games === 1 ? 'game' : 'games')
        + (board.liveCount ? `<div class="tz-stat live"><b>${board.liveCount}</b><small>live now</small></div>` : '')
      : s('—', 'events counted') + s('—', 'ranked players') + s('—', 'games');
  }

  function paintCounts(now) {
    const open = openRows(now);
    const hist = historyRows(now);
    q('#tz-open-n').textContent = open.length || '';
    q('#tz-hist-n').textContent = hist.length || '';
    q('#tz-live-dot').hidden = !open.some(isLive);
  }

  function paintBody() {
    host.querySelectorAll('.tz-tab').forEach((x) => x.classList.toggle('on', x.dataset.t === tab));
    /* The season banner is the point of the Ranked tab; elsewhere it steps
       back to a strip so the schedule or the cabinet gets the room. */
    q('.tz-hero').classList.toggle('compact', tab !== 'ranked');
    const body = q('#tz-body');
    const now = Date.now();
    paintCounts(now);

    if (tab === 'setup') {
      q('#tn-source').hidden = true;
      if (!setupCleanup) mountSetup(body);
      return;
    }
    unmountSetup();
    q('#tn-source').hidden = tab === 'ranked' || !lichess.length || !all.length;

    if (tab === 'ranked') {
      body.innerHTML = `
        <div class="tz-split">
          <section class="tz-panel tz-board-panel">
            <div class="tz-panel-head">
              <div><h3>Leaderboard</h3><small>${MODES[modeOf(ctx)].short} · updates live</small></div>
            </div>
            <div id="tz-board">${rankedBoardHTML(board, ctx)}</div>
          </section>
          <section class="tz-panel tz-feed-panel">
            <div id="tz-feed"></div>
          </section>
        </div>`;
      paintBoard();
      paintFeed();
      return;
    }

    if (tab === 'open') {
      const rs = openRows(now);
      body.innerHTML = rs.length
        ? `<div class="tz-live-grid">${rs.map((r) => liveCardHTML(r, now)).join('')}</div>`
        : emptyHTML(mayHost
          ? 'Nothing scheduled. A date on the calendar is the best thing you can give a club.'
          : 'Nothing scheduled right now. Check back soon.');
      wireList(body);
      return;
    }

    // history: a cabinet, grouped by month
    const rs = historyRows(now);
    if (!rs.length) { body.innerHTML = emptyHTML('No tournaments have finished yet.'); return; }
    const groups = [];
    rs.forEach((r) => {
      const d = new Date(r.t.startsAt || endedAt(r));
      const key = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.rows.push(r); else groups.push({ key, rows: [r] });
    });
    body.innerHTML = `<div class="tz-history">${groups.map((g) => `
      <div class="tz-month">
        <div class="tz-month-head"><b>${esc(g.key)}</b><span>${g.rows.length} event${g.rows.length === 1 ? '' : 's'}</span></div>
        <div class="tz-tickets">${g.rows.map(ticketHTML).join('')}</div>
      </div>`).join('')}</div>`;
    wireList(body);
  }

  function paintBoard() {
    const box = q('#tz-board');
    if (!box) return;
    box.innerHTML = rankedBoardHTML(board, ctx);
    wireRankedBoard(box, ctx, board);
  }

  /* Right of the board: whatever is happening, or the latest results. */
  function paintFeed() {
    const box = q('#tz-feed');
    if (!box) return;
    const now = Date.now();
    const open = openRows(now);
    const liveRows = open.filter(isLive);
    const next = open.find((r) => !isLive(r));
    const recent = historyRows(now).slice(0, 6);

    if (liveRows.length) {
      box.innerHTML = `
        <div class="tz-panel-head"><div><h3><span class="tn-live-dot"></span> Happening now</h3><small>${liveRows.length} live · trophies move as games finish</small></div></div>
        <div class="tz-feed-live">${liveRows.map((r) => liveCardHTML(r, now)).join('')}</div>
        ${next ? `<div class="tz-feed-sub">Up next</div>${liveCardHTML(next, now)}` : ''}
        ${recent.length ? `<div class="tz-feed-sub">Latest results</div>
          <div class="tz-tickets compact">${recent.slice(0, 3).map(ticketHTML).join('')}</div>` : ''}
        <button class="tz-more" data-goto="history">See past tournaments →</button>`;
    } else {
      box.innerHTML = `
        <div class="tz-panel-head"><div><h3>Recent results</h3><small>${recent.length ? 'The latest podiums' : 'Nothing has finished yet'}</small></div></div>
        ${next ? `<div class="tz-feed-sub">Up next</div>${liveCardHTML(next, now)}<div class="tz-feed-sub">Latest</div>` : ''}
        ${recent.length ? `<div class="tz-tickets compact">${recent.map(ticketHTML).join('')}</div>`
          : '<div class="rk-empty"><b>No results yet</b><small>Finished tournaments land here with their podiums.</small></div>'}
        ${historyRows(now).length > recent.length ? '<button class="tz-more" data-goto="history">All history →</button>' : ''}`;
    }
    wireList(box);
  }

  const emptyHTML = (msg) => `<div class="rk-empty wide"><span class="rk-empty-ico">${TROPHY_SVG}</span><b>${esc(msg)}</b></div>`;

  function wireList(scope) {
    scope.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => { location.hash = tournamentHash(b.dataset.open); };
      b.onkeydown = (e) => { if (e.key === 'Enter') b.onclick(); };
    });
    scope.querySelectorAll('[data-open-lichess]').forEach((b) => {
      b.onclick = () => { location.hash = li.hashFor(b.dataset.openLichess); };
      b.onkeydown = (e) => { if (e.key === 'Enter') b.onclick(); };
    });
    scope.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => { tab = b.dataset.goto; paintBody(); };
    });
    scope.querySelectorAll('[data-archive]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const [kind, id] = b.dataset.archive.split(':');
        const hide = b.dataset.hidden !== '1';
        if (hide) {
          const ok = await confirmDialog({
            title: 'Archive this tournament?',
            body: 'Students will no longer see it, and it stops counting towards the ranked leaderboard. You can restore it any time.',
            confirmText: 'Archive'
          });
          if (!ok) return;
        }
        try {
          await setArchived(kind, id, hide);
          toast(hide ? 'Archived — hidden from students and ranked' : 'Restored', 'ok');
        } catch (err) {
          console.error(err);
          toast(err.code === 'permission-denied' ? 'Only club staff can archive tournaments.' : 'Could not change that', 'error');
        }
      };
    });
  }

  /* ── keeping it live ─────────────────────────────────────────────── */

  const stops = [
    watchTournamentList(ctx, (r) => { all = r; paintBody(); }),
    watchLichess(ctx, (r) => { lichess = r; paintBody(); }),
    watchRanked(ctx, (b) => {
      board = b;
      paintHero();
      if (tab === 'ranked') { paintBoard(); paintFeed(); }
      noteMyRank(ctx, b);
    })
  ];
  paintHero();

  /* A club's lichess teams have to be synced by somebody, and this is the
     page where the result shows. Outside a club the hub page has already
     started a worker for the global scope, so this does not. The lease means
     a second worker would be harmless anyway — just pointless. */
  if (ctx.clubId) {
    import('./lichess-sync.js')
      .then(({ startSync }) => { stops.push(startSync(ctx)); })
      .catch((e) => console.warn('Could not start the lichess sync', e));
  }

  /* Countdowns move on their own, without redrawing anything else; a start
     time passing changes what belongs where, so that redraws once. */
  let lastSplit = '';
  const tick = setInterval(() => {
    const now = Date.now();
    host.querySelectorAll('[data-until]').forEach((n) => {
      const at = +n.dataset.until;
      if (at) n.textContent = countdown(at - now);
    });
    const split = openRows(now).map((r) => r.t.id + r.phase).join();
    if (split !== lastSplit) {
      if (lastSplit) paintBody();
      lastSplit = split;
    }
  }, 1000);

  return () => {
    unmountSetup();
    stops.forEach((s) => { try { s(); } catch (_) {} });
    clearInterval(tick);
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  CREATING                                                           */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Two kinds of tournament can be created from this page, and they are not
 * variations on each other: one runs here, one runs on lichess. So the
 * button asks which rather than burying the choice in a form.
 */
export function openNewMenu(ctx, anchor) {
  const wrap = el(`
    <div class="modal tn-modal">
      <div class="modal-card tn-pick">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <h3>New tournament</h3>
        <p class="modal-meta" style="margin:0 0 4px">Where should it run?</p>
        <div class="tn-choice tn-pick-choice">
          <button type="button" class="tn-opt" data-v="arena">
            <b>JagChess arena</b>
            <small>Runs here. Timed, auto-paired, and it moves
              ${ctx.clubId ? 'club' : 'global'} JagChess ratings. Everybody needs a JagChess account.</small>
          </button>
          <button type="button" class="tn-opt" data-v="lichess">
            <b>Lichess tournament</b>
            <small>Created on lichess.org through its official API, with the full
              lichess setup — arena or Swiss, variants, entry conditions. Moves lichess
              ratings, and appears live on this page.</small>
          </button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };

  wrap.querySelector('.tn-pick-choice').onclick = async (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    close();
    if (b.dataset.v === 'arena') {
      openTournamentCreate(ctx, (t) => { location.hash = tournamentHash(t.id); });
      return;
    }
    const teams = await listTeams(ctx).catch(() => []);
    openLichessCreate(ctx, teams, (t) => { location.hash = li.hashFor(t.id); });
  };
}

export function openTournamentCreate(ctx, onDone) {
  const inClub = !!ctx.clubId;
  const hasEvents = inClub && ((ctx.club && ctx.club.blocks) || []).some((b) => b.type === 'events');

  // default to the next round hour, an hour out
  const soon = new Date(Date.now() + 60 * 60000);
  soon.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const dateVal = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  const timeVal = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

  const state = {
    rated: true, berserk: false,
    durationMin: 60, tcId: '5+3',
    addToCalendar: hasEvents
  };

  const wrap = el(`
    <div class="modal tn-modal">
      <div class="modal-card tn-create">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <h3>New tournament</h3>
        <p class="modal-meta" style="margin:0">
          ${inClub
            ? `For members of ${esc((ctx.club && ctx.club.name) || 'this club')}.`
            : 'Open to anybody on JagChess.'}
        </p>

        <div class="tn-field">
          <label for="tn-name">Name</label>
          <input id="tn-name" placeholder="Friday Night Arena" autocomplete="off" />
        </div>

        <div class="tn-field">
          <label for="tn-desc">Description <span class="opt">optional</span></label>
          <textarea id="tn-desc" rows="2" placeholder="Anything entrants should know."></textarea>
        </div>

        <div class="tn-row-2">
          <div class="tn-field">
            <label for="tn-date">Starts on</label>
            <input id="tn-date" type="date" value="${dateVal}" />
          </div>
          <div class="tn-field">
            <label for="tn-time">At</label>
            <input id="tn-time" type="time" value="${timeVal}" />
          </div>
        </div>

        <div class="tn-row-2">
          <div class="tn-field">
            <label for="tn-tc">Time control</label>
            <select id="tn-tc"></select>
          </div>
          <div class="tn-field">
            <label for="tn-dur">Lasts</label>
            <select id="tn-dur">
              ${DURATIONS.map((d) => `<option value="${d}"${d === 60 ? ' selected' : ''}>${d} minutes</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="tn-field">
          <label>Stakes</label>
          <div class="duel-seg" id="tn-rated">
            <button type="button" class="duel-seg-opt on" data-v="rated">Rated</button>
            <button type="button" class="duel-seg-opt" data-v="casual">Casual</button>
          </div>
          <small class="tn-hint" id="tn-rated-hint"></small>
        </div>

        <label class="tn-switch">
          <span>
            <b>Allow berserk</b>
            <small>Players may halve their own clock for a bonus point on a win.</small>
          </span>
          <span class="switch">
            <input type="checkbox" id="tn-berserk" />
            <span class="switch-track"><span class="switch-knob"></span></span>
          </span>
        </label>

        ${hasEvents ? `
        <label class="tn-switch">
          <span>
            <b>Add to the club calendar</b>
            <small>Writes the event onto the Events page for you.</small>
          </span>
          <span class="switch">
            <input type="checkbox" id="tn-cal" checked />
            <span class="switch-track"><span class="switch-knob"></span></span>
          </span>
        </label>` : ''}

        <div class="tn-create-foot">
          <span class="create-error" id="tn-error"></span>
          <button class="btn subtle" data-x>Cancel</button>
          <button class="btn primary" id="tn-save">Create tournament</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(wrap);
  const q = (s) => wrap.querySelector(s);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };

  /* time controls */
  const tcSel = q('#tn-tc');
  let lastCat = '';
  tcSel.innerHTML = TIME_CONTROLS.map((t) => {
    const head = t.cat !== lastCat ? (lastCat ? '</optgroup>' : '') + `<optgroup label="${t.cat}">` : '';
    lastCat = t.cat;
    return head + `<option value="${t.id}">${t.min} + ${t.inc}</option>`;
  }).join('') + '</optgroup>';
  tcSel.value = state.tcId;
  tcSel.onchange = () => { state.tcId = tcSel.value; };

  function paint() {
    wrap.querySelectorAll('#tn-rated [data-v]').forEach((b) =>
      b.classList.toggle('on', b.dataset.v === (state.rated ? 'rated' : 'casual')));

    q('#tn-rated-hint').textContent = state.rated
      ? (inClub
        ? 'Every game moves the club rating and the players’ records.'
        : 'Every game moves the global rating and the players’ records.')
      : 'Standings are kept, but nobody’s rating moves.';
  }

  q('#tn-rated').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    state.rated = b.dataset.v === 'rated';
    paint();
  };
  q('#tn-dur').onchange = (e) => { state.durationMin = +e.target.value; };
  q('#tn-berserk').onchange = (e) => { state.berserk = e.target.checked; };
  if (q('#tn-cal')) q('#tn-cal').onchange = (e) => { state.addToCalendar = e.target.checked; };

  paint();
  setTimeout(() => q('#tn-name').focus(), 60);

  q('#tn-save').onclick = async () => {
    const err = q('#tn-error');
    err.textContent = '';
    const name = q('#tn-name').value.trim();
    if (!name) { err.textContent = 'Give the tournament a name.'; return; }

    const d = q('#tn-date').value;
    const tm = q('#tn-time').value;
    if (!d || !tm) { err.textContent = 'Pick a date and a time.'; return; }
    const startsAt = new Date(`${d}T${tm}`).getTime();
    if (!isFinite(startsAt)) { err.textContent = 'That date does not look right.'; return; }

    const btn = q('#tn-save');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const t = await createTournament(ctx, {
        name,
        description: q('#tn-desc').value.trim(),
        tc: tcFromId(state.tcId),
        rated: state.rated,
        berserk: state.berserk,
        startsAt,
        durationMin: state.durationMin,
        addToCalendar: state.addToCalendar
      });
      close();
      toast('Tournament created', 'ok');
      if (onDone) onDone(t);
    } catch (e) {
      console.error(e);
      err.textContent = e.code === 'permission-denied'
        ? 'You do not have permission to create tournaments here.'
        : (e.message || 'Could not create that tournament.');
      btn.disabled = false;
      btn.textContent = 'Create tournament';
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  ONE TOURNAMENT                                                     */
/* ═══════════════════════════════════════════════════════════════════ */

export async function renderTournamentView(ctx, host, id, api) {
  let t = null;
  let players = [];
  let games = [];
  let dead = false;

  /* guards so the engine work never runs twice at once in this tab */
  let pairing = false;
  let closing = false;
  const applied = new Set();

  host.innerHTML = '<div class="tn-view"><div class="empty-state">Loading the tournament…</div></div>';

  const me = () => players.find((p) => p.uid === ctx.user.uid) || null;
  const backHash = () => (api && api.listHash) || 'tournaments';

  /* ── painting ──────────────────────────────────────────────────── */

  function paint() {
    if (dead || !t) return;
    const now = Date.now();
    const phase = phaseOf(t, now);
    const mine = me();
    const joined = !!mine && mine.state !== 'out';
    const rows = standingsFor(t, players);
    const manage = canManage(t, ctx);

    host.innerHTML = `
      <div class="tn-view">
        <button class="tn-back" id="tn-back">← All tournaments</button>

        <section class="tn-hero ${isRetiredFormat(t.format) ? 'retired' : t.format} ${phase}">
          <div class="tn-hero-main">
            <div class="tn-hero-status">
              <span class="tn-status ${phase}">${phase === 'running' || phase === 'ending' ? '<span class="tn-live-dot"></span>' : ''}${PHASE_LABEL[phase]}</span>
              ${t.scope === 'club' ? `<span class="tn-pill soft">${esc(t.clubName || 'Club')}</span>` : '<span class="tn-pill soft">Global</span>'}
            </div>
            <h2>${esc(t.name)}</h2>
            <div class="tn-hero-terms">${termPills(t)}</div>
            ${t.description ? `<p class="tn-hero-desc">${esc(t.description)}</p>` : ''}
            <div class="tn-hero-host">${avatarHTML(t.host, 22)} Hosted by ${esc(t.host.username)} · ${startLabel(t)}</div>
          </div>
          <div class="tn-hero-side">
            ${clockHTML(phase, now)}
            ${actionsHTML(phase, joined, mine)}
          </div>
        </section>

        ${manage && phase !== 'finished' && phase !== 'cancelled'
          ? `<div class="tn-manage">
               <span>You are hosting this.</span>
               ${phase === 'running' ? '<button class="btn subtle sm" id="tn-finish">Finish now</button>' : ''}
               ${phase === 'scheduled' || phase === 'retired' ? '<button class="btn subtle sm danger" id="tn-cancel">Cancel tournament</button>' : ''}
             </div>` : ''}

        ${phase === 'cancelled' ? '<div class="empty-state">This tournament was cancelled.</div>' : ''}
        ${retiredHTML(phase)}

        ${t.podiumResult && t.podiumResult.length ? arenaPodium(t.podiumResult) : ''}

        <div class="tn-body">
          <div class="tn-main">
            ${standingsHTML(rows, phase)}
          </div>
          <aside class="tn-side">
            ${nextGameHTML(phase, mine, joined)}
            ${liveGamesHTML()}
            ${isRetiredFormat(t.format) ? '' : scoringHTML()}
          </aside>
        </div>
      </div>`;

    wire(phase, mine, joined, manage);
  }

  /* ── header pieces ─────────────────────────────────────────────── */

  function clockHTML(phase, now) {
    if (phase === 'scheduled') {
      return `<div class="tn-clock"><b>${countdown(t.startsAt - now)}</b><small>until it starts</small></div>`;
    }
    if (phase === 'running') {
      return `<div class="tn-clock live"><b>${countdown(arenaEndsAt(t) - now)}</b><small>remaining</small></div>`;
    }
    if (phase === 'ending') {
      return '<div class="tn-clock"><b>0:00</b><small>time is up</small></div>';
    }
    return `<div class="tn-clock"><b>${players.length}</b><small>entrants</small></div>`;
  }

  /* A format that no longer exists says so plainly, rather than leaving an
     entrant staring at a page that is never going to move again. */
  function retiredHTML(phase) {
    if (phase !== 'retired') return '';
    const r = RETIRED_FORMATS[t.format];
    return `<div class="tn-retired">
      <b>${esc(r.name)} tournaments have been discontinued.</b>
      <span>${esc(r.note)} This one never finished, so it has no result. Every rating
        change from the games that were actually played still stands.</span>
    </div>`;
  }

  function actionsHTML(phase, joined, mine) {
    if (phase === 'finished' || phase === 'cancelled') return '';
    if (phase === 'retired') return '<div class="tn-out">Discontinued.</div>';
    const open = isOpenForEntry(t);

    if (!joined) {
      return open
        ? '<button class="btn primary lg" id="tn-join">Join</button>'
        : '<div class="tn-out">Entries are closed.</div>';
    }
    if (mine.state === 'paused') {
      return '<button class="btn primary lg" id="tn-join">Come back in</button>';
    }
    const canPause = phase === 'running' || phase === 'ending';
    return `
      <div class="tn-joined">In — ${mine.score || 0} pts</div>
      ${canPause ? '<button class="btn subtle" id="tn-pause">Pause</button>' : ''}
      ${phase === 'scheduled' ? '<button class="btn subtle" id="tn-withdraw">Withdraw</button>' : ''}
      ${t.berserk && phase === 'running' ? `
        <label class="tn-berserk-toggle ${mine.wantBerserk ? 'on' : ''}">
          <input type="checkbox" id="tn-berserk-next" ${mine.wantBerserk ? 'checked' : ''} />
          Berserk my next game
        </label>` : ''}`;
  }

  function arenaPodium(podium) {
    const label = ['Champion', 'Runner-up', 'Third'];
    const scored = !isRetiredFormat(t.format);
    return `<section class="tz-podium-stage">${podiumHTML(podium.slice(0, 3).map((p, i) => ({
      uid: p.uid,
      person: p,
      value: p.score != null && scored ? `${TROPHY_SVG}${p.score} pts` : '',
      sub: label[i]
    })), { cls: 'big' })}</section>`;
  }

  /* ── standings ─────────────────────────────────────────────────── */

  function standingsHTML(rows, phase) {
    /* A discontinued bracket was ranked by seed and finishing place, never by
       points, so its table keeps the columns it was written with. */
    const scored = !isRetiredFormat(t.format);
    if (!rows.length) {
      return `<section class="tile tn-standings">
        <div class="tn-standings-head"><h3>${scored ? 'Standings' : 'Entrants'}</h3></div>
        <div class="empty-state">Nobody has entered yet. Be the first.</div>
      </section>`;
    }
    return `
      <section class="tile tn-standings">
        <div class="tn-standings-head">
          <h3>${phase === 'finished' ? 'Final standings' : scored ? 'Standings' : 'Entrants'}</h3>
          <span class="muted">${rows.length} ${rows.length === 1 ? 'player' : 'players'}</span>
        </div>
        <div class="tn-row tn-row-head">
          <span class="tn-c-rank">#</span>
          <span class="tn-c-player">Player</span>
          <span class="tn-c-wdl">W/D/L</span>
          <span class="tn-c-score">${scored ? 'Score' : 'Seed'}</span>
        </div>
        <div class="tn-rows">${rows.map((p, i) => {
          const isMe = p.uid === ctx.user.uid;
          const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          return `<div class="tn-row ${isMe ? 'me' : ''} ${p.state === 'out' ? 'gone' : ''}" data-profile="${esc(p.uid)}">
            <span class="tn-c-rank ${medal}">${p.place || i + 1}</span>
            <span class="tn-c-player">
              ${avatarHTML(p, 30)}
              <span class="tn-player-id">
                <span class="tn-player-name">${esc(p.username)}${isMe ? '<span class="lb-me-badge">You</span>' : ''}${onFire(p) && scored ? '<span class="tn-fire" title="On a streak — double points">streak</span>' : ''}</span>
                <span class="tn-player-sub">${displayRating(p.rating)}${p.state === 'playing' ? ' · playing' : p.state === 'paused' ? ' · paused' : p.state === 'out' ? ' · out' : ''}</span>
              </span>
            </span>
            <span class="tn-c-wdl">${p.wins || 0}/${p.draws || 0}/${p.losses || 0}</span>
            <span class="tn-c-score">${scored ? (p.score || 0) : (p.seed ? '#' + p.seed : '—')}</span>
          </div>`;
        }).join('')}</div>
      </section>`;
  }

  /* ── side panels ───────────────────────────────────────────────── */

  function nextGameHTML(phase, mine, joined) {
    if (!joined || phase === 'finished' || phase === 'cancelled') return '';

    if (mine && mine.currentGameId) {
      return `<section class="tile tn-next live">
        <h4>Your game is on</h4>
        <button class="btn primary block" data-enter="${esc(mine.currentGameId)}">Enter the game</button>
      </section>`;
    }

    if (phase === 'scheduled') {
      return `<section class="tile tn-next">
        <h4>You are in</h4>
        <p class="modal-meta" style="margin:0">
          When it starts you will be paired automatically. Keep this page open.
        </p>
      </section>`;
    }

    // arena
    if (mine && mine.state === 'paused') {
      return `<section class="tile tn-next"><h4>Paused</h4>
        <p class="modal-meta" style="margin:0">You will not be paired again until you come back in. Your ${mine.score || 0} points are safe.</p></section>`;
    }
    return `<section class="tile tn-next">
      <h4>Looking for a game…</h4>
      <p class="modal-meta" style="margin:0">You are in the pool. The next opponent near your score gets paired with you.</p>
      <div class="tn-pool-bar"><span></span></div>
    </section>`;
  }

  function liveGamesHTML() {
    const live = games.filter((g) => g.status === 'active');
    if (!live.length) return '';
    return `<section class="tile tn-live">
      <h4>Games in progress</h4>
      <div class="tn-live-list">${live.slice(0, 8).map((g) => `
        <button class="tn-live-row" data-watch="${esc(g.id)}">
          <span>${esc(g.white.username)}</span>
          <span class="tn-vs">vs</span>
          <span>${esc(g.black.username)}</span>
        </button>`).join('')}</div>
    </section>`;
  }

  function scoringHTML() {
    return `<section class="tile tn-rules">
      <h4>How scoring works</h4>
      <div class="tn-rule"><span>Win</span><b>2</b></div>
      <div class="tn-rule"><span>Draw</span><b>1</b></div>
      <div class="tn-rule"><span>Loss</span><b>0</b></div>
      <div class="tn-rule"><span>On a streak</span><b>double</b></div>
      ${t.berserk ? '<div class="tn-rule"><span>Berserked win</span><b>+1</b></div>' : ''}
      <p class="field-hint" style="margin:10px 0 0">Two wins in a row starts a streak. Everything after it is worth double until you fail to win.</p>
    </section>`;
  }

  /* ── wiring ────────────────────────────────────────────────────── */

  function wire(phase, mine, joined, manage) {
    const q = (s) => host.querySelector(s);
    q('#tn-back').onclick = () => { location.hash = backHash(); };

    host.querySelectorAll('[data-enter]').forEach((b) => {
      b.onclick = () => { location.hash = 'duel/' + b.dataset.enter; };
    });
    host.querySelectorAll('[data-watch]').forEach((b) => {
      b.onclick = () => { location.hash = 'duel/' + b.dataset.watch; };
    });

    if (q('#tn-join')) q('#tn-join').onclick = async (e) => {
      e.target.disabled = true;
      try { await joinTournament(ctx, t); toast('You are in', 'ok'); }
      catch (err) { toast(err.message || 'Could not join.', 'error'); e.target.disabled = false; }
    };
    if (q('#tn-pause')) q('#tn-pause').onclick = () =>
      pauseInTournament(t, ctx.user.uid).catch(() => toast('Could not pause', 'error'));
    if (q('#tn-withdraw')) q('#tn-withdraw').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Withdraw?', body: 'You give up your seat. You can enter again while entries are open.',
        confirmText: 'Withdraw', danger: true
      });
      if (ok) withdrawFromTournament(t, ctx.user.uid).catch(() => toast('Could not withdraw', 'error'));
    };
    if (q('#tn-berserk-next')) q('#tn-berserk-next').onchange = (e) =>
      updateDoc(tPlayerRef(t.id, ctx.user.uid), { wantBerserk: e.target.checked }).catch(() => {});

    if (q('#tn-finish')) q('#tn-finish').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Finish this arena now?',
        body: 'Standings are frozen where they are and the leader wins. Games already in progress still count.',
        confirmText: 'Finish now'
      });
      if (ok) finishTournament(t, players).catch(() => toast('Could not finish it', 'error'));
    };
    if (q('#tn-cancel')) q('#tn-cancel').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Cancel this tournament?',
        body: 'Entrants are told it is off, and the calendar entry is removed.',
        confirmText: 'Cancel it', danger: true
      });
      if (ok) {
        await cancelTournament(t).catch(() => toast('Could not cancel it', 'error'));
        toast('Tournament cancelled');
      }
    };
  }

  /* ── the engine loop ───────────────────────────────────────────── */

  /* Everything below is safe to run from every open tab: each step either
     carries an idempotency guard or writes an absolute value. */
  async function tickEngine() {
    if (dead || !t) return;
    const phase = phaseOf(t);
    const mine = me();

    // 1 — finished games get counted, exactly once each
    for (const g of games) {
      if (g.status !== 'finished' || applied.has(g.id)) continue;
      applied.add(g.id);
      await applyTournamentGame(t, g).catch((e) => {
        applied.delete(g.id);
        console.warn('Could not record a tournament game', e);
      });
    }

    if (phase === 'cancelled' || phase === 'finished' || phase === 'retired') return;

    // 2 — an arena pairs whoever is free
    if (phase === 'running' && mine &&
        mine.state === 'ready' && !mine.currentGameId && !pairing) {
      const them = findArenaOpponent(players, ctx.user.uid);
      // one side initiates; the transaction settles it if both somehow do
      if (them && ctx.user.uid < them.uid) {
        pairing = true;
        try {
          const gameId = await pairArena(t, mine, them);
          if (gameId) location.hash = 'duel/' + gameId;
        } catch (e) {
          if (e && e.message !== 'busy' && e.message !== 'gone') console.warn('Pairing failed', e);
        } finally { pairing = false; }
      }
    }

    /* 3 — an arena whose clock has run out closes itself, once the games that
       were already going have finished. A row left "playing" by a tab that
       died is ignored after a grace period, or the arena would never close. */
    if (phase === 'ending' && !closing) {
      const cutoff = Date.now() - 3 * 60000;
      const stillPlaying = players.some((p) =>
        p.currentGameId && (p.heartbeat || 0) > cutoff);
      if (!stillPlaying) {
        closing = true;
        try { await finishTournament(t, players); }
        catch (e) { console.warn('Could not close the arena', e); }
        finally { closing = false; }
      }
    }
  }

  /* ── subscriptions ─────────────────────────────────────────────── */

  const stops = [
    watchTournament(id, (row) => {
      if (!row) {
        host.innerHTML = `<div class="empty-state">That tournament no longer exists.
          <button class="btn subtle sm" id="tn-gone">Back</button></div>`;
        const b = host.querySelector('#tn-gone');
        if (b) b.onclick = () => { location.hash = backHash(); };
        dead = true;
        return;
      }
      t = row;
      paint();
      tickEngine();
    }),
    watchPlayers(id, (rows) => { players = rows; paint(); tickEngine(); }),
    watchTournamentGames(id, (rows) => { games = rows; paint(); tickEngine(); })
  ];

  /* The countdown has to move, and the engine has to get a chance to act even
     when nothing has changed — a start time passing is not a snapshot. */
  const tick = setInterval(() => { paint(); tickEngine(); }, 1000);

  /* Being on the page is what marks you as available to be paired. */
  const pulse = setInterval(() => {
    const mine = me();
    const p = t && phaseOf(t);
    if (mine && mine.state !== 'out' && (p === 'scheduled' || p === 'running' || p === 'ending')) {
      beat(t, ctx.user.uid);
    }
  }, 10000);

  return () => {
    dead = true;
    stops.forEach((s) => { try { s(); } catch (_) {} });
    clearInterval(tick);
    clearInterval(pulse);
  };
}
