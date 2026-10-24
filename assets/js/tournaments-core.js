/* ═══════════════════════════════════════════════════════════════════════
   tournaments-core.js — the engine behind a JagChess arena.

     tournaments/{id}                 the event itself
     tournaments/{id}/players/{uid}   one row per entrant: score, record, state

   Tournaments sit at the root next to duels, for the same reason duels do: a
   global event has entrants from clubs that share nothing.

   There is no server here, so pairing and result-processing are driven by the
   clients that are watching. Two rules keep that honest, and they are the same
   two the duels module already relies on:

     • every write is an ABSOLUTE value worked out from a frozen snapshot,
       never an increment, so two clients writing at once write the same thing;
     • anything that must happen exactly once carries an idempotency guard —
       a `done` map keyed by game id — and is applied inside a transaction.

   Whoever's tab is alive does the work. Nobody's score depends on their
   opponent still being on the page when the game ends.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, limit, runTransaction,
  clubCol, memberRef, makeCode
} from './club-core.js';

import { readRating, newRating } from './glicko2.js';
import {
  buildGame, playerSnap, duelsCol, TIME_CONTROLS, tcLabel, tcCategory
} from './club-duels.js';

/* The rules themselves live in a Firebase-free module so they can be tested
   on their own. Everything is re-exported here, so callers only ever import
   tournaments-core. */
import {
  FORMATS, arenaPoints, outcomeOf, standingsFor
} from './tournaments-rules.js';

export {
  FORMATS, RETIRED_FORMATS, DURATIONS, arenaEndsAt, phaseOf, isOpenForEntry,
  arenaPoints, nextStreak, onFire, outcomeOf, sortStandings, placeStandings,
  standingsFor, isRetiredFormat, formatName
} from './tournaments-rules.js';

/* ── paths ─────────────────────────────────────────────────────────── */

export const tournCol    = () => collection(db, 'tournaments');
export const tournRef    = (id) => doc(db, 'tournaments', id);
export const tPlayersCol = (id) => collection(db, 'tournaments', id, 'players');
export const tPlayerRef  = (id, uid) => doc(db, 'tournaments', id, 'players', uid);
const userRef = (uid) => doc(db, 'users', uid);

/* ── shapes ────────────────────────────────────────────────────────── */

export const tcFromId = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id) || TIME_CONTROLS[5];
  return { initial: t.min * 60000, increment: t.inc * 1000 };
};

export const canManage = (t, ctx) =>
  !!t && !!ctx.user && (t.host.uid === ctx.user.uid || (t.scope === 'club' && ctx.isAdmin));

/* ── creating ──────────────────────────────────────────────────────── */

export async function createTournament(ctx, form) {
  const id = 't' + Date.now().toString(36) + makeCode(4).toLowerCase();

  const t = {
    scope: ctx.clubId ? 'club' : 'global',
    clubId: ctx.clubId || null,
    clubName: (ctx.club && ctx.club.name) || null,
    name: form.name,
    description: form.description || '',
    format: 'arena',
    tc: form.tc,
    rated: !!form.rated,
    berserk: !!form.berserk,
    startsAt: form.startsAt,
    durationMin: form.durationMin || 60,
    host: {
      uid: ctx.user.uid,
      username: (ctx.member && ctx.member.username) || (ctx.user.email || '').split('@')[0] || 'Player',
      avatarColor: (ctx.member && ctx.member.avatarColor) || '#2e90fa'
    },
    status: 'scheduled',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    playerCount: 0,
    finalStandings: null,
    podiumResult: null,
    eventId: null
  };

  await setDoc(tournRef(id), t);

  /* A date and a time is a calendar entry — writing it by hand afterwards is
     just a way to forget. Only clubs have a calendar to write to. */
  if (form.addToCalendar && ctx.clubId) {
    try {
      const eventId = 'tourn-' + id;
      await setDoc(doc(clubCol(ctx.clubId, 'events'), eventId), {
        title: form.name,
        date: form.startsAt,
        tag: 'tournament',
        description: `${FORMATS.arena.name} · ${tcLabel(form.tc)} ${tcCategory(form.tc)} · ${form.rated ? 'Rated' : 'Casual'}`,
        durationMin: form.durationMin || 60,
        tournamentId: id,
        createdAt: Date.now()
      });
      await updateDoc(tournRef(id), { eventId });
    } catch (e) {
      // a calendar that refuses the write must not lose you the tournament
      console.warn('Could not add the tournament to the calendar', e);
    }
  }

  return { id, ...t };
}

export async function cancelTournament(t) {
  await updateDoc(tournRef(t.id), { status: 'cancelled', finishedAt: Date.now() });
  if (t.eventId && t.clubId) {
    await deleteDoc(doc(clubCol(t.clubId, 'events'), t.eventId)).catch(() => {});
  }
}

export async function deleteTournament(t) {
  // the subcollections are small and bounded; clear them so a deleted
  // tournament does not leave orphan rows behind
  const kill = async (col) => {
    const s = await getDocs(col).catch(() => null);
    if (!s) return;
    await Promise.all(s.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  };
  await kill(tPlayersCol(t.id));
  /* Brackets are gone, but a tournament drawn before they were retired may
     still have its tree underneath it — clear that too rather than orphan it. */
  await kill(collection(db, 'tournaments', t.id, 'matches'));
  if (t.eventId && t.clubId) {
    await deleteDoc(doc(clubCol(t.clubId, 'events'), t.eventId)).catch(() => {});
  }
  await deleteDoc(tournRef(t.id));
}

/* ── entering and leaving ──────────────────────────────────────────── */

export function blankPlayer(uid, username, avatarColor, rating) {
  return {
    uid,
    username: username || 'Player',
    avatarColor: avatarColor || '#2e90fa',
    rating: { r: rating.r, rd: rating.rd, vol: rating.vol, games: rating.games },
    state: 'ready',
    score: 0,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    streak: 0,
    berserks: 0,
    currentGameId: null,
    wantBerserk: false,
    joinedAt: Date.now(),
    heartbeat: Date.now(),
    seed: null,
    place: null,
    eliminatedIn: null,
    done: {}
  };
}

/* The rating a tournament pairs and seeds on is read from the same document
   the results will be written back to — the member row inside a club, the
   user profile outside one. */
export async function myTournamentProfile(ctx, t) {
  let source = {};
  try {
    const ref = t.scope === 'club' ? memberRef(t.clubId, ctx.user.uid) : userRef(ctx.user.uid);
    const s = await getDoc(ref);
    if (s.exists()) source = s.data();
  } catch (e) { console.warn('Could not read your rating for this tournament', e); }
  return {
    source,
    username: source.username || (ctx.member && ctx.member.username) ||
      (ctx.user.email || '').split('@')[0] || 'Player',
    avatarColor: source.avatarColor || (ctx.member && ctx.member.avatarColor) || '#2e90fa',
    rating: source.rating ? readRating(source) : newRating()
  };
}

export async function joinTournament(ctx, t) {
  const me = await myTournamentProfile(ctx, t);
  const existing = await getDoc(tPlayerRef(t.id, ctx.user.uid)).catch(() => null);

  if (existing && existing.exists()) {
    // coming back after a pause keeps every point already earned
    const d = existing.data();
    if (d.state === 'out') throw new Error('You are out of this tournament.');
    await updateDoc(tPlayerRef(t.id, ctx.user.uid), {
      state: 'ready', heartbeat: Date.now()
    });
    return;
  }

  if (!isOpenForEntry(t)) throw new Error('Entries for this tournament are closed.');
  await setDoc(tPlayerRef(t.id, ctx.user.uid),
    blankPlayer(ctx.user.uid, me.username, me.avatarColor, me.rating));
  await bumpPlayerCount(t.id);
}

/* Pausing keeps your score; withdrawing before the start gives up your seat. */
export const pauseInTournament = (t, uid) =>
  updateDoc(tPlayerRef(t.id, uid), { state: 'paused', heartbeat: Date.now() });

export async function withdrawFromTournament(t, uid) {
  if (phaseOf(t) === 'scheduled') {
    await deleteDoc(tPlayerRef(t.id, uid));
    await bumpPlayerCount(t.id);
    return;
  }
  await updateDoc(tPlayerRef(t.id, uid), { state: 'out', heartbeat: Date.now() });
}

async function bumpPlayerCount(id) {
  try {
    const s = await getDocs(tPlayersCol(id));
    await updateDoc(tournRef(id), { playerCount: s.size });
  } catch (e) { console.warn('Could not refresh the entrant count', e); }
}

export const beat = (t, uid) =>
  updateDoc(tPlayerRef(t.id, uid), { heartbeat: Date.now() }).catch(() => {});

/* ── ARENA: pairing ────────────────────────────────────────────────── */

const FRESH = 30000;

const isFree = (p, now) =>
  p.state === 'ready' && !p.currentGameId && (now - (p.heartbeat || 0) < FRESH);

/**
 * Works out who this player should be facing, or null.
 *
 * Free players are sorted by score and paired off in twos, which is how an
 * arena keeps the leaders meeting each other. Only the lower uid of a pair
 * calls `pairArena`, so two clients never build the same game twice — and
 * the transaction settles it if they somehow both try.
 */
export function findArenaOpponent(players, uid, now = Date.now()) {
  const free = sortStandings(players.filter((p) => isFree(p, now)));
  const i = free.findIndex((p) => p.uid === uid);
  if (i === -1) return null;
  const partner = i % 2 === 0 ? free[i + 1] : free[i - 1];
  return partner || null;
}

export async function pairArena(t, meRow, themRow) {
  return runTransaction(db, async (tx) => {
    const [a, b, sa, sb] = await Promise.all([
      tx.get(tPlayerRef(t.id, meRow.uid)),
      tx.get(tPlayerRef(t.id, themRow.uid)),
      tx.get(settleRef(t, meRow.uid)),
      tx.get(settleRef(t, themRow.uid))
    ]);
    if (!a.exists() || !b.exists()) throw new Error('gone');
    const A = a.data(), B = b.data();
    const SA = (sa.exists() && sa.data()) || {};
    const SB = (sb.exists() && sb.data()) || {};
    if (A.currentGameId || B.currentGameId) throw new Error('busy');
    if (A.state !== 'ready' || B.state !== 'ready') throw new Error('busy');

    // colors alternate off the game count so nobody sits on one side all night
    const meWhite = ((A.games || 0) + (B.games || 0)) % 2 === 0;
    const white = meWhite ? snapOf(A, SA) : snapOf(B, SB);
    const black = meWhite ? snapOf(B, SB) : snapOf(A, SA);

    const ref = doc(duelsCol());
    tx.set(ref, buildGame(
      { scope: t.scope, clubId: t.clubId, rated: t.rated, tc: t.tc, white, black },
      {
        tournamentId: t.id,
        tournamentName: t.name,
        berserk: t.berserk
          ? { w: !!(meWhite ? A.wantBerserk : B.wantBerserk), b: !!(meWhite ? B.wantBerserk : A.wantBerserk) }
          : null
      }
    ));
    tx.update(tPlayerRef(t.id, meRow.uid), { state: 'playing', currentGameId: ref.id, wantBerserk: false });
    tx.update(tPlayerRef(t.id, themRow.uid), { state: 'playing', currentGameId: ref.id, wantBerserk: false });
    return ref.id;
  });
}

/* Where a player's real rating and win/draw/loss record live — the member row
   inside a club, the user profile outside one. This is the document a rated
   result gets written back to, so it is also the one a game must be built
   from: a snapshot taken off the tournament row instead would freeze the
   rating at join time and count every player's record as zero. */
export const settleRef = (t, uid) =>
  t.scope === 'club' ? memberRef(t.clubId, uid) : userRef(uid);

/* `source` is that live document; the tournament row only supplies identity. */
const snapOf = (p, source) => playerSnap(
  p.uid,
  (source && source.username) || p.username,
  (source && source.avatarColor) || p.avatarColor,
  readRating(source || p),
  source || {}
);

/* ── processing a finished game ────────────────────────────────────── */

/**
 * Applies one finished tournament game to both players' rows.
 *
 * Guarded by `done[gameId]` inside a transaction, so it runs exactly once per
 * player per game no matter how many tabs notice the game ending. Everything
 * written is absolute.
 */
export async function applyTournamentGame(t, game) {
  const sides = [
    { uid: game.white.uid, side: 'white', berserked: !!(game.berserk && game.berserk.w) },
    { uid: game.black.uid, side: 'black', berserked: !!(game.berserk && game.berserk.b) }
  ];

  for (const s of sides) {
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(tPlayerRef(t.id, s.uid));
        if (!snap.exists()) return;
        const p = snap.data();
        if (p.done && p.done[game.id]) return;      // already counted

        const outcome = outcomeOf(game.result, s.side);

        const gained = arenaPoints(outcome, p.streak || 0, s.berserked);

        const patch = {
          score: (p.score || 0) + gained,
          games: (p.games || 0) + 1,
          wins: (p.wins || 0) + (outcome === 'win' ? 1 : 0),
          draws: (p.draws || 0) + (outcome === 'draw' ? 1 : 0),
          losses: (p.losses || 0) + (outcome === 'loss' ? 1 : 0),
          streak: nextStreak(outcome, p.streak || 0),
          berserks: (p.berserks || 0) + (s.berserked ? 1 : 0),
          heartbeat: Date.now(),
          done: { ...(p.done || {}), [game.id]: true }
        };

        /* A finished game puts you straight back in the pool, unless you
           paused or withdrew while it was running. */
        patch.state = p.state === 'paused' || p.state === 'out' ? p.state : 'ready';
        patch.currentGameId = null;

        tx.update(tPlayerRef(t.id, s.uid), patch);
      });
    } catch (e) {
      console.warn('Could not record the arena result for ' + s.uid, e);
    }
  }
}

/* ── ARENA: the finish ─────────────────────────────────────────────── */

export async function finishTournament(t, rows) {
  const ordered = standingsFor(t, rows);
  const standings = ordered.map((p, i) => ({
    place: i + 1,
    uid: p.uid,
    username: p.username,
    avatarColor: p.avatarColor,
    rating: p.rating,
    score: p.score || 0,
    games: p.games || 0,
    wins: p.wins || 0,
    draws: p.draws || 0,
    losses: p.losses || 0
  }));
  await updateDoc(tournRef(t.id), {
    status: 'finished',
    finishedAt: Date.now(),
    finalStandings: standings,
    podiumResult: standings.slice(0, Math.min(3, standings.length))
  }).catch((e) => console.warn('Could not close the tournament', e));
}

/* ── watching ──────────────────────────────────────────────────────── */

export const watchTournament = (id, cb) =>
  onSnapshot(tournRef(id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    (e) => console.warn('Tournament listener stopped', e));

export const watchPlayers = (id, cb) =>
  onSnapshot(tPlayersCol(id), (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (e) => console.warn('Entrant listener stopped', e));

export const watchTournamentGames = (id, cb) =>
  onSnapshot(query(duelsCol(), where('tournamentId', '==', id), limit(200)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => console.warn('Tournament game listener stopped', e));

/* Club tournaments and global ones are two different queries; both sort in
   the browser so a fresh project needs no composite index. */
export async function listTournaments(ctx) {
  const q = ctx.clubId
    ? query(tournCol(), where('clubId', '==', ctx.clubId), limit(120))
    : query(tournCol(), where('scope', '==', 'global'), limit(120));
  const s = await getDocs(q);
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.startsAt || 0) - (a.startsAt || 0));
}

export const watchTournamentList = (ctx, cb) => {
  const q = ctx.clubId
    ? query(tournCol(), where('clubId', '==', ctx.clubId), limit(120))
    : query(tournCol(), where('scope', '==', 'global'), limit(120));
  return onSnapshot(q, (s) => cb(
    s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.startsAt || 0) - (a.startsAt || 0))
  ), (e) => console.warn('Tournament list listener stopped', e));
};
