/* ═══════════════════════════════════════════════════════════════════════
   lichess-live.js — the one open line to lichess about YOUR games.

   `GET /api/stream/event` pushes a line the instant anything happens to the
   signed-in player: a game starts, a game finishes, a challenge arrives. It
   is the difference between "click Join, then hunt for your board" and
   "click Join, and the board opens on its own a second later".

   Two things make it awkward, and both are handled here rather than by every
   caller:

     • LICHESS ALLOWS ONE STREAM PER TOKEN. Opening a second one silently
       closes the first. So this module is a singleton with a reference
       count: many screens can listen, exactly one connection exists.
     • IT IS A LONG-LIVED FETCH. Reconnection, back-off, token changes and
       tab suspension all have to be dealt with, or the "instant" part stops
       being instant after the first hiccup.

   When the stream opens, lichess replays every game already in progress —
   which is what lets a page reloaded mid-game put you straight back on your
   board.
   ═══════════════════════════════════════════════════════════════════════ */

import * as api from './lichess-api.js';
import { session, hasScopes, SCOPES, onAuthChange } from './lichess-auth.js';

/* ── state ─────────────────────────────────────────────────────────── */

const listeners = new Set();

let refs = 0;
let abort = null;
let running = false;
let backoff = 1000;
let token = null;
let retryTimer = null;
let connected = false;

/** gameId → the game as lichess last described it. */
const live = new Map();

/** The games this account is playing right now, newest first. */
export const liveGames = () => [...live.values()];

/** The live game belonging to a given tournament, if there is one. */
export function gameInTournament(tournamentId) {
  if (!tournamentId) return null;
  for (const g of live.values()) {
    if (g.tournamentId === tournamentId) return g;
  }
  return null;
}

const emit = (ev) => {
  listeners.forEach((fn) => {
    try { fn(ev); } catch (e) { console.error('lichess event listener failed', e); }
  });
};

/* ── the connection ────────────────────────────────────────────────── */

/**
 * Subscribe to your own lichess events.
 *
 * @param {(ev: {type: string, game?: object}) => void} fn
 * @returns {Function} unsubscribe
 */
export function onLichessEvent(fn) {
  listeners.add(fn);
  refs++;
  open();
  let live2 = true;
  return () => {
    if (!live2) return;
    live2 = false;
    listeners.delete(fn);
    refs = Math.max(0, refs - 1);
    /* Nobody is listening any more, but the connection is cheap to keep for
       a moment and expensive to re-establish — a route change between two
       screens that both want it must not close and reopen it. */
    setTimeout(() => { if (refs === 0) close(); }, 4000);
  };
}

/** True when there is any point trying: a token that may play. */
export const canStream = () => !!session() && hasScopes([SCOPES.board]);

/** True once lichess has actually answered on the event stream. */
export const isConnected = () => connected;

function open() {
  if (running || !canStream()) return;
  running = true;
  token = session().token;
  loop();
}

function close() {
  running = false;
  connected = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (abort) { try { abort.abort(); } catch (_) {} abort = null; }
  live.clear();
}

async function loop() {
  while (running) {
    abort = new AbortController();
    try {
      await api.streamEvents(token, (line) => { connected = true; handle(line); }, abort.signal);
      /* A clean end means lichess closed it — usually because another client
         opened one with the same token. Reconnecting immediately would be a
         fight, so it backs off like any other drop. */
      if (!running) return;
    } catch (e) {
      if (!running) return;
      if (e && e.status === 401) {
        // the token is gone; there is nothing to reconnect to
        running = false;
        emit({ type: 'unauthorized' });
        return;
      }
    }
    if (!running) return;
    connected = false;
    emit({ type: 'reconnecting' });
    await new Promise((r) => { retryTimer = setTimeout(r, backoff); });
    backoff = Math.min(backoff * 2, 30000);
  }
}

function handle(line) {
  connected = true;
  if (!line || !line.type) return;

  if (line.type === 'gameStart' && line.game) {
    backoff = 1000;
    const g = normalize(line.game);
    live.set(g.gameId, g);
    emit({ type: 'gameStart', game: g });
    return;
  }
  if (line.type === 'gameFinish' && line.game) {
    const g = normalize(line.game);
    live.delete(g.gameId);
    emit({ type: 'gameFinish', game: g });
    return;
  }
  emit({ type: line.type, raw: line });
}

/* lichess's GameEventInfo, reduced to what the board and the tournament page
   actually ask of it. `compat` is dropped: we are a board client, always.
 *
 * NOTE the asymmetry, which cost an afternoon: the `gameStart` event carries
 * `tournamentId`, but the rows from /api/account/playing do NOT — they only
 * say `source: "arena"`. So a row from the poll can be known to be a
 * tournament game without being known to be a game in THIS tournament, and
 * `isTournamentGame` below is what the matching has to fall back on. */
const normalize = (g) => ({
  gameId: g.gameId || g.id,
  fullId: g.fullId || null,
  color: g.color || null,
  fen: g.fen || null,
  lastMove: g.lastMove || null,
  isMyTurn: !!g.isMyTurn,
  hasMoved: !!g.hasMoved,
  secondsLeft: g.secondsLeft != null ? g.secondsLeft : null,
  rated: !!g.rated,
  speed: g.speed || null,
  variant: (g.variant && g.variant.key) || g.variant || 'standard',
  source: g.source || null,
  /* The field the whole "take me to my game" trick hangs on — present on
     the event, absent on the poll. */
  tournamentId: g.tournamentId || g.tournament || null,
  isTournamentGame: g.source === 'arena' || g.source === 'swiss' ||
    !!(g.tournamentId || g.tournament || g.swissId),
  swissId: g.swissId || null,
  opponent: g.opponent || null,
  status: g.status || null,
  winner: g.winner || null
});

/* A new login means a new token and a stream that has to be rebuilt. */
onAuthChange(() => {
  const s = session();
  const next = s ? s.token : null;
  if (next === token) return;
  const wanted = refs > 0;
  close();
  if (wanted && canStream()) { backoff = 1000; open(); }
});

/* ── the fast path that does not need the stream ───────────────────── */

/**
 * Asks lichess directly whether this account is in a game right now.
 *
 * One request, no stream to wait for. Used the moment a tournament page
 * opens, so somebody who reloads mid-game is put back on their board without
 * waiting for the event stream to connect and replay.
 *
 * @returns {Promise<Array>} the same shape `liveGames()` gives
 */
export async function fetchLiveGames() {
  const s = session();
  if (!s) return [];
  try {
    const res = await api.nowPlaying(s.token);
    const rows = (res && res.nowPlaying) || [];
    rows.forEach((g) => {
      const n = normalize(g);
      if (!live.has(n.gameId)) live.set(n.gameId, n);
    });
    return rows.map(normalize);
  } catch (e) {
    console.warn('Could not read your games in progress', e);
    return [];
  }
}

/**
 * Is this game the one we are waiting for?
 *
 * When lichess told us the tournament id, it is an exact answer. When it did
 * not — which is every row from /api/account/playing — the best available
 * answer is "it is a tournament game and you are only ever paired in one at
 * a time". That is true in practice, and the board corrects itself anyway:
 * it reads the real game from lichess the moment it opens.
 */
export const matches = (g, tournamentId) => {
  if (!tournamentId) return true;
  if (g.tournamentId) return g.tournamentId === tournamentId;
  return !!g.isTournamentGame;
};

/**
 * Waits for a game in this tournament to start, however the news arrives.
 *
 * Resolves with the game, or null if `signal` aborts or `timeoutMs` passes.
 * The stream is the fast path; the poll is the safety net for the case where
 * the stream could not be opened at all.
 */
export function waitForGame(tournamentId, { signal, timeoutMs = 120000, onPoll } = {}) {
  return new Promise((resolve) => {
    const already = gameInTournament(tournamentId);
    if (already) { resolve(already); return; }

    let done = false;
    const finish = (g) => {
      if (done) return;
      done = true;
      off();
      clearInterval(poller);
      clearTimeout(timer);
      resolve(g);
    };

    const off = onLichessEvent((ev) => {
      if (ev.type !== 'gameStart' || !ev.game) return;
      if (!matches(ev.game, tournamentId)) return;
      finish(ev.game);
    });

    /* The stream is the fast path. The poll underneath it is the safety net
       for a browser that could not open the stream at all — and the place
       `pairMeAsap` gets renewed, because lichess forgets it after a minute.
       When the stream is up, the net is cast far less often. */
    let beats = 0;
    const poller = setInterval(async () => {
      if (done) return;
      beats++;
      if (onPoll) { try { await onPoll(); } catch (_) {} }
      // with a live stream, gameStart will arrive on its own; check rarely
      if (connected && beats % 4 !== 0) return;
      const rows = await fetchLiveGames();
      const hit = rows.find((g) => matches(g, tournamentId));
      if (hit) finish(hit);
    }, 3000);

    const timer = setTimeout(() => finish(null), timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => finish(null), { once: true });
    }
  });
}
