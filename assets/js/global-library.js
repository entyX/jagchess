/* ═══════════════════════════════════════════════════════════════════════
   global-library.js — /library, the puzzle library outside any club.

   Every club that has decided to share a collection puts a copy of it, and of
   the puzzles on it, where anybody signed in to JagChess can read them. This
   page is the whole of what those copies are for: one shelf per collection, a
   board, and a credit line on everything saying which club it came from and
   who made it.

   Two things are different here from the same panel inside a club, and both
   come from the same fact — the club is somebody else's:

     · a puzzle is only worth points to somebody who is actually in the club
       that published it. For everybody else the solve is real and the score
       is not, which the board says plainly rather than quietly awarding
       nothing
     · a member building their own puzzle has to choose a club to publish
       into, because a puzzle with no club has nowhere to live and nobody to
       moderate it

   The ids need a word. A club's puzzle is `pz1` inside its own club and two
   clubs will both have a `pz1`, so the copies are keyed `clubId__localId`
   and that is the id this page uses throughout — including for the link
   from a puzzle to its collection, which is rewritten on the way in. The
   local id is kept alongside, because writing an attempt back means writing
   it into the club's own collection under the name the club knows.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, getDoc, setDoc, updateDoc, onSnapshot, query, orderBy, limit,
  collection, increment, memberRef, esc, toast
} from './club-core.js';

import { normalizePuzzle, normalizeCollection, scoreFor, sourceHref, sourceLabel } from './puzzle-model.js';
import {
  mountLibrary, bylineHTML, difficultyChip, mirrorId, mergeCustomCollections,
  ensureGlobalCollection, ensureClubShelfMirrored, globalCollection, globalClub,
  GLOBAL_CLUB_ID, GLOBAL_CLUB_NAME, DEFAULT_COLLECTION_ID, isGlobal
} from './puzzle-library.js';
import { mountSolver, celebrate, openBuilderModal, adoptPuzzle } from './club-puzzles.js';
import { bootHub } from './hub-shell.js';
import { watchActiveDuels, gameOf } from './club-duels.js';

const $ = (id) => document.getElementById(id);

/* A shared shelf is not unlimited, and a page that tries to draw every
   puzzle on JagChess at once is a page that never finishes drawing. */
const CAP_COLLECTIONS = 300;
const CAP_PUZZLES = 800;

(async function init() {
  const ctx = await bootHub('library');

  $('hub-boot').hidden = true;
  $('hub-body').hidden = false;

  /* Which clubs you are actually in, which is the only thing that decides
     whether a solve here is worth anything. The index on your profile is
     enough to ask the question; the club's own row is what answers it when
     the points are written. */
  const myClubs = (ctx.member && ctx.member.clubs) || {};
  const amIn = (clubId) => !!myClubs[clubId];

  /* The club index carries your role, not just the fact of membership, which
     is what lets an admin adopt a member's puzzle from out here. It is only
     ever your OWN club: adopting pays the author out of their club's points
     and retires their original, and both of those are writes only that
     club's staff may make. An admin of one club browsing another's shelf is
     a reader, and the button is simply not there. */
  const isStaffOf = (clubId) => myClubs[clubId] === 'admin' || myClubs[clubId] === 'founder';

  let collections = [];
  let puzzles = [];
  let current = null;
  let solver = null;
  let attempt = null;          // the row for the puzzle on the board, if any

  const host = $('hub-main');
  host.innerHTML = `
    <div class="puzzle-layout lib-layout">
      <div class="tile puzzle-board" id="pz-board-tile">
        <div class="puzzle-header">
          <h3 id="pz-title">The puzzle board</h3>
          <div class="pz-head-tools" id="pz-head-tools"></div>
        </div>
        <div class="pz-byline" id="pz-byline" hidden></div>
        <p class="pz-desc" id="pz-desc" hidden></p>
        <div class="pz-award-note" id="pz-award" hidden></div>
        <div id="pz-solver"></div>
        <div class="empty-state" id="pz-none">
          Pick a collection below, then a puzzle, and it opens here.
        </div>
      </div>
      <div class="tile lib-aside">
        <h3>Build one of your own</h3>
        <p>Anybody can make a puzzle. It goes onto a club's custom shelf, where the club's
          admins can adopt it — and if one does, you are paid for it.</p>
        <button class="btn primary block" id="lib-make" type="button">Create custom puzzle</button>
        <p class="field-hint" id="lib-make-hint"></p>
      </div>
    </div>
    <div class="tile pzlib-tile" id="pz-library"></div>`;

  const library = mountLibrary($('pz-library'), {
    title: 'Puzzle library',
    sub: 'Every collection clubs have chosen to share, with the club and the person behind it.',
    showClub: true,
    emptyText: 'No club has shared a collection yet.',
    onPick: (p) => {
      select(p);
      const tile = $('pz-board-tile');
      if (tile && tile.scrollIntoView) tile.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    tools: (p) => (p.custom && isStaffOf(p.clubId)
      ? [{ action: 'adopt', label: 'Adopt', kind: 'primary' }]
      : []),
    onTool: (action, p) => { if (action === 'adopt') adoptHere(p); }
  });

  /* Adopting from out here writes into one club, so the builder is handed
     that club's own names for everything — its id for the puzzle rather
     than the copy's, and its own collection ids rather than the copies'. */
  function adoptHere(p) {
    const shelves = collections
      .filter((c) => c.clubId === p.clubId)
      .map((c) => ({ ...c, id: c.collectionId }));

    adoptPuzzle(
      { ...ctx, clubId: p.clubId, club: { id: p.clubId, name: p.clubName } },
      { ...p, id: p.puzzleId },
      {
        collections: () => shelves,
        club: () => ({ id: p.clubId, name: p.clubName })
      }
    );
  }

  /* ── the board ─────────────────────────────────────────────────────── */

  async function select(p) {
    if (solver) { solver.destroy(); solver = null; }
    current = p;
    attempt = null;
    library.mark(p ? p.id : null);
    if (!p) return;

    $('pz-none').hidden = true;
    $('pz-title').textContent = p.title || 'Puzzle';

    const by = $('pz-byline');
    by.innerHTML = bylineHTML(p, { showClub: true });
    by.hidden = !by.innerHTML;

    const desc = $('pz-desc');
    desc.textContent = p.description || '';
    desc.hidden = !p.description;

    const href = sourceHref(p.source);
    $('pz-head-tools').innerHTML = difficultyChip(p.difficulty) + (href
      ? `<a class="btn subtle sm pz-source" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(sourceLabel(href))}</a>`
      : '');

    const member = amIn(p.clubId);
    const note = $('pz-award');
    note.hidden = false;
    note.className = 'pz-award-note' + (member && p.points ? ' is-live' : '');
    note.textContent = !p.points
      ? 'This one is a member’s own puzzle, so it is worth no points to anybody — just the solve.'
      : member
        ? `You are in ${p.clubName || 'this club'}, so solving this is worth ${scoreFor(p).points} of its points.`
        : `Published by ${p.clubName || 'another club'}. You are not a member, so this is practice — nothing is awarded.`;

    /* Whether it has already been solved can only be asked of the club's own
       collection, and only a member may ask. Not being able to ask is not an
       error here; it is the answer. */
    if (member) {
      try {
        const snap = await getDoc(doc(db, 'clubs', p.clubId, 'puzzleAttempts',
          `${ctx.user.uid}_${p.puzzleId}`));
        attempt = snap.exists() ? snap.data() : null;
      } catch (_) { attempt = null; }
    }

    solver = mountSolver({
      mount: $('pz-solver'),
      puzzle: p,
      practice: !member || !p.points,
      alreadyDone: attempt,
      onSolved: (r) => finish(p, r)
    });
  }

  async function finish(p, result) {
    const member = amIn(p.clubId);
    const score = scoreFor(p);

    if (!p.points) {
      celebrate({ score, seconds: result.seconds, moves: result.moves, unpaid: true });
      return;
    }
    if (!member) {
      celebrate({ score, seconds: result.seconds, moves: result.moves, practice: true });
      return;
    }
    if (attempt) {
      celebrate({
        score: { ...score, points: Math.max(0, Number(attempt.scoreAwarded) || 0) },
        seconds: result.seconds, moves: result.moves, replay: true
      });
      return;
    }

    try {
      await setDoc(doc(db, 'clubs', p.clubId, 'puzzleAttempts', `${ctx.user.uid}_${p.puzzleId}`), {
        puzzleId: p.puzzleId,
        userId: ctx.user.uid,
        completedAt: Date.now(),
        movesUsed: result.moves,
        seconds: result.seconds,
        scoreAwarded: score.points,
        scoreBase: score.base,
        late: score.late
      }, { merge: true });

      if (score.points) await updateDoc(memberRef(p.clubId, ctx.user.uid), { points: increment(score.points) });
      attempt = { scoreAwarded: score.points };
      celebrate({ score, seconds: result.seconds, moves: result.moves });
    } catch (e) {
      console.error(e);
      toast('Solved — but your score could not be saved', 'error');
    }
  }

  /* ── building one from out here ────────────────────────────────────── */

  /* A puzzle needs a club: somewhere to live, and somebody to moderate it.
     So the shelves you may publish onto are the custom ones, in clubs you
     are actually in — and if there are none, the button says so rather than
     opening a wizard that cannot finish. */
  /* The global shelf is always offered, and is built from the local
     descriptor rather than from the mirror: whether its document happens to
     have been written yet decides whether the shelf is LISTED, never whether
     somebody may publish to it. A button that is disabled because a write
     somewhere else has not landed is the bug this replaced. */
  const globalShelf = () => Object.assign({}, globalCollection(), {
    id: mirrorId(GLOBAL_CLUB_ID, DEFAULT_COLLECTION_ID),
    collectionId: DEFAULT_COLLECTION_ID,
    clubId: GLOBAL_CLUB_ID,
    clubName: GLOBAL_CLUB_NAME
  });

  const publishable = () => collections
    .filter((c) => c.kind === 'custom' && !isGlobal(c.clubId) && amIn(c.clubId))
    .concat([globalShelf()]);

  function paintMake() {
    const mine = publishable().filter((c) => !isGlobal(c.clubId)).length;
    $('lib-make').disabled = false;
    $('lib-make-hint').textContent = mine
      ? `Goes onto one of your ${mine} club shelf${mine === 1 ? '' : 'ves'}, or onto the global shelf anybody can read.`
      : 'You are in no club with a shelf yet, so it goes onto the global shelf — anybody on JagChess can play it.';
  }

  $('lib-make').onclick = async () => {
    const open = publishable();
    if (!open.length) return;
    const coll = open.length === 1 ? open[0] : await pickShelf(open);
    if (!coll) return;
    if (isGlobal(coll.clubId)) {
      openBuilderModal({ ...ctx, clubId: GLOBAL_CLUB_ID, club: globalClub() }, {
        mode: 'student',
        global: true,
        club: () => globalClub(),
        collections: () => [{ ...globalCollection(), id: DEFAULT_COLLECTION_ID }]
      });
      return;
    }

    /* The builder writes into one club, so it is handed one club's worth of
       context — the same shape the club page gives it, with the one shelf
       the author picked. */
    openBuilderModal({
      ...ctx,
      clubId: coll.clubId,
      club: { id: coll.clubId, name: coll.clubName }
    }, {
      mode: 'student',
      club: () => ({ id: coll.clubId, name: coll.clubName }),
      collections: () => [{ ...coll, id: coll.collectionId }]
    });
  };

  function pickShelf(open) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `
        <div class="modal-card lib-pick">
          <h3>Where should it go?</h3>
          <p class="muted">Pick the club and shelf to publish onto.</p>
          <div class="list">${open.map((c, i) => `
            <button class="pz-row" data-i="${i}" type="button">
              <span class="pz-row-info">
                <span class="pz-row-title">${esc(c.name)}</span>
                <span class="pz-row-meta">${esc(c.clubName || c.clubId)}</span>
              </span>
            </button>`).join('')}</div>
          <button class="btn subtle block" data-x type="button">Cancel</button>
        </div>`;
      document.body.appendChild(wrap);
      const close = (value) => { wrap.remove(); resolve(value); };
      wrap.querySelectorAll('[data-i]').forEach((b) =>
        (b.onclick = () => close(open[Number(b.dataset.i)])));
      wrap.querySelector('[data-x]').onclick = () => close(null);
      wrap.onclick = (e) => { if (e.target === wrap) close(null); };
    });
  }

  /* ── the shelves ───────────────────────────────────────────────────── */

  /* One shelf for everybody's own work, rather than one per club. Twenty
     clubs would otherwise mean twenty near-identical cards all called the
     same thing, and the shelf a visitor actually wants — everything people
     have built — would not exist at all. Each puzzle keeps its own club on
     its byline, which is where that belongs. */
  const refresh = () => {
    library.update(mergeCustomCollections(collections, puzzles));
    paintMake();
  };

  onSnapshot(
    query(collection(db, 'publicPuzzleCollections'), orderBy('createdAt', 'desc'), limit(CAP_COLLECTIONS)),
    (s) => {
      const have = s.docs.map((d) => ({ id: d.id }));
      ensureGlobalCollection(have);
      /* Your own clubs' shelves, published from here if nobody has opened
         the club's puzzles page since they became public. */
      Object.keys(myClubs).filter((id) => myClubs[id]).forEach((id) => ensureClubShelfMirrored(id, have));
      collections = s.docs.map((d) => {
        const raw = d.data();
        /* Keyed by the copy's id, not the club's own — two clubs may both
           call a shelf `abc`, and the panel matches puzzles to shelves by id. */
        return { ...normalizeCollection({ ...raw, id: d.id }), collectionId: raw.collectionId };
      });
      refresh();
    },
    (e) => { console.error(e); toast('Could not load the library', 'error'); }
  );

  onSnapshot(
    query(collection(db, 'publicPuzzles'), orderBy('createdAt', 'desc'), limit(CAP_PUZZLES)),
    (s) => {
      puzzles = s.docs.map((d) => {
        const raw = d.data();
        const p = normalizePuzzle({ ...raw, id: d.id });
        p.puzzleId = raw.puzzleId || '';
        p.collectionId = raw.collectionId ? mirrorId(raw.clubId, raw.collectionId) : '';
        return p;
      });
      refresh();
      if (current) {
        const fresh = puzzles.find((x) => x.id === current.id);
        if (fresh) current = fresh;
      }
    },
    (e) => { console.error(e); toast('Could not load the library', 'error'); }
  );

  /* the resume chip every hub page carries */
  watchActiveDuels((games) => {
    const mine = gameOf(games, ctx.user.uid);
    const chip = $('hub-resume');
    if (!chip) return;
    chip.hidden = !mine;
    if (mine) chip.onclick = () => { location.href = '/play#duel/' + mine.id; };
  });

  paintMake();
})();
