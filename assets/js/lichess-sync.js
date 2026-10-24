/* ═══════════════════════════════════════════════════════════════════════
   lichess-sync.js — the worker that watches lichess and fills the database.

   The architecture lichess asks for is:

       lichess APIs → one sync worker → a database → many readers

   JagChess has no server, so the worker runs in a browser — but it is still
   ONE worker. A single Firestore document is a lease; whichever tab holds it
   does the polling and everybody else reads what it wrote. That is the whole
   reason this file exists rather than each page fetching for itself, and it
   is what keeps the site inside the API's "one request at a time" rule no
   matter how many people have it open.

   Everything the worker reads is public. A token is only used where lichess
   requires one, and only the lease-holder's own token, never anybody else's.

   ─── cadence ───────────────────────────────────────────────────────────
     team listing        every `syncEverySec` (5 minutes by default)
     live tournament     every 10s for the detail, every 30s for standings
     starting soon       every 30s
     scheduled, later    every 5 minutes
     just finished       one archive pass, then never again

   ─── failure ───────────────────────────────────────────────────────────
   A failed call is logged, counted against the team or tournament, and
   retried on the next tick. Backoff is handled inside lichess-api.js, which
   parks every request for a minute after a 429. Nothing here throws upward:
   a site that cannot reach lichess shows stale data with a timestamp, which
   is the correct behaviour, not a broken page.
   ═══════════════════════════════════════════════════════════════════════ */

import * as api from './lichess-api.js';
import * as store from './lichess-store.js';
import { updateDoc, setDoc, getDocs } from './club-core.js';

const now = () => Date.now();
const secs = (n) => n * 1000;

/* how stale each kind of thing is allowed to get */
const EVERY = {
  liveDetail: secs(10),
  liveStandings: secs(12),
  soon: secs(30),
  soonWindow: secs(600),      // "starting soon" means within ten minutes
  scheduled: secs(300),
  finishedGrace: secs(120)    // wait this long after the end before archiving
};

const TICK = secs(6);

/* ── one tab's worker ──────────────────────────────────────────────── */

/**
 * Starts the worker for one scope (the whole site, or one club).
 *
 * @param {object} ctx      the JagChess context
 * @param {object} [opts]   { onState } — called with a health object each tick
 * @returns {Function}      stop
 */
export function startSync(ctx, opts = {}) {
  const key = store.scopeKey(ctx);
  const holder = ctx.user.uid + ':' + Math.random().toString(36).slice(2, 8);

  let stopped = false;
  let running = false;
  let leader = false;
  let lastTrim = 0;
  const state = { leader: false, lastTickAt: 0, lastWorkAt: 0, errors: 0 };

  /* The worker needs to know what exists every few seconds. Reading the
     collections on each tick would be a hundred Firestore reads a minute for
     nothing, so it subscribes once and works from what the listeners hand
     it — the same documents it is itself writing, so they stay current. */
  let teams = [];
  let rows = [];
  const feeds = [
    store.watchTeams(ctx, (r) => { teams = r; }),
    store.watchTournaments(ctx, (r) => { rows = r; })
  ];

  const report = () => { if (opts.onState) opts.onState({ ...state, ...api.health() }); };

  async function tick() {
    if (stopped || running) return;
    /* A hidden tab is a tab whose owner is not watching. It keeps its lease
       if it has one — dropping it every time someone switches tabs would
       make the lease useless — but it does not go looking for new work. */
    if (document.hidden && !leader) return;

    running = true;
    try {
      leader = await store.claimLease(key, holder);
      state.leader = leader;
      state.lastTickAt = now();
      if (!leader) return;

      const worked = await runDueWork(ctx, teams, rows);
      if (worked) state.lastWorkAt = now();

      if (now() - lastTrim > secs(600)) {
        lastTrim = now();
        store.trimSyncLog(ctx);
      }
    } catch (e) {
      state.errors++;
      console.warn('Lichess sync tick failed', e);
    } finally {
      running = false;
      report();
    }
  }

  const timer = setInterval(tick, TICK);
  tick();

  const onVisible = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    feeds.forEach((f) => { try { f(); } catch (_) {} });
    if (leader) store.releaseLease(key, holder);
  };
}

/* ── deciding what is due ──────────────────────────────────────────── */

/** @returns {Promise<boolean>} whether anything was actually synced */
async function runDueWork(ctx, teams, rows) {
  let did = false;

  for (const team of teams) {
    if (!team.monitoring) continue;
    if (now() - (team.lastSyncAt || 0) < secs(team.syncEverySec || 300)) continue;
    await syncTeam(ctx, team);
    did = true;
    // one team per tick keeps the request rate flat rather than spiky
    break;
  }

  const due = rows.filter((t) => dueAt(t) <= now());
  /* Live tournaments first — a finished one waiting to be archived can wait
     another six seconds, a game in progress cannot. */
  due.sort((a, b) => rank(a) - rank(b) || (dueAt(a) - dueAt(b)));

  for (const t of due.slice(0, 2)) {
    await syncTournament(ctx, t);
    did = true;
  }
  return did;
}

const rank = (t) => (t.status === 'started' ? 0 : t.status === 'created' ? 1 : 2);

/** The next moment a tournament is worth asking lichess about. */
export function dueAt(t) {
  if (t.archived) return Infinity;
  const last = t.lastSyncedAt || 0;
  if (t.status === 'unavailable') return last + secs(1800);
  if (t.status === 'finished') {
    /* Counted from when we SAW it finish, not from when it was scheduled to:
       an arena terminated early has a finish time in the future, and waiting
       for that would leave it unarchived for hours. */
    const seen = t.finishedSeenAt || t.lastSyncedAt || 0;
    return Math.max(last + secs(15), seen + EVERY.finishedGrace);
  }
  if (t.status === 'started') return last + EVERY.liveDetail;
  const until = (t.startsAt || 0) - now();
  return last + (until < EVERY.soonWindow ? EVERY.soon : EVERY.scheduled);
}

/* ── the foreground poller ─────────────────────────────────────────── */

/*  The lease worker exists so that a hundred idle tabs do not each poll
    lichess. It is the wrong tool for the tab somebody is actually looking
    at: there, a ten-second lag reads as the site being broken, and the
    person is sitting in front of it waiting.

    So an open tournament page drives its own refresh, on top of the lease
    worker and independently of it. One visible page, one request every few
    seconds, through the same globally-serialized queue as everything else —
    which is roughly what lichess's own tournament page does over its socket,
    and well inside what the API asks for. It stops the moment the tab is
    hidden or the page is closed.                                          */

const FOCUS_EVERY = {
  running: secs(4),
  starting: secs(5),
  finished: secs(6),
  soon: secs(8),
  scheduled: secs(30)
};

function focusInterval(t) {
  /* Nothing yet: check back quickly, because the row is about to arrive
     from Firestore and the real pace follows from its status. */
  if (!t) return secs(2);
  if (t.archived) return 0;                       // it can never change again
  if (t.status === 'finished') return FOCUS_EVERY.finished;
  if (t.status === 'started') return FOCUS_EVERY.running;
  /* A tournament lichess has lost is worth retrying while somebody is
     watching the page, just not often. */
  if (t.status === 'unavailable') return secs(60);
  const until = (t.startsAt || 0) - now();
  if (until <= 0) return FOCUS_EVERY.starting;
  return until < EVERY.soonWindow ? FOCUS_EVERY.soon : FOCUS_EVERY.scheduled;
}

/**
 * Keeps one tournament fresh for as long as somebody is looking at it.
 *
 * @param {object} ctx
 * @param {() => object|null} getRow   the current stored row, read fresh each
 *                                     time so the pace follows the status
 * @returns {{stop: Function, now: Function}}  `now()` forces a refresh
 */
export function focusTournament(ctx, getRow) {
  let stopped = false;
  let busy = false;
  let timer = null;

  async function beat(force) {
    if (stopped || busy) return;
    const t = getRow();
    /* Archived beats everything, including an explicit Refresh: there is
       nothing left on lichess that could differ from what we hold. */
    if (t && t.archived) return;
    if (!t) { schedule(); return; }
    /* A hidden tab is nobody watching. It stops entirely rather than
       spinning a timer, and the visibility listener starts it again. */
    if (!force && document.hidden) return;

    busy = true;
    try { await syncTournament(ctx, t); }
    catch (e) { console.warn('Could not refresh the tournament', e); }
    finally { busy = false; schedule(); }
  }

  function schedule() {
    if (stopped || document.hidden) return;
    clearTimeout(timer);
    const gap = focusInterval(getRow());
    if (!gap) return;
    timer = setTimeout(() => beat(false), gap);
  }

  const onVisible = () => { if (!document.hidden) beat(false); };
  document.addEventListener('visibilitychange', onVisible);

  beat(false);

  return {
    now: () => beat(true),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/* ── a team ────────────────────────────────────────────────────────── */

/**
 * Asks lichess what tournaments a team has, and writes the ones it does not
 * already know about. Safe to call by hand from the admin page.
 */
export async function syncTeam(ctx, team) {
  const started = now();
  let found = 0;
  try {
    /* Both kinds, because a team can run either and the spec is explicit
       that we must not assume which. Arenas first: they are the common case. */
    /* The listing is the only endpoint that reports a team entry condition,
       so it is marked as such: its silence about `teamMember` means the
       tournament really is open to everyone. See shapeArena. */
    const arenas = await api.teamArenas(team.teamId, { max: 30 });
    for (const a of arenas) {
      await store.upsertTournament(store.shapeArena(a, team, {}, { source: 'listing' }));
      found++;
    }

    let swisses = [];
    try {
      swisses = await api.teamSwiss(team.teamId, { max: 30 });
    } catch (e) {
      // a team with no swiss tournaments is not an error worth recording
      if (!e || e.status !== 404) throw e;
    }
    for (const sw of swisses) {
      await store.upsertTournament(store.shapeSwiss(sw, team, { teamId: team.teamId }));
      found++;
    }

    await updateDoc(store.teamRef(team.key), {
      lastSyncAt: now(), lastSyncOk: true, lastError: null, tournamentCount: found
    }).catch(() => {});

    await store.logSync({
      scope: team.scope, clubId: team.clubId, teamId: team.teamId,
      action: 'team.tournaments', endpoint: `/api/team/${team.teamId}/arena+swiss`,
      ok: true, ms: now() - started, status: 200
    });
    return found;
  } catch (e) {
    await updateDoc(store.teamRef(team.key), {
      lastSyncAt: now(), lastSyncOk: false,
      lastError: { at: now(), message: e.message || String(e), status: e.status || 0 }
    }).catch(() => {});
    await store.logSync({
      scope: team.scope, clubId: team.clubId, teamId: team.teamId,
      action: 'team.tournaments', endpoint: `/api/team/${team.teamId}/arena+swiss`,
      ok: false, ms: now() - started, status: e.status || 0, error: e.message
    });
    return 0;
  }
}

/** Validates a team id or URL against lichess and hands back its metadata. */
export async function validateTeam(input) {
  const id = api.parseTeamId(input);
  if (!id) throw new Error('That does not look like a lichess team id or team URL.');
  try {
    return await api.team(id);
  } catch (e) {
    if (e.status === 404) throw new Error(`Lichess has no team called “${id}”.`);
    throw e;
  }
}

/* ── one tournament ────────────────────────────────────────────────── */

export async function syncTournament(ctx, t) {
  return t.kind === 'swiss' ? syncSwiss(ctx, t) : syncArena(ctx, t);
}

async function syncArena(ctx, t) {
  const started = now();
  const teamRow = {
    teamId: t.teamId, name: t.teamName, key: t.teamKey,
    scope: t.scope, clubId: t.clubId, clubName: t.clubName
  };
  try {
    /* The detail endpoint cannot see a `teamMember` condition at all, so it
       is marked as such and upsertTournament keeps what the listing said. */
    const full = await api.arena(t.lichessId, { page: 1 });
    const shape = store.shapeArena(full, teamRow, {}, { source: 'detail' });
    await store.upsertTournament(shape);

    /* The duels list is the live-games view: it is the only thing the arena
       endpoint says about games in progress. */
    for (const d of (full.duels || []).slice(0, 40)) {
      await store.upsertGame(t.lichessId, store.shapeDuel(d, { tournamentId: t.lichessId }));
    }
    if (full.featured && full.featured.id) {
      await store.upsertGame(t.lichessId, {
        ...store.shapeDuel({ id: full.featured.id, p: [] }, { tournamentId: t.lichessId }),
        white: { username: full.featured.white.name, rating: full.featured.white.rating || null, rank: full.featured.white.rank || null },
        black: { username: full.featured.black.name, rating: full.featured.black.rating || null, rank: full.featured.black.rank || null },
        colorsKnown: true,
        featured: true,
        fen: full.featured.fen || null,
        lastMove: full.featured.lastMove || null,
        clockSeconds: full.featured.c || null
      });
    }

    /* Standings are a separate, heavier call, so they run on their own
       slower clock rather than with every detail refresh. */
    const stale = now() - (t.standingsAt || 0) > EVERY.liveStandings;
    if (stale || shape.status === 'finished') {
      await syncStandings(t.lichessId, 'arena', shape.status === 'finished' ? 200 : 100);
      await updateDoc(store.tournRef(t.lichessId), { standingsAt: now() }).catch(() => {});
    } else if (full.standing && full.standing.players) {
      // the cheap top-of-the-table refresh that came free with the detail call
      await writeParticipants(t.lichessId, full.standing.players);
    }

    if (shape.status === 'finished') await archive(ctx, { ...t, ...shape });

    await store.logSync({
      scope: t.scope, clubId: t.clubId, teamId: t.teamId, tournamentId: t.lichessId,
      action: 'arena.sync', endpoint: `/api/tournament/${t.lichessId}`,
      ok: true, ms: now() - started, status: 200
    });
    return true;
  } catch (e) {
    await onTournamentError(t, e, `/api/tournament/${t.lichessId}`, 'arena.sync', started);
    return false;
  }
}

async function syncSwiss(ctx, t) {
  const started = now();
  const teamRow = {
    teamId: t.teamId, name: t.teamName, key: t.teamKey,
    scope: t.scope, clubId: t.clubId, clubName: t.clubName
  };
  try {
    const full = await api.swiss(t.lichessId);
    const shape = store.shapeSwiss(full, teamRow, { teamId: t.teamId });
    await store.upsertTournament(shape);

    const stale = now() - (t.standingsAt || 0) > EVERY.liveStandings;
    if (stale || shape.status === 'finished') {
      await syncStandings(t.lichessId, 'swiss', shape.status === 'finished' ? 200 : 100);
      await updateDoc(store.tournRef(t.lichessId), { standingsAt: now() }).catch(() => {});
    }

    if (shape.status === 'finished') await archive(ctx, { ...t, ...shape });

    await store.logSync({
      scope: t.scope, clubId: t.clubId, teamId: t.teamId, tournamentId: t.lichessId,
      action: 'swiss.sync', endpoint: `/api/swiss/${t.lichessId}`,
      ok: true, ms: now() - started, status: 200
    });
    return true;
  } catch (e) {
    await onTournamentError(t, e, `/api/swiss/${t.lichessId}`, 'swiss.sync', started);
    return false;
  }
}

async function onTournamentError(t, e, endpoint, action, started) {
  /* A 404 means the tournament is gone from lichess — deleted, or never
     public. That is a state, not a failure, and the page should say so. */
  if (e && e.status === 404) {
    await store.markUnavailable(t.lichessId, 'Lichess no longer has this tournament.');
  } else {
    await updateDoc(store.tournRef(t.lichessId), {
      lastSyncedAt: now(),
      lastError: { at: now(), message: e.message || String(e), status: e.status || 0 }
    }).catch(() => {});
  }
  await store.logSync({
    scope: t.scope, clubId: t.clubId, teamId: t.teamId, tournamentId: t.lichessId,
    action, endpoint, ok: false, ms: now() - started, status: (e && e.status) || 0,
    error: e && e.message
  });
}

/* ── standings ─────────────────────────────────────────────────────── */

async function syncStandings(id, kind, nb) {
  const rows = kind === 'swiss'
    ? await api.swissResults(id, { nb })
    : await api.arenaResults(id, { nb });
  await writeParticipants(id, rows);
  return rows.length;
}

async function writeParticipants(id, rows) {
  await Promise.all(rows.map((p) => {
    const shaped = store.shapeParticipant(p);
    if (!shaped.userId) return null;
    return setDoc(store.partRef(id, shaped.userId), shaped, { merge: true }).catch(() => {});
  }));
}

/* ── archiving ─────────────────────────────────────────────────────── */

/*  A finished tournament is pulled down once, in full, and then left alone.
    That is the moment the site stops depending on lichess for it: the games,
    the moves, the standings and the podium are ours to serve from then on.  */

async function archive(ctx, t) {
  if (t.archived) return;
  const ended = t.finishesAt || t.startsAt || 0;
  if (ended && now() - ended < EVERY.finishedGrace) return;

  const started = now();
  try {
    let count = 0;
    const onGame = async (g) => {
      count++;
      if (count > 400) return;   // a cap, so one enormous arena cannot run away
      await store.upsertGame(t.lichessId, store.shapeGame(g, { tournamentId: t.lichessId }));
    };

    /* The export is streamed and throttled by lichess, so this is one long
       call rather than many short ones — exactly what it is designed for. */
    const pending = [];
    if (t.kind === 'swiss') {
      await api.swissGames(t.lichessId, (g) => pending.push(onGame(g)));
    } else {
      await api.arenaGames(t.lichessId, (g) => pending.push(onGame(g)));
    }
    await Promise.all(pending);

    const calc = await tallyFromGames(t.lichessId);

    const patch = {
      archived: true,
      archivedAt: now(),
      gameCount: Math.min(count, 400),
      calcFrom: 'lichess game export',
      lastSyncedAt: now()
    };

    /* An arena hands us a podium; a Swiss does not, so the top of its final
       standings becomes one. Both are lichess's own ranking either way. */
    if (!t.podium || !t.podium.length) {
      const top = await topThree(t.lichessId);
      if (top.length) patch.podium = top;
    }

    await updateDoc(store.tournRef(t.lichessId), patch).catch(() => {});

    await store.logSync({
      scope: t.scope, clubId: t.clubId, teamId: t.teamId, tournamentId: t.lichessId,
      action: 'archive', endpoint: `/api/${t.kind === 'swiss' ? 'swiss' : 'tournament'}/${t.lichessId}/games`,
      ok: true, ms: now() - started, status: 200
    });
    return calc;
  } catch (e) {
    await store.logSync({
      scope: t.scope, clubId: t.clubId, teamId: t.teamId, tournamentId: t.lichessId,
      action: 'archive', endpoint: 'games', ok: false,
      ms: now() - started, status: (e && e.status) || 0, error: e && e.message
    });
    // not archived: the next tick tries again
  }
}

/** The first three rows of the final standings, as lichess ranked them. */
async function topThree(id) {
  const snap = await getDocs(store.partsCol(id)).catch(() => null);
  if (!snap) return [];
  const rows = [];
  snap.forEach((d) => rows.push(d.data()));
  return rows
    .filter((p) => p.rank)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((p) => ({
      rank: p.rank,
      username: p.username,
      rating: p.rating || null,
      score: p.score || 0,
      performance: p.performance || null,
      games: (p.calc && p.calc.games) || 0,
      wins: (p.calc && p.calc.wins) || 0,
      berserks: (p.calc && p.calc.berserks) || 0
    }));
}

/**
 * Win / draw / loss per player, worked out from the games we stored.
 *
 * These are OUR numbers, not lichess's — lichess gives score, rank and
 * performance but not a record — so they are written under `calc` and the
 * standings table labels the column accordingly.
 */
export async function tallyFromGames(id) {
  const rows = [];
  const snap = await getDocs(store.gamesCol(id));
  snap.forEach((d) => rows.push(d.data()));

  const tally = new Map();
  const bump = (name, field) => {
    const k = String(name || '').toLowerCase();
    if (!k || k === 'anonymous') return;
    const cur = tally.get(k) || { wins: 0, draws: 0, losses: 0, games: 0, berserks: 0, name };
    cur[field]++;
    cur.games++;
    tally.set(k, cur);
  };

  for (const g of rows) {
    if (g.state !== store.GAME_STATE.FINISHED || !g.colorsKnown) continue;
    const w = g.white || {}, b = g.black || {};
    if (g.winner === 'white') { bump(w.username, 'wins'); bump(b.username, 'losses'); }
    else if (g.winner === 'black') { bump(b.username, 'wins'); bump(w.username, 'losses'); }
    else { bump(w.username, 'draws'); bump(b.username, 'draws'); }
    if (w.berserk) { const c = tally.get(String(w.username || '').toLowerCase()); if (c) c.berserks++; }
    if (b.berserk) { const c = tally.get(String(b.username || '').toLowerCase()); if (c) c.berserks++; }
  }

  await Promise.all([...tally.entries()].map(([userId, c]) =>
    setDoc(store.partRef(id, userId), {
      userId,
      username: c.name,
      calc: { wins: c.wins, draws: c.draws, losses: c.losses, games: c.games, berserks: c.berserks },
      calcAt: now()
    }, { merge: true }).catch(() => {})));

  return tally;
}

/* ── manual triggers, for the admin page ───────────────────────────── */

export async function syncNow(ctx, team) {
  const found = await syncTeam(ctx, team);
  const rows = (await store.listTournaments(ctx))
    .filter((t) => t.teamId === team.teamId && !t.archived)
    .sort((a, b) => (b.startsAt || 0) - (a.startsAt || 0))
    .slice(0, 5);
  for (const t of rows) await syncTournament(ctx, t);
  return found;
}

export const refreshTournament = (ctx, t) => syncTournament(ctx, t);
