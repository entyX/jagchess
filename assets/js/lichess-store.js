/* ═══════════════════════════════════════════════════════════════════════
   lichess-store.js — where the lichess integration keeps what it learns.

     lichessTeams/{key}                        a monitored team
     lichessTournaments/{lichessId}            one detected tournament
       …/participants/{userId}                 standings row per player
       …/games/{gameId}                        one game, live or finished
     lichessSyncEvents/{auto}                  the sync log the admin page reads
     lichessSync/{scopeKey}                    which tab is currently syncing
     lichessAccounts/{uid}                     a JagChess user's lichess link

   Two identifiers do all the work, and they are lichess's own:

     • the TEAM ID is the last part of a team URL;
     • the TOURNAMENT ID is the document id, which is what makes a second
       sync of the same tournament an update rather than a duplicate. The
       same rule holds for participants (keyed by lichess user id) and games
       (keyed by lichess game id).

   Nothing here calls lichess. Nothing here paints. It is the shapes, the
   paths, and the merge rules — so that "did the sync write this or did we
   work it out ourselves" has one answer per field, written down.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, runTransaction
} from './club-core.js';

import { ARENA_STATUS, teamUrl, tournamentUrl } from './lichess-api.js';

/* ── paths ─────────────────────────────────────────────────────────── */

export const teamsCol = () => collection(db, 'lichessTeams');
export const teamRef = (key) => doc(db, 'lichessTeams', key);

export const tournCol = () => collection(db, 'lichessTournaments');
export const tournRef = (id) => doc(db, 'lichessTournaments', id);
export const partsCol = (id) => collection(db, 'lichessTournaments', id, 'participants');
export const partRef = (id, userId) => doc(db, 'lichessTournaments', id, 'participants', userId);
export const gamesCol = (id) => collection(db, 'lichessTournaments', id, 'games');
export const gameRef = (id, gameId) => doc(db, 'lichessTournaments', id, 'games', gameId);

export const eventsCol = () => collection(db, 'lichessSyncEvents');
export const leaseRef = (key) => doc(db, 'lichessSync', key);
export const accountRef = (uid) => doc(db, 'lichessAccounts', uid);

/**
 * A monitored team belongs either to the whole site or to one club, and the
 * same lichess team may legitimately be watched by both. The key carries the
 * scope so those two are separate rows rather than one that fights itself.
 */
export const teamKey = (scope, clubId, teamId) =>
  scope === 'club' ? `club_${clubId}__${teamId}` : `global__${teamId}`;

/** The lease key for a sync scope — one syncing tab per scope, not per team. */
export const scopeKey = (ctx) => (ctx && ctx.clubId ? 'club_' + ctx.clubId : 'global');

/* ── teams ─────────────────────────────────────────────────────────── */

/**
 * Writes a validated lichess team into the list of monitored teams.
 *
 * @param {object} ctx      the JagChess context (clubId null outside a club)
 * @param {object} t        the team as lichess described it
 * @param {object} opts     { syncEverySec }
 */
export async function addTeam(ctx, t, opts = {}) {
  const scope = ctx.clubId ? 'club' : 'global';
  const key = teamKey(scope, ctx.clubId, t.id);
  const existing = await getDoc(teamRef(key)).catch(() => null);

  const row = {
    key,
    teamId: t.id,
    name: t.name || t.id,
    url: teamUrl(t.id),
    description: t.description || '',
    flair: t.flair || null,
    nbMembers: t.nbMembers || 0,
    open: !!t.open,
    leaders: (t.leaders || []).map((l) => l.name || l.id).slice(0, 8),
    scope,
    clubId: ctx.clubId || null,
    clubName: (ctx.club && ctx.club.name) || null,
    monitoring: true,
    syncEverySec: Math.max(60, opts.syncEverySec || 300),
    addedAt: (existing && existing.exists() && existing.data().addedAt) || Date.now(),
    addedBy: {
      uid: ctx.user.uid,
      username: (ctx.member && ctx.member.username) || (ctx.user.email || '').split('@')[0] || 'admin'
    },
    lastSyncAt: (existing && existing.exists() && existing.data().lastSyncAt) || 0,
    lastSyncOk: null,
    lastError: null,
    tournamentCount: (existing && existing.exists() && existing.data().tournamentCount) || 0,
    updatedAt: Date.now()
  };
  await setDoc(teamRef(key), row, { merge: true });
  return row;
}

export const setTeamMonitoring = (key, on) =>
  updateDoc(teamRef(key), { monitoring: !!on, updatedAt: Date.now() });

export const setTeamInterval = (key, sec) =>
  updateDoc(teamRef(key), { syncEverySec: Math.max(60, sec | 0), updatedAt: Date.now() });

/**
 * Stops watching a team. The tournaments it already produced are kept —
 * they are the history, and they are not the team's to take away.
 */
export const removeTeam = (key) => deleteDoc(teamRef(key));

export const watchTeams = (ctx, cb) => {
  const q = ctx && ctx.clubId
    ? query(teamsCol(), where('clubId', '==', ctx.clubId), limit(50))
    : query(teamsCol(), where('scope', '==', 'global'), limit(50));
  return onSnapshot(q,
    (s) => cb(s.docs.map((d) => ({ key: d.id, ...d.data() }))),
    (e) => console.warn('Lichess team listener stopped', e));
};

export async function listTeams(ctx) {
  const q = ctx && ctx.clubId
    ? query(teamsCol(), where('clubId', '==', ctx.clubId), limit(50))
    : query(teamsCol(), where('scope', '==', 'global'), limit(50));
  const s = await getDocs(q);
  return s.docs.map((d) => ({ key: d.id, ...d.data() }));
}

/* ── tournaments ───────────────────────────────────────────────────── */

/* A value lichess did not mention is left out of the write entirely, because
   every write is a merge: a key set to null would erase what the other
   endpoint told us, and the two endpoints do not answer the same questions.
   This is the difference between "lichess says no" and "lichess did not say". */
const prune = (o) => {
  Object.keys(o).forEach((k) => { if (o[k] === undefined) delete o[k]; });
  return o;
};

/**
 * Turns a lichess arena into the shape this site stores.
 *
 * TWO ENDPOINTS FEED THIS, AND THEY DISAGREE — which is the single most
 * important thing to know about this function:
 *
 *   GET /api/team/{id}/arena   the LISTING. Numeric `status`, numeric
 *                              `startsAt`, `finishesAt`, and — the reason it
 *                              matters — `teamMember`, the team a player must
 *                              belong to. This is the ONLY endpoint that
 *                              reports that, so its silence is an answer:
 *                              no `teamMember` means no team requirement.
 *
 *   GET /api/tournament/{id}   the DETAIL. No `status` (just `isFinished`),
 *                              an ISO-8601 `startsAt`, no `finishesAt`, no
 *                              `teamMember` at all — and the standings, the
 *                              duels, the podium and the description.
 *
 * So `source` says which one is talking, and a detail refresh is not allowed
 * to conclude that a team-restricted tournament is open to everybody.
 *
 * Everything below comes from lichess except the fields `ourFields` adds.
 *
 * @param {object} a
 * @param {object} team
 * @param {object} [extra]
 * @param {{source?: 'listing'|'detail'}} [opts]
 */
export function shapeArena(a, team, extra = {}, opts = {}) {
  const fromListing = opts.source !== 'detail';
  const clock = a.clock || {};
  const startsAt = typeof a.startsAt === 'string' ? Date.parse(a.startsAt) : (a.startsAt || 0);

  /* The listing numbers its statuses; the detail does not have the field at
     all, so it is worked out from what the detail does say. */
  const status = a.status != null
    ? (ARENA_STATUS[a.status] || 'created')
    : a.isFinished ? 'finished'
      : (startsAt && Date.now() < startsAt) ? 'created'
        : 'started';

  const finishesAt = a.finishesAt
    || (startsAt && a.minutes ? startsAt + a.minutes * 60000 : undefined);

  /* Two different ways a lichess arena can be restricted to a team, and they
     are not the same thing: `teamMember` is a plain entry condition, while a
     team battle needs membership of one of the competing teams. Guessing
     wrong here is exactly the mistake that tells a player to join a team
     they do not need, so both are read, and neither is inferred. */
  const battleTeams = (a.teamBattle && a.teamBattle.teams) || null;
  const requiredTeamId = a.teamMember
    || (a.conditions && a.conditions.teamMember && a.conditions.teamMember.teamId)
    || (fromListing ? null : undefined);

  const conditions = prune({
    minRating: (a.minRating && a.minRating.rating) || undefined,
    maxRating: (a.maxRating && a.maxRating.rating) || undefined,
    minRatedGames: (a.minRatedGames && a.minRatedGames.nb) || undefined,
    minAccountAgeInDays: a.minAccountAgeInDays || undefined,
    onlyTitled: a.onlyTitled != null ? !!a.onlyTitled : undefined,
    botsAllowed: a.botsAllowed != null ? !!a.botsAllowed : undefined,
    allowList: a.allowList || undefined
  });

  return prune({
    lichessId: a.id,
    kind: 'arena',
    source: 'lichess',

    name: a.fullName || a.name || a.id,
    fullName: a.fullName || a.name || a.id,
    description: a.description || undefined,
    createdBy: a.createdBy || undefined,
    url: tournamentUrl('arena', a.id),

    status,
    startsAt,
    finishesAt,
    durationMin: a.minutes || undefined,

    clock: { limit: clock.limit || 0, increment: clock.increment || 0 },
    variant: typeof a.variant === 'string' ? a.variant : ((a.variant && a.variant.key) || 'standard'),
    rated: !!a.rated,
    berserkable: a.berserkable != null ? !!a.berserkable : undefined,
    position: (a.position && (a.position.fen || a.position.name)) || undefined,
    private: a.private != null ? !!a.private : undefined,
    perf: (a.perf && a.perf.key) || undefined,

    /* membershipRequired is not set here on purpose — it is derived from the
       merged document in upsertTournament, because neither endpoint on its
       own knows both halves of the answer. */
    requiredTeamId,
    teamBattleTeams: battleTeams,
    conditions: Object.keys(conditions).length ? conditions : undefined,

    nbPlayers: a.nbPlayers != null ? a.nbPlayers : undefined,
    winner: (a.winner && (a.winner.name || a.winner.id)) || undefined,
    stats: a.stats || undefined,
    podium: (a.podium && a.podium.length) ? a.podium.map((p, i) => ({
      rank: p.rank || i + 1,
      username: p.name,
      rating: p.rating || null,
      score: p.score || 0,
      performance: p.performance || null,
      games: (p.nb && p.nb.game) || 0,
      wins: (p.nb && p.nb.win) || 0,
      berserks: (p.nb && p.nb.berserk) || 0
    })) : undefined,

    ...ourFields(team, extra)
  });
}

/** The Swiss equivalent. Swiss tournaments on lichess always belong to a team. */
export function shapeSwiss(sw, team, extra = {}) {
  const clock = sw.clock || {};
  return prune({
    lichessId: sw.id,
    kind: 'swiss',
    source: 'lichess',

    name: sw.name || sw.id,
    fullName: sw.name || sw.id,
    description: sw.description || undefined,
    createdBy: sw.createdBy || undefined,
    url: tournamentUrl('swiss', sw.id),

    status: sw.status || 'created',
    startsAt: typeof sw.startsAt === 'string' ? Date.parse(sw.startsAt) : (sw.startsAt || 0),
    finishesAt: null,
    durationMin: null,
    nextRoundAt: (sw.nextRound && sw.nextRound.at) ? Date.parse(sw.nextRound.at) : null,

    clock: { limit: clock.limit || 0, increment: clock.increment || 0 },
    variant: sw.variant || 'standard',
    rated: sw.rated !== false,
    berserkable: false,
    private: false,

    /* A swiss lives inside a team and only its members may enter — that is
       how lichess builds them, so it is never guesswork here. */
    membershipRequired: true,
    requiredTeamId: (extra && extra.teamId) || (team && team.teamId) || null,
    teamBattleTeams: null,
    conditions: {},

    round: sw.round || 0,
    nbRounds: sw.nbRounds || 0,
    nbPlayers: sw.nbPlayers || 0,
    nbOngoing: sw.nbOngoing || 0,
    stats: sw.stats || undefined,

    ...ourFields(team, extra)
  });
}

/* The handful of fields that are ours rather than lichess's. Anything the
   page labels "calculated by JagChess" comes from in here. */
const ourFields = (team, extra) => ({
  teamId: (team && team.teamId) || null,
  teamName: (team && team.name) || null,
  teamKey: (team && team.key) || null,
  scope: (team && team.scope) || 'global',
  clubId: (team && team.clubId) || null,
  clubName: (team && team.clubName) || null,
  lastSyncedAt: Date.now(),
  ...extra
});

/**
 * The whole answer to "must I join a team to enter this?", in one place.
 *
 * It cannot live in shapeArena because neither lichess endpoint knows both
 * halves: the team listing reports `teamMember`, the tournament detail
 * reports team battles, and each is silent about the other. So `undefined`
 * on the incoming row means "this endpoint did not say" and what we already
 * knew stands, while `null` means "this endpoint says there is none".
 *
 * Getting this wrong in the permissive direction hides a tournament nobody
 * can enter; getting it wrong in the other direction tells a player to join
 * a team they do not need, which the brief singles out as the one mistake
 * this integration must not make. Hence a pure function, and hence tests.
 *
 * @param {object} row   the incoming shape
 * @param {object} prev  what is already stored (an empty object is fine)
 */
export function deriveMembership(row, prev = {}) {
  const reqTeam = row.requiredTeamId !== undefined
    ? row.requiredTeamId : (prev.requiredTeamId || null);
  const battle = row.teamBattleTeams !== undefined
    ? row.teamBattleTeams : (prev.teamBattleTeams || null);
  const teams = (battle && battle.length) ? battle : null;
  return {
    requiredTeamId: reqTeam || null,
    teamBattleTeams: teams,
    membershipRequired: !!(reqTeam || teams)
  };
}

/**
 * Writes a tournament, creating it the first time and updating it after.
 *
 * The lichess id is the document id, so running the sync twice over the same
 * tournament produces one row. `detectedAt` and `archived` are only ever set
 * on the way in, so a later sync cannot un-archive something or move the
 * moment we first saw it.
 */
export async function upsertTournament(shape) {
  const ref = tournRef(shape.lichessId);
  const snap = await getDoc(ref).catch(() => null);
  const isNew = !snap || !snap.exists();
  const prev = (!isNew && snap.data()) || {};

  const row = { ...shape };
  if (row.kind === 'arena') Object.assign(row, deriveMembership(row, prev));

  /* The moment we first saw it finished, which is not the same as the moment
     it was scheduled to finish: an arena terminated early has a `finishesAt`
     in the future, and waiting for that was what left a finished tournament
     looking live until somebody reloaded the page. */
  if (row.status === 'finished' && prev.status !== 'finished') {
    row.finishedSeenAt = Date.now();
  }

  if (isNew) {
    row.detectedAt = Date.now();
    row.archived = false;
    row.archivedAt = null;
  } else {
    delete row.detectedAt;
    delete row.archived;
    delete row.archivedAt;
    /* A tournament that finished keeps the podium it finished with, even if
       a later listing call answers with an empty one. */
    if ((!row.podium || !row.podium.length) && prev.podium && prev.podium.length) {
      row.podium = prev.podium;
    }
  }

  await setDoc(ref, row, { merge: true });
  return { isNew, id: shape.lichessId };
}

export const archiveTournament = (id) =>
  updateDoc(tournRef(id), { archived: true, archivedAt: Date.now() });

/** Marks a tournament lichess no longer answers for, without deleting it. */
export const markUnavailable = (id, why) =>
  updateDoc(tournRef(id), {
    status: 'unavailable', unavailableReason: why || null, lastSyncedAt: Date.now()
  });

export const readTournament = async (id) => {
  const s = await getDoc(tournRef(id)).catch(() => null);
  return s && s.exists() ? { id: s.id, ...s.data() } : null;
};

export const watchTournament = (id, cb) =>
  onSnapshot(tournRef(id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    (e) => console.warn('Lichess tournament listener stopped', e));

export const watchTournaments = (ctx, cb) => {
  const q = ctx && ctx.clubId
    ? query(tournCol(), where('clubId', '==', ctx.clubId), limit(150))
    : query(tournCol(), where('scope', '==', 'global'), limit(150));
  return onSnapshot(q, (s) => cb(
    s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.startsAt || 0) - (a.startsAt || 0))
  ), (e) => console.warn('Lichess tournament list listener stopped', e));
};

export async function listTournaments(ctx) {
  const q = ctx && ctx.clubId
    ? query(tournCol(), where('clubId', '==', ctx.clubId), limit(150))
    : query(tournCol(), where('scope', '==', 'global'), limit(150));
  const s = await getDocs(q);
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.startsAt || 0) - (a.startsAt || 0));
}

/* ── participants ──────────────────────────────────────────────────── */

/**
 * One standings row.
 *
 * `score`, `rank`, `rating` and `performance` are lichess's own numbers. The
 * win / draw / loss counts are ours, worked out from the games we have
 * stored, and the page says so — a partial game list would otherwise read as
 * a player having played fewer games than they did.
 */
export const shapeParticipant = (p, calculated = {}) => ({
  userId: String(p.username || p.name || '').toLowerCase(),
  username: p.username || p.name || '?',
  title: p.title || null,
  flair: p.flair || null,
  rank: p.rank || null,
  rating: p.rating || null,
  score: p.score || 0,
  performance: p.performance || null,
  team: p.team || null,
  sheet: p.sheet || null,
  /* ours */
  calc: {
    wins: calculated.wins || 0,
    draws: calculated.draws || 0,
    losses: calculated.losses || 0,
    games: calculated.games || 0,
    berserks: calculated.berserks || 0,
    ...calculated
  },
  updatedAt: Date.now()
});

export const readParticipant = async (id, userId) => {
  const s = await getDoc(partRef(id, userId)).catch(() => null);
  return s && s.exists() ? { userId: s.id, ...s.data() } : null;
};

export const watchParticipants = (id, cb) =>
  onSnapshot(partsCol(id), (s) => cb(
    s.docs.map((d) => ({ userId: d.id, ...d.data() }))
      .sort((a, b) => (a.rank || 9999) - (b.rank || 9999) || (b.score || 0) - (a.score || 0))
  ), (e) => console.warn('Lichess participant listener stopped', e));

/* ── games ─────────────────────────────────────────────────────────── */

export const GAME_STATE = { WAITING: 'WAITING', LIVE: 'LIVE', FINISHED: 'FINISHED' };

/** A live pairing, which is all the arena endpoint gives while it is running. */
export const shapeDuel = (d, extra = {}) => ({
  gameId: d.id,
  state: GAME_STATE.LIVE,
  white: { username: (d.p && d.p[0] && d.p[0].n) || '?', rating: (d.p && d.p[0] && d.p[0].r) || null, rank: (d.p && d.p[0] && d.p[0].k) || null },
  black: { username: (d.p && d.p[1] && d.p[1].n) || '?', rating: (d.p && d.p[1] && d.p[1].r) || null, rank: (d.p && d.p[1] && d.p[1].k) || null },
  /* lichess's duel list does not say which side is which colour, so this is
     the pairing rather than the board. The board learns the truth when the
     game is streamed or exported. */
  colorsKnown: false,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  ...extra
});

/** A finished game, as the tournament game export describes it. */
export function shapeGame(g, extra = {}) {
  const w = (g.players && g.players.white) || {};
  const b = (g.players && g.players.black) || {};
  const side = (p) => ({
    username: (p.user && (p.user.name || p.user.id))
      || (p.aiLevel ? 'Stockfish level ' + p.aiLevel : 'Anonymous'),
    userId: (p.user && p.user.id) || null,
    rating: p.rating || null,
    ratingDiff: p.ratingDiff != null ? p.ratingDiff : null,
    title: (p.user && p.user.title) || null,
    berserk: !!p.berserk
  });
  return {
    gameId: g.id,
    state: g.status && g.status !== 'started' && g.status !== 'created'
      ? GAME_STATE.FINISHED : GAME_STATE.LIVE,
    white: side(w),
    black: side(b),
    colorsKnown: true,
    variant: g.variant || 'standard',
    speed: g.speed || null,
    perf: g.perf || null,
    rated: !!g.rated,
    initialFen: g.initialFen || null,
    moves: g.moves || '',
    clocks: g.clocks || null,
    clock: g.clock || null,
    status: g.status || null,
    winner: g.winner || null,
    result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1'
      : (g.status && g.status !== 'started') ? '1/2-1/2' : null,
    createdAt: g.createdAt || null,
    lastMoveAt: g.lastMoveAt || null,
    updatedAt: Date.now(),
    ...extra
  };
}

/** Never overwrites a finished game with a thinner live snapshot of it. */
export async function upsertGame(tournamentId, row) {
  const ref = gameRef(tournamentId, row.gameId);
  const snap = await getDoc(ref).catch(() => null);
  if (snap && snap.exists() && snap.data().state === GAME_STATE.FINISHED
      && row.state !== GAME_STATE.FINISHED) {
    return false;
  }
  await setDoc(ref, row, { merge: true });
  return true;
}

export const watchGames = (id, cb) =>
  onSnapshot(gamesCol(id), (s) => cb(
    s.docs.map((d) => ({ gameId: d.id, ...d.data() }))
  ), (e) => console.warn('Lichess game listener stopped', e));

export const readGame = async (tournamentId, gameId) => {
  const s = await getDoc(gameRef(tournamentId, gameId)).catch(() => null);
  return s && s.exists() ? { gameId: s.id, ...s.data() } : null;
};

/* ── the sync log ──────────────────────────────────────────────────── */

const LOG_KEEP = 60;

/**
 * Records one synchronization attempt.
 *
 * Deliberately small and deliberately capped: the admin page wants the last
 * hour of activity, not a permanent audit trail, and an uncapped log written
 * by every open tab is a bill rather than a feature.
 */
export async function logSync(entry) {
  try {
    await addDoc(eventsCol(), {
      at: Date.now(),
      scope: entry.scope || 'global',
      clubId: entry.clubId || null,
      teamId: entry.teamId || null,
      tournamentId: entry.tournamentId || null,
      action: entry.action,
      endpoint: entry.endpoint || null,
      ok: !!entry.ok,
      ms: entry.ms || 0,
      status: entry.status != null ? entry.status : null,
      error: entry.error ? String(entry.error).slice(0, 300) : null
    });
  } catch (e) { console.warn('Could not record the sync event', e); }
}

/* One order-by and no where, so a fresh project needs no composite index —
   the same trade the tournaments list already makes. The scope is picked out
   in the browser afterwards. */
const recentEvents = () => query(eventsCol(), orderBy('at', 'desc'), limit(200));

const mine = (ctx) => (row) => (ctx && ctx.clubId
  ? row.clubId === ctx.clubId
  : row.scope === 'global');

export const watchSyncEvents = (ctx, cb, n = 40) =>
  onSnapshot(recentEvents(), (s) => cb(
    s.docs.map((d) => ({ id: d.id, ...d.data() })).filter(mine(ctx)).slice(0, n)
  ), (e) => console.warn('Sync event listener stopped', e));

/** Trims the log. Run by whichever tab holds the sync lease, occasionally. */
export async function trimSyncLog(ctx) {
  try {
    const s = await getDocs(recentEvents());
    const rows = s.docs.filter((d) => mine(ctx)(d.data()));
    await Promise.all(rows.slice(LOG_KEEP).map((d) => deleteDoc(d.ref).catch(() => {})));
  } catch (e) { console.warn('Could not trim the sync log', e); }
}

/* ── the lease ─────────────────────────────────────────────────────── */

/*  There is no server here, so the synchronization has to run in somebody's
    browser. What must NOT happen is every open tab polling lichess at once —
    that is the behaviour the API asks people not to have.

    So one tab at a time holds a lease. It is a single document with a holder
    and an expiry; claiming is a transaction, so two tabs racing produce one
    winner. A tab that closes stops renewing and the lease falls to whoever
    asks next, a few seconds later. Nobody has to be elected, and nothing
    breaks if nobody is here at all — the next visitor catches up. */

export const LEASE_MS = 45000;

export async function claimLease(key, holderId) {
  try {
    return await runTransaction(db, async (tx) => {
      const ref = leaseRef(key);
      const snap = await tx.get(ref);
      const now = Date.now();
      const cur = snap.exists() ? snap.data() : null;
      if (cur && cur.holder !== holderId && (cur.until || 0) > now) return false;
      tx.set(ref, { holder: holderId, until: now + LEASE_MS, at: now }, { merge: true });
      return true;
    });
  } catch (e) {
    // a refused lease is not worth a console full of red; we simply do not sync
    return false;
  }
}

export const releaseLease = (key, holderId) =>
  runTransaction(db, async (tx) => {
    const ref = leaseRef(key);
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().holder === holderId) {
      tx.set(ref, { holder: null, until: 0, at: Date.now() }, { merge: true });
    }
  }).catch(() => {});

export const watchLease = (key, cb) =>
  onSnapshot(leaseRef(key), (s) => cb(s.exists() ? s.data() : null), () => {});

/* ── the account link ──────────────────────────────────────────────── */

/*  The token itself never comes near this. What is stored is the fact of the
    link, so that a standings row can be marked "this is you" and an admin
    can see who has connected an account. */

export const linkAccount = (uid, s) => setDoc(accountRef(uid), {
  uid,
  lichessId: s.userId || (s.username || '').toLowerCase(),
  username: s.username,
  scopes: s.scopes || [],
  linkedAt: s.linkedAt || Date.now(),
  lastSeenAt: Date.now()
}, { merge: true });

export const unlinkAccount = (uid) => deleteDoc(accountRef(uid));

export const readAccount = async (uid) => {
  const s = await getDoc(accountRef(uid)).catch(() => null);
  return s && s.exists() ? s.data() : null;
};
