/* ═══════════════════════════════════════════════════════════════════════
   tests/puzzle-model.test.mjs — the puzzle graph, checked without a browser.

   There is no Firestore emulator on this machine, so the way anything here
   gets tested is by not needing one: puzzle-model.js is the whole of what a
   puzzle means and touches nothing but chess.js. This file is why it is
   split out.

   Run it with:  node tests/puzzle-model.test.mjs

   Two of these were written after the bug, not before it, and both are the
   kind that ships silently:
     · two transpositions have different FENs and the same position, so
       merging compared the wrong thing and refused every honest merge
     · the cycle guard asked "is `into` below `id`" when the question is the
       other way round, which let you merge a move into its own ancestor and
       publish a puzzle that never ends
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// the vendored chess.js is a plain script that defines a global
const src = fs.readFileSync(path.join(root, 'assets/vendor/chess/chess.min.js'), 'utf8');
vm.runInThisContext(src + '\nglobalThis.Chess = Chess;');

/* The module under test is a browser file, and this package is declared
   commonjs — so node would read its `export` as a syntax error. It imports
   nothing itself, which makes handing it over as a data URL the honest way
   to load the real file rather than a copy of it. */
const source = fs.readFileSync(path.join(root, 'assets/js/puzzle-model.js'), 'utf8');
const M = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : extra); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ── legacy linear puzzles still load ────────────────────────────────
{
  const t = M.treeFromSolution(['e4', 'e5', 'Nf3']);
  const s = M.treeStats(t);
  eq('legacy: node count', s.nodes, 3);
  eq('legacy: one line', s.lines, 1);
  eq('legacy: player moves', s.moves, 2);   // e4 and Nf3
  eq('legacy: no branches', s.branches, 0);

  const p = M.normalizePuzzle({ solution: ['e4', 'e5', 'Nf3'], fen: START, points: 10 });
  eq('legacy: normalize keeps moves', p.stats.moves, 2);
}

// ── building a tree by hand ─────────────────────────────────────────
{
  let t = M.normalizeTree(null);
  eq('empty tree has just a root', Object.keys(t.nodes).length, 1);
  eq('empty stats', M.treeStats(t).moves, 0);
  ok('empty flagged', M.treeStats(t).empty);

  let r = M.addMove(t, M.ROOT, 'e4'); t = r.tree;
  const e4 = r.id;
  ok('e4 created', r.created);

  // replaying the same move follows it rather than duplicating it
  const again = M.addMove(t, M.ROOT, 'e4');
  ok('replay does not duplicate', !again.created);
  eq('replay returns same node', again.id, e4);

  r = M.addMove(t, e4, 'e5'); t = r.tree;
  const e5 = r.id;
  r = M.addMove(t, e5, 'Nf3'); t = r.tree;
  const nf3 = r.id;

  eq('fen after e4 e5 Nf3', M.fenAt(t, START, nf3),
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  eq('depth of Nf3', M.depthOf(t, nf3), 3);
  eq('to move at Nf3', M.toMoveAt(t, nf3), 'opponent');
  eq('to move at e5', M.toMoveAt(t, e5), 'player');
  ok('Nf3 is an end', M.isEnd(t, nf3));
  eq('child lookup', M.childByMove(t, M.ROOT, 'e4'), e4);
  eq('child lookup miss', M.childByMove(t, M.ROOT, 'd4'), null);

  // ── a second good move branches ───────────────────────────────────
  r = M.addMove(t, e5, 'Bc4'); t = r.tree;
  const bc4 = r.id;
  let s = M.treeStats(t);
  eq('two lines now', s.lines, 2);
  eq('branch count', s.branches, 2);
  eq('shortest is still 2', s.moves, 2);

  // ── deleting one branch leaves the other ──────────────────────────
  let t2 = M.deleteNode(t, bc4);
  eq('delete drops the branch', M.treeStats(t2).lines, 1);
  ok('other branch survives', !!t2.nodes[nf3]);

  // ── deleting a move takes its continuation with it ────────────────
  let t3 = M.deleteNode(t, e5);
  eq('deleting e5 removes everything under it', M.treeStats(t3).nodes, 1);
}

// ── merging two lines that reach the same position ──────────────────
{
  // 1. e4 e5 2. Nf3 Nc6   and   1. Nf3 Nc6 2. e4 e5  -> same position
  let t = M.normalizeTree(null);
  let r;
  r = M.addMove(t, M.ROOT, 'e4'); t = r.tree; const a1 = r.id;
  r = M.addMove(t, a1, 'e5');     t = r.tree; const a2 = r.id;
  r = M.addMove(t, a2, 'Nf3');    t = r.tree; const a3 = r.id;
  r = M.addMove(t, a3, 'Nc6');    t = r.tree; const a4 = r.id;
  r = M.addMove(t, a4, 'Bb5');    t = r.tree; const a5 = r.id;

  r = M.addMove(t, M.ROOT, 'Nf3'); t = r.tree; const b1 = r.id;
  r = M.addMove(t, b1, 'Nc6');     t = r.tree; const b2 = r.id;
  r = M.addMove(t, b2, 'e4');      t = r.tree; const b3 = r.id;
  r = M.addMove(t, b3, 'e5');      t = r.tree; const b4 = r.id;

  ok('transposed FENs differ on paper',
    M.fenAt(t, START, a4) !== M.fenAt(t, START, b4));
  eq('but they are the same position',
    M.keyAt(t, START, a4), M.keyAt(t, START, b4));

  const cands = M.mergeCandidates(t, START, b4);
  ok('merge candidate found', cands.includes(a4), cands);

  const before = M.treeStats(t).lines;
  eq('two separate lines before merge', before, 2);

  const merged = M.mergeNodes(t, START, b4, a4);
  ok('merge accepted', merged.ok, merged.why);
  t = merged.tree;
  eq('merged graph still has two lines', M.treeStats(t).lines, 2);
  ok('the shared continuation is not duplicated', !!t.nodes[a5]);
  ok('the folded node is gone', !t.nodes[b4]);
  // both routes now end on Bb5
  const lines = M.allLines(t);
  ok('every line ends on the shared move', lines.every((l) => l[l.length - 1] === a5), lines.length);

  // ── a merge that would loop is refused ────────────────────────────
  const loop = M.mergeNodes(t, START, a1, a5);
  ok('circular merge refused', !loop.ok);

  // ── a merge between different positions is refused ────────────────
  const wrong = M.mergeNodes(t, START, a3, a1);
  ok('mismatched merge refused', !wrong.ok);
}

// ── dangling children never crash the solver ────────────────────────
{
  const t = M.normalizeTree({ nodes: { r: { children: ['ghost', 'x'] }, x: { san: 'e4', children: [] } } });
  eq('dangling child dropped', t.nodes.r.children.length, 1);
  eq('real child kept', t.nodes.r.children[0], 'x');
  eq('stats survive', M.treeStats(t).nodes, 1);
}

// ── unreachable nodes are pruned on load ────────────────────────────
{
  const t = M.normalizeTree({ nodes: { r: { children: [] }, orphan: { san: 'e4', children: [] } } });
  ok('orphan pruned', !t.nodes.orphan);
}

// ── scoring ─────────────────────────────────────────────────────────
{
  const now = 1000;
  eq('no expiry: full points', M.scoreFor({ points: 10 }, now).points, 10);
  eq('before expiry: full points',
    M.scoreFor({ points: 10, expiresAt: 2000, latePenaltyPct: 40 }, now).points, 10);

  const late = M.scoreFor({ points: 10, expiresAt: 500, latePenaltyPct: 40 }, now);
  eq('after expiry: cut applied', late.points, 6);
  ok('after expiry: flagged late', late.late);
  eq('penalty reported', late.penalty, 4);

  // truncation, not rounding — 25 at 33% off is 16.75
  eq('truncates down',
    M.scoreFor({ points: 25, expiresAt: 1, latePenaltyPct: 33 }, now).points, 16);
  eq('truncates 7 at 15% off',
    M.scoreFor({ points: 7, expiresAt: 1, latePenaltyPct: 15 }, now).points, 5);   // 5.95
  eq('100% off is nothing',
    M.scoreFor({ points: 50, expiresAt: 1, latePenaltyPct: 100 }, now).points, 0);
  eq('0% off is everything',
    M.scoreFor({ points: 50, expiresAt: 1, latePenaltyPct: 0 }, now).points, 50);
  eq('over 100 clamps', M.scoreFor({ points: 50, expiresAt: 1, latePenaltyPct: 250 }, now).points, 0);
  eq('negative clamps', M.scoreFor({ points: 50, expiresAt: 1, latePenaltyPct: -5 }, now).points, 50);

  ok('hasExpired true', M.hasExpired({ expiresAt: 500 }, now));
  ok('hasExpired false with no date', !M.hasExpired({}, now));
}

// ── source links ────────────────────────────────────────────────────
{
  eq('bare domain gets https', M.sourceHref('lichess.org/training/1'), 'https://lichess.org/training/1');
  eq('https kept', M.sourceHref('https://x.com/a'), 'https://x.com/a');
  eq('empty is null', M.sourceHref('  '), null);
  eq('javascript refused', M.sourceHref('javascript:alert(1)'), null);
  eq('label is the host', M.sourceLabel('https://www.lichess.org/x'), 'lichess.org');
}


// ── a merge into an ancestor would loop forever ─────────────────────
{
  // 1.Nf3 Nf6 2.Ng1 Ng8 puts the board back where it started
  let t = M.normalizeTree(null);
  let r;
  r = M.addMove(t, M.ROOT, 'Nf3'); t = r.tree; const m1 = r.id;
  r = M.addMove(t, m1, 'Nf6');     t = r.tree; const m2 = r.id;
  r = M.addMove(t, m2, 'Ng1');     t = r.tree; const m3 = r.id;
  r = M.addMove(t, m3, 'Ng8');     t = r.tree; const m4 = r.id;

  eq('shuffle returns to the start', M.keyAt(t, START, m4), M.positionKey(START));
  ok('merging into the root is refused', !M.mergeNodes(t, START, m4, M.ROOT).ok);

  // 3.Nf3 repeats the position after 1.Nf3
  r = M.addMove(t, m4, 'Nf3'); t = r.tree; const m5 = r.id;
  eq('and repeats after that', M.keyAt(t, START, m5), M.keyAt(t, START, m1));

  const loop = M.mergeNodes(t, START, m5, m1);
  ok('merging a move into its own ancestor is refused', !loop.ok, loop.why);
  ok('and the other way round too', !M.mergeNodes(t, START, m1, m5).ok);
  ok('neither is offered as a candidate', !M.mergeCandidates(t, START, m5).includes(m1));
  eq('a refused merge changes nothing', M.treeStats(t).nodes, 5);
  ok('the graph is still walkable', M.allLines(t).length >= 1);
}

// ── a legitimate cross-branch merge still works ─────────────────────
{
  let t = M.normalizeTree(null);
  let r;
  r = M.addMove(t, M.ROOT, 'd4');  t = r.tree; const a1 = r.id;
  r = M.addMove(t, a1, 'd5');      t = r.tree; const a2 = r.id;
  r = M.addMove(t, a2, 'c4');      t = r.tree; const a3 = r.id;
  r = M.addMove(t, a3, 'e6');      t = r.tree; const a4 = r.id;
  r = M.addMove(t, a4, 'Nc3');     t = r.tree; const a5 = r.id;

  r = M.addMove(t, M.ROOT, 'c4');  t = r.tree; const b1 = r.id;
  r = M.addMove(t, b1, 'e6');      t = r.tree; const b2 = r.id;
  r = M.addMove(t, b2, 'd4');      t = r.tree; const b3 = r.id;
  r = M.addMove(t, b3, 'd5');      t = r.tree; const b4 = r.id;

  eq('two move orders, one position', M.keyAt(t, START, b4), M.keyAt(t, START, a4));
  ok('candidate offered', M.mergeCandidates(t, START, b4).includes(a4));
  const m = M.mergeNodes(t, START, b4, a4);
  ok('cross-branch merge still allowed', m.ok, m.why);
  t = m.tree;
  ok('shared continuation kept once', !!t.nodes[a5]);
  eq('still two routes in', M.allLines(t).length, 2);
  ok('both end on the shared move', M.allLines(t).every((l) => l[l.length - 1] === a5));
  eq('player moves counted through the merge', M.treeStats(t).moves, 3);
}

/* ═══════════════════════════════════════════════════════════════════════
   The library: difficulty, who may see a puzzle, and whose name goes on it.

   All three are pure, and all three are the kind of rule that is wrong in
   production for weeks because nothing crashes — a puzzle quietly shared
   that should not have been, or a student credited on something they asked
   to be anonymous on. So they are checked here rather than by eye.
   ═══════════════════════════════════════════════════════════════════════ */

// ── difficulty out of ten ───────────────────────────────────────────
{
  eq('unset stays unset', M.clampDifficulty(null), null);
  eq('empty is unset, not zero', M.clampDifficulty(''), null);
  eq('zero is a real answer', M.clampDifficulty(0), 0);
  eq('a string from a range input', M.clampDifficulty('6.5'), 6.5);
  eq('rounded to one decimal', M.clampDifficulty(6.54321), 6.5);
  eq('clamped above', M.clampDifficulty(99), 10);
  eq('clamped below', M.clampDifficulty(-4), 0);
  eq('nonsense is unset', M.clampDifficulty('hard'), null);

  eq('written to one place', M.difficultyText(7), '7.0');
  eq('and never as float noise', M.difficultyText(0.1 + 0.2), '0.3');
  eq('nothing to write', M.difficultyText(null), '');

  /* Five even bands, so the middle of the scale lands in the middle one.
     With four the boundaries fell at 2.5, 5 and 7.5, and 5.0 — the one
     number that means "average" — came out as "tough" in warning orange. */
  eq('band: easy', M.difficultyBand(1), 'easy');
  eq('band: gentle', M.difficultyBand(2), 'gentle');
  eq('band: moderate', M.difficultyBand(5), 'moderate');
  eq('the midpoint is neutral', M.difficultyBand(5.5), 'moderate');
  eq('and so is the default the builder starts on', M.difficultyBand(5), 'moderate');
  eq('band: hard', M.difficultyBand(6), 'hard');
  eq('band: brutal', M.difficultyBand(8), 'brutal');
  eq('the very bottom', M.difficultyBand(0), 'easy');
  eq('and the very top', M.difficultyBand(10), 'brutal');
  eq('band of nothing', M.difficultyBand(null), null);

  eq('every band has a word', M.difficultyWord(5), 'Moderate');
  eq('and nothing has none', M.difficultyWord(null), '');

  eq('normalized onto the puzzle', M.normalizePuzzle({ difficulty: '3.25' }).difficulty, 3.3);
  eq('an old puzzle has none', M.normalizePuzzle({}).difficulty, null);
}

// ── the collection is the outer switch ────────────────────────────────
{
  const openColl = { id: 'c1', visibility: 'public', kind: 'staff' };
  const shutColl = { id: 'c1', visibility: 'club', kind: 'staff' };
  const shared = { visibility: 'public' };
  const kept = { visibility: 'club' };

  eq('no collection: the puzzle decides', M.effectiveVisibility(shared, null), 'public');
  eq('open collection, shared puzzle', M.effectiveVisibility(shared, openColl), 'public');
  eq('open collection, kept puzzle', M.effectiveVisibility(kept, openColl), 'club');
  eq('shut collection overrides', M.effectiveVisibility(shared, shutColl), 'club');

  ok('the switch is inert while shut', M.visibilityLocked(shutColl));
  ok('and live while open', !M.visibilityLocked(openColl));
  ok('no collection locks nothing', !M.visibilityLocked(null));

  /* The whole point of overriding rather than overwriting: reopening the
     collection has to give every puzzle back the answer it had. */
  eq('the puzzle kept its own answer', shared.visibility, 'public');
  eq('and gets it back', M.effectiveVisibility(shared, openColl), 'public');

  eq('isPublic agrees', M.isPublic(shared, shutColl), false);
  eq('isPublic agrees the other way', M.isPublic(shared, openColl), true);

  // a member's puzzle has no switch of its own — it follows its shelf
  const mine = { custom: true, visibility: 'club' };
  eq('a member follows an open shelf', M.effectiveVisibility(mine, openColl), 'public');
  eq('and a shut one', M.effectiveVisibility(mine, shutColl), 'club');
  eq('with no shelf at all it stays in', M.effectiveVisibility({ custom: true, visibility: 'public' }, null), 'club');

  eq('anything else is club', M.normalizeVisibility('nonsense'), 'club');
  eq('and public survives', M.normalizeVisibility('public'), 'public');
}

// ── whose name goes on it ───────────────────────────────────────────
{
  const mine = { authorName: 'Ada', clubName: 'Jags' };
  eq('the author, inside their own club', M.bylineText(mine, {}), 'Ada');
  eq('and the club, outside it', M.bylineText(mine, { showClub: true }), 'Ada · Jags');

  const hidden = { authorName: 'Ada', anonymous: true, clubName: 'Jags' };
  eq('anonymous leaves only the club', M.bylineText(hidden, {}), 'Anonymous · Jags');
  ok('and names nobody', M.bylineOf(hidden, {}).names.length === 0);
  ok('which the club is asked to cover', M.bylineOf(hidden, {}).club === 'Jags');

  const adopted = {
    authorName: 'Mr Lee', originalAuthorName: 'Ada', clubName: 'Jags'
  };
  eq('both names on an adopted puzzle', M.bylineText(adopted, {}), 'Mr Lee · adapted from Ada');

  /* Anonymity is per person: the student asking not to be named says
     nothing about the admin who adopted it, and the other way round. */
  const adoptedQuiet = { ...adopted, originalAnonymous: true };
  eq('the student stays out of it', M.bylineText(adoptedQuiet, {}), 'Mr Lee');
  const adopterQuiet = { ...adopted, anonymous: true };
  eq('and so can the adopter', M.bylineText(adopterQuiet, {}), 'Ada');

  eq('nobody at all, no club', M.bylineText({}, {}), 'Anonymous');
}

// ── the puzzle as stored ────────────────────────────────────────────
{
  const p = M.normalizePuzzle({
    title: 'Fork', collectionId: 'c1', visibility: 'public', anonymous: true,
    authorUid: 'u1', authorName: 'Ada', custom: true, points: '12',
    originalAuthorUid: 'u0', originalAuthorName: 'Bo', prizePoints: '5.9'
  });
  eq('collection kept', p.collectionId, 'c1');
  eq('visibility kept', p.visibility, 'public');
  eq('anonymous kept', p.anonymous, true);
  eq('author kept', p.authorName, 'Ada');
  eq('custom kept', p.custom, true);
  eq('points are whole', p.points, 12);
  eq('the prize is whole too', p.prizePoints, 5);
  eq('the original is remembered', p.originalAuthorName, 'Bo');
  eq('and defaults are honest', M.normalizePuzzle({}).custom, false);
  eq('an unfiled puzzle', M.normalizePuzzle({}).collectionId, '');
  eq('and a private one', M.normalizePuzzle({}).visibility, 'club');
}

// ── a collection, cleaned up ──────────────────────────────────────────
{
  const c = M.normalizeCollection({
    id: 'c1', name: 'Endgames', kind: 'custom', visibility: 'public',
    createdByName: 'Ada', clubName: 'Jags'
  });
  eq('kind kept', c.kind, 'custom');
  eq('visibility kept', c.visibility, 'public');
  eq('name kept', c.name, 'Endgames');
  eq('a collection is staff-only by default', M.normalizeCollection({}).kind, 'staff');
  eq('and club-only by default', M.normalizeCollection({}).visibility, 'club');
  eq('junk kind falls back', M.normalizeCollection({ kind: 'whatever' }).kind, 'staff');
}


// ── the collection every club is born with ──────────────────────────
{
  eq('it has a fixed id', M.DEFAULT_COLLECTION_ID, 'custom');
  eq('and a name', M.DEFAULT_COLLECTION_NAME, 'Custom');
  ok('with the name it used to have remembered',
    M.LEGACY_DEFAULT_NAMES.indexOf('Made by members') !== -1);

  /* The id alone marks it, so a document written before the flag existed
     is still recognised as the one that cannot be taken away. */
  const byId = M.normalizeCollection({ id: 'custom', name: M.DEFAULT_COLLECTION_NAME });
  ok('the id alone marks it', byId.isDefault);
  eq('and forces it to take members’ puzzles', byId.kind, 'custom');

  const flagged = M.normalizeCollection({ id: 'anything', isDefault: true, kind: 'staff' });
  ok('so does the flag', flagged.isDefault);
  eq('which wins over a staff-only kind', flagged.kind, 'custom');

  ok('an ordinary shelf is not it', !M.normalizeCollection({ id: 'endings' }).isDefault);

  /* The name it was given for an afternoon reads as the new one without
     anything being written. Repairing it on the way in is what made the
     name flicker: the repair ran from a snapshot handler, and a refused
     write rolled back into a snapshot that asked for the repair again. */
  eq('the first name reads as the new one',
    M.normalizeCollection({ id: 'custom', name: 'Made by members' }).name, 'Custom');
  eq('and so does no name at all',
    M.normalizeCollection({ id: 'custom' }).name, 'Custom');
  eq('a club that renamed it keeps their name',
    M.normalizeCollection({ id: 'custom', name: 'Our own' }).name, 'Our own');
  eq('and an ordinary shelf is never renamed for them',
    M.normalizeCollection({ id: 'endings', name: 'Made by members' }).name, 'Made by members');
}

// ── the old field name still reads ──────────────────────────────────
{
  eq('a puzzle filed before the rename', M.normalizePuzzle({ categoryId: 'c1' }).collectionId, 'c1');
  eq('and one filed after', M.normalizePuzzle({ collectionId: 'c2' }).collectionId, 'c2');
  eq('the new name wins', M.normalizePuzzle({ collectionId: 'c2', categoryId: 'c1' }).collectionId, 'c2');
}

// ── a custom shelf is public, and has no private mode ───────────
//    The rules used to hardcode the opposite, so these say which way round
//    it is now. A stored 'club' on a custom shelf is a document written
//    under the old rule: it has to READ as public without anything being
//    written, because a member is not allowed to rewrite it.
{
  const custom = M.normalizeCollection({ id: 'custom', kind: 'custom', visibility: 'club' });
  eq('a custom shelf stored club-only still reads public', custom.visibility, 'public');
  eq('and is still custom', custom.kind, 'custom');
  eq('the default shelf is custom whatever it says',
    M.normalizeCollection({ id: 'custom', kind: 'staff' }).kind, 'custom');
  eq('and public with it',
    M.normalizeCollection({ id: 'custom', kind: 'staff' }).visibility, 'public');
  eq('a staff shelf keeps club-only',
    M.normalizeCollection({ id: 's1', kind: 'staff', visibility: 'club' }).visibility, 'club');
  eq('and a staff shelf set public keeps that',
    M.normalizeCollection({ id: 's2', kind: 'staff', visibility: 'public' }).visibility, 'public');
}

// ── what a shelf forces on what is filed under it ───────────────
{
  const custom = M.normalizeCollection({ id: 'custom', kind: 'custom' });
  const shut = M.normalizeCollection({ id: 's1', kind: 'staff', visibility: 'club' });
  const open = M.normalizeCollection({ id: 's2', kind: 'staff', visibility: 'public' });

  eq('a custom shelf forces public', M.forcedVisibility(custom), 'public');
  eq('a club-only staff shelf forces club', M.forcedVisibility(shut), 'club');
  eq('an open staff shelf forces nothing', M.forcedVisibility(open), null);
  eq('no shelf forces nothing', M.forcedVisibility(null), null);

  ok('both kinds of forcing count as locked',
    M.visibilityLocked(custom) && M.visibilityLocked(shut));
  ok('an open staff shelf is not locked', !M.visibilityLocked(open));

  eq('a member puzzle on a custom shelf is public',
    M.effectiveVisibility({ custom: true, visibility: 'club' }, custom), 'public');
  eq('a staff puzzle on a custom shelf is public too',
    M.effectiveVisibility({ custom: false, visibility: 'club' }, custom), 'public');
  eq('a club-only staff shelf still closes over its puzzles',
    M.effectiveVisibility({ visibility: 'public' }, shut), 'club');
  eq('and an unfiled member puzzle is still club-only',
    M.effectiveVisibility({ custom: true }, null), 'club');
  ok('so a custom shelf puzzle belongs in the library',
    M.isPublic({ custom: true, visibility: 'club' }, custom));
}

// ── the shelf that belongs to no club ───────────────────────
{
  eq('the global club id', M.GLOBAL_CLUB_ID, '__global');
  ok('it is recognised', M.isGlobal(M.GLOBAL_CLUB_ID));
  ok('a real club is not', !M.isGlobal('abc123') && !M.isGlobal('') && !M.isGlobal(null));
  // the key must be built the ordinary way, or the security rule that
  // rebuilds it from the document data will not match what we wrote
  eq('the mirror key is the ordinary one',
    M.GLOBAL_CLUB_ID + '__' + M.DEFAULT_COLLECTION_ID, '__global__custom');
  eq('the global shelf is named', M.GLOBAL_COLLECTION_NAME, 'Global custom');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
