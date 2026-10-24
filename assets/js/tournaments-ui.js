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
/*  THE LIST                                                           */
/* ═══════════════════════════════════════════════════════════════════ */

export async function renderTournaments(ctx, host, api) {
  const mayHost = ctx.clubId ? ctx.isAdmin : true;
  /* Configuring which lichess teams a page watches decides what everyone
     else sees, so it belongs to whoever runs the place: a club's own staff
     inside a club, and the site administrator at /admin outside one. The
     hub's Tournaments page therefore has no setup tab. */
  const maySetUp = !!ctx.clubId && ctx.isAdmin;
  let all = [];
  let lichess = [];
  let tab = 'open';
  let source = 'all';
  let setupCleanup = null;

  host.innerHTML = `
    <div class="tn-head">
      <div class="tn-tabs">
        <button class="tn-tab on" data-t="open">Upcoming &amp; live</button>
        <button class="tn-tab" data-t="history">History</button>
        ${maySetUp ? '<button class="tn-tab" data-t="setup">Lichess</button>' : ''}
      </div>
      <div class="tn-head-right">
        <div class="duel-seg tn-source" id="tn-source" hidden>
          <button type="button" class="duel-seg-opt on" data-s="all">All</button>
          <button type="button" class="duel-seg-opt" data-s="jag">JagChess</button>
          <button type="button" class="duel-seg-opt" data-s="lichess">Lichess</button>
        </div>
        ${mayHost ? '<button class="btn primary" id="tn-new">＋ New tournament</button>' : ''}
      </div>
    </div>
    <div id="tn-list"></div>`;

  if (mayHost) {
    host.querySelector('#tn-new').onclick = () => openNewMenu(ctx, host.querySelector('#tn-new'));
  }

  host.querySelector('#tn-source').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    source = b.dataset.s;
    host.querySelectorAll('#tn-source [data-s]').forEach((x) =>
      x.classList.toggle('on', x.dataset.s === source));
    paint();
  };

  host.querySelector('.tn-tabs').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    tab = b.dataset.t;
    host.querySelectorAll('.tn-tab').forEach((x) => x.classList.toggle('on', x.dataset.t === tab));
    paint();
  };

  /* The admin panel is a whole module with its own subscriptions, so it is
     mounted and unmounted rather than repainted with the list. */
  async function mountSetup() {
    const list = host.querySelector('#tn-list');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const { renderLichessAdmin } = await import('./lichess-admin.js');
    if (tab !== 'setup') return;
    list.innerHTML = '';
    setupCleanup = renderLichessAdmin(ctx, list, { ownSync: false });
  }

  const unmountSetup = () => {
    if (!setupCleanup) return;
    try { setupCleanup(); } catch (_) {}
    setupCleanup = null;
  };

  /* Two very different phase vocabularies, reduced to the one question the
     list asks: is this still to come, or is it over? */
  const openish = (kind, phase) => kind === 'lichess'
    ? (phase === 'scheduled' || phase === 'starting' || phase === 'running')
    : (phase === 'scheduled' || phase === 'running' || phase === 'ending');

  function paint() {
    if (tab === 'setup') {
      host.querySelector('#tn-source').hidden = true;
      const btn = host.querySelector('#tn-new');
      if (btn) btn.hidden = true;
      if (!setupCleanup) mountSetup();
      return;
    }
    unmountSetup();
    const btn = host.querySelector('#tn-new');
    if (btn) btn.hidden = false;

    const now = Date.now();
    host.querySelector('#tn-source').hidden = !lichess.length;

    const jagRows = (source === 'lichess' ? [] : all)
      .map((t) => ({ kind: 'jag', t, phase: phaseOf(t, now) }));
    const liRows = (source === 'jag' ? [] : lichess)
      .map((t) => ({ kind: 'lichess', t, phase: li.phaseOf(t, now) }));

    /* A discontinued format is history whatever its status says — an
       unfinished bracket must not sit at the top of "upcoming" forever. */
    const rows = [...jagRows, ...liRows].filter(({ kind, phase }) =>
      tab === 'open' ? openish(kind, phase) : !openish(kind, phase));

    // live first, then whatever starts soonest
    const liveRank = (r) => (r.phase === 'running' || r.phase === 'ending' || r.phase === 'starting' ? 0 : 1);
    rows.sort((a, b) => {
      if (tab === 'open') {
        return liveRank(a) - liveRank(b) || (a.t.startsAt || 0) - (b.t.startsAt || 0);
      }
      const ended = (r) => (r.kind === 'lichess' ? (r.t.finishesAt || r.t.startsAt || 0)
        : (r.t.finishedAt || r.t.startsAt || 0));
      return ended(b) - ended(a);
    });

    const list = host.querySelector('#tn-list');
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state">${tab === 'open'
        ? (mayHost
          ? 'No tournaments scheduled. Create one — a date on the calendar is the best thing you can give a club.'
          : 'No tournaments scheduled right now.')
        : 'No tournaments have finished yet.'}</div>`;
      return;
    }

    list.innerHTML = `<div class="tn-grid">${rows.map(({ kind, t, phase }) => {
      if (kind === 'lichess') return li.lichessCard(t, now);
      const live = phase === 'running' || phase === 'ending';
      const podium = t.podiumResult || [];
      return `
      <button class="tn-card ${phase}" data-open="${esc(t.id)}">
        <div class="tn-card-top">
          <span class="tn-status ${phase}">${live ? '<span class="tn-live-dot"></span>' : ''}${PHASE_LABEL[phase]}</span>
          <span class="tn-when">${phase === 'scheduled'
            ? 'in ' + countdown(t.startsAt - now)
            : live
              ? countdown(arenaEndsAt(t) - now) + ' left'
              : startLabel(t)}</span>
        </div>
        <div class="tn-card-name">${esc(t.name)}</div>
        <div class="tn-card-terms">${termPills(t)}</div>
        ${podium.length ? `<div class="tn-podium-mini">${podium.slice(0, 3).map((p, i) =>
          `<span class="tn-podium-chip p${i + 1}">${['1st', '2nd', '3rd'][i]} ${esc(p.username)}</span>`).join('')}</div>` : ''}
        <div class="tn-card-foot">
          <span class="tn-card-host">${avatarHTML(t.host, 20)} ${esc(t.host.username)}</span>
          <span class="tn-card-count">${t.playerCount || 0} ${(t.playerCount || 0) === 1 ? 'player' : 'players'}</span>
        </div>
      </button>`;
    }).join('')}</div>`;

    list.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => { location.hash = tournamentHash(b.dataset.open); };
    });
    list.querySelectorAll('[data-open-lichess]').forEach((b) => {
      b.onclick = () => { location.hash = li.hashFor(b.dataset.openLichess); };
    });
  }

  const stops = [
    watchTournamentList(ctx, (rows) => { all = rows; paint(); }),
    watchLichess(ctx, (rows) => { lichess = rows; paint(); })
  ];

  /* A club's lichess teams have to be synced by somebody, and this is the
     page where the result shows. Outside a club the hub page has already
     started a worker for the global scope, so this does not. The lease means
     a second worker would be harmless anyway — just pointless. */
  if (ctx.clubId) {
    import('./lichess-sync.js')
      .then(({ startSync }) => { stops.push(startSync(ctx)); })
      .catch((e) => console.warn('Could not start the lichess sync', e));
  }
  // the countdowns on the cards have to move on their own
  const tick = setInterval(paint, 1000);

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

        ${t.podiumResult && t.podiumResult.length ? podiumHTML(t.podiumResult) : ''}

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

  function podiumHTML(podium) {
    const label = ['Champion', 'Runner-up', 'Third', 'Fourth'];
    return `<section class="tn-podium">${podium.map((p, i) => `
      <div class="tn-podium-card p${i + 1}">
        <span class="tn-podium-place">${i + 1}</span>
        ${avatarHTML(p, 44)}
        <b>${esc(p.username)}</b>
        <small>${label[i]}${p.score != null && !isRetiredFormat(t.format) ? ` · ${p.score} pts` : ''}</small>
      </div>`).join('')}</section>`;
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
          return `<div class="tn-row ${isMe ? 'me' : ''} ${p.state === 'out' ? 'gone' : ''}">
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
