/* ═══════════════════════════════════════════════════════════════════════
   club-duels.js — 1v1 chess.

   Three root collections, deliberately outside /clubs so a global duel
   between two people from different clubs has somewhere to live:

     duels/{gameId}                the game itself — moves, clocks, result
     duels/{gameId}/viewers/{uid}  spectator heartbeats, for the viewer count
     duelSeeks/{uid}               the matchmaking queue, one row per player
     duelChallenges/{id}           a direct "play me" sent to one person

   A duel is either club-scoped (rated against your club rating, paired only
   with club members) or global (your global rating, paired with anyone).
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, clubCol, memberRef, doc, collection, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, limit, runTransaction,
  esc, initials, toast, confirmDialog
} from './club-core.js';

import { readRating, displayRating, rateGame, newRating } from './glicko2.js';
import { serverNow, syncServerTime } from './server-time.js';
import { miniBoardHTML } from './mini-board.js';

const PIECE_THEME = (p) => `/assets/vendor/chessboard/img/chesspieces/wikipedia/${p}.png`;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/* ── paths ─────────────────────────────────────────────────────────── */

export const duelsCol = () => collection(db, 'duels');
export const duelRef  = (id) => doc(db, 'duels', id);
const seeksCol   = () => collection(db, 'duelSeeks');
const seekRef    = (uid) => doc(db, 'duelSeeks', uid);
const chalCol    = () => collection(db, 'duelChallenges');
const chalRef    = (id) => doc(db, 'duelChallenges', id);
const viewersCol = (gameId) => collection(db, 'duels', gameId, 'viewers');
const viewerRef  = (gameId, uid) => doc(db, 'duels', gameId, 'viewers', uid);
const userRef    = (uid) => doc(db, 'users', uid);

/* ── time controls ─────────────────────────────────────────────────── */

export const TIME_CONTROLS = [
  { id: '1+0',   min: 1,  inc: 0,  cat: 'Bullet' },
  { id: '2+1',   min: 2,  inc: 1,  cat: 'Bullet' },
  { id: '3+0',   min: 3,  inc: 0,  cat: 'Blitz' },
  { id: '3+2',   min: 3,  inc: 2,  cat: 'Blitz' },
  { id: '5+0',   min: 5,  inc: 0,  cat: 'Blitz' },
  { id: '5+3',   min: 5,  inc: 3,  cat: 'Blitz' },
  { id: '10+0',  min: 10, inc: 0,  cat: 'Rapid' },
  { id: '10+5',  min: 10, inc: 5,  cat: 'Rapid' },
  { id: '15+10', min: 15, inc: 10, cat: 'Rapid' },
  { id: '30+0',  min: 30, inc: 0,  cat: 'Classical' },
  { id: '30+20', min: 30, inc: 20, cat: 'Classical' }
];

const tcFromId = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id) || TIME_CONTROLS[4];
  return { initial: t.min * 60000, increment: t.inc * 1000 };
};

export const tcLabel = (tc) => {
  if (!tc) return '—';
  return `${Math.round(tc.initial / 60000)}+${Math.round(tc.increment / 1000)}`;
};

export const tcCategory = (tc) => {
  if (!tc) return 'Blitz';
  // lichess's own bucketing: estimated duration = initial + 40 moves of increment
  const est = tc.initial + 40 * tc.increment;
  if (est < 179000) return 'Bullet';
  if (est < 479000) return 'Blitz';
  if (est < 1499000) return 'Rapid';
  return 'Classical';
};

/* ── ratings and records ───────────────────────────────────────────── */

/* Club ratings live on the member row, global ratings on the user profile.
   Both use the identical `rating` map so one code path serves them. */
const ratingDocRef = (scope, clubId, uid) =>
  scope === 'club' ? memberRef(clubId, uid) : userRef(uid);

/* A win / draw / loss tally, kept beside the rating on the same document and
   scoped the same way — a club record on the member row, a global record on
   the user profile. Only rated games touch it. */
export function readRecord(source) {
  const v = (source && source.record) || {};
  const n = (x) => Math.max(0, Math.round(typeof x === 'number' && isFinite(x) ? x : 0));
  return { w: n(v.w), d: n(v.d), l: n(v.l) };
}

export const recordTotal = (rec) => rec.w + rec.d + rec.l;

/* Absolute, never an increment: the same reasoning as the ratings below. The
   new tally is worked out once from the snapshot the game was built with, so
   whoever writes it writes the identical numbers and writing twice is a no-op. */
const bumpRecord = (rec, outcome) => ({
  w: rec.w + (outcome === 'win' ? 1 : 0),
  d: rec.d + (outcome === 'draw' ? 1 : 0),
  l: rec.l + (outcome === 'loss' ? 1 : 0)
});

const outcomeFor = (side, result) =>
  result === '1/2-1/2' ? 'draw'
    : (result === '1-0') === (side === 'white') ? 'win' : 'loss';

export async function loadMyRatings(ctx) {
  let global = newRating();
  let profile = {};
  try {
    const s = await getDoc(userRef(ctx.user.uid));
    if (s.exists()) { profile = s.data(); global = readRating(profile); }
  } catch (e) { console.warn('Could not read the global rating', e); }
  const out = { club: readRating(ctx.member), global };
  // the documents themselves, so a game snapshot can freeze the record too
  out.sources = { club: ctx.member || {}, global: profile };
  return out;
}

/* The global side of a duel needs a name and color that aren't in the club
   member row, so the user profile carries a copy. Cheap, and it keeps the
   opponent list readable for people you share no club with. */
export async function syncPublicProfile(ctx) {
  const username = ctx.member.username || (ctx.user.email || '').split('@')[0] || 'Player';
  try {
    await setDoc(userRef(ctx.user.uid), {
      username,
      avatarColor: ctx.member.avatarColor || '#2e90fa',
      email: (ctx.user.email || '').toLowerCase()
    }, { merge: true });
  } catch (e) { console.warn('Could not sync the public profile', e); }
}

/* Ratings and records are computed once, when the game ends, and stored on
   the game doc so whoever writes them writes identical numbers. Applying
   twice is harmless because the values are absolute, never increments. */
export async function applySettlement(game) {
  if (!game.rated || !game.newRatings || game.ratingApplied) return;
  const sides = [['white', game.white], ['black', game.black]];
  await Promise.all(sides.map(([side, p]) => {
    const next = game.newRatings[side];
    if (!next || !p) return null;
    const patch = { rating: next };
    // newRecords is absent on games that finished before records existed
    const rec = game.newRecords && game.newRecords[side];
    if (rec) patch.record = rec;
    return setDoc(ratingDocRef(game.scope, game.clubId, p.uid), patch, { merge: true })
      .catch((e) => console.warn('Result write failed for ' + side, e));
  }));
  await updateDoc(duelRef(game.id), { ratingApplied: true }).catch(() => {});
}

/* ── the live index of active games ────────────────────────────────── */

/* One listener serves the watch panel, the leaderboard buttons and the
   "back to your game" chip, so nothing subscribes twice. */
let activeCache = [];
let activeSubs = new Set();
let activeStop = null;

export function watchActiveDuels(cb) {
  activeSubs.add(cb);
  cb(activeCache);
  if (!activeStop) {
    activeStop = onSnapshot(
      query(duelsCol(), where('status', '==', 'active'), limit(80)),
      (s) => {
        activeCache = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        activeSubs.forEach((f) => { try { f(activeCache); } catch (e) { console.error(e); } });
      },
      (e) => console.warn('Live games listener stopped', e)
    );
  }
  return () => {
    activeSubs.delete(cb);
    if (!activeSubs.size && activeStop) { activeStop(); activeStop = null; activeCache = []; }
  };
}

/* The watch panel shows either this club's own games or every global game,
   depending on which tab is selected. */
export function visibleDuels(games, ctx, scope) {
  return games.filter((g) => {
    // out in the world beyond a club there is no club tab to satisfy
    if (scope === 'club') return !!ctx.clubId && g.scope === 'club' && g.clubId === ctx.clubId;
    return g.scope === 'global';
  });
}

export const gameOf = (games, uid) => games.find((g) => (g.uids || []).includes(uid)) || null;

/* The hash of this club's duels page — its block id when one has been added,
   the standalone route when it hasn't. */
export const duelsHash = (ctx) =>
  (((ctx.club && ctx.club.blocks) || []).find((b) => b.type === 'duels') || {}).id || 'duels';

/* Outside a club there is no club scope at all. The hub's Play a match page
   and every global tournament run this module with clubId left null, and the
   club half of the interface folds away. */
export const isGlobalOnly = (ctx) => !ctx.clubId;

/* Where "back" goes when you leave a game. A tournament round belongs to its
   tournament, not to the duels page, so it returns you to the standings. */
export const exitHash = (ctx, game) =>
  game && game.tournamentId ? 'tournament/' + game.tournamentId : duelsHash(ctx);

/* ── small shared bits ─────────────────────────────────────────────── */

const fmtClock = (ms) => {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  if (t < 20000) return `${m}:${String(s).padStart(2, '0')}.${Math.floor((t % 1000) / 100)}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const avatarHTML = (p, size) =>
  `<span class="lb-avatar" style="background:${esc((p && p.avatarColor) || '#2e90fa')};width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px">${esc(initials((p && p.username) || '?'))}</span>`;

const eyeSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 12S6 5.4 12 5.4 21.6 12 21.6 12 18 18.6 12 18.6 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="2.9"/></svg>';

/* viewerCount is written by whoever has the game open, so it is never trusted
   as-is — it goes through Number before it reaches the markup. */
export const viewerBadge = (raw) => {
  const n = Math.max(0, Math.round(Number(raw) || 0));
  return n > 0 ? `<span class="duel-viewers" title="${n} watching">${eyeSVG}${n}</span>` : '';
};

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

/* The frozen copy of a player a game is settled against. `source` is whatever
   document the rating and record live on — a member row or a user profile. */
export const playerSnap = (uid, username, avatarColor, rating, source) => ({
  uid,
  username: username || 'Player',
  avatarColor: avatarColor || '#2e90fa',
  rating: { r: rating.r, rd: rating.rd, vol: rating.vol, games: rating.games },
  record: readRecord(source)
});

/* `extra` carries whatever the caller needs stapled to the game: a tournament
   id and match id, or a berserk map halving one side's clock. */
export function buildGame({ scope, clubId, rated, tc, white, black }, extra = {}) {
  const now = serverNow();
  const berserk = extra.berserk || null;
  const clockFor = (side) =>
    berserk && berserk[side] ? Math.round(tc.initial / 2) : tc.initial;
  return {
    scope,
    clubId: scope === 'club' ? clubId : null,
    rated: !!rated,
    tc,
    white, black,
    uids: [white.uid, black.uid],
    status: 'active',
    moves: [],
    fen: START_FEN,
    turn: 'w',
    // a berserked side starts on half the clock and gets no increment back
    clock: { w: clockFor('w'), b: clockFor('b') },
    berserk,
    tournamentId: extra.tournamentId || null,
    tournamentName: extra.tournamentName || null,
    matchId: extra.matchId || null,
    startedAt: now,
    lastMoveAt: now,
    endedAt: null,
    result: null,
    reason: null,
    winner: null,
    drawOfferFrom: null,
    takebackFrom: null,
    rematchFrom: null,
    rematchId: null,
    seen: {},
    viewerCount: 0,
    newRatings: null,
    newRecords: null,
    ratingApplied: false
  };
}

/* Berserk buys a shorter clock, and the increment goes with it. */
const incrementFor = (game, color) =>
  game.berserk && game.berserk[color] ? 0 : game.tc.increment;

/* Whoever ends the game computes both new ratings and both new records from
   the snapshot the game was created with, so the numbers never depend on who
   was watching when it finished. */
export function endPatch(game, result, reason) {
  const patch = {
    status: 'finished',
    result,
    reason,
    endedAt: serverNow(),
    winner: result === '1-0' ? game.white.uid : result === '0-1' ? game.black.uid : null,
    drawOfferFrom: null,
    takebackFrom: null
  };
  // an aborted game ('*') never happened as far as ratings are concerned
  if (game.rated && result !== '*') {
    patch.newRatings = rateGame(readRating(game.white), readRating(game.black), result);
    patch.newRecords = {
      white: bumpRecord(readRecord(game.white), outcomeFor('white', result)),
      black: bumpRecord(readRecord(game.black), outcomeFor('black', result))
    };
  }
  return patch;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  THE PLAY PAGE                                                      */
/* ═══════════════════════════════════════════════════════════════════ */

/* Set by the home page buttons so the page opens on the right scope. */
const INTENT_KEY = 'jag-duel-intent';
export const setDuelIntent = (intent) => {
  try { sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent)); } catch (_) {}
};
const takeIntent = () => {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
};

/* The six time controls on the quick-pairing grid: what people actually
   play. The full list stays available for challenges. */
const QUICK_TCS = ['1+0', '3+0', '3+2', '5+3', '10+0', '10+5', '15+10', '30+0'];

export async function renderDuels(ctx, host) {
  const intent = takeIntent();
  const globalOnly = isGlobalOnly(ctx);
  const startScope = globalOnly ? 'global' : ((intent && intent.scope) || 'club');
  const state = {
    scope: startScope,
    watchScope: startScope,
    tcId: '5+3',
    color: 'random',
    rated: true,
    filter: ''
  };

  syncServerTime(ctx.user.uid);

  host.innerHTML = `
    <div class="play">
      <section class="play-main">
        <div class="play-bar">
          <div class="seg play-scope" id="duel-scope"${globalOnly ? ' hidden' : ''}>
            <button class="seg-btn" data-v="club">${esc((ctx.club && ctx.club.name) || 'Club')}</button>
            <button class="seg-btn" data-v="global">Everyone</button>
          </div>
          <div class="play-rating" id="duel-my-rating"></div>
        </div>

        <div class="play-card">
          <div class="play-card-head">
            <h3>Quick game</h3>
            <p>Pick a time. We'll pair you with the closest rating that's looking for a game.</p>
          </div>
          <div class="tc-grid" id="tc-grid"></div>
          <div class="play-opts">
            <div class="play-opt">
              <span>Rated</span>
              <div class="seg" id="duel-rated">
                <button class="seg-btn" data-v="rated">Rated</button>
                <button class="seg-btn" data-v="casual">Just for fun</button>
              </div>
            </div>
            <div class="play-opt">
              <span>Your side</span>
              <div class="seg colors" id="duel-color">
                <button class="seg-btn" data-v="white" title="Play White"><i class="side-dot w"></i>White</button>
                <button class="seg-btn" data-v="random" title="Random"><i class="side-dot r"></i>Random</button>
                <button class="seg-btn" data-v="black" title="Play Black"><i class="side-dot b"></i>Black</button>
              </div>
            </div>
          </div>
        </div>

        <div class="play-card">
          <div class="play-card-head row">
            <div>
              <h3>Challenge someone</h3>
              <p>They get a notification wherever they are on JagChess.</p>
            </div>
            <select id="chal-tc" aria-label="Time for the challenge"></select>
          </div>
          <div class="opp-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input id="opp-filter" type="search" placeholder="Search by name" autocomplete="off" />
          </div>
          <div class="opp-list" id="opp-list"><div class="empty-state">Loading players…</div></div>
          <button class="btn subtle block play-link" id="duel-link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 13.6a3.7 3.7 0 0 0 5.6.4l2.6-2.6a3.7 3.7 0 1 0-5.2-5.2l-1.5 1.5"/><path d="M13.6 10.4a3.7 3.7 0 0 0-5.6-.4l-2.6 2.6a3.7 3.7 0 1 0 5.2 5.2l1.5-1.5"/></svg>
            Make a link for a friend who isn't here
          </button>
        </div>
      </section>

      <aside class="play-side">
        <section class="tile play-live">
          <div class="play-side-head">
            <h3>Live now</h3>
            <div class="seg tiny" id="duel-watch-scope"${globalOnly ? ' hidden' : ''}>
              <button class="seg-btn" data-v="club">Club</button>
              <button class="seg-btn" data-v="global">Everyone</button>
            </div>
          </div>
          <div class="duel-watch-list" id="duel-watch-list"></div>
          <div class="empty-state" id="duel-watch-empty" hidden>No games being played right now.</div>
        </section>
        <section class="tile play-recent">
          <div class="play-side-head"><h3>Your recent games</h3></div>
          <div id="recent-games"><div class="empty-state">Loading…</div></div>
        </section>
      </aside>
    </div>
    <div class="duel-pending" id="duel-pending" hidden></div>`;

  await syncPublicProfile(ctx);
  const ratings = await loadMyRatings(ctx);

  /* ── the time-control tiles ── */

  let waitingByTc = {};
  const tcGrid = host.querySelector('#tc-grid');
  function paintTiles() {
    tcGrid.innerHTML = QUICK_TCS.map((id) => {
      const t = TIME_CONTROLS.find((x) => x.id === id);
      const n = waitingByTc[id] || 0;
      return `<button class="tc-tile" data-tc="${id}">
        <b>${t.min}+${t.inc}</b>
        <span>${t.cat}</span>
        ${n ? `<small class="tc-waiting">${n} waiting</small>` : ''}
      </button>`;
    }).join('');
  }
  paintTiles();

  tcGrid.onclick = async (e) => {
    const b = e.target.closest('[data-tc]');
    if (!b) return;
    state.tcId = b.dataset.tc;
    b.classList.add('pressed');
    try { await startSearch(); }
    finally { b.classList.remove('pressed'); }
  };

  /* how many are waiting at each time, so a quiet club can see where to go */
  const stopSeeks = onSnapshot(query(seeksCol(), limit(200)), (s) => {
    const now = Date.now();
    waitingByTc = {};
    s.docs.map((d) => d.data()).filter((x) =>
      x.uid !== ctx.user.uid && !x.gameId && x.heartbeat && now - x.heartbeat < 25000 &&
      x.scope === state.scope && (state.scope !== 'club' || x.clubId === ctx.clubId) &&
      !!x.rated === !!state.rated && x.tc
    ).forEach((x) => {
      const id = `${Math.round(x.tc.initial / 60000)}+${Math.round(x.tc.increment / 1000)}`;
      waitingByTc[id] = (waitingByTc[id] || 0) + 1;
    });
    paintTiles();
  }, () => {});

  const meSnap = () => {
    const mine = state.scope === 'club' ? ratings.club : ratings.global;
    const source = state.scope === 'club' ? ratings.sources.club : ratings.sources.global;
    return playerSnap(
      ctx.user.uid,
      ctx.member.username || (ctx.user.email || '').split('@')[0],
      ctx.member.avatarColor,
      mine, source
    );
  };

  async function startSearch() {
    try {
      await openLobby(ctx, { ...state, tc: tcFromId(state.tcId), me: meSnap() });
    } catch (e) {
      console.error(e);
      toast(e.message || 'Could not start looking for a game.', 'error');
    }
  }

  /* ── the challenge list ── */

  const chalTc = host.querySelector('#chal-tc');
  let lastCat = '';
  chalTc.innerHTML = TIME_CONTROLS.map((t) => {
    const headTag = t.cat !== lastCat ? (lastCat ? '</optgroup>' : '') + `<optgroup label="${t.cat}">` : '';
    lastCat = t.cat;
    return headTag + `<option value="${t.id}">${t.min}+${t.inc} ${t.cat}</option>`;
  }).join('') + '</optgroup>';
  chalTc.value = state.tcId;

  const opponentCache = { club: null, global: null };

  async function loadOpponents(scope) {
    if (opponentCache[scope]) return opponentCache[scope];
    let rows = [];
    try {
      if (scope === 'club') {
        const s = await getDocs(clubCol(ctx.clubId, 'members'));
        rows = s.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((m) => !m.deleted);
      } else {
        const s = await getDocs(query(collection(db, 'users'), limit(150)));
        rows = s.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.username);
      }
    } catch (e) { console.warn('Could not load the player list', e); }
    rows = rows.filter((r) => r.uid !== ctx.user.uid)
      .sort((a, b) => readRating(b).r - readRating(a).r || (a.username || '').localeCompare(b.username || ''));
    opponentCache[scope] = rows;
    return rows;
  }

  async function paintOpponents() {
    const list = host.querySelector('#opp-list');
    const rows = await loadOpponents(state.scope);
    const term = state.filter.toLowerCase();
    const shown = rows.filter((r) => !term || (r.username || '').toLowerCase().includes(term)).slice(0, 40);
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state">${state.scope === 'club'
        ? 'Nobody else is in the club yet. Invite a friend, or switch to Everyone.'
        : 'No other players yet.'}</div>`;
      return;
    }
    list.innerHTML = shown.map((r) => {
      const rec = readRecord(r);
      const live = gameOf(games, r.uid);
      return `<div class="opp-row">
        ${avatarHTML(r, 36)}
        <span class="opp-id">
          <b>${esc(r.username || 'Player')}</b>
          <small>${recordTotal(rec) ? `${rec.w} won, ${rec.l} lost${rec.d ? `, ${rec.d} drawn` : ''}` : 'No rated games yet'}</small>
        </span>
        <span class="opp-rating tabular">${displayRating(r.rating)}</span>
        ${live
          ? `<button class="btn subtle sm" data-watch="${esc(live.id)}">Watch</button>`
          : `<button class="btn primary sm" data-chal="${esc(r.uid)}">Challenge</button>`}
      </div>`;
    }).join('') || '<div class="empty-state">No one by that name.</div>';
  }

  host.querySelector('#opp-list').onclick = async (e) => {
    const w = e.target.closest('[data-watch]');
    if (w) { location.hash = 'duel/' + w.dataset.watch; return; }
    const b = e.target.closest('[data-chal]');
    if (!b) return;
    const rows = await loadOpponents(state.scope);
    const target = rows.find((r) => r.uid === b.dataset.chal);
    if (!target) return;
    b.disabled = true;
    try {
      await sendChallenge(ctx, { ...state, tc: tcFromId(chalTc.value), me: meSnap(), target });
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not send that challenge.', 'error');
    } finally { b.disabled = false; }
  };

  host.querySelector('#opp-filter').oninput = (e) => { state.filter = e.target.value.trim(); paintOpponents(); };

  /* ── segmented controls ── */

  const seg = (id, key, onChange) => {
    const wrap = host.querySelector('#' + id);
    wrap.onclick = (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      state[key] = key === 'rated' ? b.dataset.v === 'rated' : b.dataset.v;
      paintSegs();
      if (onChange) onChange();
    };
  };

  function paintSegs() {
    const on = (id, val) => host.querySelectorAll('#' + id + ' [data-v]')
      .forEach((b) => b.classList.toggle('on', b.dataset.v === val));
    on('duel-scope', state.scope);
    on('duel-color', state.color);
    on('duel-rated', state.rated ? 'rated' : 'casual');
    on('duel-watch-scope', state.watchScope);
    const g = state.scope === 'club' ? ratings.club : ratings.global;
    const rec = readRecord(state.scope === 'club' ? ratings.sources.club : ratings.sources.global);
    host.querySelector('#duel-my-rating').innerHTML = `
      <span>Your ${state.scope === 'club' ? 'club' : 'global'} rating</span>
      <b class="tabular">${displayRating(g)}</b>
      ${recordTotal(rec) ? `<small>${rec.w}W ${rec.d}D ${rec.l}L</small>` : ''}`;
  }

  seg('duel-scope', 'scope', () => { state.watchScope = state.scope; paintOpponents(); paintWatch(); });
  seg('duel-color', 'color');
  seg('duel-rated', 'rated');
  seg('duel-watch-scope', 'watchScope', paintWatch);

  /* ── live games ── */

  let games = [];

  function paintWatch() {
    const list = host.querySelector('#duel-watch-list');
    const rows = visibleDuels(games, ctx, state.watchScope);
    host.querySelector('#duel-watch-empty').hidden = rows.length > 0;
    list.innerHTML = rows.map((g) => `
      <button class="watch-row" data-g="${esc(g.id)}">
        <span class="watch-board">${miniBoardHTML(g.fen)}</span>
        <span class="watch-body">
          <span class="watch-side"><i class="side-dot w"></i>${esc(g.white.username)} <small>${displayRating(g.white.rating)}</small></span>
          <span class="watch-side"><i class="side-dot b"></i>${esc(g.black.username)} <small>${displayRating(g.black.rating)}</small></span>
          <span class="watch-meta">${tcLabel(g.tc)} ${g.rated ? 'rated' : 'casual'}, move ${Math.ceil(((g.moves || []).length + 1) / 2)} ${viewerBadge(g.viewerCount || 0)}</span>
        </span>
      </button>`).join('');
    list.querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => { location.hash = 'duel/' + b.dataset.g; };
    });
  }

  const stopActive = watchActiveDuels((rows) => { games = rows; paintWatch(); paintOpponents(); });

  /* ── your recent games ── */

  async function paintRecent() {
    const box = host.querySelector('#recent-games');
    let rows = [];
    try {
      const s = await getDocs(query(duelsCol(), where('uids', 'array-contains', ctx.user.uid), limit(40)));
      rows = s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((g) => g.status === 'finished' && g.reason !== 'aborted')
        .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 6);
    } catch (e) { console.warn('Could not load recent games', e); }
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state">Games you finish show up here, so you can replay them.</div>';
      return;
    }
    box.innerHTML = rows.map((g) => {
      const meWhite = g.white.uid === ctx.user.uid;
      const opp = meWhite ? g.black : g.white;
      const out = !g.winner ? 'draw' : g.winner === ctx.user.uid ? 'win' : 'loss';
      let delta = '';
      if (g.rated && g.newRatings) {
        const side = meWhite ? 'white' : 'black';
        const d = Math.round(g.newRatings[side].r - readRating(g[side]).r);
        delta = `<small class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</small>`;
      }
      return `<button class="recent-row" data-g="${esc(g.id)}">
        <span class="recent-out ${out}">${out === 'win' ? 'Won' : out === 'loss' ? 'Lost' : 'Draw'}</span>
        <span class="recent-body"><b>vs ${esc(opp.username)}</b>
          <small>${tcLabel(g.tc)}, ${esc(reasonText(g.reason))}</small></span>
        ${delta}
      </button>`;
    }).join('');
    box.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => { location.hash = 'duel/' + b.dataset.g; }; });
  }
  paintRecent();

  /* ── challenges waiting for you ── */

  const stopPending = onSnapshot(
    query(chalCol(), where('toUid', '==', ctx.user.uid)),
    (s) => {
      const rows = s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.status === 'pending' && Date.now() - c.createdAt < 5 * 60000);
      const bar = host.querySelector('#duel-pending');
      bar.hidden = !rows.length;
      bar.innerHTML = rows.map((c) => `
        <div class="duel-pending-card" data-c="${esc(c.id)}">
          ${avatarHTML(c.from, 40)}
          <div class="duel-pending-body">
            <b>${esc(c.from.username)} (${displayRating(c.from.rating)}) challenged you</b>
            <small>${tcLabel(c.tc)} ${tcCategory(c.tc)}, ${c.rated ? 'rated' : 'just for fun'}</small>
          </div>
          <button class="btn subtle sm" data-decline>Decline</button>
          <button class="btn primary sm" data-accept>Play</button>
        </div>`).join('');
      bar.querySelectorAll('.duel-pending-card').forEach((card) => {
        const id = card.dataset.c;
        document.querySelectorAll(`.duel-invite[data-c="${id}"]`).forEach((n) => n.remove());
        card.querySelector('[data-accept]').onclick = () => acceptChallenge(ctx, id);
        card.querySelector('[data-decline]').onclick = () =>
          updateDoc(chalRef(id), { status: 'declined' }).catch(() => {});
      });
    },
    (e) => console.warn('Challenge listener stopped', e)
  );

  /* ── keep the rating chip honest ── */

  const stopMe = onSnapshot(
    globalOnly ? userRef(ctx.user.uid) : memberRef(ctx.clubId, ctx.user.uid),
    (s) => {
      if (!s.exists()) return;
      const d = s.data();
      if (globalOnly) { ratings.global = readRating(d); ratings.sources.global = d; }
      else { ratings.club = readRating(d); ratings.sources.club = d; }
      paintSegs();
    }, () => {});

  host.querySelector('#duel-link').onclick = async () => {
    const { openMatchLinkSheet } = await import('./match-links.js');
    openMatchLinkSheet(ctx, {
      ratings, scope: state.scope, tcId: chalTc.value, color: state.color, rated: state.rated
    });
  };

  paintSegs();
  paintWatch();
  await paintOpponents();

  return () => { stopActive(); stopPending(); stopMe(); stopSeeks(); };
}

const REASONS = {
  checkmate: 'checkmate', resignation: 'resigned', timeout: 'on time', agreement: 'agreed draw',
  stalemate: 'stalemate', 'insufficient material': 'not enough pieces to mate',
  'threefold repetition': 'repetition', draw: 'draw', aborted: 'aborted', abandoned: 'opponent left',
  'timeout vs insufficient material': 'time ran out, but no mating material'
};
const reasonText = (r) => REASONS[r] || r || '';

/* ═══════════════════════════════════════════════════════════════════ */
/*  MATCHMAKING                                                        */
/* ═══════════════════════════════════════════════════════════════════ */

/* The lobby and the "waiting for them to accept" screen both hold something
   on the server — a queue row, an open challenge. Leaving the page has to
   take that with it, or you sit in a queue you can no longer see. */
let waiting = null;

export function closeDuelWaiting() {
  const w = waiting;
  waiting = null;
  if (w) { try { w(); } catch (e) { console.error(e); } }
}

/* The window opens up the longer you wait, and after 25 seconds it stops
   caring about rating entirely and takes the closest person there is —
   which is what happens on a quiet evening in a school club. */
const ratingWindow = (elapsed) => {
  if (elapsed > 25000) return Infinity;
  return 100 + Math.floor(elapsed / 3000) * 90;
};

const colorsFit = (a, b) =>
  a === 'random' || b === 'random' || a !== b;

function assignColors(mine, theirs, meSnap, themSnap) {
  let meWhite;
  if (mine === 'white') meWhite = true;
  else if (mine === 'black') meWhite = false;
  else if (theirs === 'white') meWhite = false;
  else if (theirs === 'black') meWhite = true;
  else meWhite = Math.random() < 0.5;
  return meWhite ? { white: meSnap, black: themSnap } : { white: themSnap, black: meSnap };
}

async function openLobby(ctx, opts) {
  const { scope, rated, color, tc, me } = opts;
  const started = Date.now();

  const stage = el(`
    <div class="duel-lobby">
      <div class="duel-lobby-card">
        <div class="duel-lobby-orbit" aria-hidden="true">
          <span class="duel-lobby-ring"></span>
          <span class="duel-lobby-ring d2"></span>
          <span class="duel-lobby-ring d3"></span>
          <span class="duel-lobby-piece">♞</span>
        </div>
        <h3>Finding you an opponent</h3>
        <p class="duel-lobby-terms">
          ${tcLabel(tc)} ${tcCategory(tc)}, ${rated ? 'rated' : 'just for fun'}, ${scope === 'club' ? 'in ' + esc(ctx.club.name || 'the club') : 'with anyone'}
        </p>
        <div class="duel-lobby-stats">
          <div><b id="lobby-time">0:00</b><small>Searching</small></div>
          <div><b id="lobby-window">±100</b><small>Rating range</small></div>
          <div><b id="lobby-pool">0</b><small>In queue</small></div>
        </div>
        <div class="duel-lobby-bar"><span></span></div>
        <button class="btn subtle" id="lobby-cancel">Cancel</button>
      </div>
    </div>`);
  document.body.appendChild(stage);

  let done = false;
  let stopSeeks = null;
  let stopMine = null;
  let beat = null;
  let tick = null;

  const cleanup = async (removeSeek) => {
    if (done) return;
    done = true;
    if (waiting === leave) waiting = null;
    if (stopSeeks) stopSeeks();
    if (stopMine) stopMine();
    clearInterval(beat);
    clearInterval(tick);
    stage.remove();
    if (removeSeek) await deleteDoc(seekRef(ctx.user.uid)).catch(() => {});
  };

  // leaving the page drops you out of the queue rather than stranding you in it
  const leave = () => cleanup(true);
  closeDuelWaiting();
  waiting = leave;

  const enter = async (gameId) => {
    await cleanup(true);
    location.hash = 'duel/' + gameId;
  };

  const seek = {
    uid: ctx.user.uid,
    username: me.username,
    avatarColor: me.avatarColor,
    rating: me.rating,
    record: me.record,
    scope,
    clubId: scope === 'club' ? ctx.clubId : null,
    rated: !!rated,
    color,
    tc,
    createdAt: started,
    heartbeat: Date.now(),
    gameId: null
  };
  await setDoc(seekRef(ctx.user.uid), seek);

  stage.querySelector('#lobby-cancel').onclick = () => cleanup(true);

  beat = setInterval(() => {
    updateDoc(seekRef(ctx.user.uid), { heartbeat: Date.now() }).catch(() => {});
  }, 8000);

  tick = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    stage.querySelector('#lobby-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const w = ratingWindow(Date.now() - started);
    stage.querySelector('#lobby-window').textContent = w === Infinity ? 'Any' : '±' + w;
  }, 250);

  /* If the other side claimed us first, our own seek row tells us where to go. */
  stopMine = onSnapshot(seekRef(ctx.user.uid), (s) => {
    const d = s.data();
    if (d && d.gameId) enter(d.gameId);
  }, () => {});

  let claiming = false;

  stopSeeks = onSnapshot(query(seeksCol(), limit(200)), async (snap) => {
    if (done || claiming) return;
    const now = Date.now();
    const all = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    const fresh = all.filter((s) => s.heartbeat && now - s.heartbeat < 25000);

    const pool = fresh.filter((s) =>
      s.uid !== ctx.user.uid &&
      !s.gameId &&
      s.scope === scope &&
      (scope !== 'club' || s.clubId === ctx.clubId) &&
      !!s.rated === !!rated &&
      s.tc && s.tc.initial === tc.initial && s.tc.increment === tc.increment &&
      colorsFit(color, s.color)
    );

    stage.querySelector('#lobby-pool').textContent = String(pool.length + 1);

    // stale rows from closed tabs get swept up by whoever notices them
    all.filter((s) => s.heartbeat && now - s.heartbeat > 60000)
      .forEach((s) => deleteDoc(seekRef(s.uid)).catch(() => {}));

    if (!pool.length) return;

    const win = ratingWindow(now - started);
    const byDistance = pool
      .map((s) => ({ s, d: Math.abs(readRating(s).r - readRating(me).r) }))
      .sort((a, b) => a.d - b.d || a.s.createdAt - b.s.createdAt);

    const pick = byDistance.find((c) => c.d <= win);
    if (!pick) return;

    // one side initiates; the transaction settles it if both ever do
    if (ctx.user.uid > pick.s.uid) return;

    claiming = true;
    try {
      const gameId = await claimMatch(ctx, me, seek, pick.s);
      if (gameId) await enter(gameId);
    } catch (e) {
      if (e && e.message !== 'taken') console.warn('Pairing attempt failed', e);
    } finally {
      claiming = false;
    }
  }, (e) => {
    console.error(e);
    toast('Matchmaking is unavailable right now.', 'error');
    cleanup(true);
  });
}

async function claimMatch(ctx, me, mySeek, theirSeek) {
  return runTransaction(db, async (tx) => {
    const [a, b] = await Promise.all([
      tx.get(seekRef(ctx.user.uid)),
      tx.get(seekRef(theirSeek.uid))
    ]);
    if (!a.exists() || !b.exists()) throw new Error('taken');
    if (a.data().gameId || b.data().gameId) throw new Error('taken');

    const them = playerSnap(theirSeek.uid, theirSeek.username, theirSeek.avatarColor, readRating(theirSeek), theirSeek);
    const sides = assignColors(mySeek.color, theirSeek.color, me, them);
    const ref = doc(duelsCol());
    tx.set(ref, buildGame({
      scope: mySeek.scope,
      clubId: ctx.clubId,
      rated: mySeek.rated,
      tc: mySeek.tc,
      white: sides.white,
      black: sides.black
    }));
    tx.update(seekRef(ctx.user.uid), { gameId: ref.id, matchedAt: Date.now() });
    tx.update(seekRef(theirSeek.uid), { gameId: ref.id, matchedAt: Date.now() });
    return ref.id;
  });
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  DIRECT CHALLENGES                                                  */
/* ═══════════════════════════════════════════════════════════════════ */

export async function sendChallenge(ctx, opts) {
  const { scope, rated, color, tc, me, target } = opts;
  const ref = doc(chalCol());
  await setDoc(ref, {
    from: me,
    toUid: target.uid,
    toName: target.username || 'Player',
    scope,
    clubId: scope === 'club' ? ctx.clubId : null,
    rated: !!rated,
    color,
    tc,
    status: 'pending',
    createdAt: Date.now(),
    gameId: null
  });

  const wait = el(`
    <div class="duel-lobby">
      <div class="duel-lobby-card">
        <div class="duel-lobby-orbit" aria-hidden="true">
          <span class="duel-lobby-ring"></span>
          <span class="duel-lobby-ring d2"></span>
          <span class="duel-lobby-ring d3"></span>
          <span class="duel-lobby-piece">♞</span>
        </div>
        <h3>Waiting for ${esc(target.username || 'your opponent')}…</h3>
        <p class="duel-lobby-terms">
          ${tcLabel(tc)} ${tcCategory(tc)}, ${rated ? 'rated' : 'just for fun'}, ${scope === 'club' ? 'in ' + esc(ctx.club.name || 'the club') : 'with anyone'}
        </p>
        <p class="modal-meta" style="margin:0">They'll get a notification. If they miss it, it waits for them on their Play page.</p>
        <div class="duel-lobby-bar"><span></span></div>
        <button class="btn subtle" id="chal-cancel">Cancel challenge</button>
      </div>
    </div>`);
  document.body.appendChild(wait);

  let closed = false;
  const close = () => { closed = true; stop(); wait.remove(); if (waiting === withdraw) waiting = null; };

  // navigating away withdraws the challenge instead of leaving it hanging
  const withdraw = () => { close(); updateDoc(ref, { status: 'cancelled' }).catch(() => {}); };
  closeDuelWaiting();
  waiting = withdraw;

  const stop = onSnapshot(ref, (s) => {
    const d = s.data();
    if (!d || closed) return;
    if (d.status === 'accepted' && d.gameId) {
      close();
      location.hash = 'duel/' + d.gameId;
    } else if (d.status === 'declined') {
      close();
      toast(`${target.username || 'They'} declined the duel.`);
    }
  }, () => {});

  wait.querySelector('#chal-cancel').onclick = withdraw;
}

export async function acceptChallenge(ctx, challengeId) {
  try {
    const gameId = await runTransaction(db, async (tx) => {
      const s = await tx.get(chalRef(challengeId));
      if (!s.exists()) throw new Error('That challenge is gone.');
      const c = s.data();
      if (c.status !== 'pending') throw new Error('That challenge is no longer open.');

      const source = c.scope === 'club'
        ? (ctx.member || {})
        : ((await tx.get(userRef(ctx.user.uid))).data() || {});
      const me = playerSnap(
        ctx.user.uid,
        ctx.member.username || (ctx.user.email || '').split('@')[0],
        ctx.member.avatarColor,
        readRating(source), source
      );
      // the challenger picked their side, so ours is whatever is left
      const sides = assignColors(
        c.color === 'white' ? 'black' : c.color === 'black' ? 'white' : 'random',
        c.color, me, c.from
      );

      const ref = doc(duelsCol());
      tx.set(ref, buildGame({
        scope: c.scope,
        clubId: c.clubId || ctx.clubId,
        rated: c.rated,
        tc: c.tc,
        white: sides.white,
        black: sides.black
      }));
      tx.update(chalRef(challengeId), { status: 'accepted', gameId: ref.id });
      return ref.id;
    });
    location.hash = 'duel/' + gameId;
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could not accept that duel.', 'error');
  }
}

/* The pop-up the challenged player sees wherever they are in the club.
   Ignoring it is allowed — the duels page keeps it waiting for them. */
export function watchChallenges(ctx) {
  const shown = new Set();
  return onSnapshot(
    query(chalCol(), where('toUid', '==', ctx.user.uid)),
    (s) => {
      s.docs.forEach((d) => {
        const c = { id: d.id, ...d.data() };
        if (c.status !== 'pending') return;
        if (Date.now() - c.createdAt > 5 * 60000) return;
        if (shown.has(c.id)) return;
        shown.add(c.id);
        // the duels page already carries an un-dismissable bar for these,
        // so a pop-up on top of it would just be the same thing twice
        if (document.querySelector('.duel-pending:not([hidden])')) return;
        popChallenge(ctx, c, d.ref);
      });
    },
    (e) => console.warn('Challenge notifications unavailable', e)
  );
}

function popChallenge(ctx, c, ref) {
  const card = el(`
    <div class="duel-invite" data-c="${esc(c.id)}">
      <div class="duel-invite-head">
        ${avatarHTML(c.from, 44)}
        <div>
          <b>${esc(c.from.username)} wants to play</b>
          <small>Rated ${displayRating(c.from.rating)}, ${readRating(c.from).games} rated games</small>
        </div>
        <button class="duel-invite-x" title="Dismiss">✕</button>
      </div>
      <div class="duel-invite-terms">
        <span class="duel-pill">${tcLabel(c.tc)} ${tcCategory(c.tc)}</span>
        <span class="duel-pill ${c.rated ? 'rated' : ''}">${c.rated ? 'Rated' : 'Casual'}</span>
      </div>
      <div class="duel-invite-actions">
        <button class="btn subtle sm" data-no>Decline</button>
        <button class="btn primary sm" data-yes>Accept</button>
      </div>
    </div>`);

  let host = document.querySelector('.duel-invite-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'duel-invite-host';
    document.body.appendChild(host);
  }
  host.appendChild(card);

  const close = () => card.remove();
  card.querySelector('.duel-invite-x').onclick = close;
  card.querySelector('[data-no]').onclick = () => {
    close();
    updateDoc(ref, { status: 'declined' }).catch(() => {});
  };
  card.querySelector('[data-yes]').onclick = () => { close(); acceptChallenge(ctx, c.id); };

  // it stops nagging after a while, but the duels page still holds it
  const stop = onSnapshot(ref, (s) => {
    const d = s.data();
    if (!d || d.status !== 'pending') { close(); stop(); }
  }, () => {});
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  THE GAME — playing, watching and replaying are the same screen     */
/* ═══════════════════════════════════════════════════════════════════ */

/* How long past zero a clock has to be before the game is called on time.
   Covers the trip a move takes to the server, so a move made with a tenth
   of a second left counts. */
const FLAG_GRACE = 800;
/* Neither clock runs until both sides have moved once, the way lichess
   does it; until then a game nobody starts can simply be abandoned. */
const ABORT_AFTER = 30000;
const PRESENCE_EVERY = 15000;
const AWAY_AFTER = 40000;
const CLAIM_AFTER = 120000;
const ADD_TIME = 15000;

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/* ── sound ─────────────────────────────────────────────────────────── */

const SOUND_KEY = 'jag.sound';
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) { return true; } };
let audio = null;

/* Short synthesized clicks rather than audio files: nothing to download,
   and they stay quiet enough for a classroom. */
function play(kind) {
  if (!soundOn()) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const tone = (freq, at, dur, vol, type = 'triangle') => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + at);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(vol, t + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + dur + 0.02);
    };
    if (kind === 'move') tone(420, 0, 0.07, 0.18);
    if (kind === 'capture') { tone(300, 0, 0.06, 0.2); tone(220, 0.045, 0.08, 0.16); }
    if (kind === 'check') { tone(660, 0, 0.08, 0.14); tone(880, 0.07, 0.1, 0.12); }
    if (kind === 'notify') { tone(740, 0, 0.09, 0.12, 'sine'); tone(988, 0.1, 0.14, 0.12, 'sine'); }
    if (kind === 'low') tone(1200, 0, 0.04, 0.06, 'square');
    if (kind === 'end') { tone(523, 0, 0.14, 0.14, 'sine'); tone(659, 0.12, 0.14, 0.14, 'sine'); tone(784, 0.24, 0.24, 0.14, 'sine'); }
  } catch (_) { /* no audio, no problem */ }
}

/* ── the stage ─────────────────────────────────────────────────────── */

let stage = null;

export function closeDuelStage() {
  if (!stage) return;
  try { stage.destroy(); } catch (e) { console.error(e); }
  stage = null;
}

const ICO = {
  back: '<path d="M15 6l-6 6 6 6"/>',
  first: '<path d="M17 6l-6 6 6 6M7 6v12"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  last: '<path d="M7 6l6 6-6 6M17 6v12"/>',
  flip: '<path d="M7 4v14M4 15l3 3 3-3M17 20V6M14 9l3-3 3 3"/>',
  sound: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="m16 10 4 4M20 10l-4 4"/>',
  flag: '<path d="M5.5 21V4.5M5.5 4.5h11l-2.2 4 2.2 4h-11"/>',
  half: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  again: '<path d="M20 11.5a8 8 0 1 1-2.6-5.4"/><path d="M20 4.5V11h-6.5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.6"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  scope: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'
};
const ico = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[n]}</svg>`;

export function openDuelStage(ctx, gameId) {
  if (stage && stage.gameId === gameId) return;
  closeDuelStage();
  syncServerTime(ctx.user.uid);

  const root = el(`
    <div class="duel-stage" role="dialog" aria-label="Chess game">
      <div class="duel-stage-bar">
        <button class="duel-exit" id="duel-exit">${ico('back')}<span>Back</span></button>
        <div class="duel-stage-tags" id="duel-tags"></div>
        <div class="duel-stage-tools">
          <span id="duel-views"></span>
          <button class="duel-tool" id="duel-flip" title="Flip the board" aria-label="Flip the board">${ico('flip')}</button>
          <button class="duel-tool" id="duel-sound" title="Sound" aria-label="Sound"></button>
        </div>
      </div>
      <div class="duel-stage-body">
        <div class="duel-board-col">
          <div class="duel-player" id="duel-top"></div>
          <div class="duel-board-wrap">
            <div id="duel-board" class="chessboard"></div>
            <div class="duel-board-flash" id="duel-flash" hidden></div>
          </div>
          <div class="duel-player" id="duel-bottom"></div>
        </div>
        <aside class="duel-side">
          <div class="duel-status" id="duel-status"></div>
          <div class="duel-offer" id="duel-offer" hidden></div>
          <div class="duel-moves-wrap">
            <div class="duel-moves" id="duel-moves"></div>
            <div class="duel-nav">
              <button data-nav="first" title="First move" aria-label="First move">${ico('first')}</button>
              <button data-nav="prev" title="Previous move" aria-label="Previous move">${ico('prev')}</button>
              <button data-nav="next" title="Next move" aria-label="Next move">${ico('next')}</button>
              <button data-nav="last" title="Latest move" aria-label="Latest move">${ico('last')}</button>
            </div>
          </div>
          <div class="duel-actions" id="duel-actions"></div>
        </aside>
      </div>
    </div>`);
  document.body.appendChild(root);
  document.body.classList.add('duel-open');

  const S = {
    gameId,
    game: null,
    chess: null,        // the game as played
    board: null,
    myColor: null,      // 'w' | 'b' | null when watching
    orientation: 'white',
    view: null,         // null = live; otherwise a ply count to show
    stopGame: null,
    clockTimer: null,
    beat: null,
    claiming: null,     // the state a flag claim was made against
    pending: false,     // a move of ours is on its way
    destroyed: false,
    lastTick: 0,
    destroy
  };
  stage = S;

  const replay = (moves, upto) => {
    const c = new window.Chess();
    (moves || []).slice(0, upto == null ? undefined : upto).forEach((san) => c.move(san, { sloppy: true }));
    return c;
  };

  const $ = (sel) => root.querySelector(sel);
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  const sideKey = (c) => (c === 'w' ? 'white' : 'black');
  const live = () => S.game && S.game.status === 'active';
  const inTournament = () => !!(S.game && S.game.tournamentId);
  const plies = () => (S.game && S.game.moves ? S.game.moves.length : 0);

  $('#duel-exit').onclick = () => { location.hash = exitHash(ctx, S.game); };

  /* ── sound toggle ── */

  const paintSound = () => {
    $('#duel-sound').innerHTML = ico(soundOn() ? 'sound' : 'mute');
    $('#duel-sound').classList.toggle('off', !soundOn());
  };
  $('#duel-sound').onclick = () => {
    try { localStorage.setItem(SOUND_KEY, soundOn() ? 'off' : 'on'); } catch (_) {}
    paintSound();
    play('move');
  };
  paintSound();

  /* ── the board ── */

  const boardHost = $('#duel-board');
  const boardCol = $('.duel-board-col');

  /* chessboard.js sizes itself from its container's width, so the square
     that actually fits — width against the height the player cards leave —
     is measured here and handed to the CSS. */
  const sizeBoard = () => {
    const cards = [...root.querySelectorAll('.duel-player')].reduce((h, n) => h + n.offsetHeight, 0);
    const avail = boardCol.clientHeight - cards - 20;
    const size = Math.max(240, Math.floor(Math.min(boardCol.clientWidth, avail) / 8) * 8);
    boardCol.style.setProperty('--duel-board', size + 'px');
    if (S.board && S.board.resize) S.board.resize();
    paintMarks();
  };

  const buildBoard = (fen) => {
    if (S.board && S.board.destroy) S.board.destroy();
    S.board = window.Chessboard(boardHost, {
      draggable: !!S.myColor,
      position: fen,
      orientation: S.orientation,
      pieceTheme: PIECE_THEME,
      moveSpeed: 160,
      snapbackSpeed: 160,
      snapSpeed: 40,
      appearSpeed: 150,
      trashSpeed: 120,
      dropOffBoard: 'snapback',
      onDragStart: (src, piece) => {
        if (!canMove()) return false;
        if (piece[0] !== S.myColor) return false;
        selected = null;
        showHints(src);
      },
      onDrop: (from, to) => { clearHints(); return attemptMove(from, to); },
      onSnapEnd: () => S.board.position(currentFen(), false)
    });
    sizeBoard();
  };

  const canMove = () => !!S.myColor && live() && S.view == null && !S.pending &&
    S.chess && S.chess.turn() === S.myColor;

  const currentFen = () => (S.view == null ? S.chess.fen() : replay(S.game.moves, S.view).fen());

  /* ── squares: hints, last move, check ── */

  let selected = null;
  const squareEl = (sq) => boardHost.querySelector('.square-' + sq);
  const squareOf = (node) => {
    const cell = node && node.closest && node.closest('.square-55d63');
    if (!cell) return null;
    const c = [...cell.classList].find((x) => /^square-[a-h][1-8]$/.test(x));
    return c ? c.slice(7) : null;
  };

  const clearHints = () => {
    boardHost.querySelectorAll('.duel-from, .duel-to, .duel-take')
      .forEach((n) => n.classList.remove('duel-from', 'duel-to', 'duel-take'));
  };

  const showHints = (from) => {
    clearHints();
    if (!canMove()) return false;
    const moves = S.chess.moves({ square: from, verbose: true });
    if (!moves.length) return false;
    squareEl(from)?.classList.add('duel-from');
    moves.forEach((m) => squareEl(m.to)?.classList.add(m.captured ? 'duel-take' : 'duel-to'));
    return true;
  };

  /* The last move and a king in check, for whatever position is on show. */
  function paintMarks() {
    boardHost.querySelectorAll('.duel-last, .duel-check')
      .forEach((n) => n.classList.remove('duel-last', 'duel-check'));
    if (!S.chess || !S.game) return;
    const c = S.view == null ? S.chess : replay(S.game.moves, S.view);
    const hist = c.history({ verbose: true });
    const last = hist[hist.length - 1];
    if (last) { squareEl(last.from)?.classList.add('duel-last'); squareEl(last.to)?.classList.add('duel-last'); }
    if (c.in_check()) {
      const turn = c.turn();
      const board = c.board();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === 'k' && p.color === turn) squareEl('abcdefgh'[f] + (8 - r))?.classList.add('duel-check');
        }
      }
    }
  }

  /* tap a piece, then tap where it goes; dragging works too */
  boardHost.addEventListener('click', (e) => {
    if (!canMove()) return;
    const sq = squareOf(e.target);
    if (!sq) return;
    if (selected && sq !== selected) {
      const legal = S.chess.moves({ square: selected, verbose: true }).some((m) => m.to === sq);
      if (legal) {
        const from = selected;
        selected = null;
        clearHints();
        attemptMove(from, sq, true);
        return;
      }
    }
    const piece = S.chess.get(sq);
    if (piece && piece.color === S.myColor && sq !== selected) { selected = sq; showHints(sq); }
    else { selected = null; clearHints(); }
  });

  function attemptMove(from, to, byClick) {
    if (!canMove()) return 'snapback';
    const legal = S.chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
    if (!legal.length) return 'snapback';
    if (legal.some((m) => m.flags.includes('p'))) {
      askPromotion(S.myColor, (choice) => {
        if (choice) commitMove(from, to, choice, true);
        else S.board.position(S.chess.fen());
      });
      return 'snapback';
    }
    return commitMove(from, to, 'q', byClick) ? undefined : 'snapback';
  }

  /* ── making a move ───────────────────────────────────────────────────
     The board moves at once; the write is a transaction against the game
     as the server has it. If the other side's move, a takeback or a flag
     got there first, ours is refused and the board snaps back to the truth
     rather than the two sides quietly seeing different games.
     ─────────────────────────────────────────────────────────────────── */

  function commitMove(from, to, promotion, animate) {
    const ply = plies();
    const move = S.chess.move({ from, to, promotion });
    if (!move) return false;
    if (animate) S.board.position(S.chess.fen());
    S.pending = true;
    sfx(move, S.chess);
    paintMarks();
    paintMoves();

    const fen = S.chess.fen();
    const over = S.chess.game_over();
    const result = !over ? null
      : S.chess.in_checkmate() ? (move.color === 'w' ? '1-0' : '0-1') : '1/2-1/2';
    const reason = !over ? null
      : S.chess.in_checkmate() ? 'checkmate'
      : S.chess.in_stalemate() ? 'stalemate'
      : S.chess.insufficient_material() ? 'insufficient material'
      : S.chess.in_threefold_repetition() ? 'threefold repetition' : 'draw';

    runTransaction(db, async (tx) => {
      const snap = await tx.get(duelRef(gameId));
      const g = snap.data();
      if (!g || g.status !== 'active') throw new Error('over');
      if ((g.moves || []).length !== ply) throw new Error('stale');
      const now = serverNow();
      const clockOn = ply >= 2;
      const left = g.clock[S.myColor] - (clockOn ? now - g.lastMoveAt : 0);
      if (left <= -FLAG_GRACE) {
        // too late: the move doesn't count, the clock does
        tx.update(duelRef(gameId), timeoutPatch(g, S.myColor));
        throw new Error('flagged');
      }
      const patch = {
        moves: [...(g.moves || []), move.san],
        fen,
        turn: opp(S.myColor),
        clock: { ...g.clock, [S.myColor]: Math.max(0, left) + (clockOn ? incrementFor(g, S.myColor) : 0) },
        lastMoveAt: now,
        takebackFrom: null
      };
      // moving answers the other side's draw offer with no; ours stands
      if (g.drawOfferFrom && g.drawOfferFrom !== ctx.user.uid) patch.drawOfferFrom = null;
      if (over) Object.assign(patch, endPatch({ ...g, ...patch }, result, reason));
      tx.update(duelRef(gameId), patch);
    }).then(() => {
      S.pending = false;
    }).catch((e) => {
      S.pending = false;
      if (e.message === 'flagged') toast('Your time ran out before that move landed.', 'error');
      else if (e.message !== 'over' && e.message !== 'stale') {
        console.error(e);
        toast('That move didn\'t reach the server. Check your connection.', 'error');
      }
      resync();
    });
    return true;
  }

  /* back to the game exactly as the server last told us */
  function resync() {
    if (!S.game) return;
    S.chess = replay(S.game.moves);
    S.board.position(S.chess.fen());
    paintAll();
  }

  function sfx(move, chess) {
    if (chess.in_check()) play('check');
    else if (move.captured) play('capture');
    else play('move');
  }

  function askPromotion(color, done) {
    const pieces = ['q', 'r', 'b', 'n'];
    const m = el(`<div class="modal duel-promo"><div class="modal-card" style="max-width:340px;text-align:center">
      <h3>Promote to</h3>
      <div class="duel-promo-row">${pieces.map((p) =>
        `<button data-p="${p}" aria-label="${{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p]}">
          <img src="${PIECE_THEME(color + p.toUpperCase())}" alt=""></button>`).join('')}</div>
    </div></div>`);
    document.body.appendChild(m);
    m.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { m.remove(); done(b.dataset.p); }));
    m.onclick = (e) => { if (e.target === m) { m.remove(); done(null); } };
  }

  /* ── clocks ── */

  const clockRunning = (g) => g.status === 'active' && (g.moves || []).length >= 2;

  const remaining = (color) => {
    const g = S.game;
    if (!g) return 0;
    if (!clockRunning(g) || g.turn !== color) return g.clock[color];
    return g.clock[color] - (serverNow() - g.lastMoveAt);
  };

  /* The side that ran out loses, unless the other side couldn't possibly
     mate — then it's a draw, as it would be over the board. */
  function timeoutPatch(g, loser) {
    const c = replay(g.moves);
    const winner = opp(loser);
    const canMate = c.board().flat().some((p) => p && p.color === winner && p.type !== 'k');
    if (!canMate) return endPatch(g, '1/2-1/2', 'timeout vs insufficient material');
    return endPatch(g, loser === 'w' ? '0-1' : '1-0', 'timeout');
  }

  function claimFlag() {
    const g = S.game;
    const key = `${(g.moves || []).length}:${g.lastMoveAt}`;
    if (S.claiming === key) return;
    S.claiming = key;
    runTransaction(db, async (tx) => {
      const snap = await tx.get(duelRef(gameId));
      const cur = snap.data();
      if (!cur || cur.status !== 'active') return;
      if ((cur.moves || []).length !== (g.moves || []).length || cur.lastMoveAt !== g.lastMoveAt) return;
      const left = cur.clock[cur.turn] - (serverNow() - cur.lastMoveAt);
      if (left > -FLAG_GRACE) return;   // our clock was ahead; the server's says not yet
      tx.update(duelRef(gameId), timeoutPatch(cur, cur.turn));
    }).catch((e) => console.warn('Flag claim failed', e));
  }

  function paintClocks() {
    const g = S.game;
    if (!g) return;
    root.querySelectorAll('.duel-clock').forEach((n) => {
      const c = n.dataset.c;
      const ms = remaining(c);
      n.textContent = fmtClock(ms);
      const running = clockRunning(g) && g.turn === c;
      n.parentElement.classList.toggle('low', ms < 20000 && running);
    });
    if (!live()) return;
    if (clockRunning(g) && S.myColor && remaining(g.turn) < -FLAG_GRACE) claimFlag();
    // a soft tick once a second when your own clock is under ten seconds
    if (S.myColor && g.turn === S.myColor && clockRunning(g)) {
      const ms = remaining(S.myColor);
      const sec = Math.ceil(ms / 1000);
      if (ms < 10000 && ms > 0 && sec !== S.lastTick) { S.lastTick = sec; play('low'); }
    }
    paintAbortTimer();
  }

  /* ── the two player cards ── */

  function material(c) {
    const count = { w: {}, b: {} };
    c.board().flat().forEach((p) => { if (p) count[p.color][p.type] = (count[p.color][p.type] || 0) + 1; });
    const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const lost = (color) => Object.keys(start).flatMap((t) =>
      Array(Math.max(0, start[t] - (count[color][t] || 0))).fill(t));
    const score = (color) => Object.entries(count[color]).reduce((s, [t, n]) => s + PIECE_VALUE[t] * n, 0);
    return { capturedBy: { w: lost('b'), b: lost('w') }, diff: score('w') - score('b') };
  }

  function paintPlayer(node, color) {
    const g = S.game;
    const p = color === 'w' ? g.white : g.black;
    const ms = remaining(color);
    const running = clockRunning(g) && g.turn === color;
    const mat = material(S.view == null ? S.chess : replay(g.moves, S.view));
    const lead = color === 'w' ? mat.diff : -mat.diff;
    const seen = g.seen && g.seen[color];
    const away = live() && seen && serverNow() - seen > AWAY_AFTER && p.uid !== ctx.user.uid;
    const result = g.status === 'finished' && g.reason !== 'aborted'
      ? (g.winner ? (g.winner === p.uid ? 'won' : 'lost') : 'drew') : null;
    let delta = '';
    if (g.rated && g.newRatings) {
      const d = Math.round(g.newRatings[sideKey(color)].r - readRating(p).r);
      delta = `<span class="duel-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</span>`;
    }
    node.className = 'duel-player' + (running ? ' live' : '') + (ms < 20000 && running ? ' low' : '') + (result ? ' ' + result : '');
    node.innerHTML = `
      ${avatarHTML(p, 40)}
      <div class="duel-player-id">
        <b>${esc(p.username)}${p.uid === ctx.user.uid ? ' <span class="you-tag">you</span>' : ''}${away ? ' <span class="away-tag">away</span>' : ''}</b>
        <small><span class="tabular">${displayRating(p.rating)}</span>${delta}
          <span class="duel-captured">${mat.capturedBy[color].sort((a, b) => PIECE_VALUE[a] - PIECE_VALUE[b]).map((t) =>
            `<img src="${PIECE_THEME(opp(color) + t.toUpperCase())}" alt="">`).join('')}${lead > 0 ? `<em>+${lead}</em>` : ''}</span>
        </small>
      </div>
      <div class="duel-clock tabular" data-c="${color}">${fmtClock(ms)}</div>`;
  }

  /* ── moves list and replay ── */

  function paintMoves() {
    const moves = S.chess ? S.chess.history() : (S.game.moves || []);
    const box = $('#duel-moves');
    const at = S.view == null ? moves.length : S.view;
    const rows = [];
    for (let i = 0; i < moves.length; i += 2) {
      rows.push(`<div class="mv-row"><span class="mv-n">${i / 2 + 1}</span>
        <button class="mv${at === i + 1 ? ' on' : ''}" data-ply="${i + 1}">${esc(moves[i])}</button>
        ${moves[i + 1] ? `<button class="mv${at === i + 2 ? ' on' : ''}" data-ply="${i + 2}">${esc(moves[i + 1])}</button>` : '<span></span>'}
      </div>`);
    }
    const end = S.game.status === 'finished'
      ? `<div class="mv-result">${esc(S.game.result === '*' ? 'Aborted' : S.game.result)}<small>${esc(reasonText(S.game.reason))}</small></div>` : '';
    box.innerHTML = rows.join('') + end || '<div class="mv-empty">The moves will show up here.</div>';
    const on = box.querySelector('.mv.on');
    if (S.view == null) box.scrollTop = box.scrollHeight;
    else if (on) on.scrollIntoView({ block: 'nearest' });
    root.querySelectorAll('.duel-nav button').forEach((b) => {
      const n = b.dataset.nav;
      b.disabled = (n === 'first' || n === 'prev') ? at === 0 : at >= moves.length;
    });
  }

  function viewPly(n) {
    const total = plies();
    const ply = Math.max(0, Math.min(total, n));
    S.view = ply === total ? null : ply;
    selected = null;
    clearHints();
    S.board.position(currentFen());
    paintAll();
  }

  $('#duel-moves').onclick = (e) => {
    const b = e.target.closest('[data-ply]');
    if (b) viewPly(+b.dataset.ply);
  };
  root.querySelector('.duel-nav').onclick = (e) => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    const at = S.view == null ? plies() : S.view;
    const to = { first: 0, prev: at - 1, next: at + 1, last: plies() }[b.dataset.nav];
    viewPly(to);
  };
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const at = S.view == null ? plies() : S.view;
    if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(at - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(at + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); viewPly(0); }
    if (e.key === 'ArrowDown') { e.preventDefault(); viewPly(plies()); }
    if (e.key === 'f') flip();
  };
  document.addEventListener('keydown', onKey);

  function flip() {
    S.orientation = S.orientation === 'white' ? 'black' : 'white';
    S.board.orientation(S.orientation);
    paintAll();
  }
  $('#duel-flip').onclick = flip;

  /* ── status line ── */

  function paintStatus() {
    const g = S.game;
    const box = $('#duel-status');
    if (g.status === 'finished') {
      const won = g.winner === ctx.user.uid;
      const aborted = g.reason === 'aborted';
      const head = aborted ? 'Game aborted'
        : S.myColor ? (!g.winner ? 'Draw' : won ? 'You won' : 'You lost')
        : !g.winner ? 'Draw' : `${esc((g.winner === g.white.uid ? g.white : g.black).username)} won`;
      let delta = '';
      if (g.rated && g.newRatings && S.myColor) {
        const side = sideKey(S.myColor);
        const d = Math.round(g.newRatings[side].r - readRating(g[side]).r);
        delta = `<span class="duel-status-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d} rating, now ${Math.round(g.newRatings[side].r)}</span>`;
      }
      const tone = aborted || !g.winner ? 'draw' : (won || !S.myColor) ? 'win' : 'loss';
      box.className = 'duel-status done ' + tone;
      box.innerHTML = `<b>${head}</b><span>${esc(aborted ? 'No one moved in time, so nothing counts.' : reasonLine(g))}</span>${delta}`;
      return;
    }
    if (S.view != null) {
      box.className = 'duel-status review';
      box.innerHTML = `<b>Looking at move ${Math.ceil(S.view / 2) || 'zero'}</b><button class="btn subtle sm" data-live>Back to the game</button>`;
      box.querySelector('[data-live]').onclick = () => viewPly(plies());
      return;
    }
    const mine = S.myColor && g.turn === S.myColor;
    const who = g.turn === 'w' ? g.white : g.black;
    box.className = 'duel-status' + (mine ? ' mine' : '');
    box.innerHTML = !S.myColor
      ? `<b>${esc(who.username)} to move</b><span>You're watching</span>`
      : mine
        ? `<b>Your move</b><span>${plies() < 2 ? 'The clocks start once both of you have moved.' : 'Playing ' + (S.myColor === 'w' ? 'White' : 'Black')}</span>`
        : `<b>Waiting for ${esc(who.username)}</b><span>${plies() < 2 ? 'The clocks start once both of you have moved.' : 'Their clock is running'}</span>`;
  }

  const reasonLine = (g) => {
    const r = g.reason;
    if (r === 'checkmate') return 'Checkmate';
    if (r === 'resignation') return `${(g.winner === g.white.uid ? g.black : g.white).username} resigned`;
    if (r === 'timeout') return `${(g.winner === g.white.uid ? g.black : g.white).username} ran out of time`;
    if (r === 'abandoned') return `${(g.winner === g.white.uid ? g.black : g.white).username} left the game`;
    if (r === 'agreement') return 'Both players agreed to a draw';
    return reasonText(r).replace(/^./, (c) => c.toUpperCase());
  };

  /* ── offers: draw, takeback, rematch ── */

  function paintOffer() {
    const g = S.game;
    const box = $('#duel-offer');
    const me = ctx.user.uid;
    const them = S.myColor ? (S.myColor === 'w' ? g.black : g.white) : null;
    let html = '';
    if (S.myColor && live()) {
      if (g.drawOfferFrom && g.drawOfferFrom !== me) {
        html = offerCard(`${esc(them.username)} offers a draw`, 'draw-yes', 'Accept draw', 'draw-no');
      } else if (g.takebackFrom && g.takebackFrom !== me) {
        html = offerCard(`${esc(them.username)} wants to take back their last move`, 'tb-yes', 'Allow it', 'tb-no');
      } else if (g.drawOfferFrom === me) {
        html = pendingCard('You offered a draw', 'draw-cancel');
      } else if (g.takebackFrom === me) {
        html = pendingCard('You asked for a takeback', 'tb-cancel');
      }
    }
    if (S.myColor && g.status === 'finished' && !g.rematchId && !inTournament()) {
      if (g.rematchFrom && g.rematchFrom !== me) html = offerCard(`${esc(them.username)} wants a rematch`, 'rm-yes', 'Play again', 'rm-no');
      else if (g.rematchFrom === me) html = pendingCard(`Rematch offered to ${esc(them.username)}`, 'rm-cancel');
    }
    const was = box.innerHTML;
    box.hidden = !html;
    box.innerHTML = html;
    if (html && html !== was && !box.querySelector('[data-act$="cancel"]')) play('notify');

    const act = (name, fn) => { const b = box.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
    const set = (patch) => updateDoc(duelRef(gameId), patch).catch((e) => console.warn(e));
    act('draw-yes', () => endWith('1/2-1/2', 'agreement'));
    act('draw-no', () => set({ drawOfferFrom: null }));
    act('draw-cancel', () => set({ drawOfferFrom: null }));
    act('tb-yes', acceptTakeback);
    act('tb-no', () => set({ takebackFrom: null }));
    act('tb-cancel', () => set({ takebackFrom: null }));
    act('rm-yes', acceptRematch);
    act('rm-no', () => set({ rematchFrom: null }));
    act('rm-cancel', () => set({ rematchFrom: null }));
  }

  const offerCard = (text, yes, yesLabel, no) => `
    <span class="duel-offer-text">${text}</span>
    <div class="duel-offer-btns">
      <button class="btn subtle sm" data-act="${no}">No thanks</button>
      <button class="btn primary sm" data-act="${yes}">${yesLabel}</button>
    </div>`;
  const pendingCard = (text, cancel) => `
    <span class="duel-offer-text muted">${text}</span>
    <div class="duel-offer-btns"><button class="btn ghost sm" data-act="${cancel}">Take it back</button></div>`;

  /* Every result goes through a transaction, so a resign that crosses a
     checkmate in flight can't overwrite it. */
  function endWith(result, reason) {
    runTransaction(db, async (tx) => {
      const snap = await tx.get(duelRef(gameId));
      const g = snap.data();
      if (!g || g.status !== 'active') return;
      tx.update(duelRef(gameId), endPatch({ id: gameId, ...g }, result, reason));
    }).catch((e) => { console.error(e); toast('That didn\'t go through. Try again.', 'error'); });
  }

  function acceptTakeback() {
    runTransaction(db, async (tx) => {
      const snap = await tx.get(duelRef(gameId));
      const g = snap.data();
      if (!g || g.status !== 'active' || !g.takebackFrom) return;
      const asker = g.white.uid === g.takebackFrom ? 'w' : 'b';
      const moves = (g.moves || []).slice();
      // undo the asker's last move, and the reply to it if there was one
      const undo = g.turn === asker ? 2 : 1;
      if (moves.length < undo) return;
      moves.splice(moves.length - undo, undo);
      const c = replay(moves);
      tx.update(duelRef(gameId), {
        moves, fen: c.fen(), turn: c.turn(),
        lastMoveAt: serverNow(), takebackFrom: null, drawOfferFrom: null
      });
    }).catch((e) => console.warn('Takeback failed', e));
  }

  async function acceptRematch() {
    const g = S.game;
    try {
      const nextId = await runTransaction(db, async (tx) => {
        const snap = await tx.get(duelRef(gameId));
        const cur = snap.data();
        if (!cur) throw new Error('That game is gone.');
        if (cur.rematchId) return cur.rematchId;
        const snapOf = (side) => {
          const p = cur[side];
          const rating = cur.rated && cur.newRatings ? cur.newRatings[side] : readRating(p);
          const record = cur.rated && cur.newRecords ? cur.newRecords[side] : readRecord(p);
          return { ...playerSnap(p.uid, p.username, p.avatarColor, readRating({ rating }), { record }) };
        };
        const ref = doc(duelsCol());
        // colours swap, everything else stays the same
        tx.set(ref, buildGame({
          scope: cur.scope, clubId: cur.clubId, rated: cur.rated, tc: cur.tc,
          white: snapOf('black'), black: snapOf('white')
        }));
        tx.update(duelRef(gameId), { rematchId: ref.id, rematchFrom: null });
        return ref.id;
      });
      location.hash = 'duel/' + nextId;
    } catch (e) {
      console.error(e);
      toast(e.message || 'Could not start the rematch.', 'error');
    }
  }

  /* ── the buttons under the moves ── */

  function paintActions() {
    const g = S.game;
    const box = $('#duel-actions');
    if (!S.myColor) {
      box.innerHTML = g.status === 'finished' ? finishedButtons(false) : '';
      wireFinished();
      return;
    }
    if (g.status === 'finished') {
      box.innerHTML = finishedButtons(true);
      wireFinished();
      return;
    }
    const n = plies();
    const myMoves = S.myColor === 'w' ? Math.ceil(n / 2) : Math.floor(n / 2);
    const abortable = n < 2;
    const them = S.myColor === 'w' ? 'b' : 'w';
    const seen = g.seen && g.seen[them];
    const gone = n >= 2 && g.turn === them && seen && serverNow() - seen > CLAIM_AFTER;
    box.innerHTML = `
      ${gone ? `<button class="btn primary block" data-a="claim">Your opponent left. Claim the win</button>` : ''}
      <div class="duel-btn-row">
        ${abortable
          ? `<button class="duel-act" data-a="abort">${ico('x')}<span>Abort</span></button>`
          : `<button class="duel-act" data-a="draw"${g.drawOfferFrom ? ' disabled' : ''}>${ico('half')}<span>Offer draw</span></button>`}
        ${!inTournament() ? `<button class="duel-act" data-a="takeback"${myMoves < 1 || g.takebackFrom ? ' disabled' : ''}>${ico('undo')}<span>Takeback</span></button>` : ''}
        ${!inTournament() ? `<button class="duel-act" data-a="time" title="Give your opponent 15 more seconds">${ico('plus')}<span>15 seconds</span></button>` : ''}
        ${!abortable ? `<button class="duel-act danger" data-a="resign">${ico('flag')}<span>Resign</span></button>` : ''}
      </div>`;
    const on = (a, fn) => { const b = box.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
    on('abort', () => endWith('*', 'aborted'));
    on('draw', () => updateDoc(duelRef(gameId), { drawOfferFrom: ctx.user.uid }).catch(() => {}));
    on('takeback', () => updateDoc(duelRef(gameId), { takebackFrom: ctx.user.uid }).catch(() => {}));
    on('time', () => {
      runTransaction(db, async (tx) => {
        const snap = await tx.get(duelRef(gameId));
        const cur = snap.data();
        if (!cur || cur.status !== 'active') return;
        tx.update(duelRef(gameId), { clock: { ...cur.clock, [them]: cur.clock[them] + ADD_TIME } });
      }).then(() => toast('Gave them 15 seconds')).catch(() => {});
    });
    on('resign', async () => {
      const ok = await confirmDialog({
        title: 'Resign this game?', body: 'Your opponent wins the game.',
        confirmText: 'Resign', danger: true
      });
      if (ok) endWith(S.myColor === 'w' ? '0-1' : '1-0', 'resignation');
    });
    on('claim', () => endWith(S.myColor === 'w' ? '1-0' : '0-1', 'abandoned'));
  }

  /* the abort button shows how long until the game abandons itself */
  function paintAbortTimer() {
    const g = S.game;
    const b = root.querySelector('[data-a="abort"] span');
    if (!b || plies() >= 2) return;
    const left = Math.ceil((ABORT_AFTER - (serverNow() - g.lastMoveAt)) / 1000);
    b.textContent = left > 0 ? `Abort (${left})` : 'Abort';
    // a game the side to move never starts ends itself, without a result
    if (left <= -2 && S.myColor && g.turn !== S.myColor) endWith('*', 'aborted');
  }

  const finishedButtons = (player) => `
    ${player && !inTournament() && !S.game.rematchId ? `<button class="btn primary block" data-f="rematch"${S.game.rematchFrom === ctx.user.uid ? ' disabled' : ''}>${ico('again')}Rematch</button>` : ''}
    ${S.game.rematchId ? `<button class="btn primary block" data-f="to-rematch">Go to the rematch</button>` : ''}
    <div class="duel-btn-row">
      ${player ? `<button class="duel-act" data-f="new">${ico('scope')}<span>New opponent</span></button>` : ''}
      <button class="duel-act" data-f="pgn">${ico('copy')}<span>Copy PGN</span></button>
      <a class="duel-act" data-f="lichess" target="_blank" rel="noopener">${ico('scope')}<span>Analyse on lichess</span></a>
    </div>`;

  function wireFinished() {
    const box = $('#duel-actions');
    const on = (a, fn) => { const b = box.querySelector(`[data-f="${a}"]`); if (b) b.onclick = fn; };
    on('rematch', () => updateDoc(duelRef(gameId), { rematchFrom: ctx.user.uid }).catch(() => {}));
    on('to-rematch', () => { location.hash = 'duel/' + S.game.rematchId; });
    on('new', () => { location.hash = exitHash(ctx, S.game); });
    on('pgn', async () => {
      try { await navigator.clipboard.writeText(pgnOf(S.game)); toast('PGN copied', 'ok'); }
      catch { toast('Could not copy the PGN', 'error'); }
    });
    const li = box.querySelector('[data-f="lichess"]');
    if (li) li.href = 'https://lichess.org/analysis/pgn/' + encodeURIComponent(replay(S.game.moves).pgn({ max_width: 0 }));
  }

  function pgnOf(g) {
    const c = replay(g.moves);
    const d = new Date(g.startedAt || Date.now());
    c.header(
      'Event', g.tournamentName || (g.rated ? 'Rated game' : 'Casual game'),
      'Site', location.origin,
      'Date', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
      'White', g.white.username, 'Black', g.black.username,
      'Result', g.result && g.result !== '*' ? g.result : '*',
      'WhiteElo', String(Math.round(readRating(g.white).r)),
      'BlackElo', String(Math.round(readRating(g.black).r)),
      'TimeControl', `${Math.round(g.tc.initial / 1000)}+${Math.round(g.tc.increment / 1000)}`,
      'Termination', reasonText(g.reason) || 'Normal'
    );
    return c.pgn();
  }

  function paintTags() {
    const g = S.game;
    const berserked = g.berserk && (g.berserk.w || g.berserk.b);
    $('#duel-tags').innerHTML = `
      <span class="duel-pill">${tcLabel(g.tc)} ${tcCategory(g.tc)}</span>
      <span class="duel-pill ${g.rated ? 'rated' : ''}">${g.rated ? 'Rated' : 'Casual'}</span>
      ${g.tournamentId ? `<span class="duel-pill tourn">${esc(g.tournamentName || 'Tournament')}</span>` : ''}
      ${berserked ? '<span class="duel-pill berserk">Berserk</span>' : ''}`;
    $('#duel-views').innerHTML = viewerBadge(g.viewerCount || 0);
  }

  function paintAll() {
    if (!S.game || !S.chess) return;
    const top = S.orientation === 'white' ? 'b' : 'w';
    paintPlayer($('#duel-top'), top);
    paintPlayer($('#duel-bottom'), opp(top));
    paintTags();
    paintStatus();
    paintOffer();
    paintMoves();
    paintActions();
    paintMarks();
    boardHost.classList.toggle('reviewing', S.view != null);
  }

  /* a big word over the board when the game ends */
  function flashResult(g) {
    const f = $('#duel-flash');
    if (!S.myColor || g.reason === 'aborted') return;
    const won = g.winner === ctx.user.uid;
    f.className = 'duel-board-flash ' + (!g.winner ? 'draw' : won ? 'win' : 'loss');
    f.innerHTML = `<b>${!g.winner ? 'Draw' : won ? 'You won' : 'Good game'}</b><span>${esc(reasonLine(g))}</span>`;
    f.hidden = false;
    setTimeout(() => { f.hidden = true; }, 2600);
  }

  /* ── the live game ── */

  let built = false;
  let wasStatus = null;

  S.stopGame = onSnapshot(duelRef(gameId), (snap) => {
    if (S.destroyed) return;
    if (!snap.exists()) {
      toast('That game no longer exists.', 'error');
      location.hash = duelsHash(ctx);
      return;
    }
    const g = { id: snap.id, ...snap.data() };
    const prev = S.game;
    S.game = g;

    if (!built) {
      built = true;
      S.myColor = g.white.uid === ctx.user.uid ? 'w' : g.black.uid === ctx.user.uid ? 'b' : null;
      S.orientation = S.myColor === 'b' ? 'black' : 'white';
      S.chess = replay(g.moves);
      buildBoard(S.chess.fen());
      joinAsViewer();
      requestAnimationFrame(sizeBoard);
    } else if (!S.pending || (g.moves || []).length !== S.chess.history().length) {
      const before = S.chess.history().length;
      const after = (g.moves || []).length;
      if (after !== before || g.fen !== S.chess.fen()) {
        S.chess = replay(g.moves);
        selected = null;
        clearHints();
        if (S.view == null) S.board.position(S.chess.fen());
        if (after === before + 1) {
          const last = S.chess.history({ verbose: true }).pop();
          if (last && last.color !== S.myColor) sfx(last, S.chess);
        }
        if (after < before && prev) toast('A move was taken back');
      }
    }

    // someone else's rematch landed: both players follow it
    if (g.rematchId && prev && !prev.rematchId && S.myColor) {
      location.hash = 'duel/' + g.rematchId;
      return;
    }

    paintAll();

    if (wasStatus === 'active' && g.status === 'finished') { play('end'); flashResult(g); }
    wasStatus = g.status;

    if (g.status === 'finished' && g.rated && g.newRatings && !g.ratingApplied) {
      applySettlement(g).catch((e) => console.warn('Could not store the result', e));
    }
  }, (e) => {
    console.error(e);
    toast('Lost the connection to that game. Reconnecting…', 'error');
  });

  S.clockTimer = setInterval(paintClocks, 100);

  /* ── presence and viewers ──────────────────────────────────────────
     Players stamp the game every few seconds so the other side can tell
     a slow thinker from a closed tab. Watchers keep a row each, which is
     what the viewer count sums.
     ─────────────────────────────────────────────────────────────────── */

  function joinAsViewer() {
    const beat = () => {
      if (S.myColor && live()) {
        updateDoc(duelRef(gameId), { ['seen.' + S.myColor]: serverNow() }).catch(() => {});
      } else if (!S.myColor) {
        setDoc(viewerRef(gameId, ctx.user.uid), { at: Date.now(), uid: ctx.user.uid }).catch(() => {});
      }
      recount();
    };
    beat();
    S.beat = setInterval(beat, PRESENCE_EVERY);
  }

  async function recount() {
    try {
      const s = await getDocs(viewersCol(gameId));
      const cut = Date.now() - 30000;
      const fresh = s.docs.filter((d) => (d.data().at || 0) > cut);
      s.docs.filter((d) => (d.data().at || 0) <= cut && d.id === ctx.user.uid)
        .forEach((d) => deleteDoc(d.ref).catch(() => {}));
      if (S.game && (S.game.viewerCount || 0) !== fresh.length) {
        await updateDoc(duelRef(gameId), { viewerCount: fresh.length }).catch(() => {});
      }
    } catch (e) { /* the count is cosmetic; never let it break the game */ }
  }

  const onResize = () => sizeBoard();
  window.addEventListener('resize', onResize);

  function destroy() {
    S.destroyed = true;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    if (S.stopGame) S.stopGame();
    clearInterval(S.clockTimer);
    clearInterval(S.beat);
    if (S.board && S.board.destroy) S.board.destroy();
    if (!S.myColor) deleteDoc(viewerRef(gameId, ctx.user.uid)).catch(() => {});
    root.remove();
    document.body.classList.remove('duel-open');
  }
}
