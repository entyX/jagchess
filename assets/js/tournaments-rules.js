/* ═══════════════════════════════════════════════════════════════════════
   tournaments-rules.js — the rules of a tournament, and nothing else.

   Deliberately free of Firebase: everything here is a pure function of its
   arguments, which is what lets the scoring and the standings be tested on
   their own rather than only being observable by running a real tournament.
   tournaments-core.js re-exports the whole surface, so nothing outside needs
   to know this file exists.

   JagChess runs one native format — the arena. Brackets were discontinued in
   26.9.19.3; what remains of them here is the single flag that lets an old
   bracket document still be recognized and shown for what it is.
   ═══════════════════════════════════════════════════════════════════════ */

import { readRating } from './glicko2.js';

/* ── shapes ────────────────────────────────────────────────────────── */

export const FORMATS = {
  arena: {
    name: 'Arena',
    blurb: 'Timed and auto-paired, lichess style. Lose and you are back in within seconds.',
    long: 'Everyone plays continuously for a fixed stretch of time. You are paired with whoever is nearest you on score, and the most points when the clock runs out wins.'
  }
};

/* Formats that no longer exist. Documents written before they were retired
   are still in the database, so every screen has to be able to name one
   rather than crash on a format it has never heard of. */
export const RETIRED_FORMATS = {
  bracket: {
    name: 'Bracket',
    retiredIn: '26.9.19.3',
    note: 'Knockout brackets were discontinued. Finished ones keep their results; nothing new can be drawn.'
  }
};

export const isRetiredFormat = (f) => !!RETIRED_FORMATS[f];

export const formatName = (f) =>
  (FORMATS[f] && FORMATS[f].name) || (RETIRED_FORMATS[f] && RETIRED_FORMATS[f].name) || 'Tournament';

export const DURATIONS = [20, 30, 45, 60, 90, 120, 180];

/* ── phases ────────────────────────────────────────────────────────── */

export const arenaEndsAt = (t) => (t.startsAt || 0) + (t.durationMin || 60) * 60000;

/* The single source of truth for "what phase is this in". The status field on
   the document lags reality by design — no server is running to flip it at
   the exact second — so the derived phase is what the interface reads. */
export function phaseOf(t, now = Date.now()) {
  if (!t) return 'missing';
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'finished') return 'finished';
  /* A retired format can never move again, whatever its status says. */
  if (isRetiredFormat(t.format)) return 'retired';
  if (now < (t.startsAt || 0)) return 'scheduled';
  if (now >= arenaEndsAt(t)) return 'ending';
  return 'running';
}

export function isOpenForEntry(t, now = Date.now()) {
  const p = phaseOf(t, now);
  // an arena takes latecomers the whole way through
  return p === 'scheduled' || p === 'running';
}

/* ── arena scoring ─────────────────────────────────────────────────── */

const WIN = 2, DRAW = 1, LOSS = 0;

/**
 * lichess arena scoring, and the one place these rules live.
 *
 * Two wins in a row put you on a streak; from the third game on everything is
 * worth double, until a game you do not win. That game scores normally and
 * the streak resets. A berserked win is worth one extra point on top.
 *
 * @param {'win'|'draw'|'loss'} outcome
 * @param {number} streak   consecutive wins BEFORE this game
 * @param {boolean} berserked
 */
export function arenaPoints(outcome, streak, berserked) {
  const base = outcome === 'win' ? WIN : outcome === 'draw' ? DRAW : LOSS;
  const doubled = streak >= 2 ? base * 2 : base;
  return doubled + (berserked && outcome === 'win' ? 1 : 0);
}

export const nextStreak = (outcome, streak) => (outcome === 'win' ? streak + 1 : 0);

export const onFire = (p) => (p.streak || 0) >= 2;

export const outcomeOf = (result, side) =>
  result === '1/2-1/2' ? 'draw'
    : (result === '1-0') === (side === 'white') ? 'win' : 'loss';

/* ── standings ─────────────────────────────────────────────────────── */

/* Level on points: more wins first, then fewer games (a better score off
   fewer games is the better score), then the higher rating. */
export function sortStandings(rows) {
  return rows.slice().sort((a, b) =>
    (b.score || 0) - (a.score || 0) ||
    (b.wins || 0) - (a.wins || 0) ||
    (a.games || 0) - (b.games || 0) ||
    readRating(b).r - readRating(a).r ||
    (a.joinedAt || 0) - (b.joinedAt || 0));
}

/* An old bracket was ordered by its finishing places rather than by points,
   so a finished one still reads correctly in the history. */
export function placeStandings(rows) {
  return rows.slice().sort((a, b) => {
    const pa = a.place || 99, pb = b.place || 99;
    if (pa !== pb) return pa - pb;
    return (b.eliminatedIn || 0) - (a.eliminatedIn || 0) ||
      (a.seed || 99) - (b.seed || 99);
  });
}

export const standingsFor = (t, rows) =>
  isRetiredFormat(t.format) ? placeStandings(rows) : sortStandings(rows);
