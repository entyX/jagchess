/* ═══════════════════════════════════════════════════════════════════════
   lichess-api.js — every call JagChess makes to lichess.org, and nothing
   else. No Firebase, no DOM: this module is a typed-ish wrapper around the
   official API so that the day lichess changes an endpoint, there is exactly
   one file to change.

   Three rules are enforced here rather than trusted to callers:

     • ONE REQUEST AT A TIME. The API docs ask for it in as many words, so
       every call goes through a single queue with a minimum gap between
       requests. A caller that fires ten at once still makes ten in a row.
     • 429 IS NOT A FAILURE, IT IS A SPEED LIMIT. A rate-limited response
       parks the whole queue for a minute, which is what the docs ask for,
       and the call is retried once afterwards rather than thrown away.
     • NOTHING IS SCRAPED. Every path below appears in the official OpenAPI
       description at github.com/lichess-org/api. If a feature is not in
       there, it is not done here — see LICHESS.md for the list of things
       that had to be done differently because of that.

   Everything is public unless a token is passed. Tokens are never stored in
   this module; the caller hands one in per call.
   ═══════════════════════════════════════════════════════════════════════ */

export const LICHESS = 'https://lichess.org';

/* ── the queue ─────────────────────────────────────────────────────── */

const MIN_GAP = 250;          // ms between two requests, at the very least
const RATE_LIMIT_PARK = 61000; // what the docs ask for after a 429

let chain = Promise.resolve();
let nextAt = 0;
/* When lichess rate-limits us, everything waits until this moment. Exported
   through `health()` so the admin page can say so out loud. */
let parkedUntil = 0;
let lastError = null;
let lastOkAt = 0;
let errorCount = 0;
let callCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the sync page shows as the connection light. */
export function health() {
  const now = Date.now();
  return {
    state: parkedUntil > now ? 'degraded'
      : lastOkAt && now - lastOkAt < 10 * 60000 ? 'connected'
        : lastError ? 'offline' : 'unknown',
    parkedForMs: Math.max(0, parkedUntil - now),
    lastOkAt,
    lastError,
    errorCount,
    callCount
  };
}

export class LichessError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LichessError';
    this.status = status;
    this.body = body;
  }
}

/* A 429 or a 5xx is worth trying again; a 400 means we asked wrong. */
const retriable = (status) => status === 429 || status === 502 || status === 503 || status === 504;

/**
 * The one door out. Serializes, paces, retries and reports.
 *
 * @param {string} path      absolute path, e.g. '/api/team/coders'
 * @param {object} opts      { method, token, form, accept, signal, retries }
 * @returns {Promise<Response>}
 */
function request(path, opts = {}) {
  const run = async () => {
    const wait = Math.max(nextAt - Date.now(), parkedUntil - Date.now(), 0);
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + MIN_GAP;

    const headers = { Accept: opts.accept || 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;

    let body;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody(opts.form);
    } else if (opts.text != null) {
      headers['Content-Type'] = 'text/plain';
      body = opts.text;
    }

    const started = Date.now();
    callCount++;
    let res;
    try {
      res = await fetch(LICHESS + path, {
        method: opts.method || 'GET',
        headers,
        body,
        signal: opts.signal
      });
    } catch (e) {
      /* A network error and a CORS refusal look identical from here. Both
         mean "this call did not happen", which is all the caller needs. */
      errorCount++;
      lastError = { at: Date.now(), path, message: e.message || 'network error' };
      throw new LichessError('Could not reach lichess.org.', 0, null);
    }

    if (res.status === 429) {
      parkedUntil = Date.now() + RATE_LIMIT_PARK;
      errorCount++;
      lastError = { at: Date.now(), path, message: 'rate limited (429)' };
    }

    if (!res.ok) {
      if (retriable(res.status) && (opts.retries || 0) > 0) {
        return request(path, { ...opts, retries: opts.retries - 1 });
      }
      const text = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { /* not json, fine */ }
      if (res.status !== 429) {
        errorCount++;
        lastError = { at: Date.now(), path, message: `HTTP ${res.status}` };
      }
      throw new LichessError(
        (parsed && (parsed.error || parsed.message)) || `lichess returned ${res.status}`,
        res.status, parsed);
    }

    lastOkAt = Date.now();
    res.jagLatency = Date.now() - started;
    return res;
  };

  // every call joins the back of the same chain, whoever asked
  const next = chain.then(run, run);
  chain = next.then(() => {}, () => {});
  return next;
}

const formBody = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    p.set(k, typeof v === 'boolean' ? String(v) : String(v));
  });
  return p.toString();
};

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    p.set(k, String(v));
  });
  const s = p.toString();
  return s ? '?' + s : '';
};

const getJSON = async (path, opts) =>
  (await request(path, { ...opts, accept: 'application/json' })).json();

/* ── nd-json ───────────────────────────────────────────────────────── */

/**
 * Reads one of lichess's nd-json endpoints, calling `onLine` per object.
 *
 * Used two ways: for a finite list (team tournaments, results) where the
 * stream ends on its own, and for a live stream (the board) where it does
 * not. Both are the same code; the caller decides by passing an AbortSignal
 * and by what it does when the promise settles.
 */
export async function ndjson(path, onLine, opts = {}) {
  const res = await request(path, { ...opts, accept: 'application/x-ndjson' });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // the board stream sends a blank line every 7s to keep itself alive
      if (!line) continue;
      try { onLine(JSON.parse(line)); }
      catch (e) { console.warn('Unreadable nd-json line from ' + path, e); }
    }
  }
  const tail = buf.trim();
  if (tail) { try { onLine(JSON.parse(tail)); } catch (_) { /* truncated */ } }
}

/** The same, collected into an array. Only for endpoints that end. */
export async function ndjsonAll(path, opts = {}) {
  const out = [];
  await ndjson(path, (o) => out.push(o), opts);
  return out;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  OAUTH                                                              */
/* ═══════════════════════════════════════════════════════════════════ */

export const AUTHORIZE_URL = LICHESS + '/oauth';

export const exchangeToken = (form) =>
  getJSON('/api/token', { method: 'POST', form });

export const revokeToken = (token) =>
  request('/api/token', { method: 'DELETE', token }).then(() => true);

/**
 * What a token is actually allowed to do, straight from lichess — rather
 * than what we believe we asked for. The tokens go in the body, not the
 * header, because the endpoint tests other people's tokens too.
 *
 * @returns {Promise<{userId: string, scopes: string[], expires: number|null}|null>}
 */
export async function testToken(token) {
  const map = await getJSON('/api/token/test', { method: 'POST', text: token });
  const row = map && map[token];
  if (!row) return null;
  return {
    userId: row.userId,
    scopes: String(row.scopes || '').split(',').map((s) => s.trim()).filter(Boolean),
    expires: row.expires == null ? null : row.expires
  };
}

export const account = (token) => getJSON('/api/account', { token, retries: 1 });

/** Anybody's public profile, ratings included. No token. */
export const publicUser = (username) =>
  getJSON('/api/user/' + encodeURIComponent(username), { retries: 1 });

/* ═══════════════════════════════════════════════════════════════════ */
/*  TEAMS                                                              */
/* ═══════════════════════════════════════════════════════════════════ */

export const team = (teamId) =>
  getJSON('/api/team/' + encodeURIComponent(teamId), { retries: 2 });

/**
 * The teams a player belongs to.
 *
 * This one needs a token, whatever the published description implies: called
 * without an Authorization header lichess answers
 * `401 {"error":"Missing authorization header"}`. It does not need a *scope* —
 * any token will do — but it does need one, and forgetting that was the bug
 * that left the membership check spinning forever.
 */
export const teamsOf = (username, token) =>
  getJSON('/api/team/of/' + encodeURIComponent(username), { token, retries: 1 });

/**
 * The games the token's owner is playing right now.
 *
 * The fastest possible answer to "am I already in a game?" — one call, no
 * stream to wait for — which is what lets the tournament page send somebody
 * straight to their board instead of making them hunt for it.
 */
export const nowPlaying = (token) =>
  getJSON('/api/account/playing?nb=30', { token, retries: 1 });

export const teamArenas = (teamId, params) =>
  ndjsonAll('/api/team/' + encodeURIComponent(teamId) + '/arena' + qs(params), { retries: 1 });

export const teamSwiss = (teamId, params) =>
  ndjsonAll('/api/team/' + encodeURIComponent(teamId) + '/swiss' + qs(params), { retries: 1 });

/**
 * Joining a team through the official endpoint.
 *
 * This is the one call in the file that may be refused by the browser rather
 * than by lichess: /team/{id}/join sits outside /api/ and the official
 * description does not promise a CORS header for it. The caller must treat a
 * status-0 failure as "do it on lichess instead" and send the user to the
 * team page — never as an error worth showing. See LICHESS.md.
 */
export const joinTeam = (teamId, token, { message, password } = {}) =>
  getJSON('/team/' + encodeURIComponent(teamId) + '/join', {
    method: 'POST', token, form: { message, password }
  });

/* ═══════════════════════════════════════════════════════════════════ */
/*  ARENA TOURNAMENTS                                                  */
/* ═══════════════════════════════════════════════════════════════════ */

/** Full detail plus one page of standings. A token adds `verdicts`. */
export const arena = (id, { page = 1, token } = {}) =>
  getJSON('/api/tournament/' + encodeURIComponent(id) + qs({ page }), { token, retries: 2 });

export const arenaResults = (id, params) =>
  ndjsonAll('/api/tournament/' + encodeURIComponent(id) + '/results' + qs(params), { retries: 1 });

export const arenaGames = (id, onGame, params) =>
  ndjson('/api/tournament/' + encodeURIComponent(id) + '/games' +
    qs({ moves: true, clocks: true, tags: true, ...params }), onGame, { retries: 1 });

export const createArena = (token, form) =>
  getJSON('/api/tournament', { method: 'POST', token, form });

export const joinArena = (id, token, form) =>
  getJSON('/api/tournament/' + encodeURIComponent(id) + '/join', {
    method: 'POST', token, form: form || {}
  });

export const withdrawArena = (id, token) =>
  getJSON('/api/tournament/' + encodeURIComponent(id) + '/withdraw', { method: 'POST', token });

/* ═══════════════════════════════════════════════════════════════════ */
/*  SWISS TOURNAMENTS                                                  */
/* ═══════════════════════════════════════════════════════════════════ */

export const swiss = (id, { token } = {}) =>
  getJSON('/api/swiss/' + encodeURIComponent(id), { token, retries: 2 });

export const swissResults = (id, params) =>
  ndjsonAll('/api/swiss/' + encodeURIComponent(id) + '/results' + qs(params), { retries: 1 });

export const swissGames = (id, onGame, params) =>
  ndjson('/api/swiss/' + encodeURIComponent(id) + '/games' +
    qs({ moves: true, clocks: true, tags: true, ...params }), onGame, { retries: 1 });

export const createSwiss = (teamId, token, form) =>
  getJSON('/api/swiss/new/' + encodeURIComponent(teamId), { method: 'POST', token, form });

export const joinSwiss = (id, token, form) =>
  getJSON('/api/swiss/' + encodeURIComponent(id) + '/join', {
    method: 'POST', token, form: form || {}
  });

export const withdrawSwiss = (id, token) =>
  getJSON('/api/swiss/' + encodeURIComponent(id) + '/withdraw', { method: 'POST', token });

/* ═══════════════════════════════════════════════════════════════════ */
/*  GAMES                                                              */
/* ═══════════════════════════════════════════════════════════════════ */

export const exportGame = (gameId, params) =>
  getJSON('/game/export/' + encodeURIComponent(gameId) +
    qs({ moves: true, clocks: true, tags: true, ...params }), { retries: 1 });

/**
 * The public move stream for any ongoing game.
 *
 * Ongoing games are delayed by three moves on purpose — lichess does that to
 * stop cheat bots, and it applies to every third-party client including this
 * one. Spectators see a slightly old position and that is correct behavior,
 * not a bug to work around.
 */
export const streamGame = (gameId, onLine, signal) =>
  ndjson('/api/stream/game/' + encodeURIComponent(gameId), onLine, { signal });

/* ═══════════════════════════════════════════════════════════════════ */
/*  BOARD API — playing from here                                      */
/* ═══════════════════════════════════════════════════════════════════ */

/* Only one event stream may be open per token: opening a second one closes
   the first. lichess-board.js owns that rule. */
export const streamEvents = (token, onLine, signal) =>
  ndjson('/api/stream/event', onLine, { token, signal });

export const streamBoardGame = (gameId, token, onLine, signal) =>
  ndjson('/api/board/game/stream/' + encodeURIComponent(gameId), onLine, { token, signal });

export const boardMove = (gameId, uci, token, offeringDraw) =>
  getJSON('/api/board/game/' + encodeURIComponent(gameId) + '/move/' + encodeURIComponent(uci) +
    qs({ offeringDraw: offeringDraw || undefined }), { method: 'POST', token });

export const boardResign = (gameId, token) =>
  getJSON('/api/board/game/' + encodeURIComponent(gameId) + '/resign', { method: 'POST', token });

export const boardDraw = (gameId, token, accept) =>
  getJSON('/api/board/game/' + encodeURIComponent(gameId) + '/draw/' + (accept ? 'yes' : 'no'),
    { method: 'POST', token });

export const boardBerserk = (gameId, token) =>
  getJSON('/api/board/game/' + encodeURIComponent(gameId) + '/berserk', { method: 'POST', token });

export const boardClaimVictory = (gameId, token) =>
  getJSON('/api/board/game/' + encodeURIComponent(gameId) + '/claim-victory',
    { method: 'POST', token });

/* ═══════════════════════════════════════════════════════════════════ */
/*  SHAPES                                                             */
/* ═══════════════════════════════════════════════════════════════════ */

/** A lichess team id out of whatever the admin pasted in. */
export function parseTeamId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const m = /lichess\.org\/team\/([A-Za-z0-9_-]+)/i.exec(raw);
  if (m) return m[1];
  // a bare id, which is what the last part of a team URL is
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

export const teamUrl = (teamId) => LICHESS + '/team/' + encodeURIComponent(teamId);
export const tournamentUrl = (kind, id) =>
  LICHESS + (kind === 'swiss' ? '/swiss/' : '/tournament/') + encodeURIComponent(id);
export const gameUrl = (id) => LICHESS + '/' + encodeURIComponent(id);
export const userUrl = (name) => LICHESS + '/@/' + encodeURIComponent(name);

/* lichess numbers arena status; these are the names it uses for them. */
export const ARENA_STATUS = { 10: 'created', 20: 'started', 30: 'finished' };
export const SWISS_STATUS = { created: 'created', started: 'started', finished: 'finished' };
