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
      avatarColor: ctx.member.avatarColor || '#1cb0f6',
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
  `<span class="lb-avatar" style="background:${esc((p && p.avatarColor) || '#1cb0f6')};width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px">${esc(initials((p && p.username) || '?'))}</span>`;

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
  avatarColor: avatarColor || '#1cb0f6',
  rating: { r: rating.r, rd: rating.rd, vol: rating.vol, games: rating.games },
  record: readRecord(source)
});

/* `extra` carries whatever the caller needs stapled to the game: a tournament
   id and match id, or a berserk map halving one side's clock. */
export function buildGame({ scope, clubId, rated, tc, white, black }, extra = {}) {
  const now = Date.now();
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
    endedAt: Date.now(),
    winner: result === '1-0' ? game.white.uid : result === '0-1' ? game.black.uid : null,
    drawOfferFrom: null
  };
  if (game.rated) {
    patch.newRatings = rateGame(readRating(game.white), readRating(game.black), result);
    patch.newRecords = {
      white: bumpRecord(readRecord(game.white), outcomeFor('white', result)),
      black: bumpRecord(readRecord(game.black), outcomeFor('black', result))
    };
  }
  return patch;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  THE DUELS PAGE                                                     */
/* ═══════════════════════════════════════════════════════════════════ */

/* Set by the dashboard buttons so the page opens on the right scope. */
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

export async function renderDuels(ctx, host, api) {
  const intent = takeIntent();
  const globalOnly = isGlobalOnly(ctx);
  const startScope = globalOnly ? 'global' : ((intent && intent.scope) || 'club');
  const state = {
    scope: startScope,
    watchScope: startScope,
    opponent: (intent && intent.opponent) || 'random',
    tcId: '5+3',
    color: 'random',
    rated: true
  };

  host.innerHTML = `
    <div class="duel-page">
      <section class="tile duel-setup">
        <div class="duel-setup-head">
          <div>
            <h3>Set up a duel</h3>
            <p class="modal-meta" style="margin:2px 0 0">Pick your terms, then hit play.</p>
          </div>
          <div class="duel-rating-chip" id="duel-my-rating"></div>
        </div>

        <div class="duel-field"${globalOnly ? ' hidden' : ''}>
          <label>Where</label>
          <div class="duel-seg" id="duel-scope">
            <button class="duel-seg-opt" data-v="club">In the club</button>
            <button class="duel-seg-opt" data-v="global">Global</button>
          </div>
          <small class="duel-hint" id="duel-scope-hint"></small>
        </div>

        <div class="duel-field">
          <label for="duel-opponent">Who you want to play</label>
          <select id="duel-opponent"><option value="random">Random</option></select>
        </div>

        <div class="duel-field">
          <label for="duel-tc">Time control</label>
          <select id="duel-tc"></select>
        </div>

        <div class="duel-field">
          <label>Your color</label>
          <div class="duel-seg colors" id="duel-color">
            <button class="duel-seg-opt" data-v="white" title="Play as White"><span class="duel-piece w">♔</span>White</button>
            <button class="duel-seg-opt" data-v="random" title="Random side"><span class="duel-piece r">⁇</span>Random</button>
            <button class="duel-seg-opt" data-v="black" title="Play as Black"><span class="duel-piece b">♚</span>Black</button>
          </div>
        </div>

        <div class="duel-field">
          <label>Stakes</label>
          <div class="duel-seg" id="duel-rated">
            <button class="duel-seg-opt" data-v="rated">Rated</button>
            <button class="duel-seg-opt" data-v="casual">Casual</button>
          </div>
          <small class="duel-hint" id="duel-rated-hint"></small>
        </div>

        <button class="btn primary lg block" id="duel-play">Play</button>
        <button class="btn subtle block duel-link-btn" id="duel-link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 13.6a3.7 3.7 0 0 0 5.6.4l2.6-2.6a3.7 3.7 0 1 0-5.2-5.2l-1.5 1.5"/><path d="M13.6 10.4a3.7 3.7 0 0 0-5.6-.4l-2.6 2.6a3.7 3.7 0 1 0 5.2 5.2l1.5-1.5"/></svg>
          Create a match link
        </button>
      </section>

      <aside class="tile duel-watch">
        <div class="duel-watch-head">
          <h3>Live games</h3>
          <div class="duel-seg tiny" id="duel-watch-scope"${globalOnly ? ' hidden' : ''}>
            <button class="duel-seg-opt" data-v="club">Club</button>
            <button class="duel-seg-opt" data-v="global">Global</button>
          </div>
        </div>
        <div class="duel-watch-list" id="duel-watch-list"></div>
        <div class="empty-state" id="duel-watch-empty" hidden>Nobody is playing right now.</div>
      </aside>
    </div>
    <div class="duel-pending" id="duel-pending" hidden></div>`;

  await syncPublicProfile(ctx);
  let ratings = await loadMyRatings(ctx);

  /* ── the opponent dropdown ── */

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
    } catch (e) { console.warn('Could not load the opponent list', e); }
    rows = rows.filter((r) => r.uid !== ctx.user.uid)
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    opponentCache[scope] = rows;
    return rows;
  }

  async function paintOpponents() {
    const sel = host.querySelector('#duel-opponent');
    const keep = state.opponent;
    const rows = await loadOpponents(state.scope);
    sel.innerHTML = '<option value="random">Random</option>' + rows.map((r) =>
      `<option value="${esc(r.uid)}">${esc(r.username || 'Player')} · ${displayRating(r.rating)}</option>`).join('');
    sel.value = rows.some((r) => r.uid === keep) ? keep : 'random';
    state.opponent = sel.value;
  }

  /* ── time control dropdown ── */

  const tcSel = host.querySelector('#duel-tc');
  let lastCat = '';
  tcSel.innerHTML = TIME_CONTROLS.map((t) => {
    const head = t.cat !== lastCat ? (lastCat ? '</optgroup>' : '') + `<optgroup label="${t.cat}">` : '';
    lastCat = t.cat;
    return head + `<option value="${t.id}">${t.min} + ${t.inc}</option>`;
  }).join('') + '</optgroup>';
  tcSel.value = state.tcId;

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
    host.querySelector('#duel-my-rating').innerHTML =
      `<span class="duel-rating-label">${state.scope === 'club' ? 'Club' : 'Global'} rating</span>
       <b class="duel-rating-num">${displayRating(g)}</b>`;
    host.querySelector('#duel-scope-hint').textContent = state.scope === 'club'
      ? `Paired with members of ${(ctx.club && ctx.club.name) || 'this club'}. Moves your club rating.`
      : 'Paired with anyone on JagChess. Moves your global rating.';
    host.querySelector('#duel-rated-hint').textContent = state.rated
      ? 'The result counts towards your rating.'
      : 'Just for fun — nobody\'s rating moves.';
  }

  seg('duel-scope', 'scope', () => {
    state.watchScope = state.scope;
    paintOpponents();
    paintWatch();
    paintSegs();
  });
  seg('duel-color', 'color');
  seg('duel-rated', 'rated');
  seg('duel-watch-scope', 'watchScope', paintWatch);

  host.querySelector('#duel-opponent').onchange = (e) => { state.opponent = e.target.value; };
  tcSel.onchange = (e) => { state.tcId = e.target.value; };

  /* ── the watch panel ── */

  let games = [];

  function paintWatch() {
    const list = host.querySelector('#duel-watch-list');
    const rows = visibleDuels(games, ctx, state.watchScope);
    host.querySelector('#duel-watch-empty').hidden = rows.length > 0;
    list.innerHTML = rows.map((g) => `
      <button class="duel-watch-row" data-g="${esc(g.id)}">
        <span class="duel-watch-players">
          <span class="duel-watch-side">
            ${avatarHTML(g.white, 26)}
            <span class="duel-watch-name">${esc(g.white.username)}</span>
            <span class="duel-watch-elo">${displayRating(g.white.rating)}</span>
          </span>
          <span class="duel-watch-vs">vs</span>
          <span class="duel-watch-side">
            ${avatarHTML(g.black, 26)}
            <span class="duel-watch-name">${esc(g.black.username)}</span>
            <span class="duel-watch-elo">${displayRating(g.black.rating)}</span>
          </span>
        </span>
        <span class="duel-watch-meta">
          <span class="duel-pill">${tcLabel(g.tc)}</span>
          <span class="duel-pill ${g.rated ? 'rated' : ''}">${g.rated ? 'Rated' : 'Casual'}</span>
          <span class="duel-pill soft">${(g.moves || []).length} moves</span>
          ${viewerBadge(g.viewerCount || 0)}
        </span>
      </button>`).join('');
    list.querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => { location.hash = 'duel/' + b.dataset.g; };
    });
  }

  const stopActive = watchActiveDuels((rows) => { games = rows; paintWatch(); });

  /* ── the un-dismissable pending-challenge bar ── */

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
            <b>${esc(c.from.username)} challenged you</b>
            <small>${displayRating(c.from.rating)} · ${tcLabel(c.tc)} ${tcCategory(c.tc)} · ${c.rated ? 'Rated' : 'Casual'} · ${c.scope === 'club' ? 'Club' : 'Global'}</small>
          </div>
          <button class="btn subtle sm" data-decline>Decline</button>
          <button class="btn primary sm" data-accept>Accept</button>
        </div>`).join('');
      bar.querySelectorAll('.duel-pending-card').forEach((card) => {
        const id = card.dataset.c;
        // the bar is the notification here; a pop-up saying the same thing goes
        document.querySelectorAll(`.duel-invite[data-c="${id}"]`).forEach((n) => n.remove());
        card.querySelector('[data-accept]').onclick = () => acceptChallenge(ctx, id);
        card.querySelector('[data-decline]').onclick = () =>
          updateDoc(chalRef(id), { status: 'declined' }).catch(() => {});
      });
    },
    (e) => console.warn('Challenge listener stopped', e)
  );

  /* ── keep my ratings live so the header number is never stale ── */

  /* Which document that is depends on where we are: a club member row inside
     a club, the user profile out on the hub. */
  const stopMe = onSnapshot(
    globalOnly ? userRef(ctx.user.uid) : memberRef(ctx.clubId, ctx.user.uid),
    (s) => {
      if (!s.exists()) return;
      const d = s.data();
      if (globalOnly) { ratings.global = readRating(d); ratings.sources.global = d; }
      else { ratings.club = readRating(d); ratings.sources.club = d; }
      paintSegs();
    }, () => {});

  /* ── play ── */

  host.querySelector('#duel-play').onclick = async () => {
    const btn = host.querySelector('#duel-play');
    btn.disabled = true;
    try {
      const tc = tcFromId(state.tcId);
      const mine = state.scope === 'club' ? ratings.club : ratings.global;
      const source = state.scope === 'club' ? ratings.sources.club : ratings.sources.global;
      const me = playerSnap(
        ctx.user.uid,
        ctx.member.username || (ctx.user.email || '').split('@')[0],
        ctx.member.avatarColor,
        mine, source
      );
      if (state.opponent === 'random') {
        await openLobby(ctx, { ...state, tc, me });
      } else {
        const rows = await loadOpponents(state.scope);
        const target = rows.find((r) => r.uid === state.opponent);
        if (!target) { toast('That player is no longer available.', 'error'); return; }
        await sendChallenge(ctx, { ...state, tc, me, target });
      }
    } catch (e) {
      console.error(e);
      toast(e.message || 'Could not start that duel.', 'error');
    } finally {
      btn.disabled = false;
    }
  };

  /* ── a link to send somebody who isn't here ── */

  host.querySelector('#duel-link').onclick = async () => {
    const { openMatchLinkSheet } = await import('./match-links.js');
    openMatchLinkSheet(ctx, {
      ratings,
      scope: state.scope,
      tcId: state.tcId,
      color: state.color,
      rated: state.rated
    });
  };

  await paintOpponents();
  paintSegs();
  paintWatch();

  return () => { stopActive(); stopPending(); stopMe(); };
}

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
        <h3>Finding an opponent…</h3>
        <p class="duel-lobby-terms">
          ${tcLabel(tc)} ${tcCategory(tc)} · ${rated ? 'Rated' : 'Casual'} · ${scope === 'club' ? esc(ctx.club.name || 'Club') : 'Global'}
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
          ${tcLabel(tc)} ${tcCategory(tc)} · ${rated ? 'Rated' : 'Casual'} · ${scope === 'club' ? esc(ctx.club.name || 'Club') : 'Global'}
        </p>
        <p class="modal-meta" style="margin:0">They'll get a notification. If they miss it, it stays waiting on their duels page.</p>
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
          <b>${esc(c.from.username)} wants to duel</b>
          <small>${displayRating(c.from.rating)} · ${readRating(c.from).games} rated games</small>
        </div>
        <button class="duel-invite-x" title="Dismiss">✕</button>
      </div>
      <div class="duel-invite-terms">
        <span class="duel-pill">${tcLabel(c.tc)} ${tcCategory(c.tc)}</span>
        <span class="duel-pill ${c.rated ? 'rated' : ''}">${c.rated ? 'Rated' : 'Casual'}</span>
        <span class="duel-pill soft">${c.scope === 'club' ? 'Club' : 'Global'}</span>
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
/*  THE GAME STAGE — playing and spectating are the same screen        */
/* ═══════════════════════════════════════════════════════════════════ */

let stage = null;

export function closeDuelStage() {
  if (!stage) return;
  try { stage.destroy(); } catch (e) { console.error(e); }
  stage = null;
}

export function openDuelStage(ctx, gameId) {
  if (stage && stage.gameId === gameId) return;
  closeDuelStage();

  const root = el(`
    <div class="duel-stage">
      <div class="duel-stage-bar">
        <button class="duel-exit" id="duel-exit">← Back to duels</button>
        <div class="duel-stage-tags" id="duel-tags"></div>
        <div class="duel-stage-views" id="duel-views"></div>
      </div>
      <div class="duel-stage-body">
        <div class="duel-board-col">
          <div class="duel-player" id="duel-top"></div>
          <div class="duel-board-wrap"><div id="duel-board" class="chessboard"></div></div>
          <div class="duel-player" id="duel-bottom"></div>
        </div>
        <aside class="duel-side">
          <div class="duel-result" id="duel-result" hidden></div>
          <div class="duel-side-head"><h4>Moves</h4><span class="muted" id="duel-movecount"></span></div>
          <div class="duel-moves" id="duel-moves"></div>
          <div class="duel-side-actions" id="duel-actions"></div>
        </aside>
      </div>
    </div>`);
  document.body.appendChild(root);
  document.body.classList.add('duel-open');

  const S = {
    gameId,
    game: null,
    chess: null,
    board: null,
    myColor: null,      // 'w' | 'b' | null when spectating
    stopGame: null,
    clockTimer: null,
    beat: null,
    destroyed: false,
    destroy
  };
  stage = S;

  /* Replaying the move list rather than loading the FEN keeps chess.js's
     history, which is the only way it can see a threefold repetition. */
  const replay = (moves) => {
    const c = new window.Chess();
    (moves || []).forEach((san) => c.move(san, { sloppy: true }));
    return c;
  };

  root.querySelector('#duel-exit').onclick = () => { location.hash = exitHash(ctx, S.game); };

  /* ── board ── */

  const boardHost = root.querySelector('#duel-board');
  const boardCol = root.querySelector('.duel-board-col');

  /* chessboard.js derives its size from the container's width alone, so the
     square that actually fits — width against whatever height the player
     cards leave behind — gets measured here and handed to the CSS. */
  const sizeBoard = () => {
    const cards = [...root.querySelectorAll('.duel-player')]
      .reduce((h, n) => h + n.offsetHeight, 0);
    const avail = boardCol.clientHeight - cards - 20;   // 20 = the two gaps
    const size = Math.max(200, Math.floor(Math.min(boardCol.clientWidth, avail)));
    boardCol.style.setProperty('--duel-board', size + 'px');
    if (S.board && S.board.resize) S.board.resize();
  };

  const buildBoard = (fen, orientation) => {
    if (S.board && S.board.destroy) S.board.destroy();
    S.board = window.Chessboard(boardHost, {
      draggable: !!S.myColor,
      position: fen,
      orientation,
      pieceTheme: PIECE_THEME,
      // a piece should travel to its square rather than blink onto it
      moveSpeed: 220,
      snapbackSpeed: 220,
      snapSpeed: 60,
      appearSpeed: 180,
      trashSpeed: 140,
      dropOffBoard: 'snapback',
      onDragStart: (src, piece) => {
        if (!S.myColor || !S.game || S.game.status !== 'active') return false;
        if (piece[0] !== S.myColor) return false;
        if (S.chess.turn() !== S.myColor) return false;
        selected = null;
        showHints(src);          // picking a piece up shows where it may go
      },
      onDrop: (from, to) => { clearHints(); return attemptMove(from, to); },
      onSnapEnd: () => S.board.position(S.chess.fen())
    });
    sizeBoard();
  };

  /* ── where a piece may go ──────────────────────────────────────────
     Squares carry the marker classes and chessboard.js leaves the square
     divs alone between positions, so these survive a re-render.
     ───────────────────────────────────────────────────────────────── */

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
    if (!S.myColor || !S.chess || S.chess.turn() !== S.myColor) return false;
    const moves = S.chess.moves({ square: from, verbose: true });
    if (!moves.length) return false;
    const src = squareEl(from);
    if (src) src.classList.add('duel-from');
    moves.forEach((m) => {
      const t = squareEl(m.to);
      // en passant captures an empty-looking square, so trust the flag
      if (t) t.classList.add(m.captured ? 'duel-take' : 'duel-to');
    });
    return true;
  };

  /* Tap a piece, then tap a dot. Dragging still works exactly as before. */
  boardHost.addEventListener('click', (e) => {
    if (!S.myColor || !S.game || S.game.status !== 'active') return;
    const sq = squareOf(e.target);
    if (!sq) return;

    if (selected && sq !== selected) {
      const legal = S.chess.moves({ square: selected, verbose: true }).some((m) => m.to === sq);
      if (legal) {
        const from = selected;
        selected = null;
        clearHints();
        attemptMove(from, sq);
        return;
      }
    }

    const piece = S.chess.get(sq);
    if (piece && piece.color === S.myColor && S.chess.turn() === S.myColor && sq !== selected) {
      selected = sq;
      showHints(sq);
    } else {
      selected = null;
      clearHints();
    }
  });

  function attemptMove(from, to) {
    if (!S.myColor || !S.game || S.game.status !== 'active') return 'snapback';
    if (S.chess.turn() !== S.myColor) return 'snapback';

    const legal = S.chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
    if (!legal.length) return 'snapback';

    if (legal.some((m) => m.flags.includes('p'))) {
      // hold the move until they've picked a piece, then play it for real
      askPromotion(S.myColor, (choice) => {
        if (choice) commitMove(from, to, choice);
        else S.board.position(S.chess.fen());
      });
      return 'snapback';
    }
    return commitMove(from, to, 'q') ? undefined : 'snapback';
  }

  function commitMove(from, to, promotion) {
    const g = S.game;
    const now = Date.now();
    const mine = g.clock[S.myColor] - (g.turn === S.myColor ? now - g.lastMoveAt : 0);
    if (mine <= 0) { flag(); return false; }

    const move = S.chess.move({ from, to, promotion });
    if (!move) return false;

    const clock = { ...g.clock, [S.myColor]: mine + incrementFor(g, S.myColor) };
    const patch = {
      moves: [...(g.moves || []), move.san],
      fen: S.chess.fen(),
      turn: S.chess.turn(),
      clock,
      lastMoveAt: now
    };

    if (S.chess.game_over()) {
      const result = S.chess.in_checkmate()
        ? (move.color === 'w' ? '1-0' : '0-1')
        : '1/2-1/2';
      const reason = S.chess.in_checkmate() ? 'checkmate'
        : S.chess.in_stalemate() ? 'stalemate'
        : S.chess.insufficient_material() ? 'insufficient material'
        : S.chess.in_threefold_repetition() ? 'threefold repetition'
        : 'draw';
      Object.assign(patch, endPatch({ ...g, ...patch }, result, reason));
    }

    S.board.position(S.chess.fen());
    updateDoc(duelRef(gameId), patch).catch((e) => {
      console.error(e);
      toast('That move did not reach your opponent.', 'error');
    });
    return true;
  }

  function askPromotion(color, done) {
    const pieces = color === 'w' ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
    const glyph = { Q: '♕', R: '♖', B: '♗', N: '♘', q: '♛', r: '♜', b: '♝', n: '♞' };
    const m = el(`<div class="modal duel-promo"><div class="modal-card" style="max-width:320px;text-align:center">
      <h3>Promote to</h3>
      <div class="duel-promo-row">${pieces.map((p) =>
        `<button data-p="${p.toLowerCase()}" title="${p}">${glyph[p]}</button>`).join('')}</div>
    </div></div>`);
    document.body.appendChild(m);
    m.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { m.remove(); done(b.dataset.p); }));
    m.onclick = (e) => { if (e.target === m) { m.remove(); done(null); } };
  }

  /* ── one side ran out of time ── */

  function flag() {
    const g = S.game;
    if (!g || g.status !== 'active' || !S.myColor) return;
    const loser = g.turn;
    updateDoc(duelRef(gameId), endPatch(g, loser === 'w' ? '0-1' : '1-0', 'timeout')).catch(() => {});
  }

  /* ── painting ── */

  const remaining = (color) => {
    const g = S.game;
    if (!g) return 0;
    if (g.status !== 'active') return g.clock[color];
    return g.clock[color] - (g.turn === color ? Date.now() - g.lastMoveAt : 0);
  };

  function paintPlayer(node, color) {
    const g = S.game;
    const p = color === 'w' ? g.white : g.black;
    const live = g.status === 'active' && g.turn === color;
    const ms = remaining(color);
    node.className = 'duel-player' + (live ? ' live' : '') + (ms < 20000 && live ? ' low' : '');
    node.innerHTML = `
      ${avatarHTML(p, 40)}
      <div class="duel-player-id">
        <b>${esc(p.username)}${p.uid === ctx.user.uid ? ' <span class="lb-me-badge">You</span>' : ''}</b>
        <small>${displayRating(p.rating)}${g.rated ? '' : ' · casual'}</small>
      </div>
      <div class="duel-clock" data-c="${color}">${fmtClock(ms)}</div>`;
  }

  function paintClocks() {
    const g = S.game;
    if (!g) return;
    root.querySelectorAll('.duel-clock').forEach((n) => {
      const c = n.dataset.c;
      const ms = remaining(c);
      n.textContent = fmtClock(ms);
      n.parentElement.classList.toggle('low', ms < 20000 && g.status === 'active' && g.turn === c);
    });
    if (g.status === 'active' && remaining(g.turn) <= 0) flag();
  }

  function paintMoves() {
    const moves = S.game.moves || [];
    const rows = [];
    for (let i = 0; i < moves.length; i += 2) {
      rows.push(`<div class="duel-move-row">
        <span class="duel-move-n">${i / 2 + 1}.</span>
        <span>${esc(moves[i] || '')}</span>
        <span>${esc(moves[i + 1] || '')}</span>
      </div>`);
    }
    const box = root.querySelector('#duel-moves');
    box.innerHTML = rows.join('') || '<div class="empty-state">No moves yet.</div>';
    box.scrollTop = box.scrollHeight;
    root.querySelector('#duel-movecount').textContent = moves.length ? moves.length + ' played' : '';
  }

  function paintResult() {
    const g = S.game;
    const box = root.querySelector('#duel-result');
    if (g.status !== 'finished') { box.hidden = true; return; }
    box.hidden = false;
    const won = g.winner === ctx.user.uid;
    const drew = !g.winner;
    const head = S.myColor
      ? (drew ? 'Draw' : won ? 'You won' : 'You lost')
      : (drew ? 'Draw' : `${esc((g.winner === g.white.uid ? g.white : g.black).username)} won`);
    let delta = '';
    if (g.rated && g.newRatings && S.myColor) {
      const side = S.myColor === 'w' ? 'white' : 'black';
      const d = Math.round(g.newRatings[side].r - readRating(g[side]).r);
      delta = `<div class="duel-result-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d} rating → ${g.newRatings[side].r}</div>`;
    }
    box.className = 'duel-result ' + (drew ? 'draw' : won || !S.myColor ? 'win' : 'loss');
    box.innerHTML = `<b>${head}</b><span>${esc(g.result || '')} · ${esc(g.reason || '')}</span>${delta}`;
  }

  function paintActions() {
    const g = S.game;
    const box = root.querySelector('#duel-actions');
    if (!S.myColor) {
      box.innerHTML = '<div class="duel-spectating">You are watching this game.</div>';
      return;
    }
    if (g.status !== 'active') {
      box.innerHTML = '<button class="btn primary block" id="duel-again">Back to duels</button>';
      box.querySelector('#duel-again').onclick = () => { location.hash = exitHash(ctx, g); };
      return;
    }
    const offeredToMe = g.drawOfferFrom && g.drawOfferFrom !== ctx.user.uid;
    box.innerHTML = offeredToMe
      ? `<div class="duel-draw-offer">Draw offered
           <button class="btn primary sm" id="duel-draw-yes">Accept</button>
           <button class="btn subtle sm" id="duel-draw-no">Decline</button>
         </div>`
      : `<button class="btn subtle" id="duel-draw">${g.drawOfferFrom === ctx.user.uid ? 'Draw offered…' : 'Offer draw'}</button>
         <button class="btn subtle danger" id="duel-resign">Resign</button>`;

    const q = (id) => box.querySelector('#' + id);
    if (q('duel-draw')) q('duel-draw').onclick = () =>
      updateDoc(duelRef(gameId), { drawOfferFrom: ctx.user.uid }).catch(() => {});
    if (q('duel-draw-no')) q('duel-draw-no').onclick = () =>
      updateDoc(duelRef(gameId), { drawOfferFrom: null }).catch(() => {});
    if (q('duel-draw-yes')) q('duel-draw-yes').onclick = () =>
      updateDoc(duelRef(gameId), endPatch(g, '1/2-1/2', 'agreement')).catch(() => {});
    if (q('duel-resign')) q('duel-resign').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Resign this game?', body: 'Your opponent takes the point.',
        confirmText: 'Resign', danger: true
      });
      if (!ok) return;
      updateDoc(duelRef(gameId), endPatch(g, S.myColor === 'w' ? '0-1' : '1-0', 'resignation')).catch(() => {});
    };
  }

  function paintTags() {
    const g = S.game;
    const berserked = g.berserk && (g.berserk.w || g.berserk.b);
    root.querySelector('#duel-tags').innerHTML = `
      <span class="duel-pill">${tcLabel(g.tc)} ${tcCategory(g.tc)}</span>
      <span class="duel-pill ${g.rated ? 'rated' : ''}">${g.rated ? 'Rated' : 'Casual'}</span>
      <span class="duel-pill soft">${g.scope === 'club' ? 'Club duel' : 'Global duel'}</span>
      ${g.tournamentId ? `<span class="duel-pill tourn">${esc(g.tournamentName || 'Tournament')}</span>` : ''}
      ${berserked ? '<span class="duel-pill berserk">Berserk</span>' : ''}`;
    root.querySelector('#duel-views').innerHTML = viewerBadge(g.viewerCount || 0);
  }

  /* ── the live game ── */

  let built = false;

  S.stopGame = onSnapshot(duelRef(gameId), (snap) => {
    if (S.destroyed) return;
    if (!snap.exists()) {
      toast('That game no longer exists.', 'error');
      location.hash = duelsHash(ctx);
      return;
    }
    const g = { id: snap.id, ...snap.data() };
    S.game = g;

    if (!built) {
      built = true;
      S.myColor = g.white.uid === ctx.user.uid ? 'w' : g.black.uid === ctx.user.uid ? 'b' : null;
      S.chess = replay(g.moves);
      buildBoard(S.chess.fen(), S.myColor === 'b' ? 'black' : 'white');
      joinAsViewer();
      // the player cards only have a height once they have been painted
      requestAnimationFrame(sizeBoard);
    } else if ((g.moves || []).length !== S.chess.history().length) {
      S.chess = replay(g.moves);
      selected = null;
      clearHints();
      S.board.position(S.chess.fen());   // animated, so the piece is seen to travel
    }

    const top = S.myColor === 'b' ? 'w' : 'b';
    paintPlayer(root.querySelector('#duel-top'), top);
    paintPlayer(root.querySelector('#duel-bottom'), top === 'w' ? 'b' : 'w');
    paintTags();
    paintMoves();
    paintResult();
    paintActions();

    if (g.status === 'finished' && g.rated && g.newRatings && !g.ratingApplied) {
      applySettlement(g).catch((e) => console.warn('Could not store the result', e));
    }
  }, (e) => {
    console.error(e);
    toast('Lost the connection to that game.', 'error');
  });

  S.clockTimer = setInterval(paintClocks, 120);

  /* ── viewers ── */

  /* Players are not spectators, so they never write a viewer row — but they
     do keep the tally honest, which means the count stays right even after
     the last watcher's tab dies. */
  function joinAsViewer() {
    if (!S.myColor) {
      setDoc(viewerRef(gameId, ctx.user.uid), { at: Date.now(), uid: ctx.user.uid }).catch(() => {});
    }
    recount();
    S.beat = setInterval(() => {
      if (!S.myColor) setDoc(viewerRef(gameId, ctx.user.uid), { at: Date.now(), uid: ctx.user.uid }).catch(() => {});
      recount();
    }, 10000);
  }

  async function recount() {
    try {
      const s = await getDocs(viewersCol(gameId));
      const cut = Date.now() - 30000;
      const live = s.docs.filter((d) => (d.data().at || 0) > cut);
      // sweep rows left behind by tabs that closed badly
      s.docs.filter((d) => (d.data().at || 0) <= cut && d.id === ctx.user.uid)
        .forEach((d) => deleteDoc(d.ref).catch(() => {}));
      if (S.game && (S.game.viewerCount || 0) !== live.length) {
        await updateDoc(duelRef(gameId), { viewerCount: live.length }).catch(() => {});
      }
    } catch (e) { /* the count is cosmetic — never let it break the game */ }
  }

  const onResize = () => sizeBoard();
  window.addEventListener('resize', onResize);

  function destroy() {
    S.destroyed = true;
    window.removeEventListener('resize', onResize);
    if (S.stopGame) S.stopGame();
    clearInterval(S.clockTimer);
    clearInterval(S.beat);
    if (S.board && S.board.destroy) S.board.destroy();
    if (!S.myColor) deleteDoc(viewerRef(gameId, ctx.user.uid)).catch(() => {});
    root.remove();
    document.body.classList.remove('duel-open');
  }
}
