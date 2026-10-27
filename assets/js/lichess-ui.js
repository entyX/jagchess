/* ═══════════════════════════════════════════════════════════════════════
   lichess-ui.js — lichess tournaments, on JagChess.

     lichessCard()              one card for the Tournaments list
     renderLichessTournament()  the live tournament page
     openPlayerCard()           one player's record in this tournament
     renderLichessPlayer()      one player across every tournament we hold

   Nothing here talks to lichess except the join flow, which has to: joining
   is an action taken by a person with their own token, not something a
   background worker can do for them. Everything else on the page — the
   standings, the participants, the games, the countdown — is read from our
   own database, which lichess-sync.js fills. That is the whole point of the
   split: a hundred people watching a tournament is a hundred Firestore
   listeners and no extra load on lichess at all.

   ─── the join button ───────────────────────────────────────────────────
   The single rule this page must never get wrong is the one the brief is
   most insistent about: DO NOT tell somebody they have to join a team when
   they do not. So the button is derived from stored facts, in this order:

     tournament over            → View results
     lichess not connected      → Log in with Lichess
     already a participant      → Enter / Play
     membership not required    → Join tournament
     membership required, in    → Join tournament
     membership required, out   → Join <team> on Lichess
     unavailable                → Unavailable

   "already a member" is checked against GET /api/team/of/{username}, which
   is lichess's own answer, and it is re-checked after the user comes back
   from joining a team rather than assumed.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, toast, fmtDate, fmtTime } from './club-core.js';
import * as api from './lichess-api.js';
import * as store from './lichess-store.js';
import {
  session, connect, disconnect, ensureScopes, hasScopes,
  onAuthChange, SCOPES, PLAYER_SCOPES
} from './lichess-auth.js';
import * as live from './lichess-live.js';
import { focusTournament } from './lichess-sync.js';
import { openLichessGame, closeLichessGame } from './lichess-board.js';
import {
  loadRanked, lastRanked, podiumHTML, personAvatar, mayArchive, setArchived, TROPHY_SVG
} from './ranked.js';

/* ── shared bits ───────────────────────────────────────────────────── */

export const hashFor = (id) => 'lichess/' + id;
export const gameHashFor = (id, gameId) => 'lichess/' + id + '/game/' + gameId;
export const playerHashFor = (name) => 'lichess-player/' + name;

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

export function countdown(ms) {
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

export const clockLabel = (c) => {
  if (!c) return '—';
  const limit = c.limit || 0;
  const mins = limit >= 60 ? String(limit / 60) : (limit / 60).toFixed(2).replace(/\.?0+$/, '');
  return `${limit === 0 ? '0' : mins} + ${c.increment || 0}`;
};

/** lichess's own name for the pace of a game, from the clock. */
export const speedOf = (c) => {
  if (!c) return '';
  const total = (c.limit || 0) + 40 * (c.increment || 0);
  if (total < 30) return 'UltraBullet';
  if (total < 180) return 'Bullet';
  if (total < 480) return 'Blitz';
  if (total < 1500) return 'Rapid';
  return 'Classical';
};

/**
 * The phase the page reads. `status` comes from lichess; this turns it into
 * the five words the interface uses, and adds the one state lichess cannot
 * report — a tournament it has forgotten.
 */
export function phaseOf(t, now = Date.now()) {
  if (!t) return 'missing';
  if (t.status === 'unavailable') return 'unavailable';
  if (t.status === 'finished') return 'finished';
  if (t.status === 'started') return 'running';
  if (t.startsAt && now >= t.startsAt) return 'starting';
  return 'scheduled';
}

export const PHASE_LABEL = {
  scheduled: 'Upcoming', starting: 'Starting', running: 'Live now',
  finished: 'Finished', unavailable: 'Unavailable', missing: 'Missing'
};

export const isOver = (t) => t.status === 'finished';

const avatarFor = (name, size = 30) =>
  `<span class="lb-avatar li-av" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px">${esc(String(name || '?').slice(0, 2).toUpperCase())}</span>`;

const titleTag = (t) => (t ? `<span class="li-title">${esc(t)}</span> ` : '');

/* Games this page session has already walked somebody into.
   It has to outlive one render: pressing Back out of your own game
   re-renders the tournament, and without this it would throw you straight
   back onto the board you just chose to leave. */
const entered = new Set();

/* ── the card the Tournaments list shows ───────────────────────────── */

export function lichessCard(t, now = Date.now()) {
  const phase = phaseOf(t, now);
  const live = phase === 'running' || phase === 'starting';
  const podium = t.podium || [];
  return `
    <button class="tn-card li-card ${phase}" data-open-lichess="${esc(t.id || t.lichessId)}">
      <div class="tn-card-top">
        <span class="tn-status ${phase}">${live ? '<span class="tn-live-dot"></span>' : ''}${PHASE_LABEL[phase]}</span>
        <span class="tn-when">${phase === 'scheduled'
          ? 'in ' + countdown((t.startsAt || 0) - now)
          : live && t.finishesAt
            ? countdown(t.finishesAt - now) + ' left'
            : `${fmtDate(t.startsAt)} · ${fmtTime(t.startsAt)}`}</span>
      </div>
      <div class="tn-card-name">${esc(t.name)}</div>
      <div class="tn-card-terms">
        <span class="tn-pill lichess">Lichess ${esc(t.kind === 'swiss' ? 'Swiss' : 'Arena')}</span>
        <span class="tn-pill">${esc(clockLabel(t.clock))} ${esc(speedOf(t.clock))}</span>
        <span class="tn-pill ${t.rated ? 'rated' : ''}">${t.rated ? 'Rated' : 'Casual'}</span>
        ${t.membershipRequired ? '<span class="tn-pill soft">Team only</span>' : ''}
        ${t.variant && t.variant !== 'standard' ? `<span class="tn-pill soft">${esc(t.variant)}</span>` : ''}
      </div>
      ${podium.length ? `<div class="tn-podium-mini">${podium.slice(0, 3).map((p, i) =>
        `<span class="tn-podium-chip p${i + 1}">${['1st', '2nd', '3rd'][i]} ${esc(p.username)}</span>`).join('')}</div>` : ''}
      <div class="tn-card-foot">
        <span class="tn-card-host">${t.teamName ? esc(t.teamName) : 'Lichess'}</span>
        <span class="tn-card-count">${t.nbPlayers || 0} ${(t.nbPlayers || 0) === 1 ? 'player' : 'players'}</span>
      </div>
    </button>`;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  ONE TOURNAMENT                                                     */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * The live tournament page.
 *
 * Three things keep it feeling live rather than merely correct:
 *
 *   1. A FOREGROUND POLLER. The lease worker exists so idle tabs do not
 *      hammer lichess; it is the wrong pace for the page somebody is looking
 *      at. While this page is open and visible it refreshes its own
 *      tournament every few seconds — see focusTournament.
 *   2. THE EVENT STREAM. The moment lichess pairs you, it says so, and this
 *      page walks you onto the board without you pressing anything.
 *   3. REPAINTING ONLY WHEN SOMETHING CHANGED. A full innerHTML rebuild
 *      every second loses your scroll position and makes the whole thing
 *      feel cheap. The clocks tick on their own; everything else waits for
 *      real news.
 *
 * @param {object} ctx
 * @param {HTMLElement} host
 * @param {string} id       the lichess tournament id
 * @param {object} api2     { listHash }
 * @returns {Promise<Function>} cleanup
 */
export async function renderLichessTournament(ctx, host, id, api2 = {}) {
  let t = null;
  let parts = [];
  let games = [];
  let dead = false;
  let tab = 'standings';
  let gameFilter = '';
  /* Who each lichess name is on JagChess, when anybody has said. */
  let board = lastRanked(ctx);
  const jagOf = (name) => {
    const uid = board && board.links && board.links[String(name || '').toLowerCase()];
    const person = uid && board.people && board.people[uid];
    return uid && person ? { uid, person } : null;
  };

  /* What lichess says about your teams. `null` means we have not asked or
     could not — never "you are not a member", which is the distinction that
     matters. */
  let myTeams = null;

  /* 'idle' → 'joining' → 'waiting' (in, looking for a pairing) → 'in' */
  let joinState = 'idle';
  let waitAbort = null;
  let lastNudge = 0;

  let sig = '';

  const backHash = () => api2.listHash || 'tournaments';
  host.innerHTML = '<div class="tn-view li-view"><div class="li-skeleton"><div class="li-sk-hero"></div><div class="li-sk-row"></div><div class="li-sk-row"></div><div class="li-sk-row"></div></div></div>';

  const meName = () => (session() || {}).username || null;
  const meRow = () => {
    const n = (meName() || '').toLowerCase();
    return n ? parts.find((p) => p.userId === n) || null : null;
  };
  const amIn = () => !!meRow();

  /* ── keeping it fresh ──────────────────────────────────────────── */

  const focus = focusTournament(ctx, () => t);

  /* ── teams: asked only when it actually matters ────────────────── */

  /*  The old version gated the Join button behind this check and got stuck
      when the check failed. It now runs in the background to get the LABEL
      right, and never blocks the action: pressing Join simply tries, and
      lichess is the one that decides. */
  async function refreshTeams({ force } = {}) {
    const s = session();
    if (!s || (myTeams && !force)) return myTeams;
    try {
      const rows = await api.teamsOf(s.username, s.token);
      myTeams = (rows || []).map((r) => r.id);
    } catch (e) {
      myTeams = null;
      console.warn('Could not read your lichess teams', e);
    }
    render();
    return myTeams;
  }

  const requiredTeams = () => {
    if (!t || !t.membershipRequired) return [];
    if (t.teamBattleTeams && t.teamBattleTeams.length) return t.teamBattleTeams;
    return t.requiredTeamId ? [t.requiredTeamId] : [];
  };

  const amMember = () => {
    const need = requiredTeams();
    if (!need.length) return true;
    if (!myTeams) return null;         // we have not been told
    return need.some((x) => myTeams.includes(x));
  };

  const teamLabel = () => {
    const need = requiredTeams();
    if (!need.length) return '';
    if (need.length === 1) return t.teamName && need[0] === t.teamId ? t.teamName : need[0];
    return 'one of the competing teams';
  };

  /* ── walking somebody onto their board ─────────────────────────── */

  function enterGame(gameId, { auto } = {}) {
    if (dead || !gameId) return;
    if (auto && entered.has(gameId)) return;
    entered.add(gameId);
    location.hash = gameHashFor(id, gameId);
  }

  /** The live game this account is playing in this tournament, if any. */
  function myLiveGame() {
    const fromStream = live.gameInTournament(id);
    if (fromStream) return fromStream.gameId;
    const n = (meName() || '').toLowerCase();
    if (!n) return null;
    const g = ongoing().find((x) =>
      (x.white.username || '').toLowerCase() === n || (x.black.username || '').toLowerCase() === n);
    return g ? g.gameId : null;
  }

  /* ── painting ──────────────────────────────────────────────────── */

  /* Everything that can change what the page looks like, in one string.
     When it has not moved, neither does the DOM. */
  function signature() {
    const s = session();
    return [
      t && t.status, t && t.nbPlayers, t && t.round, t && t.archived,
      t && t.membershipRequired, t && t.requiredTeamId,
      parts.length, parts.slice(0, 40).map((p) => p.userId + p.rank + p.score).join(','),
      games.length, games.filter((g) => g.state !== store.GAME_STATE.FINISHED).map((g) => g.gameId).join(','),
      tab, joinState, s && s.username, myTeams && myTeams.length, amIn(),
      t && t.staffHidden, board ? Object.keys(board.links || {}).length : -1
    ].join('|');
  }

  function render(force) {
    if (dead || !t) return;
    const next = signature();
    if (!force && next === sig) { tick(); return; }
    sig = next;

    const now = Date.now();
    const phase = phaseOf(t, now);

    host.innerHTML = `
      <div class="tn-view li-view">
        <button class="tn-back" id="li-back">← All tournaments</button>

        <section class="tn-hero li-hero ${phase}">
          <div class="tn-hero-main">
            <div class="tn-hero-status">
              <span class="tn-status ${phase}">${phase === 'running' || phase === 'starting' ? '<span class="tn-live-dot"></span>' : ''}${PHASE_LABEL[phase]}</span>
              <span class="tn-pill lichess">Lichess ${esc(t.kind === 'swiss' ? 'Swiss' : 'Arena')}</span>
              ${t.teamName ? `<span class="tn-pill soft">${esc(t.teamName)}</span>` : ''}
              ${t.clubName && t.clubName !== t.teamName ? `<span class="tn-pill soft">${esc(t.clubName)}</span>` : ''}
            </div>
            <h2>${esc(t.name)}</h2>
            <div class="tn-hero-terms">${termPills()}</div>
            ${t.description ? `<p class="tn-hero-desc">${esc(t.description)}</p>` : ''}
            <div class="tn-hero-host">
              ${t.createdBy ? `Created by ${esc(t.createdBy)} · ` : ''}${fmtDate(t.startsAt)} · ${fmtTime(t.startsAt)}
              ${t.durationMin ? ' · ' + t.durationMin + ' minutes' : ''}
              ${t.kind === 'swiss' && t.nbRounds ? ` · round ${t.round || 0} of ${t.nbRounds}` : ''}
            </div>
            <div class="li-hero-links">
              <a class="li-out" href="${esc(t.url)}" target="_blank" rel="noopener">Open on lichess.org ↗</a>
              ${mayArchive(ctx) ? `<button class="li-out li-archive" id="li-archive">${t.staffHidden ? 'Restore to students &amp; ranked' : 'Archive this tournament'}</button>` : ''}
            </div>
          </div>
          <div class="tn-hero-side">
            <div id="li-clock">${clockPanel(phase, now)}</div>
            ${actionPanel(phase)}
          </div>
        </section>

        ${t.staffHidden ? `<div class="li-notice-bar"><b>Archived.</b><span>Students do not see this tournament, and it does not count towards the ranked leaderboard.</span></div>` : ''}
        ${accessNotice(phase)}

        ${t.podium && t.podium.length ? lichessPodium(t.podium) : ''}

        <div class="tn-body">
          <div class="tn-main">
            <div class="li-tabs">
              <button class="tn-tab ${tab === 'standings' ? 'on' : ''}" data-tab="standings">Standings</button>
              <button class="tn-tab ${tab === 'games' ? 'on' : ''}" data-tab="games">Match history${games.length ? ` <span class="li-count">${games.length}</span>` : ''}</button>
              <button class="tn-tab ${tab === 'about' ? 'on' : ''}" data-tab="about">About</button>
            </div>
            ${tab === 'standings' ? standingsHTML() : tab === 'games' ? gamesHTML() : aboutHTML()}
          </div>
          <aside class="tn-side">
            ${mySidePanel(phase)}
            ${liveGamesHTML()}
            ${sourceHTML()}
          </aside>
        </div>
      </div>`;

    wire(phase);
  }

  /* The only thing that has to move every second. */
  function tick() {
    if (dead || !t) return;
    const box = host.querySelector('#li-clock');
    if (box) box.innerHTML = clockPanel(phaseOf(t), Date.now());
    const ago = host.querySelector('#li-ago');
    if (ago) ago.textContent = t.lastSyncedAt ? countdown(Date.now() - t.lastSyncedAt) + ' ago' : 'never';
  }

  function termPills() {
    return `
      <span class="tn-pill">${esc(clockLabel(t.clock))} ${esc(speedOf(t.clock))}</span>
      <span class="tn-pill ${t.rated ? 'rated' : ''}">${t.rated ? 'Rated' : 'Casual'}</span>
      ${t.variant && t.variant !== 'standard' ? `<span class="tn-pill soft">${esc(t.variant)}</span>` : ''}
      ${t.berserkable ? '<span class="tn-pill berserk">Berserk</span>' : ''}
      ${t.membershipRequired ? '<span class="tn-pill soft">Team members only</span>' : '<span class="tn-pill soft">Open to anyone</span>'}
      ${t.private ? '<span class="tn-pill soft">Password</span>' : ''}`;
  }

  function clockPanel(phase, now) {
    if (phase === 'scheduled') {
      return `<div class="tn-clock"><b>${countdown((t.startsAt || 0) - now)}</b><small>until it starts</small></div>`;
    }
    if (phase === 'running' && t.kind === 'swiss') {
      return `<div class="tn-clock live"><b>${t.round || 0}/${t.nbRounds || '?'}</b><small>rounds played</small></div>`;
    }
    if (phase === 'running' && t.finishesAt) {
      return `<div class="tn-clock live"><b>${countdown(t.finishesAt - now)}</b><small>remaining</small></div>`;
    }
    return `<div class="tn-clock"><b>${t.nbPlayers || parts.length}</b><small>players</small></div>`;
  }

  /* ── the one button that matters ───────────────────────────────── */

  /*  The rule: pressing it should get you playing, and it should never stop
      to ask you something lichess has not asked for. So it is optimistic.
      We do not pre-check team membership, we do not make you press a second
      button after joining, and if lichess refuses we deal with the refusal
      then — which is the only moment we actually know there is a problem. */
  function actionPanel(phase) {
    if (phase === 'unavailable') return '<div class="tn-out">Unavailable</div>';
    if (phase === 'finished') {
      return `<div class="tn-joined">Finished</div>
        ${amIn() && meRow().rank ? `<small class="li-side-note">You finished #${meRow().rank} on ${meRow().score || 0} points.</small>` : ''}`;
    }

    if (joinState === 'joining') {
      return `<button class="btn primary lg" disabled><span class="li-spin"></span> Joining…</button>`;
    }
    if (joinState === 'waiting') {
      return `<button class="btn primary lg" disabled><span class="li-spin"></span> Finding you a game…</button>
        <small class="li-side-note">Lichess is pairing you. Your board opens by itself — stay here.</small>
        <button class="btn subtle sm" id="li-stop-wait">Stop waiting</button>`;
    }

    const mine = meRow();
    if (mine) {
      const g = myLiveGame();
      return `<div class="tn-joined">You are in${mine.rank ? ` · #${mine.rank}` : ''} · ${mine.score || 0} pts</div>
        ${g ? '<button class="btn primary lg" id="li-play">Go to your game</button>'
          : phase === 'running'
            ? '<button class="btn primary lg" id="li-play">Find me a game</button>'
            : '<div class="li-side-note">Your first pairing opens here by itself when it starts.</div>'}
        <button class="btn subtle sm" id="li-withdraw">Withdraw</button>`;
    }

    /* Not in yet. One button, whatever the state of the login — the OAuth
       round trip is invisible to the person pressing it, and the join fires
       by itself when they come back. */
    const member = amMember();
    if (member === false) {
      return `<button class="btn primary lg" id="li-join">Join &amp; play</button>
        <small class="li-side-note">You are not in ${esc(teamLabel())} yet — lichess will ask you to join it first.</small>`;
    }
    return `<button class="btn primary lg" id="li-join">Join &amp; play</button>
      ${!session() ? '<small class="li-side-note">Signs you in with Lichess first. One tap after that.</small>' : ''}`;
  }

  /**
   * The sentence that explains the button. Written from what lichess said,
   * not from what the team listing implies — a tournament that merely turned
   * up under a team is open to everybody unless lichess says otherwise.
   */
  function accessNotice(phase) {
    if (phase === 'unavailable') {
      return `<div class="li-notice-bar bad">
        <b>Lichess no longer has this tournament.</b>
        <span>${esc(t.unavailableReason || 'It may have been deleted, or made private.')} Everything below is the last thing we saw.</span>
      </div>`;
    }
    if (isOver(t)) return '';

    const need = requiredTeams();
    if (!need.length) {
      return `<div class="li-notice-bar">
        <b>Open to anyone on Lichess.</b>
        <span>This tournament was found through ${esc(t.teamName || 'a team')}, but lichess does not restrict entry to that team’s members — so you do not have to join it.</span>
      </div>`;
    }
    const member = amMember();
    return `<div class="li-notice-bar ${member ? 'ok' : ''}">
      <b>This tournament requires membership in ${esc(teamLabel())}.</b>
      <span>${member === null
        ? 'Press Join and lichess will tell us whether you are already a member.'
        : member
          ? 'You are already a member, so you can enter straight away.'
          : 'Joining the team happens on lichess.org. Press Join and this page will take you there, then bring you back.'}</span>
    </div>`;
  }

  /* ── standings ─────────────────────────────────────────────────── */

  function standingsHTML() {
    if (!parts.length) {
      return `<section class="tile tn-standings">
        <div class="empty-state">${isOver(t)
          ? 'No standings were recorded for this tournament.'
          : 'Nobody has entered yet.'}</div>
      </section>`;
    }
    const myName = (meName() || '').toLowerCase();
    /* Lichess does not say "this player is in a game" on a standings row, but
       it does say who is in each ongoing pairing — so the row can. */
    const playingNow = new Map();
    ongoing().forEach((g) => {
      playingNow.set((g.white.username || '').toLowerCase(), g.gameId);
      playingNow.set((g.black.username || '').toLowerCase(), g.gameId);
    });
    return `
      <section class="tile tn-standings">
        <div class="tn-standings-head">
          <h3>${isOver(t) ? 'Final standings' : 'Standings'}</h3>
          <span class="muted">${parts.length} ${parts.length === 1 ? 'player' : 'players'}</span>
        </div>
        <div class="tn-row tn-row-head li-row">
          <span class="tn-c-rank">#</span>
          <span class="tn-c-player">Player</span>
          <span class="li-c-wdl" title="Worked out by JagChess from the games it has">W/D/L*</span>
          <span class="li-c-perf" title="Lichess performance rating">Perf</span>
          <span class="tn-c-score">Score</span>
        </div>
        <div class="tn-rows">${parts.map((p, i) => {
          const isMe = p.userId === myName;
          const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          const c = p.calc || {};
          const played = (c.wins || 0) + (c.draws || 0) + (c.losses || 0);
          const inGame = playingNow.get(p.userId);
          return `<div class="tn-row li-row ${isMe ? 'me' : ''} ${inGame ? 'playing' : ''}" data-player="${esc(p.username)}">
            <span class="tn-c-rank ${medal}">${p.rank || i + 1}</span>
            <span class="tn-c-player">
              ${avatarFor(p.username, 30)}
              <span class="tn-player-id">
                <span class="tn-player-name">${titleTag(p.title)}${esc(p.username)}${isMe ? '<span class="lb-me-badge">You</span>' : ''}${jagChip(p.username)}</span>
                <span class="tn-player-sub">${p.rating ? esc(String(p.rating)) : 'unrated'}${p.team ? ' · ' + esc(p.team) : ''}${inGame ? ' · <span class="li-inplay">playing now</span>' : ''}</span>
              </span>
            </span>
            <span class="li-c-wdl">${played ? `${c.wins || 0}/${c.draws || 0}/${c.losses || 0}` : '—'}</span>
            <span class="li-c-perf">${p.performance || '—'}</span>
            <span class="tn-c-score">${p.score || 0}</span>
          </div>`;
        }).join('')}</div>
        <p class="li-footnote">
          Rank, score, rating and performance are <b>Lichess's own figures</b>.
          The W/D/L column marked <b>*</b> is counted by JagChess from the games it has stored,
          and is only complete once the tournament has been archived.
        </p>
      </section>`;
  }

  /* ── games ─────────────────────────────────────────────────────── */

  const finished = () => games.filter((g) => g.state === store.GAME_STATE.FINISHED);
  const ongoing = () => games.filter((g) => g.state !== store.GAME_STATE.FINISHED);

  /* Match history: every game, each one a button that opens it on a
     JagChess board — live if it is still going, as a replay if it is not. */
  function gamesHTML() {
    if (!games.length) {
      return `<section class="tile"><div class="empty-state">${isOver(t)
        ? 'The games for this tournament have not been archived yet.'
        : 'No games yet. They appear here as soon as the first pairings are made.'}</div></section>`;
    }
    const byTime = (a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
    const done = finished().sort(byTime);
    const total = done.length;
    const side = (g, color) => {
      const p = g[color] || {};
      const res = g.state !== store.GAME_STATE.FINISHED ? 'live'
        : !g.winner ? 'draw' : g.winner === color ? 'won' : 'lost';
      const diff = p.ratingDiff != null && p.ratingDiff !== 0
        ? `<em class="${p.ratingDiff > 0 ? 'up' : 'down'}">${p.ratingDiff > 0 ? '+' : ''}${p.ratingDiff}</em>` : '';
      return `<span class="mh-side ${res} ${color}">
        <i class="mh-piece ${color}"></i>
        <span class="mh-name">${titleTag(p.title)}${esc(p.username || '?')}${p.berserk ? '<span class="mh-berserk" title="Berserked">⚡</span>' : ''}</span>
        <small>${p.rating || ''}${diff}</small>
      </span>`;
    };
    const plies = (g) => (g.moves ? g.moves.trim().split(/\s+/).length : 0);
    const resultOf = (g) => g.state !== store.GAME_STATE.FINISHED
      ? '<span class="mh-res live"><span class="tn-live-dot"></span>live</span>'
      : `<span class="mh-res">${g.winner === 'white' ? '1–0' : g.winner === 'black' ? '0–1' : '½–½'}</span>`;
    const row = (g, n) => `
      <button class="mh-row ${g.state === store.GAME_STATE.FINISHED ? '' : 'live'}" data-game="${esc(g.gameId)}"
        data-names="${esc(((g.white.username || '') + ' ' + (g.black.username || '')).toLowerCase())}">
        <span class="mh-no">${n ? '#' + n : ''}</span>
        ${side(g, 'white')}
        ${resultOf(g)}
        ${side(g, 'black')}
        <span class="mh-meta">${plies(g) ? Math.ceil(plies(g) / 2) + ' moves' : ''}${g.status && g.status !== 'started' ? ' · ' + esc(g.status) : ''}</span>
        <span class="mh-watch">${g.state === store.GAME_STATE.FINISHED ? '▶ Replay' : '● Watch'}</span>
      </button>`;
    return `
      <section class="tile mh">
        <div class="mh-head">
          <div><h3>Match history</h3><small>Every game opens on a JagChess board${ongoing().length ? ' — live ones follow along move by move' : ''}.</small></div>
          <input class="mh-filter" id="mh-filter" placeholder="Filter by player" value="${esc(gameFilter)}" autocomplete="off" />
        </div>
        ${ongoing().length ? `<div class="mh-group">In progress · ${ongoing().length}</div>
          <div class="mh-list">${ongoing().slice(0, 40).map((g) => row(g, 0)).join('')}</div>` : ''}
        ${done.length ? `<div class="mh-group">Finished · ${done.length}</div>
          <div class="mh-list">${done.slice(0, 200).map((g, k) => row(g, total - k)).join('')}</div>` : ''}
        <div class="mh-none" hidden>No games for that player.</div>
      </section>`;
  }

  function applyGameFilter() {
    const f = gameFilter.trim().toLowerCase();
    let shown = 0;
    host.querySelectorAll('.mh-row').forEach((r) => {
      const ok = !f || r.dataset.names.includes(f);
      r.hidden = !ok;
      if (ok) shown++;
    });
    const none = host.querySelector('.mh-none');
    if (none) none.hidden = shown > 0;
  }

  function liveGamesHTML() {
    const liveOnes = ongoing();
    if (!liveOnes.length) return '';
    return `<section class="tile tn-live">
      <h4>Games in progress</h4>
      <div class="tn-live-list">${liveOnes.slice(0, 8).map((g) => `
        <button class="tn-live-row" data-game="${esc(g.gameId)}">
          <span>${esc(g.white.username)}</span>
          <span class="tn-vs">vs</span>
          <span>${esc(g.black.username)}</span>
        </button>`).join('')}</div>
      <p class="field-hint" style="margin:8px 0 0">Lichess delays ongoing games by three moves for every third-party viewer.</p>
    </section>`;
  }

  /* ── about ─────────────────────────────────────────────────────── */

  function aboutHTML() {
    const c = t.conditions || {};
    const rows = [
      ['Lichess id', t.lichessId],
      ['Kind', t.kind === 'swiss' ? 'Swiss' : 'Arena'],
      ['Time control', `${clockLabel(t.clock)} ${speedOf(t.clock)}`],
      ['Variant', t.variant || 'standard'],
      ['Rated', t.rated ? 'Yes — games move lichess ratings' : 'No'],
      ['Starts', `${fmtDate(t.startsAt)} · ${fmtTime(t.startsAt)}`],
      t.durationMin ? ['Lasts', t.durationMin + ' minutes'] : null,
      t.kind === 'swiss' ? ['Rounds', `${t.round || 0} of ${t.nbRounds || '?'}`] : null,
      t.berserkable ? ['Berserk', 'Allowed'] : null,
      ['Team membership', t.membershipRequired
        ? 'Required — ' + teamLabel()
        : 'Not required'],
      c.minRating ? ['Minimum rating', String(c.minRating)] : null,
      c.maxRating ? ['Maximum rating', String(c.maxRating)] : null,
      c.minRatedGames ? ['Rated games needed', String(c.minRatedGames)] : null,
      c.minAccountAgeInDays ? ['Account age', c.minAccountAgeInDays + ' days'] : null,
      c.onlyTitled ? ['Titled players only', 'Yes'] : null,
      c.allowList && c.allowList.length ? ['Invited players only', String(c.allowList.length) + ' names'] : null,
      t.private ? ['Private', 'A password is needed to enter'] : null,
      ['Detected', t.detectedAt ? `${fmtDate(t.detectedAt)} · ${fmtTime(t.detectedAt)}` : '—'],
      ['Last synchronized', t.lastSyncedAt ? `${fmtDate(t.lastSyncedAt)} · ${fmtTime(t.lastSyncedAt)}` : 'never'],
      ['Saved on JagChess', t.archived ? 'Yes — this page no longer depends on lichess' : 'Not yet'],
      ['Shown to students', t.staffHidden ? 'No — archived by staff, and left out of ranked' : 'Yes']
    ].filter(Boolean);

    return `<section class="tile">
      <div class="tn-standings-head"><h3>About this tournament</h3></div>
      <div class="li-about">${rows.map(([k, v]) =>
        `<div class="li-about-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}</div>
      ${t.config ? '<p class="li-footnote">Created from JagChess with the Lichess tournament form.</p>' : ''}
    </section>`;
  }

  /* ── side panels ───────────────────────────────────────────────── */

  function mySidePanel(phase) {
    const s = session();
    if (!s) {
      return `<section class="tile li-me">
        <h4>Your Lichess account</h4>
        <p class="modal-meta" style="margin:0 0 10px">Connect it to join and play from here. Watching needs nothing.</p>
        <button class="btn primary block" id="li-login-2">Log in with Lichess</button>
      </section>`;
    }
    const mine = meRow();
    const g = myLiveGame();
    return `<section class="tile li-me connected">
      <h4>Your Lichess account</h4>
      <div class="li-me-row"><span class="li-dot"></span><b>${esc(s.username)}</b></div>
      ${mine ? `<div class="li-me-stat"><span>Rank</span><b>${mine.rank ? '#' + mine.rank : '—'}</b></div>
        <div class="li-me-stat"><span>Score</span><b>${mine.score || 0}</b></div>` : ''}
      ${g ? '<button class="btn primary block" id="li-play-2">Go to your game</button>' : ''}
      <button class="btn subtle block sm" id="li-disconnect">Disconnect</button>
    </section>`;
  }

  function sourceHTML() {
    const fresh = t.lastSyncedAt ? Date.now() - t.lastSyncedAt : null;
    const stale = fresh != null && fresh > 60000 && !t.archived;
    return `<section class="tile li-source">
      <h4>Where this comes from</h4>
      <p class="field-hint" style="margin:0 0 8px">
        Everything on this page is Lichess data, synchronized by JagChess through the
        official API. Nothing is scraped.
      </p>
      <div class="tn-rule"><span>Last synchronized</span><b id="li-ago">${t.lastSyncedAt
        ? countdown(Date.now() - t.lastSyncedAt) + ' ago' : 'never'}</b></div>
      ${t.archived ? '<div class="tn-rule"><span>Saved on JagChess</span><b>Yes</b></div>' : ''}
      ${stale ? '<p class="field-hint bad" style="margin:8px 0 0">This is behind. Lichess may be unreachable or rate-limiting.</p>' : ''}
      <button class="btn subtle block sm" id="li-refresh">Refresh now</button>
    </section>`;
  }

  /* A lichess name that belongs to somebody here gets their JagChess face,
     and the card that goes with it. */
  function jagChip(name) {
    const j = jagOf(name);
    return j ? `<span class="li-jag-chip" data-profile="${esc(j.uid)}" title="${esc(j.person.username || '')} on JagChess">${esc(j.person.username || 'JagChess')}</span>` : '';
  }

  function lichessPodium(podium) {
    return `<section class="tz-podium-stage">${podiumHTML(podium.slice(0, 3).map((p) => {
      const j = jagOf(p.username);
      return {
        uid: j ? j.uid : null,
        person: j ? { ...j.person, username: j.person.username || p.username } : { username: p.username, avatarColor: '#8a8f99' },
        value: `${TROPHY_SVG}${p.score || 0} pts`,
        sub: [j && j.person.username !== p.username ? '@' + esc(p.username) : '', p.performance ? 'perf ' + p.performance : '', p.games ? `${p.wins || 0}/${p.games} won` : '']
          .filter(Boolean).join(' · ')
      };
    }), { cls: 'big' })}</section>`;
  }

  /* ── wiring ────────────────────────────────────────────────────── */

  function wire() {
    const q = (sel) => host.querySelector(sel);
    q('#li-back').onclick = () => { location.hash = backHash(); };

    host.querySelectorAll('.li-tabs [data-tab]').forEach((b) => {
      b.onclick = () => { tab = b.dataset.tab; render(); };
    });
    host.querySelectorAll('[data-game]').forEach((b) => {
      b.onclick = () => enterGame(b.dataset.game);
    });
    if (q('#mh-filter')) {
      q('#mh-filter').oninput = (e) => { gameFilter = e.target.value; applyGameFilter(); };
      applyGameFilter();
    }
    if (q('#li-archive')) q('#li-archive').onclick = async () => {
      const hide = !t.staffHidden;
      try {
        await setArchived('lichess', t.id || t.lichessId, hide);
        toast(hide ? 'Archived — hidden from students and ranked' : 'Restored', 'ok');
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'Only club staff can archive tournaments.' : 'Could not change that', 'error');
      }
    };
    host.querySelectorAll('[data-player]').forEach((b) => {
      b.onclick = () => openPlayerCard(t, b.dataset.player, parts, games, jagOf(b.dataset.player));
    });

    if (q('#li-login-2')) q('#li-login-2').onclick = () => connect(PLAYER_SCOPES);

    if (q('#li-disconnect')) q('#li-disconnect').onclick = async () => {
      await disconnect();
      myTeams = null;
      joinState = 'idle';
      toast('Lichess account disconnected');
      render(true);
    };

    if (q('#li-join')) q('#li-join').onclick = () => joinAndPlay();
    if (q('#li-withdraw')) q('#li-withdraw').onclick = () => withdrawFlow();
    if (q('#li-stop-wait')) q('#li-stop-wait').onclick = () => {
      if (waitAbort) waitAbort.abort();
      joinState = amIn() ? 'in' : 'idle';
      render(true);
    };

    const play = () => {
      const g = myLiveGame();
      if (g) { enterGame(g); return; }
      pairMeNow();
    };
    if (q('#li-play')) q('#li-play').onclick = play;
    if (q('#li-play-2')) q('#li-play-2').onclick = play;

    if (q('#li-refresh')) q('#li-refresh').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Refreshing…';
      await focus.now();
      if (!dead) render(true);
    };
  }

  /* ── joining, the whole thing, in one press ────────────────────── */

  const INTENT = 'jag-lichess-join';

  /**
   * Join, and keep going until the person is actually playing.
   *
   * Log in if needed, join, ask lichess to pair immediately, wait for the
   * pairing, open the board. The only stop is the one lichess insists on:
   * a team you genuinely have to join first.
   */
  async function joinAndPlay() {
    if (joinState === 'joining' || joinState === 'waiting') return;

    /* Not logged in: remember the intent so that coming back from lichess
       carries straight on rather than dumping them on the same button. */
    if (!session()) {
      try { sessionStorage.setItem(INTENT, id); } catch (_) {}
      connect(requiredTeams().length ? PLAYER_SCOPES : [SCOPES.tournament, SCOPES.board]);
      return;
    }
    /* Everything this tournament could need, in one trip: joining without
       being able to play was what made this feel like a form to fill in.
       A tournament with no team requirement does not ask for the team
       permission at all. */
    const want = requiredTeams().length
      ? PLAYER_SCOPES
      : [SCOPES.tournament, SCOPES.board];
    if (!hasScopes(want)) {
      try { sessionStorage.setItem(INTENT, id); } catch (_) {}
      await ensureScopes(want);
      return;
    }

    joinState = 'joining';
    render(true);

    try {
      if (!amIn()) await doJoin();
    } catch (e) {
      joinState = 'idle';
      await handleJoinError(e);
      render(true);
      return;
    }

    focus.now();
    await startWaiting();
  }

  async function doJoin() {
    const form = {};
    if (t.private) {
      const pass = prompt('This tournament needs a password.');
      if (pass == null) throw Object.assign(new Error('cancelled'), { cancelled: true });
      form.password = pass;
    }
    if (t.teamBattleTeams && t.teamBattleTeams.length) {
      const teams = myTeams || await refreshTeams();
      const mineHere = (teams || []).find((x) => t.teamBattleTeams.includes(x));
      if (mineHere) form.team = mineHere;
    }
    /* The flag that makes this work at all: it tells lichess to pair a
       player who is not sitting on its own tournament page. It lapses after
       a minute, which is why startWaiting keeps renewing it. */
    if (phaseOf(t) === 'running') form.pairMeAsap = true;

    if (t.kind === 'swiss') await api.joinSwiss(t.lichessId, session().token, form);
    else await api.joinArena(t.lichessId, session().token, form);
    lastNudge = Date.now();
  }

  /** Re-ask lichess to pair us, but not more than once every 40 seconds. */
  async function pairMeNow(force) {
    if (t.kind === 'swiss') return;          // a swiss pairs whole rounds
    if (!force && Date.now() - lastNudge < 40000) return;
    lastNudge = Date.now();
    try {
      await api.joinArena(t.lichessId, session().token, { pairMeAsap: true });
    } catch (e) { console.warn('Could not ask lichess for a pairing', e); }
  }

  /**
   * Sit on the event stream until lichess pairs us, then open the board.
   *
   * This is the half that makes "press Join and you are playing" true: the
   * person does nothing else, and the board arrives.
   */
  async function startWaiting() {
    if (dead) return;
    const already = myLiveGame();
    if (already) { joinState = 'in'; enterGame(already); return; }

    if (phaseOf(t) !== 'running') {
      joinState = 'in';
      toast('You are in — your first game opens here by itself', 'ok');
      render(true);
      return;
    }

    joinState = 'waiting';
    render(true);

    waitAbort = new AbortController();
    const game = await live.waitForGame(id, {
      signal: waitAbort.signal,
      timeoutMs: 150000,
      onPoll: () => pairMeNow()
    });
    if (dead) return;
    waitAbort = null;

    if (game) {
      joinState = 'in';
      enterGame(game.gameId);
      return;
    }
    joinState = amIn() ? 'in' : 'idle';
    toast('Lichess has you entered but has not paired you yet. It will — stay on this page.');
    render(true);
  }

  /**
   * Work out what lichess actually objected to.
   *
   * The only refusal with a real next step is "you are not in the team", and
   * we only find that out by asking, which is exactly when asking is cheap.
   */
  async function handleJoinError(e) {
    if (e && e.cancelled) return;
    if (e && e.status === 401) {
      toast('Your lichess login has expired. Log in again.', 'error');
      return;
    }
    const need = requiredTeams();
    if (need.length && e && (e.status === 400 || e.status === 403)) {
      const teams = await refreshTeams({ force: true });
      const inTeam = teams && need.some((x) => teams.includes(x));
      if (!inTeam) { openTeamPage(need[0], e); return; }
    }
    toast(joinErrorText(e), 'error');
  }

  const joinErrorText = (e) => {
    if (!e) return 'Could not join.';
    if (e.status === 401) return 'Your lichess login has expired. Log in again.';
    if (e.status === 0) return 'Could not reach lichess.';
    if (e.status === 400 || e.status === 403) {
      return 'Lichess would not let you in: ' + (e.message || 'you may not meet the entry conditions.');
    }
    return e.message || 'Could not join.';
  };

  /**
   * Joining the team.
   *
   * The official endpoint is tried first. It lives outside /api/ and is not
   * promised a CORS header, so a browser may refuse it before lichess ever
   * sees it — and a team with manual admission or a password cannot be
   * joined this way at all. Every one of those cases ends the same, correct
   * way: the user is sent to the team's own page on lichess, and this page
   * re-checks and carries on when they come back.
   */
  async function openTeamPage(teamId, why) {
    const url = api.teamUrl(teamId);

    /* One silent attempt through the API, because when it works the person
       never has to leave the page at all. */
    if (hasScopes([SCOPES.team])) {
      try {
        await api.joinTeam(teamId, session().token, {});
        const teams = await refreshTeams({ force: true });
        if (teams && teams.includes(teamId)) {
          toast('Joined the team on lichess', 'ok');
          joinAndPlay();
          return;
        }
        /* A 200 from a team that reviews admissions means the REQUEST was
           sent, not that you are in. Saying "joined" here and then bouncing
           them back to the same button is the loop this avoids. */
        toast('Your request to join ' + (t.teamName || teamId) + ' was sent. A team leader has to approve it.');
        return;
      } catch (_) { /* fall through to the team page */ }
    }

    const reason = why && why.status === 403
      ? 'This team reviews requests, or asks for a password, so joining has to be done on lichess.'
      : 'Lichess needs you to join this team before you can enter.';
    const m = el(`<div class="modal"><div class="modal-card" style="max-width:440px">
      <h3>Join ${esc(t.teamName || teamId)}</h3>
      <p class="modal-meta">${esc(reason)} Open the team page, join there, then come back — this page checks again and puts you straight in.</p>
      <div class="li-modal-foot">
        <button class="btn subtle" data-x>Cancel</button>
        <a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener" data-go>Open the team on lichess ↗</a>
      </div>
    </div></div>`);
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
    m.onclick = (ev) => { if (ev.target === m) close(); };
    m.querySelector('[data-go]').onclick = () => {
      close();
      myTeams = null;
      /* They are about to leave. When the tab comes back into focus, check
         again and carry on where they left off. */
      const back = async () => {
        window.removeEventListener('focus', back);
        if (dead) return;
        const teams = await refreshTeams({ force: true });
        if (teams && requiredTeams().some((x) => teams.includes(x))) joinAndPlay();
      };
      window.addEventListener('focus', back);
    };
  }

  async function withdrawFlow() {
    try {
      if (t.kind === 'swiss') await api.withdrawSwiss(t.lichessId, session().token);
      else await api.withdrawArena(t.lichessId, session().token);
      joinState = 'idle';
      toast('Withdrawn on lichess');
      await focus.now();
      render(true);
    } catch (e) {
      toast(joinErrorText(e), 'error');
    }
  }

  /* ── subscriptions ─────────────────────────────────────────────── */

  const stops = [
    store.watchTournament(id, (row) => {
      if (!row) {
        host.innerHTML = `<div class="empty-state">JagChess has not seen that tournament.
          <button class="btn subtle sm" id="li-gone">Back</button></div>`;
        const b = host.querySelector('#li-gone');
        if (b) b.onclick = () => { location.hash = backHash(); };
        dead = true;
        return;
      }
      const first = !t;
      t = row;
      render();
      if (first) onFirstLoad();
    }),
    store.watchParticipants(id, (rows) => { parts = rows; render(); }),
    store.watchGames(id, (rows) => {
      games = rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      render();
      /* The second net. The pairing list we sync from lichess names both
         players, so a pairing with your name on it is your game — no event
         stream needed, and no extra request. It usually arrives within a
         few seconds of the pairing being made. */
      if (joinState === 'waiting' || joinState === 'in') {
        const g = myLiveGame();
        if (g) { joinState = 'in'; enterGame(g, { auto: true }); }
      }
    }),
    onAuthChange(() => { myTeams = null; render(true); refreshTeams(); }),

    /* The event stream: the reason a pairing lands you on a board instead of
       leaving you to find it. */
    live.onLichessEvent((ev) => {
      if (dead) return;
      if (ev.type === 'gameStart' && ev.game) {
        if (ev.game.tournamentId && ev.game.tournamentId !== id) return;
        joinState = 'in';
        enterGame(ev.game.gameId, { auto: true });
      } else if (ev.type === 'gameFinish') {
        /* A finished game changes the standings, so ask straight away
           rather than waiting for the next beat. */
        focus.now();
      }
    })
  ];

  /** Once, when the tournament first loads. */
  async function onFirstLoad() {
    refreshTeams();
    if (!board) loadRanked(ctx).then((b) => { board = b; if (!dead) render(); }).catch(() => {});
    /* Ask lichess straight away rather than waiting out the first interval,
       so opening the page shows the current state and not the last one
       somebody else's tab happened to record. */
    focus.now();

    /* Already playing? Go there. This is what makes a reload mid-game put
       you back on your board instead of on a standings table. */
    if (session()) {
      const rows = await live.fetchLiveGames();
      if (dead) return;
      const mine = rows.find((g) => !g.tournamentId || g.tournamentId === id);
      if (mine && mine.tournamentId === id) { enterGame(mine.gameId, { auto: true }); return; }
    }

    /* Came back from the lichess login having pressed Join before it. */
    let intent = null;
    try { intent = sessionStorage.getItem(INTENT); } catch (_) {}
    if (intent === id && session()) {
      try { sessionStorage.removeItem(INTENT); } catch (_) {}
      joinAndPlay();
    }
  }

  const tickTimer = setInterval(tick, 1000);

  return () => {
    dead = true;
    stops.forEach((s) => { try { s(); } catch (_) {} });
    if (waitAbort) { try { waitAbort.abort(); } catch (_) {} }
    focus.stop();
    clearInterval(tickTimer);
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  ONE GAME                                                           */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * The board, opened with everything we already knew.
 *
 * The seed matters: the clock is running, so the names, ratings and pieces
 * are on screen before the first request is even sent, and the board never
 * shows an empty frame.
 */
export async function renderLichessGame(ctx, host, id, gameId, api2 = {}) {
  const [t, row] = await Promise.all([
    store.readTournament(id).catch(() => null),
    store.readGame(id, gameId).catch(() => null)
  ]);

  const streamed = live.liveGames().find((g) => g.gameId === gameId) || null;
  const me = session();
  const meLower = ((me && me.username) || '').toLowerCase();
  const mine = !!streamed || (!!meLower && !!row && (
    (row.white && (row.white.username || '').toLowerCase() === meLower) ||
    (row.black && (row.black.username || '').toLowerCase() === meLower)));

  /* A pairing made two seconds ago is not in our own store yet, but the
     event that brought us here named the opponent — so the board can still
     open with both names on it rather than two placeholders. */
  let white = row && row.white;
  let black = row && row.black;
  if (!white && !black && streamed && me) {
    const opp = streamed.opponent || {};
    const mineSide = { username: me.username, rating: streamed.rating || null };
    const theirSide = { username: opp.username || opp.id || 'Opponent', rating: opp.rating || null };
    const iAmWhite = streamed.color !== 'black';
    white = iAmWhite ? mineSide : theirSide;
    black = iAmWhite ? theirSide : mineSide;
  }

  /* Reaching a board by any route counts as having entered it. */
  entered.add(gameId);

  openLichessGame({
    gameId,
    tournament: t,
    backHash: hashFor(id),
    mine,
    seed: {
      white,
      black,
      fen: (row && row.fen) || (streamed && streamed.fen) || null,
      rated: t ? t.rated : true,
      variant: (t && t.variant) || 'standard',
      clock: t && t.clock,
      myColor: streamed ? (streamed.color === 'black' ? 'b' : 'w') : null
    }
  });

  return () => closeLichessGame();
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  ONE PLAYER                                                         */
/* ═══════════════════════════════════════════════════════════════════ */

/** A player's performance in the tournament you are looking at. */
export function openPlayerCard(t, username, parts, games, jag) {
  const key = String(username || '').toLowerCase();
  const p = parts.find((x) => x.userId === key);
  const theirs = games.filter((g) =>
    g.white.username.toLowerCase() === key || g.black.username.toLowerCase() === key);
  const c = (p && p.calc) || {};

  const m = el(`<div class="modal"><div class="modal-card li-player-card">
    <button class="icon-btn modal-close" data-x title="Close">✕</button>
    <div class="li-player-head">
      ${avatarFor(username, 48)}
      <div>
        <h3>${titleTag(p && p.title)}${esc(username)}</h3>
        <p class="modal-meta">${p && p.rating ? esc(String(p.rating)) + ' rating' : 'unrated'} · in ${esc(t.name)}</p>
      </div>
    </div>
    <div class="li-player-stats">
      <div><b>${p && p.rank ? '#' + p.rank : '—'}</b><span>Rank</span></div>
      <div><b>${(p && p.score) || 0}</b><span>Score</span></div>
      <div><b>${(p && p.performance) || '—'}</b><span>Performance</span></div>
      <div><b>${(c.wins || 0)}/${(c.draws || 0)}/${(c.losses || 0)}</b><span>W/D/L*</span></div>
    </div>
    <p class="li-footnote">Rank, score and performance come from Lichess. The W/D/L marked <b>*</b>
      is counted by JagChess from the ${theirs.length} game${theirs.length === 1 ? '' : 's'} it has stored.</p>
    <div class="li-player-games">${theirs.length ? theirs.slice(0, 30).map((g) => {
      const white = g.white.username.toLowerCase() === key;
      const opp = white ? g.black.username : g.white.username;
      const res = g.state !== store.GAME_STATE.FINISHED ? 'playing'
        : !g.winner ? 'draw'
          : (g.winner === 'white') === white ? 'won' : 'lost';
      return `<div class="li-pg ${res}">
        <span class="li-pg-res">${res}</span>
        <span>${white ? 'White' : 'Black'} vs ${esc(opp)}</span>
        <a href="#${esc(gameHashFor(t.id || t.lichessId, g.gameId))}" data-x title="Watch on JagChess">▶</a>
      </div>`;
    }).join('') : '<div class="empty-state">No games stored for this player yet.</div>'}</div>
    <div class="li-modal-foot">
      ${jag ? `<button class="btn primary" data-profile="${esc(jag.uid)}" data-x>JagChess profile</button>` : ''}
      <a class="btn subtle" href="#${esc(playerHashFor(username))}" data-x>All their tournaments</a>
      <a class="btn subtle" href="${esc(api.userUrl(username))}" target="_blank" rel="noopener">Profile on lichess ↗</a>
    </div>
  </div></div>`);

  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  m.onclick = (e) => { if (e.target === m) close(); };
}

/**
 * One player across every lichess tournament this site holds.
 *
 * Everything on this page is either lichess's own number for one tournament,
 * or a total of those numbers. Nothing here is a rating, and the page says
 * so — a JagChess average is not a lichess rating and must never read as one.
 */
export async function renderLichessPlayer(ctx, host, username, api2 = {}) {
  const key = String(username || '').toLowerCase();
  host.innerHTML = '<div class="tn-view"><div class="empty-state">Looking up their tournaments…</div></div>';

  const rows = await store.listTournaments(ctx).catch(() => []);
  const played = [];
  for (const t of rows.slice(0, 60)) {
    const p = await store.readParticipant(t.id, key).catch(() => null);
    if (p) played.push({ t, p });
  }

  const totals = played.reduce((a, { p }) => {
    const c = p.calc || {};
    a.score += p.score || 0;
    a.wins += c.wins || 0; a.draws += c.draws || 0; a.losses += c.losses || 0;
    if (p.rank === 1) a.wonIt++;
    if (p.rank && p.rank <= 3) a.podiums++;
    return a;
  }, { score: 0, wins: 0, draws: 0, losses: 0, wonIt: 0, podiums: 0 });

  host.innerHTML = `
    <div class="tn-view li-view">
      <button class="tn-back" id="li-back">← All tournaments</button>
      <section class="tn-hero li-hero">
        <div class="tn-hero-main">
          <div class="tn-hero-status"><span class="tn-pill lichess">Lichess player</span></div>
          <h2>${esc(username)}</h2>
          <div class="tn-hero-host">${played.length} tournament${played.length === 1 ? '' : 's'} on JagChess</div>
          <a class="li-out" href="${esc(api.userUrl(username))}" target="_blank" rel="noopener">Profile on lichess.org ↗</a>
        </div>
        <div class="tn-hero-side">
          <div class="tn-clock"><b>${totals.wonIt}</b><small>${totals.wonIt === 1 ? 'win' : 'wins'}</small></div>
        </div>
      </section>

      <div class="li-player-stats wide">
        <div><b>${played.length}</b><span>Entered</span></div>
        <div><b>${totals.podiums}</b><span>Top three</span></div>
        <div><b>${totals.score}</b><span>Points scored</span></div>
        <div><b>${totals.wins}/${totals.draws}/${totals.losses}</b><span>W/D/L*</span></div>
      </div>
      <p class="li-footnote">
        Points and placings are <b>Lichess's own figures</b> for each tournament.
        The totals, and the W/D/L marked <b>*</b>, are added up by JagChess across the
        tournaments it has stored — they are not Lichess statistics and they are not a rating.
      </p>

      <section class="tile">
        <div class="tn-standings-head"><h3>Tournaments</h3></div>
        ${played.length ? `<div class="tn-rows">${played
          .sort((a, b) => (b.t.startsAt || 0) - (a.t.startsAt || 0))
          .map(({ t, p }) => `
          <div class="tn-row li-hist" data-open-lichess="${esc(t.id)}">
            <span class="tn-c-rank ${p.rank === 1 ? 'gold' : p.rank === 2 ? 'silver' : p.rank === 3 ? 'bronze' : ''}">${p.rank || '—'}</span>
            <span class="tn-c-player">
              <span class="tn-player-id">
                <span class="tn-player-name">${esc(t.name)}</span>
                <span class="tn-player-sub">${fmtDate(t.startsAt)} · ${esc(clockLabel(t.clock))} ${esc(speedOf(t.clock))}${t.teamName ? ' · ' + esc(t.teamName) : ''}</span>
              </span>
            </span>
            <span class="tn-c-score">${p.score || 0}</span>
          </div>`).join('')}</div>`
        : '<div class="empty-state">No stored tournaments for that player.</div>'}
      </section>
    </div>`;

  host.querySelector('#li-back').onclick = () => { location.hash = api2.listHash || 'tournaments'; };
  host.querySelectorAll('[data-open-lichess]').forEach((b) => {
    b.onclick = () => { location.hash = hashFor(b.dataset.openLichess); };
  });

  return () => {};
}
