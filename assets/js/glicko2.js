/* ═══════════════════════════════════════════════════════════════════════
   glicko2.js — the rating system lichess runs, implemented to Glickman's
   paper (glicko2.pdf, "Example of the Glicko-2 system").

   Lichess treats every game as its own rating period rather than batching
   games into weekly periods, so `rate()` takes a single opponent and is
   applied the moment a game ends. Everything else — the system constant
   tau, the volatility iteration, the 173.7178 scale — matches.

   JagChess starts players at 1000 instead of lichess's 1500. Only the
   starting point moves; 1500 stays as the scale's centre, exactly as in
   the paper, so the maths is untouched.
   ═══════════════════════════════════════════════════════════════════════ */

export const START_RATING = 1000;
export const START_RD     = 350;
export const START_VOL    = 0.06;

const TAU    = 0.75;      // lichess's system constant
const SCALE  = 173.7178;  // Glicko → Glicko-2 conversion
const CENTRE = 1500;      // the scale's zero point, not the starting rating
const RD_MIN = 45;        // a rating never becomes perfectly certain…
const RD_MAX = 500;       // …nor completely unknown. Both bound results only:
                          // a stored RD is read as-is, or the maths shifts.
const EPS    = 0.000001;

/* A fresh, unplayed rating. */
export const newRating = () => ({
  r: START_RATING, rd: START_RD, vol: START_VOL, games: 0, at: Date.now()
});

/* Reading a rating off any document — member row, user profile, or a player
   snapshot inside a game — always goes through here, so a missing or
   half-written field can never poison the maths. */
export function readRating(source) {
  const v = (source && source.rating) || {};
  const n = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
  return {
    r:     n(v.r, START_RATING),
    rd:    clamp(n(v.rd, START_RD), 1, RD_MAX),
    vol:   n(v.vol, START_VOL) > 0 ? n(v.vol, START_VOL) : START_VOL,
    games: Math.max(0, Math.round(n(v.games, 0))),
    at:    n(v.at, 0)
  };
}

/* Everyone starts at 1000, but the number means little until they have
   actually played, so a brand-new player's rating carries a question mark
   the way lichess marks a provisional one: "1000?". */
export const isProvisional = (rating) => readRating({ rating }).games < 1;

export const displayRating = (rating) => {
  const g = readRating({ rating });
  return g.games < 1 ? Math.round(g.r) + '?' : String(Math.round(g.r));
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

const expected = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/* Step 5 of the paper: the volatility that best explains the result, found
   with the Illinois variant of regula falsi. */
function newVolatility(phi, sigma, delta, v, TAU) {
  const a = Math.log(sigma * sigma);
  const d2 = delta * delta;
  const phi2 = phi * phi;

  const f = (x) => {
    const ex = Math.exp(x);
    const t = phi2 + v + ex;
    return (ex * (d2 - t)) / (2 * t * t) - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0 && k < 100) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPS && guard++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; }
    else { fA = fA / 2; }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * A whole rating period. Glicko-2 is defined over a batch of games, so this
 * is the real algorithm; `rate` below is the one-game case lichess uses.
 *
 * @param {{r,rd,vol,games}} player
 * @param {Array<{opponent:{r,rd}, score:number}>} games  score: 1 / 0.5 / 0
 * @param {number} [tau]  system constant; 0.75 unless a test says otherwise
 * @param {boolean} [round]  false keeps full precision for comparisons
 */
export function ratePeriod(player, games, tau = TAU, round = true) {
  const p = readRating({ rating: player });
  const mu = (p.r - CENTRE) / SCALE;
  const phi = p.rd / SCALE;

  if (!games.length) {
    // nobody played: only the uncertainty grows
    const phiNew = Math.sqrt(phi * phi + p.vol * p.vol);
    return { ...p, rd: Math.round(clamp(SCALE * phiNew, RD_MIN, RD_MAX)), at: Date.now() };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const { opponent, score } of games) {
    const o = readRating({ rating: opponent });
    const muJ = (o.r - CENTRE) / SCALE;
    const phiJ = o.rd / SCALE;
    const gJ = g(phiJ);
    const eJ = expected(mu, muJ, phiJ);
    vInv += gJ * gJ * eJ * (1 - eJ);
    deltaSum += gJ * (score - eJ);
  }

  const v = 1 / vInv;
  const delta = v * deltaSum;

  const sigma = newVolatility(phi, p.vol, delta, v, tau);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;

  const r = clamp(CENTRE + SCALE * muNew, 100, 3000);
  const rd = clamp(SCALE * phiNew, RD_MIN, RD_MAX);
  return {
    r:     round ? Math.round(r) : r,
    rd:    round ? Math.round(rd) : rd,
    vol:   sigma,
    games: p.games + games.length,
    at:    Date.now()
  };
}

/**
 * One game's worth of rating change — a rating period of exactly one game,
 * which is how lichess applies Glicko-2.
 * @param {number} score  1 = win, 0.5 = draw, 0 = loss
 */
export function rate(player, opponent, score) {
  return ratePeriod(player, [{ opponent, score }]);
}

/* Both sides of a finished game, computed once so every client applies the
   identical numbers no matter who writes them. */
export function rateGame(white, black, result) {
  const scoreW = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  return {
    white: rate(white, black, scoreW),
    black: rate(black, white, 1 - scoreW)
  };
}

/* What a win / draw / loss would be worth — used to show "+8 / −7" next to
   the Play button before anything is at stake. */
export function preview(player, opponent) {
  const base = readRating({ rating: player }).r;
  return {
    win:  Math.round(rate(player, opponent, 1).r - base),
    draw: Math.round(rate(player, opponent, 0.5).r - base),
    loss: Math.round(rate(player, opponent, 0).r - base)
  };
}
