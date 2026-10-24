/* ═══════════════════════════════════════════════════════════════════════
   puzzle-model.js — what a puzzle actually is, with no screen attached.

   A puzzle used to be a list of moves. One line, one answer, and a position
   with two equally winning moves could not be published honestly. So it is a
   graph now: every node is one move, and its children are the moves that may
   follow it.

     · from the root, the player's color moves — those are the children of
       the root, and there can be several
     · their children are the opponent's replies
     · a node with no children is the end of a line, and is flagged as such

   Two lines that arrive at the same position may be **merged**, which is
   what stops a second good move meaning you retype the whole continuation.
   Merging is only offered where the position really is identical — see
   positionKey, which is stricter than it looks and looser than a FEN — so a
   merge can never quietly change what comes next. And it may never point
   backwards, or the puzzle would loop forever.

   Everything here is pure: give it a graph and a starting FEN and it will
   tell you about them. It reaches for chess.js through the global the vendor
   script sets, so a test can supply its own.
   ═══════════════════════════════════════════════════════════════════════ */

export const ROOT = 'r';

const chess = (fen) => {
  const Ctor = globalThis.Chess || (globalThis.window && globalThis.window.Chess);
  if (!Ctor) throw new Error('chess.js is not loaded');
  return fen ? new Ctor(fen) : new Ctor();
};

let seq = 0;
export const newNodeId = () =>
  'n' + Date.now().toString(36) + (seq++).toString(36) + Math.floor(Math.random() * 1296).toString(36);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ── the shape on disk ─────────────────────────────────────────────── */

/**
 * A stored graph, cleaned up enough to walk.
 *
 * Anything that does not describe a real node is dropped rather than
 * repaired: a child id pointing at nothing is the one corruption that would
 * otherwise crash the solver mid-puzzle.
 */
export function normalizeTree(raw) {
  const src = raw && typeof raw === 'object' ? raw.nodes : null;
  const nodes = { [ROOT]: { san: null, children: [] } };

  if (src && typeof src === 'object') {
    for (const [id, n] of Object.entries(src)) {
      if (!id || typeof n !== 'object' || n === null) continue;
      nodes[id] = {
        san: id === ROOT ? null : String(n.san || ''),
        children: Array.isArray(n.children) ? n.children.map(String) : []
      };
    }
  }
  if (!nodes[ROOT]) nodes[ROOT] = { san: null, children: [] };
  nodes[ROOT].san = null;

  // a child that is not a node is a dangling pointer, not a move
  for (const n of Object.values(nodes)) {
    n.children = n.children.filter((c) => c !== ROOT && nodes[c]);
  }
  // and a node nothing reaches is not part of the puzzle
  return prune({ root: ROOT, nodes });
}

/** The old shape: one line, one move per step. */
export function treeFromSolution(solution) {
  const nodes = { [ROOT]: { san: null, children: [] } };
  let at = ROOT;
  for (const san of (Array.isArray(solution) ? solution : [])) {
    const text = String(san || '').trim();
    if (!text) continue;
    const id = newNodeId();
    nodes[id] = { san: text, children: [] };
    nodes[at].children.push(id);
    at = id;
  }
  return { root: ROOT, nodes };
}

/** Whatever a stored puzzle has — a graph, or a list of moves from before. */
export const treeOf = (puzzle) => {
  const p = puzzle || {};
  if (p.tree && p.tree.nodes && Object.keys(p.tree.nodes).length > 1) return normalizeTree(p.tree);
  if (Array.isArray(p.solution) && p.solution.length) return treeFromSolution(p.solution);
  return normalizeTree(p.tree);
};

/** Drops every node the root cannot reach. */
export function prune(tree) {
  const keep = new Set([tree.root]);
  const stack = [tree.root];
  while (stack.length) {
    const id = stack.pop();
    for (const c of (tree.nodes[id] || { children: [] }).children) {
      if (!keep.has(c)) { keep.add(c); stack.push(c); }
    }
  }
  const nodes = {};
  for (const id of keep) if (tree.nodes[id]) nodes[id] = tree.nodes[id];
  return { root: tree.root, nodes };
}

const copy = (tree) => ({
  root: tree.root,
  nodes: Object.fromEntries(Object.entries(tree.nodes)
    .map(([id, n]) => [id, { san: n.san, children: n.children.slice() }]))
});

/* ── walking it ────────────────────────────────────────────────────── */

/** Every node's parents. Several is normal — that is what a merge makes. */
export function parentsOf(tree) {
  const map = {};
  for (const id of Object.keys(tree.nodes)) map[id] = [];
  for (const [id, n] of Object.entries(tree.nodes)) {
    for (const c of n.children) if (map[c]) map[c].push(id);
  }
  return map;
}

/**
 * One route from the root to `id`, as node ids.
 *
 * A merged node has more than one route to it, and this returns the first it
 * finds. That is safe precisely because merging checks the position: every
 * route to a node ends at the same board.
 */
export function pathTo(tree, id) {
  if (id === tree.root) return [tree.root];
  const seen = new Set([tree.root]);
  const queue = [[tree.root]];
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const c of (tree.nodes[last] || { children: [] }).children) {
      if (c === id) return path.concat(c);
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(path.concat(c));
    }
  }
  return null;
}

/** The position at a node, as a full FEN. */
export function fenAt(tree, startFen, id) {
  const path = pathTo(tree, id);
  if (!path) return null;
  const g = chess(startFen);
  for (const step of path.slice(1)) {
    const san = tree.nodes[step].san;
    if (!g.move(san, { sloppy: true })) return null;
  }
  return g.fen();
}

/**
 * The part of a FEN that says "this is the same position".
 *
 * Not the FEN itself, which carries two things that are not part of a
 * position at all. The move clocks differ between any two transpositions and
 * mean nothing to a puzzle. And the en-passant square is recorded by chess.js
 * whenever a pawn moves two squares, whether or not anybody can actually take
 * that way — so 1.e4 e5 2.Nf3 Nc6 and 1.Nf3 Nc6 2.e4 e5 reach one board and
 * two different FENs. The square only counts when the capture is legal, which
 * is what every repetition rule means by it too.
 */
export function positionKey(fen) {
  if (!fen) return null;
  const [placement, turn, castling, ep] = String(fen).split(/\s+/);
  let epKey = '-';
  if (ep && ep !== '-') {
    try {
      const canTake = chess(fen).moves({ verbose: true }).some((m) => String(m.flags || '').includes('e'));
      if (canTake) epKey = ep;
    } catch (_) { /* an unreadable FEN is not a position anybody can merge */ }
  }
  return `${placement} ${turn} ${castling || '-'} ${epKey}`;
}

/** The position at a node, as the key two lines have to share to be merged. */
export const keyAt = (tree, startFen, id) => positionKey(fenAt(tree, startFen, id));

/** How deep a node sits. Root is 0; even depths are the player to move. */
export function depthOf(tree, id) {
  const path = pathTo(tree, id);
  return path ? path.length - 1 : -1;
}

/** Whose move it is at a node: 'player' before an even depth, 'opponent' after. */
export const toMoveAt = (tree, id) => (depthOf(tree, id) % 2 === 0 ? 'player' : 'opponent');

/** The child of `id` played by `san`, or null. */
export function childByMove(tree, id, san) {
  const want = String(san || '').trim();
  for (const c of (tree.nodes[id] || { children: [] }).children) {
    if (tree.nodes[c].san === want) return c;
  }
  return null;
}

export const isEnd = (tree, id) => !((tree.nodes[id] || { children: [] }).children.length);

export const endNodes = (tree) =>
  Object.keys(tree.nodes).filter((id) => id !== tree.root && isEnd(tree, id));

/* ── changing it ───────────────────────────────────────────────────── */

/**
 * Records `san` as a continuation of `id`.
 * If that move is already there it is simply followed — replaying a line you
 * have already built must never duplicate it.
 * @returns {{ tree: object, id: string, created: boolean }}
 */
export function addMove(tree, id, san) {
  const existing = childByMove(tree, id, san);
  if (existing) return { tree, id: existing, created: false };

  const next = copy(tree);
  const nid = newNodeId();
  next.nodes[nid] = { san: String(san).trim(), children: [] };
  next.nodes[id].children.push(nid);
  return { tree: next, id: nid, created: true };
}

/**
 * Removes a move, and with it anything only that move led to.
 *
 * A node kept alive by a second parent — the far side of a merge — stays,
 * which is the whole point of merging: deleting one way in does not delete
 * the shared continuation.
 */
export function deleteNode(tree, id) {
  if (id === tree.root) return tree;
  const next = copy(tree);
  for (const n of Object.values(next.nodes)) {
    n.children = n.children.filter((c) => c !== id);
  }
  delete next.nodes[id];
  return prune(next);
}

/** Is `target` reachable from `from`? */
export function reaches(tree, from, target) {
  if (from === target) return true;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    for (const c of (tree.nodes[id] || { children: [] }).children) {
      if (c === target) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return false;
}

/**
 * Whether folding `id` into `into` would make the puzzle circular.
 *
 * The merge rewrites every edge `p -> id` as `p -> into`, so a loop appears
 * exactly when `into` can already reach some parent of `id` — and since the
 * last step of any route to `id` comes from a parent of `id`, that is the
 * same question as "can `into` reach `id`". Getting this backwards is easy
 * and silent: it lets you merge a move into one of its own ancestors and
 * build a puzzle that never ends.
 *
 * The other direction is refused too. `into` sitting underneath `id` is not a
 * loop, but it is a merge that quietly deletes the moves in between.
 */
export const wouldLoop = (tree, id, into) =>
  reaches(tree, into, id) || reaches(tree, id, into);

/**
 * Which nodes `id` could be merged into: the same position, and not on the
 * same branch as it in either direction.
 */
export function mergeCandidates(tree, startFen, id) {
  if (id === tree.root) return [];
  const mine = keyAt(tree, startFen, id);
  if (!mine) return [];
  return Object.keys(tree.nodes).filter((other) => {
    if (other === id || other === tree.root) return false;
    if (wouldLoop(tree, id, other)) return false;
    return keyAt(tree, startFen, other) === mine;
  });
}

/**
 * Folds `id` into `into`: everything that led to `id` now leads to `into`,
 * and the duplicate continuation underneath `id` is dropped.
 *
 * Refuses a merge that would make the puzzle circular, and a merge between
 * two different positions — either would be a puzzle nobody can finish.
 */
export function mergeNodes(tree, startFen, id, into) {
  if (id === tree.root || into === tree.root || id === into) return { tree, ok: false, why: 'Those cannot be merged.' };
  if (!tree.nodes[id] || !tree.nodes[into]) return { tree, ok: false, why: 'That move is no longer there.' };
  if (wouldLoop(tree, id, into)) {
    return { tree, ok: false, why: 'Those two are on the same branch, so merging them would send the puzzle round in a circle.' };
  }

  const a = keyAt(tree, startFen, id);
  const b = keyAt(tree, startFen, into);
  if (!a || a !== b) return { tree, ok: false, why: 'Those two moves do not reach the same position.' };

  const next = copy(tree);
  for (const n of Object.values(next.nodes)) {
    n.children = n.children.map((c) => (c === id ? into : c));
    n.children = n.children.filter((c, i) => n.children.indexOf(c) === i);   // no doubled edge
  }
  delete next.nodes[id];
  return { tree: prune(next), ok: true };
}

/* ── describing it ─────────────────────────────────────────────────── */

/**
 * Every complete line, root to end, as arrays of node ids.
 * Capped, because a graph built by hand can still fan out further than
 * anything needs to be drawn.
 */
export function allLines(tree, cap = 400) {
  const out = [];
  const walk = (id, path, seen) => {
    if (out.length >= cap) return;
    const kids = (tree.nodes[id] || { children: [] }).children.filter((c) => !seen.has(c));
    if (!kids.length) { if (path.length > 1) out.push(path); return; }
    for (const c of kids) walk(c, path.concat(c), new Set(seen).add(c));
  };
  walk(tree.root, [tree.root], new Set([tree.root]));
  return out;
}

/**
 * What the puzzle asks of whoever plays it.
 *
 * `moves` is the shortest number of moves the player's own color has to
 * find — which is what replaces the max-attempts box an admin used to fill
 * in by hand. It is the shortest rather than the longest because that is the
 * promise being made: find this many good moves and the puzzle is over.
 */
export function treeStats(tree) {
  const lines = allLines(tree);
  const playerMoves = lines.map((l) => Math.ceil((l.length - 1) / 2)).filter((n) => n > 0);
  const nodes = Object.keys(tree.nodes).length - 1;
  return {
    lines: lines.length,
    nodes,
    moves: playerMoves.length ? Math.min(...playerMoves) : 0,
    longest: playerMoves.length ? Math.max(...playerMoves) : 0,
    branches: lines.length > 1 ? lines.length : 0,
    empty: nodes === 0
  };
}

/* ── what it is worth ──────────────────────────────────────────────── */

/**
 * The points a solve is worth right now.
 *
 * An expiry does not close a puzzle, it discounts it: solving late is still
 * worth solving, just not worth as much. The cut is a percentage so the same
 * setting reads the same on a ten-point puzzle and a hundred-point one, and
 * the result is truncated rather than rounded — a club's points are whole
 * things, and rounding up would pay more for being late.
 *
 * @returns {{ points, base, late, penalty, pct, expiresAt }}
 */
export function scoreFor(puzzle, at = Date.now()) {
  const p = puzzle || {};
  const base = Math.max(0, Math.trunc(Number(p.points) || 0));
  const expiresAt = Number(p.expiresAt) || 0;
  const pct = clamp(Math.trunc(Number(p.latePenaltyPct) || 0), 0, 100);
  const late = expiresAt > 0 && at > expiresAt;

  if (!late || !pct) return { points: base, base, late, penalty: 0, pct, expiresAt };
  const points = Math.trunc((base * (100 - pct)) / 100);
  return { points, base, late: true, penalty: base - points, pct, expiresAt };
}

export const hasExpired = (puzzle, at = Date.now()) => {
  const e = Number((puzzle || {}).expiresAt) || 0;
  return e > 0 && at > e;
};

/* ── how hard it is ────────────────────────────────────────────────── */

/**
 * A difficulty out of ten, to one decimal place.
 *
 * Kept as a number rather than a band because a band is a lossy thing to
 * store: "hard" cannot be sorted against "hard", and an author who means 7.5
 * has no way to say so. The bands below are drawn from the number, never the
 * other way round.
 *
 * Zero is a real answer — "anybody can do this" — so it is distinguished
 * from an unset difficulty, which is null.
 */
export function clampDifficulty(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10;
}

/** The difficulty as it is written down: "6.5", never "6.5000001". */
export const difficultyText = (d) =>
  (d === null || d === undefined ? '' : (Math.round(d * 10) / 10).toFixed(1));

/**
 * A word for a number, for the places a number alone says nothing.
 *
 * Five bands, not four, and the middle one sits on the middle of the scale.
 * With four the boundaries fell at 2.5, 5 and 7.5, which put everything
 * from halfway up into "tough" and turned the chip warning-orange at
 * exactly 5.0 — the one number on the scale that means "average". An
 * author setting 5/10 was told they had written a hard puzzle.
 *
 * So the bands are even two-point steps, and 4–6 is the neutral one the
 * default lands in.
 */
export function difficultyBand(d) {
  if (d === null || d === undefined) return null;
  if (d < 2) return 'easy';
  if (d < 4) return 'gentle';
  if (d < 6) return 'moderate';
  if (d < 8) return 'hard';
  return 'brutal';
}

/** The band as a word to show, matching difficultyBand exactly. */
export const DIFFICULTY_WORDS = {
  easy: 'Easy',
  gentle: 'Gentle',
  moderate: 'Moderate',
  hard: 'Hard',
  brutal: 'Brutal'
};

export const difficultyWord = (d) => DIFFICULTY_WORDS[difficultyBand(d)] || '';

/* ── who may see it ────────────────────────────────────────────────────
   Two switches, and one of them wins.

   A collection set to "this club only" is a promise about everything inside
   it, so a puzzle in that collection does not get to disagree — its own
   switch is not overridden and thrown away, it is set aside. Put the
   collection back to "everyone" and each puzzle's own answer applies again,
   exactly as it was left. That is why the puzzle's own value is still
   stored while the collection is closed: taking it away would mean every
   author retyping their choices the moment a collection reopened.
   ─────────────────────────────────────────────────────────────────── */

export const VISIBILITIES = ['club', 'public'];

export const normalizeVisibility = (v, fallback = 'club') =>
  (v === 'public' || v === 'club' ? v : fallback);

/**
 * What a collection forces on everything filed under it, or null if it
 * forces nothing and each puzzle answers for itself.
 *
 * Two collections decide for their contents, in opposite directions:
 *
 *   · a club-only collection closes over everything on it, whatever each
 *     puzzle says for itself
 *   · a CUSTOM collection is always public, and that is not a default a
 *     club can change. A members' shelf exists to be read from outside the
 *     club — that is the whole of what /library is — so a private one is a
 *     shelf with no purpose. Forcing it here rather than in each screen is
 *     what stops the two disagreeing.
 */
export function forcedVisibility(collection) {
  if (!collection) return null;
  if (collection.kind === 'custom') return 'public';
  if (normalizeVisibility(collection.visibility) === 'club') return 'club';
  return null;
}

/** True while the collection is deciding, so the puzzle's own switch is inert. */
export const visibilityLocked = (collection) => forcedVisibility(collection) !== null;

/**
 * Who can actually see this puzzle, collection included.
 * @param {object} puzzle
 * @param {object|null} collection  the puzzle's collection, or null if unfiled
 */
export function effectiveVisibility(puzzle, collection) {
  const forced = forcedVisibility(collection);
  if (forced) return forced;
  /* A member's own puzzle never had a switch to set — the shelf an admin
     let them onto is the whole of the permission they were given, so it
     follows that shelf in both directions and cannot drift from it. */
  if ((puzzle || {}).custom) {
    return collection ? normalizeVisibility(collection.visibility) : 'club';
  }
  return normalizeVisibility((puzzle || {}).visibility);
}

/** Whether this puzzle belongs in the free, cross-club library. */
export const isPublic = (puzzle, collection) => effectiveVisibility(puzzle, collection) === 'public';

/* ── whose it is ───────────────────────────────────────────────────────
   Anonymous mode is per person, not per puzzle. An adopted puzzle carries
   two names — the admin who published it and the student it came from —
   and either of them may have asked not to be named without that saying
   anything about the other. So both are answered separately, and the club
   is what is left when nobody is named.
   ─────────────────────────────────────────────────────────────────── */

/**
 * The credit line for a puzzle.
 *
 * @param {object} puzzle
 * @param {object} [opts]  showClub — name the club as well, which is what
 *                         the library outside a club always wants and a
 *                         club's own page never needs
 * @returns {{ names: string[], club: string|null, anonymous: boolean }}
 */
export function bylineOf(puzzle, opts = {}) {
  const p = puzzle || {};
  const names = [];
  if (!p.anonymous && p.authorName) names.push(String(p.authorName));
  if (p.originalAuthorName && !p.originalAnonymous) names.push(String(p.originalAuthorName));

  const club = opts.showClub && p.clubName ? String(p.clubName) : null;
  return {
    names,
    /* With nobody named the club is the only honest credit left, so it is
       shown even where it otherwise would not be. */
    club: club || (!names.length && p.clubName ? String(p.clubName) : null),
    anonymous: !names.length
  };
}

/** The credit line as one string, or '' when there is nothing to say. */
export function bylineText(puzzle, opts = {}) {
  const b = bylineOf(puzzle, opts);
  const who = b.names.length
    ? (b.names.length === 1 ? b.names[0] : `${b.names[0]} · adapted from ${b.names[1]}`)
    : 'Anonymous';
  return b.club ? `${who} · ${b.club}` : who;
}

/* ── a collection ──────────────────────────────────────────────────── */

/** The one collection a club does not have to make: it is simply there. */
export const DEFAULT_COLLECTION_ID = 'custom';
export const DEFAULT_COLLECTION_NAME = 'Custom';

/* ── the shelf that belongs to no club ─────────────────────────────────
   A puzzle built from /library, by somebody who is in no club at all, has
   nowhere to go under the old rule that every puzzle lives in a club. So
   one shelf exists outside every club and takes them.

   It is keyed by a club id no club can hold. Club ids come from Firestore
   auto-ids and from slugs, and neither can begin with two underscores, so
   `__global` cannot be claimed out from under this. The mirror key it
   produces, `__global__custom`, is built by the same mirrorId() as every
   other copy, so nothing downstream has to know it is special.
   ─────────────────────────────────────────────────────────────────── */
export const GLOBAL_CLUB_ID = '__global';
export const GLOBAL_CLUB_NAME = 'JagChess';
export const GLOBAL_COLLECTION_NAME = 'Global custom';

/** A puzzle or collection that lives on the global shelf rather than in a club. */
export const isGlobal = (clubId) => clubId === GLOBAL_CLUB_ID;

/* What it was called for an afternoon. A club that was given the shelf under
   that name reads as the new one without anything being written: the name is
   mapped here, on the way out, rather than repaired on the way in.

   Repairing it was the obvious thing and it was wrong. The repair ran from a
   snapshot handler, so a write that got refused — and a member may not rename
   a collection — was rolled back, which produced a snapshot that asked for
   the repair again. The name flickered between the two. Nothing a screen
   shows should depend on a write landing. */
export const LEGACY_DEFAULT_NAMES = ['Made by members'];

/**
 * A shelf of puzzles.
 *
 * `kind` is the only thing about a collection that changes what may go in
 * it: a `custom` collection is the one place a member may publish, and it
 * is also the one place an admin goes looking for something to adopt. Staff
 * collections take staff puzzles and nothing else.
 *
 * `isDefault` marks the one every club is born with. It cannot be renamed
 * out of existence or deleted, because a member who wants to build a puzzle
 * should never have to wait for an admin to open somewhere to put it.
 */
export function normalizeCollection(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const isDefault = c.isDefault === true || c.id === DEFAULT_COLLECTION_ID;
  const stored = String(c.name || '').slice(0, 80);
  const legacy = isDefault && (!stored || LEGACY_DEFAULT_NAMES.indexOf(stored) !== -1);
  const kind = isDefault || c.kind === 'custom' ? 'custom' : 'staff';
  return {
    id: c.id,
    isDefault,
    name: legacy ? DEFAULT_COLLECTION_NAME : stored,
    description: String(c.description || '').slice(0, 400),
    icon: String(c.icon || '').slice(0, 8),
    color: String(c.color || '').slice(0, 24),
    kind: kind,
    /* Not what was stored: a custom shelf is public and cannot be anything
       else, so an old document still saying 'club' reads as public rather
       than being repaired by a write that a member is not allowed to make. */
    visibility: kind === 'custom' ? 'public' : normalizeVisibility(c.visibility),
    clubId: c.clubId || null,
    clubName: c.clubName || null,
    createdBy: c.createdBy || null,
    createdByName: c.createdByName || null,
    anonymous: c.anonymous === true,
    createdAt: Number(c.createdAt) || 0,
    updatedAt: Number(c.updatedAt) || 0
  };
}

/* ── the whole puzzle, cleaned up ──────────────────────────────────── */

export function normalizePuzzle(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const tree = treeOf(p);
  const stats = treeStats(tree);
  return {
    id: p.id,
    title: String(p.title || '').slice(0, 140),
    description: String(p.description || '').slice(0, 600),
    source: String(p.source || '').slice(0, 500),
    fen: String(p.fen || ''),
    playerColor: p.playerColor === 'b' ? 'b' : 'w',
    points: Math.max(0, Math.trunc(Number(p.points) || 0)),
    expiresAt: Number(p.expiresAt) || 0,
    latePenaltyPct: clamp(Math.trunc(Number(p.latePenaltyPct) || 0), 0, 100),
    difficulty: clampDifficulty(p.difficulty),

    /* where it lives, and who may see it. `categoryId` is what this field
       was called for about an afternoon; reading it too costs one `||` and
       saves anything filed in that time from coming loose. */
    collectionId: String(p.collectionId || p.categoryId || ''),
    visibility: normalizeVisibility(p.visibility),

    /* whose it is. A puzzle with no author at all predates the field; it is
       left unnamed rather than being credited to whoever is reading it. */
    authorUid: p.authorUid ? String(p.authorUid) : '',
    authorName: String(p.authorName || ''),
    anonymous: p.anonymous === true,
    clubId: p.clubId ? String(p.clubId) : '',
    clubName: String(p.clubName || ''),

    /* a student's own puzzle, which is what makes it adoptable and what
       keeps it from being worth points */
    custom: p.custom === true,

    /* and, if it was adopted, the person it came from and what they were
       paid for it */
    originalPuzzleId: p.originalPuzzleId ? String(p.originalPuzzleId) : '',
    originalAuthorUid: p.originalAuthorUid ? String(p.originalAuthorUid) : '',
    originalAuthorName: String(p.originalAuthorName || ''),
    originalAnonymous: p.originalAnonymous === true,
    prizePoints: Math.max(0, Math.trunc(Number(p.prizePoints) || 0)),

    tree,
    stats,
    createdAt: Number(p.createdAt) || 0,
    updatedAt: Number(p.updatedAt) || 0
  };
}

/** Only links are shown as a source button, and only ones a browser will open. */
export function sourceHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch (_) { return null; }
}

export const sourceLabel = (href) => {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch (_) { return 'Source'; }
};
