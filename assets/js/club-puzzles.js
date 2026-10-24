/* ═══════════════════════════════════════════════════════════════════════
   club-puzzles.js — the Puzzles block: solving them, and building them.

   Building one used to mean filling in a details form, picking a color out
   of a dropdown on the right, setting a position, and pressing "Record move"
   after every single move. Four things to get right before the first move
   went in, and a max-attempts box nobody could answer honestly.

   It is a wizard now, and it asks for things in the order you actually
   decide them:

     1  which color is solving        — one click, and it is the first thing
     2  the starting position          — a board with spare pieces, a reset,
                                         a clear, and a FEN import
     3  the moves                      — drag one and it is recorded. No
                                         button. Turns alternate on their
                                         own, and the last move of a line is
                                         flagged as the end
     4  the details                    — title, description, source, points,
                                         expiry, and the late cut

   Step 3 is where the branching lives. Click any move in the line to stand
   at that position again; play something different and a new branch opens.
   Two branches that meet at the same board can be merged into one, so a
   second good move never means retyping the continuation. The graph itself,
   and every rule about it, is in puzzle-model.js.

   Nobody fills in max attempts any more: what the puzzle asks of you is how
   many moves your own color has to find, and that is counted off the graph.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  clubCol, clubDoc, memberRef,
  setDoc, addDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, where,
  orderBy, increment,
  esc, fmtDate, toast, confirmDialog, promptDialog, initials, ROLE_LABEL, CLUB_COLORS
} from './club-core.js';

import {
  ROOT, normalizePuzzle, normalizeTree, normalizeCollection, treeStats,
  addMove, deleteNode, mergeNodes, wouldLoop, parentsOf, pathTo, keyAt,
  depthOf, childByMove, isEnd, scoreFor, hasExpired, sourceHref, sourceLabel,
  clampDifficulty, difficultyText, difficultyBand, difficultyWord,
  effectiveVisibility, visibilityLocked, forcedVisibility
} from './puzzle-model.js';

import {
  newPageState, pageSlice, pagerHTML, wirePager, searchHTML
} from './puzzle-pager.js';

import {
  collectionCol, collectionDoc, mountLibrary, bylineHTML, difficultyChip, visChip,
  syncPublicPuzzle, syncPublicCollection, removePublicPuzzle, removePublicCollection,
  reconcilePublicLibrary, ensureDefaultCollection, publishGlobalPuzzle,
  DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME
} from './puzzle-library.js';

const PIECE_THEME = (p) => `/assets/vendor/chessboard/img/chesspieces/wikipedia/${p}.png`;

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

const COLOR_NAME = (c) => (c === 'b' ? 'Black' : 'White');
const ORIENT = (c) => (c === 'b' ? 'black' : 'white');

const ICON_LINK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6"/>' +
  '<path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6"/></svg>';

const ICON_RESTART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 11.5a8 8 0 1 1-2.6-5.4"/><path d="M20 4.5V11h-6.5"/></svg>';

/** The starting FEN, with the solving color put on move whatever was stored. */
export function startFen(fenish, color) {
  const raw = String(fenish || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const placement = parts[0];
  const rights = parts.length >= 4
    ? [parts[2], parts[3]]
    : ['-', '-'];
  return `${placement} ${color || 'w'} ${rights[0]} ${rights[1]} 0 1`;
}

/* A FEN chess.js will accept needs all six fields; people paste four. */
export function padFen(fen) {
  const parts = String(fen || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const filled = [parts[0], parts[1] || 'w', parts[2] || '-', parts[3] || '-', parts[4] || '0', parts[5] || '1'];
  return filled.join(' ');
}

/**
 * The position, or null.
 *
 * `new Chess(bad)` does not throw and does not refuse — it hands back an
 * empty board, so a typo in a pasted FEN would sail through as a legal
 * puzzle with no pieces on it. validate_fen is what actually answers the
 * question, and even that will pass a board with no kings on it, so both
 * kings are checked here as well.
 */
const legal = (fen) => {
  try {
    const full = padFen(fen);
    if (!full) return null;
    const g = new window.Chess();
    if (!g.validate_fen(full).valid) return null;
    if (!g.load(full)) return null;
    const board = String(full.split(' ')[0]);
    if (!board.includes('k') || !board.includes('K')) return null;
    return g;
  } catch (_) { return null; }
};

/* A board position chessboard.js will accept: it wants placement only. */
const placementOf = (fen) => String(fen || '').split(/\s+/)[0] || 'start';

/* ── promoting a pawn ──────────────────────────────────────────────────
   A pawn reaching the back rank was quietly made a queen, everywhere. That
   is the right guess almost always and wrong exactly when it matters — an
   underpromotion is the point of the puzzle, and a puzzle whose answer is
   Ne8=N+ could not be recorded at all, let alone solved.

   chessboard.js wants an answer from its drop handler immediately and a
   person cannot be asked anything immediately, so the drag is snapped back
   first and the move is played afterwards, from the picker. The snap is a
   fraction of a second and the alternative is a board showing a move
   nobody has chosen yet.
   ─────────────────────────────────────────────────────────────────── */

const PROMOTIONS = [
  ['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']
];

/** Would this move put a pawn on the back rank? */
export function isPromotion(game, from, to) {
  try {
    const piece = game.get(from);
    if (!piece || piece.type !== 'p') return false;
    const rank = String(to)[1];
    return (piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1');
  } catch (_) { return false; }
}

/**
 * Asks which piece the pawn becomes.
 * @returns {Promise<'q'|'r'|'b'|'n'|null>}  null if they backed out
 */
export function askPromotion(color) {
  return new Promise((resolve) => {
    const modal = el(`
      <div class="modal pz-promo" role="dialog" aria-modal="true" aria-label="Choose a piece">
        <div class="modal-card pz-promo-card">
          <h3>Promote to</h3>
          <div class="pz-promo-row">
            ${PROMOTIONS.map(([k, name]) => `
              <button class="pz-promo-pick" data-p="${k}" type="button" title="${name}"
                aria-label="${name}">
                <img src="${PIECE_THEME((color === 'b' ? 'b' : 'w') + k.toUpperCase())}"
                  alt="${name}" width="52" height="52" />
                <span>${name}</span>
              </button>`).join('')}
          </div>
        </div>
      </div>`);

    document.body.appendChild(modal);
    let answered = false;
    const close = (value) => {
      if (answered) return;
      answered = true;
      document.removeEventListener('keydown', onKey);
      modal.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { close(null); return; }
      const hit = PROMOTIONS.find(([k, name]) => e.key.toLowerCase() === name[0].toLowerCase() ||
        e.key.toLowerCase() === k);
      if (hit) { e.preventDefault(); close(hit[0]); }
    };

    modal.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => close(b.dataset.p)));
    /* Backing out leaves the pawn where it was, which is what the snapback
       has already drawn — so there is nothing to undo. */
    modal.onclick = (e) => { if (e.target === modal) close(null); };
    document.addEventListener('keydown', onKey);
    const first = modal.querySelector('[data-p]');
    if (first) first.focus();
  });
}

export async function renderPuzzles(ctx, host, api) {
  return ctx.isAdmin && ctx.mode !== 'member'
    ? puzzlesAdmin(ctx, host)
    : puzzlesMember(ctx, host);
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  SOLVING                                                                */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * The solver, used in three places: the member's page, an admin previewing
 * one they are building, and an admin replaying one already published.
 *
 * @param {object} o
 *   mount       — where the board and its furniture go
 *   puzzle      — a normalized puzzle
 *   onSolved    — (result) => void, only when the solve counts
 *   practice    — true for a preview: nothing is awarded and nothing is saved
 *   alreadyDone — a previous attempt, if there is one
 *   source      — a link to show beside Restart, as an icon
 *   iconTools   — draw the footer controls as icons with tooltips
 */
export function mountSolver(o) {
  const puzzle = o.puzzle;
  const tree = puzzle.tree;
  const color = puzzle.playerColor;
  const opening = startFen(puzzle.fen, color);

  /* A preview has no room above the board for a source button — the modal's
     head is already carrying the title and the close — so it hands both of
     its controls to the footer as icons instead. The member's page keeps the
     worded Restart, where there is space for words. */
  const iconTools = o.iconTools === true;
  const source = o.source || null;

  o.mount.innerHTML = `
    <div class="pzs">
      <div class="pzs-top">
        <div class="pzs-turn">
          <span class="pzs-chip ${color === 'b' ? 'black' : 'white'}">${COLOR_NAME(color)} to play</span>
          <span class="pzs-ask" data-ask></span>
        </div>
        <div class="pzs-status" data-status></div>
      </div>
      <div class="chessboard" data-board></div>
      <div class="pzs-foot">
        <div class="pzs-dots" data-dots></div>
        <div class="pzs-tools${iconTools ? ' is-icons' : ''}">
          ${iconTools && source ? `<a class="btn subtle sm pzs-tool" href="${esc(source)}"
            target="_blank" rel="noopener noreferrer"
            data-tip="Source" aria-label="Source">${ICON_LINK}</a>` : ''}
          <button class="btn subtle sm${iconTools ? ' pzs-tool' : ''}" data-restart type="button"
            ${iconTools ? 'data-tip="Restart" aria-label="Restart"' : ''}>
            ${iconTools ? ICON_RESTART : 'Restart'}</button>
        </div>
      </div>
      <p class="pzs-hint" data-hint hidden></p>
    </div>`;

  const statusEl = o.mount.querySelector('[data-status]');
  const dotsEl = o.mount.querySelector('[data-dots]');
  const hintEl = o.mount.querySelector('[data-hint]');
  o.mount.querySelector('[data-ask]').textContent = puzzle.stats.moves
    ? `Find ${puzzle.stats.moves} move${puzzle.stats.moves === 1 ? '' : 's'}`
    : 'No moves recorded';

  let game = null;
  let board = null;
  let at = ROOT;
  let done = false;
  let solved = false;
  let played = 0;
  const startedAt = Date.now();

  const status = (msg, kind) => {
    statusEl.textContent = msg;
    if (kind) statusEl.dataset.status = kind; else delete statusEl.dataset.status;
  };

  /* One dot per move the player still owes, filling in as they land. The
     shortest line sets the count, so a player who finds a longer winning
     line simply finishes with dots to spare. */
  const paintDots = () => {
    const total = Math.max(puzzle.stats.moves, played);
    dotsEl.innerHTML = Array.from({ length: total }, (_, i) =>
      `<span class="pzs-dot${i < played ? ' on' : ''}"></span>`).join('');
  };

  const hint = (text) => {
    hintEl.hidden = !text;
    hintEl.textContent = text || '';
  };

  function build(fen) {
    if (board && board.destroy) board.destroy();
    board = window.Chessboard(o.mount.querySelector('[data-board]'), {
      draggable: true,
      position: placementOf(fen),
      orientation: ORIENT(color),
      pieceTheme: PIECE_THEME,
      onDragStart: () => !done,
      onDrop: (from, to) => onDrop(from, to),
      onSnapEnd: () => board.position(placementOf(game.fen()))
    });
  }

  function onDrop(from, to) {
    if (done || !game) return 'snapback';
    if (game.turn() !== color) return 'snapback';
    const piece = game.get(from);
    if (!piece || piece.color !== color) return 'snapback';

    /* The one move that cannot be answered inside the drop handler: which
       piece the pawn becomes is a question, and chessboard.js wants a
       verdict now. So the drag snaps back and the move is played from the
       picker instead. */
    if (isPromotion(game, from, to)) {
      askPromotion(color).then((choice) => {
        if (!choice || done) return;
        play(from, to, choice);
        board.position(placementOf(game.fen()));
      });
      return 'snapback';
    }
    return play(from, to, 'q');
  }

  function play(from, to, promotion) {
    const move = game.move({ from, to, promotion });
    if (!move) return 'snapback';

    const next = childByMove(tree, at, move.san);
    if (!next) {
      game.undo();
      status('Not the move — try another.', 'error');
      hint(`${move.san} is legal, but it is not what this puzzle is looking for.`);
      return 'snapback';
    }

    at = next;
    played++;
    hint('');
    paintDots();

    if (isEnd(tree, at)) return finish();

    /* The reply. Where the opponent has more than one, one is picked at
       random — two people solving the same puzzle should not be able to
       compare notes on which defence "the computer" plays. */
    const replies = tree.nodes[at].children;
    const replyId = replies[Math.floor(Math.random() * replies.length)];
    const reply = tree.nodes[replyId].san;

    status('Correct.', 'success');
    setTimeout(() => {
      if (done) return;
      game.move(reply, { sloppy: true });
      at = replyId;
      board.position(placementOf(game.fen()));
      if (isEnd(tree, at)) { finish(); return; }
      status('Your move.', 'info');
    }, 420);
    return undefined;
  }

  function finish() {
    done = true;
    solved = true;
    board.position(placementOf(game.fen()));
    status('Solved!', 'success');
    hint('');
    paintDots();
    if (o.onSolved) o.onSolved({ moves: played, seconds: Math.round((Date.now() - startedAt) / 1000) });
    return undefined;
  }

  function restart() {
    at = ROOT;
    played = 0;
    done = false;
    solved = false;
    game = legal(opening);
    if (!game) { status('This puzzle has an unreadable starting position.', 'error'); return; }
    build(game.fen());
    paintDots();
    hint('');
    status(o.alreadyDone && !o.practice ? 'Already solved — replaying for practice.' : 'Your move.',
      o.alreadyDone && !o.practice ? 'info' : 'info');
  }

  o.mount.querySelector('[data-restart]').onclick = restart;
  restart();

  return {
    destroy() { if (board && board.destroy) board.destroy(); },
    get solved() { return solved; },
    get seconds() { return Math.round((Date.now() - startedAt) / 1000); }
  };
}

/* ── the reward ────────────────────────────────────────────────────── */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const readableTime = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return plural(s, 'second');
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${plural(m, 'minute')} ${plural(rest, 'second')}` : plural(m, 'minute');
  const h = Math.floor(m / 60);
  return `${plural(h, 'hour')} ${plural(m % 60, 'minute')}`;
};

/* Easing that starts fast and lands gently — a linear count looks like a
   loading bar, and the number is meant to feel like an award. */
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * The modal after a solve. It counts, because the number is the point.
 * @param {object} o  { score, seconds, moves, practice }
 */
export function celebrate(o) {
  const score = o.score;
  const total = Math.max(0, Math.trunc(score.points));

  const modal = el(`
    <div class="modal pz-win" role="dialog" aria-modal="true">
      <div class="modal-card pz-win-card">
        <div class="pz-win-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <circle class="pz-win-ring" cx="32" cy="32" r="27" />
            <path class="pz-win-tick" d="M19 33.5 28 42.5 45.5 24" />
          </svg>
        </div>
        <h3>Puzzle solved</h3>
        <div class="pz-win-points" data-count aria-live="polite">+0</div>
        <div class="pz-win-label">${o.practice || o.unpaid
          ? 'points it would be worth'
          : o.replay ? 'points you already earned' : 'points earned'}</div>

        <div class="pz-win-stats">
          <div class="pz-win-stat">
            <span class="pz-win-stat-n" data-time>—</span>
            <span class="pz-win-stat-l">time taken</span>
          </div>
          <div class="pz-win-stat">
            <span class="pz-win-stat-n">${esc(String(o.moves || 0))}</span>
            <span class="pz-win-stat-l">move${o.moves === 1 ? '' : 's'} played</span>
          </div>
        </div>

        ${score.late ? `
        <div class="pz-win-late">
          <b>Solved after the deadline</b>
          <span>${esc(String(score.pct))}% came off the ${esc(String(score.base))} points this
            puzzle was worth — that is ${esc(String(score.penalty))} fewer.</span>
        </div>` : ''}

        ${o.practice ? '<p class="pz-win-practice">This was a preview, so nothing was awarded.</p>' : ''}
        ${o.unpaid ? `<p class="pz-win-practice">Puzzles members build are worth no points — that is
          what keeps the way to earn them being solving the club's own. Nice find all the same.</p>` : ''}
        ${o.replay ? '<p class="pz-win-practice">You had already solved this one — replaying it does not pay twice.</p>' : ''}

        <button class="btn primary block" data-x>${o.practice ? 'Close preview' : 'Nice!'}</button>
      </div>
    </div>`);

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('is-in'));

  const close = () => {
    modal.classList.remove('is-in');
    setTimeout(() => modal.remove(), 220);
  };
  modal.querySelector('[data-x]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  modal.querySelector('[data-time]').textContent = readableTime(o.seconds);

  /* The count starts once the card has finished arriving, so the two
     animations read as one thing happening rather than two competing. */
  const out = modal.querySelector('[data-count]');
  const run = () => {
    if (total === 0) { out.textContent = '+0'; return; }
    const ms = Math.min(1500, 420 + total * 26);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      out.textContent = '+' + Math.round(easeOut(p) * total);
      if (p < 1) requestAnimationFrame(step);
      else { out.textContent = '+' + total; out.classList.add('landed'); }
    };
    requestAnimationFrame(step);
  };
  setTimeout(run, 380);

  return { close };
}

const expiryChip = (p) => {
  if (!p.expiresAt) return '';
  const gone = hasExpired(p);
  if (!gone) return `<span class="pz-chip due">Due ${esc(fmtDate(p.expiresAt))}</span>`;
  return p.latePenaltyPct
    ? `<span class="pz-chip late">Late · ${esc(String(p.latePenaltyPct))}% off</span>`
    : '<span class="pz-chip late">Past its date</span>';
};

/* ── who is writing this ───────────────────────────────────────────────
   A puzzle is signed at the moment it is published, with the name the club
   knows the author by rather than a live lookup. Names change; credit on a
   thing already published should not move with them, and the mirror cannot
   ask a club collection for one anyway.
   ─────────────────────────────────────────────────────────────────── */

export const whoAmI = (ctx) => ({
  uid: (ctx.user && ctx.user.uid) || '',
  name: String((ctx.member && ctx.member.username) ||
    (ctx.user && ctx.user.displayName) ||
    String((ctx.user && ctx.user.email) || '').split('@')[0] || 'Member')
});

/** The collection a puzzle sits in, or null — the thing every visibility question needs. */
const collOf = (collections, p) =>
  (collections || []).find((c) => c.id === (p || {}).collectionId) || null;

/** Collections a student is allowed to publish into. */
export const customCollections = (collections) => (collections || []).filter((c) => c.kind === 'custom');

/* ── the builder, in a modal ───────────────────────────────────────────
   Students get the same wizard admins get, and adopting gets the same one
   again. Neither of those has a page of its own to live on, so the wizard
   is lifted into a sheet — which is also what keeps there being exactly one
   builder rather than three that drift apart.
   ─────────────────────────────────────────────────────────────────── */

export function openBuilderModal(ctx, opts) {
  const o = opts || {};
  const modal = el(`
    <div class="modal pz-build-modal">
      <div class="modal-card pz-build-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <div data-mount></div>
      </div>
    </div>`);

  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  let builder = null;
  const close = () => {
    if (builder) builder.destroy();
    modal.remove();
    document.body.style.overflow = '';
  };

  builder = mountBuilder(ctx, modal.querySelector('[data-mount]'), {
    mode: o.mode,
    collections: o.collections,
    club: o.club,
    adopt: o.adopt,
    onPublished: () => { close(); if (o.onPublished) o.onPublished(); }
  });

  /* `seed` is a puzzle being copied — adopting. `editing` is the same
     puzzle being changed in place, which is what a member does to their
     own. The difference is entirely whether it keeps its id. */
  if (o.seed) builder.edit(o.seed, { asNew: true });
  else if (o.editing) builder.edit(o.editing);

  modal.querySelector('[data-x]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  return { close };
}

/* ── adopting somebody else's puzzle ───────────────────────────────────
   A member's puzzle opened by an admin, loaded into the admin's own
   builder as a fresh, unpublished thing. Nothing is taken from the member
   until the admin presses publish — at which point the prize is paid, the
   original is retired, and both names go on it.
   ─────────────────────────────────────────────────────────────────── */

export function adoptPuzzle(ctx, puzzle, o) {
  const opts = o || {};
  openBuilderModal(ctx, {
    mode: 'staff',
    collections: opts.collections,
    club: opts.club,
    seed: puzzle,
    adopt: {
      puzzleId: puzzle.id,
      clubId: puzzle.clubId || ctx.clubId,
      authorUid: puzzle.authorUid,
      authorName: puzzle.authorName,
      anonymous: !!puzzle.anonymous
    },
    onPublished: opts.onPublished
  });
}

/* ── the board when there is nothing on it ─────────────────────────────
   A club with no puzzles yet used to show a line of text where the board
   goes, which reads as something failing to load. A board with the pieces
   set up reads as a board waiting for a puzzle, which is what it is. It is
   not playable, because there is nothing to play.
   ─────────────────────────────────────────────────────────────────── */

export function mountIdleBoard(mount, note) {
  mount.innerHTML = `
    <div class="pz-idle">
      <div class="chessboard pz-idle-board" data-board></div>
      <p class="pz-idle-note">${esc(note || 'No puzzles yet — this board is just waiting for one.')}</p>
    </div>`;

  let board = null;
  try {
    board = window.Chessboard(mount.querySelector('[data-board]'), {
      draggable: false,
      position: 'start',
      pieceTheme: PIECE_THEME
    });
  } catch (e) { console.warn('Could not draw the idle board', e); }

  return { destroy() { if (board && board.destroy) board.destroy(); } };
}

/* ── the list beside the board ─────────────────────────────────────────
   All puzzles is pinned to the height of the board next to it, so the two
   tiles line up whether the club has one puzzle or forty.

   Pinned, not stretched. The box gets the board's height; what is in it
   keeps the size it had and stays at the top, and the rest of the box is
   simply empty. A list of one puzzle stretched down a board's worth of
   tile would be a row of nothing pretending to be content.

   Past that height the list scrolls inside the box rather than making the
   page longer, which is what the max-height is for — worked out from where
   the list actually starts, so the header and the button above it are
   counted without anything here knowing what they are.

   All of it applies only while the two are actually side by side: stacked
   on a narrow screen, a pinned height would be a box with its own
   scrollbar in the middle of the page. The number of grid columns is asked
   of the browser rather than of a breakpoint, so the two cannot drift.
   ─────────────────────────────────────────────────────────────────── */

function pinHeights(layout, boardTile, sideTile, list) {
  if (!layout || !boardTile || !sideTile || typeof ResizeObserver !== 'function') {
    return () => {};
  }
  const twoUp = () =>
    getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length > 1;

  const clear = () => {
    sideTile.style.height = '';
    if (list) list.style.maxHeight = '';
  };

  const apply = () => {
    if (!twoUp()) return clear();
    const h = boardTile.offsetHeight;
    if (!h) return clear();
    sideTile.style.height = h + 'px';

    if (list) {
      const above = list.getBoundingClientRect().top - sideTile.getBoundingClientRect().top;
      const below = parseFloat(getComputedStyle(sideTile).paddingBottom) || 0;
      list.style.maxHeight = Math.max(96, h - above - below) + 'px';
    }
  };

  /* Watching the board only: everything set here is downstream of its
     height, so observing any of it as well would be a loop. */
  const ro = new ResizeObserver(apply);
  ro.observe(boardTile);
  window.addEventListener('resize', apply);
  apply();

  return () => { ro.disconnect(); clear(); window.removeEventListener('resize', apply); };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE MEMBER'S PAGE                                                      */
/* ═══════════════════════════════════════════════════════════════════════ */

async function puzzlesMember(ctx, host) {
  host.innerHTML = `
    <div class="puzzle-layout">
      <div class="tile puzzle-board" id="pz-board-tile">
        <div class="puzzle-header">
          <h3 id="pz-title">Puzzles</h3>
          <div class="pz-head-tools" id="pz-head-tools"></div>
        </div>
        <div class="pz-byline" id="pz-byline" hidden></div>
        <p class="pz-desc" id="pz-desc" hidden></p>
        <div id="pz-solver"></div>
      </div>
      <div class="tile puzzle-side" id="pz-side">
        <div class="puzzle-side-header"><h3>All puzzles</h3><span class="muted" id="pz-meta"></span></div>
        <button class="btn subtle sm block pz-make" id="pz-make" type="button">
          ＋ Create custom puzzle</button>
        <div class="list" id="pz-list"></div>
        <div class="empty-state" id="pz-empty" hidden>No puzzles published yet.</div>
      </div>
    </div>
    <div class="tile pzlib-tile" id="pz-library"></div>`;

  let puzzles = [];
  let collections = [];
  let attempts = new Map();
  let current = null;
  let solver = null;
  let idle = null;

  const unpin = pinHeights(
    host.querySelector('.puzzle-layout'),
    host.querySelector('#pz-board-tile'),
    host.querySelector('#pz-side'),
    host.querySelector('#pz-list')
  );

  const library = mountLibrary(host.querySelector('#pz-library'), {
    title: 'Puzzle library',
    sub: 'Everything this club has filed away, by collection. Pick one and it opens on the board above.',
    emptyText: 'Nobody has made a collection yet.',
    onPick: (p) => {
      select(p);
      const tile = host.querySelector('#pz-board-tile');
      if (tile && tile.scrollIntoView) tile.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    /* Your own puzzle, and only while it is still yours: an adopted one has
       been republished by an admin and the original is gone, so there is
       nothing here to edit. */
    tools: (p) => (mine(p)
      ? [{ action: 'edit', label: 'Edit' }, { action: 'delete', label: 'Delete', kind: 'danger' }]
      : []),
    onTool: (action, p) => (action === 'edit' ? editMine(p) : deleteMine(p))
  });

  const mine = (p) => !!p.custom && p.authorUid === ctx.user.uid;

  const editMine = (p) => openBuilderModal(ctx, {
    mode: 'student',
    editing: p,
    collections: () => collections,
    club: () => ctx.club
  });

  const deleteMine = async (p) => {
    if (!await confirmDialog({
      title: 'Delete your puzzle?',
      body: `"${p.title || 'Untitled puzzle'}" disappears for everyone in the club.`,
      confirmText: 'Delete',
      danger: true
    })) return;
    try {
      await deleteDoc(clubDoc(ctx.clubId, 'puzzles', p.id));
      await removePublicPuzzle(ctx.clubId, p.id);
      if (current && current.id === p.id) { current = null; showIdle(); }
      toast('Puzzle deleted');
    } catch (e) {
      console.error(e);
      toast('Could not delete that', 'error');
    }
  };

  /* The button is only honest once there is somewhere for the puzzle to go:
     a student's puzzle has to live in a collection an admin opened for them,
     and there is no point offering a wizard that cannot be published. */
  const paintMake = () => {
    const btn = host.querySelector('#pz-make');
    const open = customCollections(collections);
    btn.disabled = !open.length;
    btn.title = open.length
      ? 'Build one of your own'
      : 'An admin has to open a custom collection before members can publish puzzles.';
    btn.onclick = () => openBuilderModal(ctx, {
      mode: 'student',
      collections: () => collections,
      club: () => ctx.club
    });
  };

  /* All puzzles is what the club has set, and members' own work is not
     that. It has its own shelf in the library, where it is next to the
     other things members built rather than mixed in with the week's
     homework — and where nothing about it is worth points. */
  const listed = () => puzzles.filter((p) => !p.custom);

  const paintList = () => {
    const rows = listed();
    host.querySelector('#pz-empty').hidden = rows.length > 0;
    host.querySelector('#pz-meta').textContent = rows.length ? `${rows.length} published` : '';
    host.querySelector('#pz-list').innerHTML = rows.map((p, i) => {
      const a = attempts.get(p.id);
      const worth = scoreFor(p);
      return `<button class="pz-row${current && current.id === p.id ? ' on' : ''}" data-p="${esc(p.id)}">
        <span class="pz-row-info">
          <span class="pz-row-title">${esc(p.title || 'Puzzle ' + (i + 1))}</span>
          <span class="pz-row-meta">${p.points
            ? esc(String(worth.points)) + ' pts · '
            : 'no points · '}${esc(String(p.stats.moves))} move${p.stats.moves === 1 ? '' : 's'}${
              p.stats.branches > 1 ? ' · ' + esc(String(p.stats.branches)) + ' ways' : ''}</span>
          ${bylineHTML(p, { showClub: false })}
          <span class="pz-row-flags">${difficultyChip(p.difficulty)}${expiryChip(p)}</span>
        </span>
        ${a ? `<span class="pz-done">${Number(a.scoreAwarded) > 0
          ? '+' + esc(String(a.scoreAwarded))
          : 'Done'}</span>` : ''}
      </button>`;
    }).join('');
    host.querySelectorAll('[data-p]').forEach((b) =>
      (b.onclick = () => select(puzzles.find((x) => x.id === b.dataset.p))));
  };

  /* The clock starts here — the moment the puzzle is opened, not the moment
     the first piece moves. Thinking is the puzzle. */
  const select = (p) => {
    if (solver) { solver.destroy(); solver = null; }
    if (idle) { idle.destroy(); idle = null; }
    current = p;
    paintList();
    library.mark(p ? p.id : null);
    if (!p) return showIdle();

    host.querySelector('#pz-title').textContent = p.title || 'Puzzle';

    const by = host.querySelector('#pz-byline');
    by.innerHTML = bylineHTML(p, { showClub: false });
    by.hidden = !by.innerHTML;

    const desc = host.querySelector('#pz-desc');
    desc.textContent = p.description || '';
    desc.hidden = !p.description;

    const href = sourceHref(p.source);
    host.querySelector('#pz-head-tools').innerHTML =
      difficultyChip(p.difficulty) + (href
        ? `<a class="btn subtle sm pz-source" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
             ${ICON_LINK}${esc(sourceLabel(href))}</a>`
        : '');

    const done = attempts.get(p.id);
    solver = mountSolver({
      mount: host.querySelector('#pz-solver'),
      puzzle: p,
      alreadyDone: done,
      onSolved: (r) => award(p, r)
    });
  };

  const award = async (p, result) => {
    /* A puzzle a member built is not worth points, by design — otherwise
       the way to earn is to write your own easy one. It still celebrates,
       because solving it is still solving it. */
    if (!p.points) {
      celebrate({ score: scoreFor(p), seconds: result.seconds, moves: result.moves, unpaid: true });
      return;
    }
    if (attempts.has(p.id)) {
      const already = attempts.get(p.id);
      celebrate({
        score: { ...scoreFor(p), points: Math.max(0, Number(already.scoreAwarded) || 0) },
        seconds: result.seconds,
        moves: result.moves,
        replay: true
      });
      return;
    }
    const score = scoreFor(p);
    try {
      await setDoc(clubDoc(ctx.clubId, 'puzzleAttempts', `${ctx.user.uid}_${p.id}`), {
        puzzleId: p.id,
        userId: ctx.user.uid,
        completedAt: Date.now(),
        movesUsed: result.moves,
        seconds: result.seconds,
        scoreAwarded: score.points,
        scoreBase: score.base,
        late: score.late
      }, { merge: true });

      if (score.points) {
        await updateDoc(memberRef(ctx.clubId, ctx.user.uid), { points: increment(score.points) });
        ctx.member.points = (ctx.member.points || 0) + score.points;
      }
      attempts.set(p.id, { scoreAwarded: score.points });
      paintList();
      celebrate({ score, seconds: result.seconds, moves: result.moves });
    } catch (e) {
      console.error(e);
      toast('Could not save your score', 'error');
    }
  };

  /* Nothing to solve: the board is still drawn, with the pieces where they
     start, so the tile reads as a board and not as a failure. */
  function showIdle() {
    if (idle) return;
    host.querySelector('#pz-title').textContent = 'Puzzles';
    host.querySelector('#pz-head-tools').innerHTML = '';
    host.querySelector('#pz-byline').hidden = true;
    host.querySelector('#pz-desc').hidden = true;
    idle = mountIdleBoard(host.querySelector('#pz-solver'), puzzles.length
      ? 'Pick a puzzle to start.'
      : 'No puzzles yet — this board is just waiting for one.');
  }

  const refreshLibrary = () => library.update({ collections, puzzles });

  const stopC = onSnapshot(query(collectionCol(ctx.clubId), orderBy('createdAt', 'desc')), (s) => {
    collections = s.docs.map((d) => normalizeCollection({ id: d.id, ...d.data() }));
    /* Every club has a shelf for its members' own work, whether or not an
       admin ever opened one. A member turning up first is what creates it. */
    ensureDefaultCollection(ctx.clubId, ctx.club, collections);
    paintMake();
    refreshLibrary();
  }, (e) => console.warn('Could not read the collections', e));

  const stopP = onSnapshot(query(clubCol(ctx.clubId, 'puzzles'), orderBy('createdAt', 'desc')), (s) => {
    puzzles = s.docs.map((d) => normalizePuzzle({ id: d.id, clubName: ctx.club.name, ...d.data() }));
    paintList();
    refreshLibrary();
    if (current) {
      const fresh = puzzles.find((x) => x.id === current.id);
      if (fresh) current = fresh;
    }
    const rows = listed();
    if (!current && rows.length) select(rows[0]);
    if (!puzzles.length) { current = null; showIdle(); }
  });

  const stopA = onSnapshot(query(clubCol(ctx.clubId, 'puzzleAttempts'), where('userId', '==', ctx.user.uid)), (s) => {
    attempts = new Map(s.docs.map((d) => [d.data().puzzleId, d.data()]));
    paintList();
  });

  paintMake();
  showIdle();

  return () => {
    stopC(); stopP(); stopA();
    unpin();
    library.destroy();
    if (solver) solver.destroy();
    if (idle) idle.destroy();
  };
}

/* ── previewing one, from either side ──────────────────────────────── */

/**
 * Play a puzzle without it counting. The same solver, the same modal, and a
 * banner saying so — an admin checking their own puzzle has to see exactly
 * what a member will see, or the check is worth nothing.
 */
export function openPuzzlePreview(raw) {
  const puzzle = normalizePuzzle(raw);
  const href = sourceHref(puzzle.source);
  const score = scoreFor(puzzle);

  const modal = el(`
    <div class="modal pz-preview">
      <div class="modal-card pz-preview-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <div class="pz-preview-head">
          <div>
            <span class="pz-preview-eyebrow">Preview · nothing is awarded</span>
            <h3>${esc(puzzle.title || 'Untitled puzzle')}</h3>
          </div>
        </div>
        ${bylineHTML(puzzle, { showClub: true })}
        ${puzzle.description ? `<p class="pz-desc">${esc(puzzle.description)}</p>` : ''}
        <div class="pz-preview-meta">
          ${difficultyChip(puzzle.difficulty)}
          <span>${puzzle.points ? esc(String(score.points)) + ' points' : 'no points'}</span>
          <span>${esc(String(puzzle.stats.moves))} move${puzzle.stats.moves === 1 ? '' : 's'} to find</span>
          ${puzzle.stats.branches > 1 ? `<span>${esc(String(puzzle.stats.branches))} winning lines</span>` : ''}
          ${puzzle.expiresAt ? `<span>due ${esc(fmtDate(puzzle.expiresAt))}</span>` : ''}
        </div>
        <div data-mount></div>
      </div>
    </div>`);

  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  let solver = null;
  if (puzzle.stats.empty) {
    modal.querySelector('[data-mount]').innerHTML =
      '<div class="empty-state">This puzzle has no moves recorded yet, so there is nothing to play.</div>';
  } else {
    solver = mountSolver({
      mount: modal.querySelector('[data-mount]'),
      puzzle,
      practice: true,
      source: href,
      iconTools: true,
      onSolved: (r) => celebrate({ score, seconds: r.seconds, moves: r.moves, practice: true })
    });
  }

  const close = () => {
    if (solver) solver.destroy();
    modal.remove();
    document.body.style.overflow = '';
  };
  modal.querySelector('[data-x]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  return { close };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  BUILDING ONE                                                           */
/* ═══════════════════════════════════════════════════════════════════════ */

const STEPS = [
  ['Color', 'Who is solving'],
  ['Position', 'Where it starts'],
  ['Moves', 'How it is won'],
  ['Details', 'What it is worth']
];

const dateValue = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* A date with no time means the end of that day — a puzzle "due Friday" is
   not late at one minute past midnight on Friday morning. */
const endOfDay = (value) => {
  if (!value) return 0;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
};

/* ═══════════════════════════════════════════════════════════════════════ */
/*  COLLECTIONS                                                            */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * The shelves, and who they are for.
 *
 * Two switches, and they mean different things often enough to be worth
 * separating. `kind` says who may put a puzzle on the shelf — staff, or any
 * member. `visibility` says who may take one off it, and it is the outer of
 * the two: a collection kept inside the club keeps everything in it inside
 * the club, whatever each puzzle says for itself.
 */
/* The shelves, and what is on them.
 *
 * This used to be half the story: a list of shelves here, and a separate
 * library tile underneath drawing the same shelves again with their
 * contents. Two boxes, one screen apart, disagreeing about nothing. The
 * shelf opens in place instead, which is also the only place a member's
 * own puzzle appears now that Published leaves them out.
 *
 * `opts` carries what a puzzle row can do — preview, edit, adopt, delete —
 * because all four already exist upstairs and none of them belong to a
 * list of shelves.
 */
function mountCollections(ctx, host, opts) {
  const o = opts || {};
  let collections = [];
  let puzzles = [];
  let editingId = null;
  let open = false;
  let term = '';
  const unfolded = new Set();
  const page = newPageState(10);

  const $ = (sel) => host.querySelector(sel);

  const blank = () => ({
    name: '', description: '', icon: '♟', color: CLUB_COLORS[0],
    kind: 'staff', visibility: 'club', anonymous: false
  });
  let form = blank();

  /* The shell is drawn once. Everything that changes afterwards — the form
     opening, a page turning, a search — repaints its own piece, because a
     box that rebuilds itself takes the caret out of the search field with
     every keystroke. */
  host.innerHTML = `
    <div class="puzzle-side-header">
      <h3>Collections</h3>
      <button class="btn subtle sm" data-new type="button">＋ New collection</button>
    </div>
    <p class="pz-colls-note">A collection is a shelf, and every puzzle in the club lives on one.
      Open a shelf to see what is on it. Every club starts with
      <b>${esc(DEFAULT_COLLECTION_NAME)}</b>, which your members publish their own puzzles onto and
      which is where you go to adopt one. Make as many more as you like — rename that one, share it,
      or keep it in the club, but it cannot be taken away.</p>
    <div data-form></div>
    ${searchHTML('', 'Search collections')}
    <div class="list pz-coll-list" data-list></div>
    <div data-pager></div>`;

  $('[data-new]').onclick = () => {
    open = !open;
    if (!open) { editingId = null; form = blank(); }
    paintForm();
  };

  const search = $('[data-q]');
  search.oninput = () => {
    term = search.value.trim().toLowerCase();
    page.page = 1;
    paintList();
  };

  const countIn = (id) => puzzles.filter((p) => p.collectionId === id).length;
  const puzzlesIn = (id) => puzzles.filter((p) => p.collectionId === id);

  const matches = (c) => !term ||
    String(c.name || '').toLowerCase().includes(term) ||
    String(c.description || '').toLowerCase().includes(term);

  /* A shelf that was deleted leaves its puzzles filed under nothing. The
     club's own still show under Published, but a member's would have
     nowhere left to be, so they get a place here — pinned below the pages
     and counted in none of them, because it is not a collection. */
  const shelfless = () => puzzles.filter((p) => !p.collectionId);

  function paintForm() {
    $('[data-new]').textContent = open ? 'Close' : '＋ New collection';
    $('[data-form]').innerHTML = open ? formHTML() : '';
    if (open) wireForm();
  }

  function paintList() {
    const found = collections.filter(matches);
    const rows = pageSlice(page, found);
    const loose = term ? [] : shelfless();

    $('[data-list]').innerHTML = collections.length
      ? (found.length
        ? rows.map(rowHTML).join('') + (loose.length ? looseHTML(loose) : '')
        : '<div class="empty-state">No collection matches that search.</div>')
      : '<div class="empty-state">No collections yet. The library is empty until there is one.</div>';

    $('[data-pager]').innerHTML = found.length
      ? pagerHTML(page, found.length, 'collection', 'collections')
      : '';
    wirePager($('[data-pager]'), page, found.length, paintList);

    wireRows();
  }

  function paint() { paintForm(); paintList(); }

  /* ── one shelf ── */

  const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
    stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>`;

  function rowHTML(c) {
    const n = countIn(c.id);
    const isOpen = unfolded.has(c.id);
    return `<div class="pz-coll-item${isOpen ? ' is-open' : ''}">
      <div class="pz-coll-row">
        <button class="pz-coll-fold" data-fold="${esc(c.id)}" type="button"
          aria-expanded="${isOpen ? 'true' : 'false'}"
          aria-label="${isOpen ? 'Hide' : 'Show'} what is on ${esc(c.name || 'this shelf')}"
          ${n ? '' : 'disabled title="Nothing on this shelf yet"'}>${chevron}</button>
        <span class="pz-coll-icon" style="background:${esc(c.color || 'var(--surface-2)')}">${esc(c.icon || '♟')}</span>
        <span class="pz-row-info">
          <span class="pz-row-title">${esc(c.name || 'Untitled collection')}</span>
          <span class="pz-row-meta">${n} puzzle${n === 1 ? '' : 's'} ·
            ${c.kind === 'custom' ? 'members can add' : 'staff only'}</span>
          <span class="pz-row-flags">${visChip(c.visibility)}
            ${c.kind === 'custom' ? '<span class="pz-chip custom">Members can add</span>' : ''}
            ${c.isDefault ? '<span class="pz-chip">Always here</span>' : ''}</span>
        </span>
        <span class="pz-row-tools">
          ${c.kind === 'custom' ? '' : `
          <button class="btn subtle sm" data-vis-coll="${esc(c.id)}" type="button"
            title="${c.visibility === 'public'
              ? 'Keep this collection and everything in it inside the club'
              : 'Offer this collection to everybody on JagChess'}">
            ${c.visibility === 'public' ? 'Make club only' : 'Share with everyone'}</button>`}
          <button class="btn subtle sm" data-edit-coll="${esc(c.id)}" type="button">Edit</button>
          ${c.isDefault ? '' : `<button class="btn danger sm" data-del-coll="${esc(c.id)}"
            type="button" aria-label="Delete">✕</button>`}
        </span>
      </div>
      ${isOpen ? kidsHTML(puzzlesIn(c.id)) : ''}
    </div>`;
  }

  function looseHTML(loose) {
    const isOpen = unfolded.has('');
    return `<div class="pz-coll-item is-loose${isOpen ? ' is-open' : ''}">
      <div class="pz-coll-row">
        <button class="pz-coll-fold" data-fold="" type="button" aria-expanded="${isOpen ? 'true' : 'false'}"
          aria-label="${isOpen ? 'Hide' : 'Show'} the puzzles that are on no shelf">${chevron}</button>
        <span class="pz-coll-icon" style="background:var(--surface-2);color:var(--muted)">?</span>
        <span class="pz-row-info">
          <span class="pz-row-title">Not in a collection</span>
          <span class="pz-row-meta">${loose.length} puzzle${loose.length === 1 ? '' : 's'} ·
            nobody can browse to ${loose.length === 1 ? 'it' : 'them'}</span>
        </span>
      </div>
      ${isOpen ? kidsHTML(loose) : ''}
    </div>`;
  }

  function kidsHTML(rows) {
    return `<div class="pz-coll-kids">${rows.length
      ? rows.map(kidHTML).join('')
      : '<div class="pz-coll-kid is-empty">Nothing on this shelf yet.</div>'}</div>`;
  }

  function kidHTML(p) {
    return `<div class="pz-coll-kid">
      <span class="pz-row-info">
        <span class="pz-row-title">${esc(p.title || 'Untitled puzzle')}</span>
        <span class="pz-row-meta">${esc(String(p.points))} pts ·
          ${esc(String(p.stats.moves))} move${p.stats.moves === 1 ? '' : 's'} ·
          ${COLOR_NAME(p.playerColor)}</span>
        ${bylineHTML(p, { showClub: false })}
        <span class="pz-row-flags">
          ${difficultyChip(p.difficulty)}
          ${p.custom ? '<span class="pz-chip custom">Member-made</span>' : ''}
          ${expiryChip(p)}
        </span>
      </span>
      <span class="pz-row-tools">
        <button class="btn subtle sm" data-kid-play="${esc(p.id)}" type="button">Preview</button>
        <button class="btn subtle sm" data-kid-manage="${esc(p.id)}" type="button"
          title="Who has finished it">Manage</button>
        ${p.custom ? `<button class="btn primary sm" data-kid-adopt="${esc(p.id)}" type="button"
          title="Make it yours, and pay the member who built it">Adopt</button>` : ''}
        <button class="btn subtle sm" data-kid-edit="${esc(p.id)}" type="button">Edit</button>
        <button class="btn danger sm" data-kid-del="${esc(p.id)}" type="button" aria-label="Delete">✕</button>
      </span>
    </div>`;
  }

  function wireRows() {
    const findP = (id) => puzzles.find((x) => x.id === id);

    host.querySelectorAll('[data-fold]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.fold;
      if (unfolded.has(id)) unfolded.delete(id); else unfolded.add(id);
      paintList();
    }));

    host.querySelectorAll('[data-edit-coll]').forEach((b) => (b.onclick = () => {
      const c = collections.find((x) => x.id === b.dataset.editColl);
      if (!c) return;
      editingId = c.id;
      form = {
        name: c.name, description: c.description, icon: c.icon || '♟',
        color: c.color || CLUB_COLORS[0], kind: c.kind, visibility: c.visibility,
        anonymous: c.anonymous
      };
      open = true;
      paintForm();
      const el0 = $('#pzcl-name');
      if (el0) el0.focus();
    }));

    host.querySelectorAll('[data-del-coll]').forEach((b) => (b.onclick = () => removeCollection(b.dataset.delColl)));
    host.querySelectorAll('[data-vis-coll]').forEach((b) => (b.onclick = () => flipVisibility(b.dataset.visColl)));

    host.querySelectorAll('[data-kid-play]').forEach((b) => (b.onclick = () =>
      o.onPreview && o.onPreview(findP(b.dataset.kidPlay))));
    host.querySelectorAll('[data-kid-edit]').forEach((b) => (b.onclick = () =>
      o.onEdit && o.onEdit(findP(b.dataset.kidEdit))));
    host.querySelectorAll('[data-kid-manage]').forEach((b) => (b.onclick = () =>
      o.onManage && o.onManage(findP(b.dataset.kidManage))));
    host.querySelectorAll('[data-kid-adopt]').forEach((b) => (b.onclick = () =>
      o.onAdopt && o.onAdopt(findP(b.dataset.kidAdopt))));
    host.querySelectorAll('[data-kid-del]').forEach((b) => (b.onclick = () =>
      o.onDelete && o.onDelete(findP(b.dataset.kidDel))));
  }

  function formHTML() {
    /* The shelf every club is born with is the one place members can always
       publish. Turning it into a staff-only shelf would take that away
       without looking like it had, so that switch is not offered on it. */
    const lockedKind = editingId === DEFAULT_COLLECTION_ID;
    return `
      <div class="pz-coll-form">
        <div class="pz-field">
          <label for="pzcl-name">Name</label>
          <input id="pzcl-name" maxlength="80" value="${esc(form.name)}" placeholder="Endgames" />
        </div>
        <div class="pz-field">
          <label for="pzcl-desc">Description <span class="opt">optional</span></label>
          <input id="pzcl-desc" maxlength="400" value="${esc(form.description)}"
            placeholder="Rook and pawn, mostly." />
        </div>
        <div class="pz-field-row">
          <div class="pz-field">
            <label for="pzcl-icon">Icon</label>
            <input id="pzcl-icon" maxlength="2" value="${esc(form.icon)}" class="pz-icon-input" />
          </div>
          <div class="pz-field">
            <label>Color</label>
            <div class="pz-swatches" data-swatches>${CLUB_COLORS.map((c) =>
              `<button class="pz-swatch${form.color === c ? ' on' : ''}" type="button"
                 data-color="${esc(c)}" style="background:${esc(c)}"
                 aria-label="${esc(c)}"></button>`).join('')}</div>
          </div>
        </div>

        <div class="pz-field">
          <label>Who may put puzzles on it</label>
          <div class="pz-seg${lockedKind ? ' is-locked' : ''}" data-kind>
            <button type="button" data-k="staff" class="${form.kind === 'staff' ? 'on' : ''}"
              ${lockedKind ? 'disabled' : ''}>Staff only</button>
            <button type="button" data-k="custom" class="${form.kind === 'custom' ? 'on' : ''}"
              ${lockedKind ? 'disabled' : ''}>Members can add</button>
          </div>
          <p class="field-hint" data-kind-hint></p>
        </div>

        <!-- Both halves are always in the document and one of them is hidden,
             rather than only the live one being rendered. The kind can be
             switched while the form is open, and a form that renders only
             what the current kind needs leaves the handlers wired to
             elements that are no longer there. -->
        <div class="pz-field" data-vis-field hidden>
          <label>Who can see it</label>
          <div class="pz-seg" data-vis>
            <button type="button" data-v="club" class="${form.visibility === 'club' ? 'on' : ''}">This club only</button>
            <button type="button" data-v="public" class="${form.visibility === 'public' ? 'on' : ''}">Everyone</button>
          </div>
          <p class="field-hint" data-vis-hint></p>
        </div>
        <div class="pz-field" data-vis-fixed hidden>
          <label>Who can see it</label>
          <p class="field-hint">Everybody. A shelf that takes members’ puzzles is always
            readable from the puzzle library, so there is nothing to set here.</p>
        </div>

        <label class="pz-check">
          <input type="checkbox" id="pzcl-anon" ${form.anonymous ? 'checked' : ''} />
          <span>Do not put my name on this collection — show the club instead.</span>
        </label>

        <div class="pz-coll-form-tools">
          <button class="btn primary" data-save type="button">
            ${editingId ? 'Save collection' : 'Create collection'}</button>
          ${editingId ? '<button class="btn subtle" data-cancel type="button">Cancel</button>' : ''}
        </div>
      </div>`;
  }

  function wireForm() {
    const hints = () => {
      /* A custom shelf has no switch to offer, so the segment is put away
         and the plain statement takes its place. Both are in the document,
         so this is the only thing that decides which is seen. */
      const custom = form.kind === 'custom';
      const seg = $('[data-vis-field]');
      const fixed = $('[data-vis-fixed]');
      if (seg) seg.hidden = custom;
      if (fixed) fixed.hidden = !custom;

      $('[data-kind-hint]').textContent = editingId === DEFAULT_COLLECTION_ID
        ? 'This is the shelf every club has, so it always takes members’ puzzles. Everything else about it is yours to change.'
        : form.kind === 'custom'
          ? 'Any member of the club can publish into this one. Their puzzles are worth no points until you adopt one.'
          : 'Only admins and founders can publish into this one.';
      const visHint = $('[data-vis-hint]');
      if (visHint) {
        visHint.textContent = form.visibility === 'public'
          ? 'It appears in the JagChess puzzle library for everybody, and every puzzle in it goes with it.'
          : 'Nobody outside the club sees it — and while it is set this way, the puzzles inside cannot be shared individually either.';
      }
    };

    host.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => {
      form.color = b.dataset.color;
      host.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    host.querySelectorAll('[data-kind] [data-k]').forEach((b) => (b.onclick = () => {
      form.kind = b.dataset.k;
      host.querySelectorAll('[data-kind] [data-k]').forEach((x) => x.classList.toggle('on', x === b));
      hints();
    }));
    host.querySelectorAll('[data-vis] [data-v]').forEach((b) => (b.onclick = () => {
      form.visibility = b.dataset.v;
      host.querySelectorAll('[data-vis] [data-v]').forEach((x) => x.classList.toggle('on', x === b));
      hints();
    }));
    hints();

    const cancel = $('[data-cancel]');
    if (cancel) cancel.onclick = () => { editingId = null; form = blank(); open = false; paint(); };

    $('[data-save]').onclick = async () => {
      form.name = $('#pzcl-name').value.trim();
      form.description = $('#pzcl-desc').value.trim();
      form.icon = $('#pzcl-icon').value.trim() || '♟';
      form.anonymous = $('#pzcl-anon').checked;
      if (!form.name) { toast('Give the collection a name', 'error'); $('#pzcl-name').focus(); return; }

      const me = whoAmI(ctx);
      const payload = {
        name: form.name,
        description: form.description,
        icon: form.icon,
        color: form.color,
        kind: form.kind,
        visibility: form.visibility,
        anonymous: form.anonymous,
        clubId: ctx.clubId,
        clubName: ctx.club.name || '',
        updatedAt: Date.now()
      };

      const btn = $('[data-save]');
      btn.disabled = true;
      try {
        let id = editingId;
        if (id) {
          await updateDoc(collectionDoc(ctx.clubId, id), payload);
        } else {
          const ref = await addDoc(collectionCol(ctx.clubId), {
            ...payload, createdBy: me.uid, createdByName: me.name, createdAt: Date.now()
          });
          id = ref.id;
        }
        /* The collection decides for everything on its shelf, so saving one is
           never just one write — the whole shelf is re-published or pulled. */
        await syncPublicCollection(ctx.club, normalizeCollection({ id, ...payload }), puzzles);
        toast(editingId ? 'Collection saved' : 'Collection created', 'ok');
        editingId = null;
        form = blank();
        open = false;
        paint();
      } catch (e) {
        console.error(e);
        toast('Could not save that collection', 'error');
        btn.disabled = false;
      }
    };
  }

  async function flipVisibility(id) {
    const c = collections.find((x) => x.id === id);
    if (!c) return;
    const next = c.visibility === 'public' ? 'club' : 'public';
    const inside = countIn(id);

    if (next === 'club' && inside) {
      const ok = await confirmDialog({
        title: 'Keep this collection inside the club?',
        body: `All ${inside} puzzle${inside === 1 ? '' : 's'} in it come out of the public library, ` +
              'and while it is set this way none of them can be shared on its own. Each one keeps ' +
              'its own setting, and gets it back the moment you share the collection again.',
        confirmText: 'Keep it in the club'
      });
      if (!ok) return;
    }

    try {
      await updateDoc(collectionDoc(ctx.clubId, id), { visibility: next, updatedAt: Date.now() });
      await syncPublicCollection(ctx.club, { ...c, visibility: next }, puzzles);
      toast(next === 'public' ? 'Shared with everyone' : 'Kept inside the club', 'ok');
    } catch (e) {
      console.error(e);
      toast('Could not change that', 'error');
    }
  }

  async function removeCollection(id) {
    const c = collections.find((x) => x.id === id);
    if (!c) return;
    if (c.isDefault) { toast('Every club keeps this one', 'error'); return; }
    const inside = countIn(id);
    const ok = await confirmDialog({
      title: 'Delete this collection?',
      body: inside
        ? `The ${inside} puzzle${inside === 1 ? '' : 's'} in it are not deleted — they come out of ` +
          'the library and go back to being filed under nothing.'
        : 'It is empty, so nothing else changes.',
      confirmText: 'Delete',
      danger: true
    });
    if (!ok) return;

    try {
      const orphans = puzzles.filter((p) => p.collectionId === id);
      await Promise.all(orphans.map((p) =>
        updateDoc(clubDoc(ctx.clubId, 'puzzles', p.id), { collectionId: '' }).catch(() => {})));
      await deleteDoc(collectionDoc(ctx.clubId, id));
      await removePublicCollection(ctx.clubId, id);
      await Promise.all(orphans.map((p) =>
        syncPublicPuzzle(ctx.club, { ...p, collectionId: '' }, null)));
      toast('Collection deleted');
    } catch (e) {
      console.error(e);
      toast('Could not delete that collection', 'error');
    }
  }

  paint();

  return {
    update(next) {
      collections = next.collections;
      puzzles = next.puzzles;
      /* The list only. Repainting the form as well would wipe whatever is
         half-typed into it every time anybody published a puzzle. */
      paintList();
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  WHO HAS FINISHED IT                                                    */
/* ═══════════════════════════════════════════════════════════════════════ */

/* Puzzles get set in a room, not only on a screen. A club works one on the
   demo board on a Tuesday and twenty people have solved it before anybody
   opens a laptop — and until now there was no way to say so, so the puzzle
   sat on everyone's list looking undone forever.
 *
 * Ticking somebody writes the same attempt row solving it writes, with one
 * difference that matters: it is worth nothing. No points are awarded for a
 * tick and none are taken back for clearing one, which is deliberate. An
 * admin should be able to tidy a list without moving the leaderboard, and a
 * puzzle that can be handed out for points is a puzzle that can be handed
 * out for points to your friends.
 *
 * The consequence to know about: a member whose row was ticked and who then
 * solves it properly gets the replay screen rather than the payout, because
 * as far as the club is concerned they have already done it.
 */

const attemptId = (uid, puzzleId) => `${uid}_${puzzleId}`;

/** What a tick writes. Shaped like a real attempt so the member's own page needs to know nothing about it. */
export const markedRow = (ctx, puzzle, uid) => ({
  puzzleId: puzzle.id,
  userId: uid,
  completedAt: Date.now(),
  movesUsed: 0,
  seconds: 0,
  scoreAwarded: 0,
  scoreBase: 0,
  late: false,
  /* What tells the two apart afterwards — for the row's own line in this
     modal, and so clearing one can warn about the other. */
  markedBy: ctx.user.uid,
  markedByName: (ctx.member && ctx.member.username) || '',
  source: 'admin'
});

/**
 * @param {object} ctx
 * @param {object} puzzle
 * @param {object} [api]  the two database calls, as a seam — `load()` hands
 *                        back { members, attempts }, `commit({adds,drops})`
 *                        writes them. Passing them is how this gets driven
 *                        in a test without a Firestore anywhere near it.
 */
export async function openCompletions(ctx, puzzle, api = {}) {
  if (!puzzle) return;

  const modal = el(`<div class="modal"><div class="modal-card pzdone-card">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>Who has finished this</h3>
    <p class="modal-meta" style="margin:0">${esc(puzzle.title || 'Untitled puzzle')} — tick anybody
      who has solved it away from the screen and it shows as done on their side too.
      <b>No points are given by ticking and none are taken by clearing a tick</b>, whichever way
      you leave it.</p>
    <div class="pzdone-body" data-body>
      <div class="pzdone-loading">Reading the roster…</div>
    </div>
    <div class="pzdone-foot">
      <span class="pzdone-status" data-status></span>
      <span style="flex:1"></span>
      <button class="btn subtle" data-x>Cancel</button>
      <button class="btn primary" data-save disabled>Save changes</button>
    </div>
  </div></div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  modal.onclick = (e) => { if (e.target === modal) close(); };

  const body = modal.querySelector('[data-body]');
  const saveBtn = modal.querySelector('[data-save]');
  const statusEl = modal.querySelector('[data-status]');

  let members = [];
  let before = new Map();     // uid → the attempt row as it stands
  let ticked = new Set();     // uid → ticked right now
  let term = '';

  const load = api.load || (async () => {
    const [mSnap, aSnap] = await Promise.all([
      getDocs(clubCol(ctx.clubId, 'members')),
      getDocs(query(clubCol(ctx.clubId, 'puzzleAttempts'), where('puzzleId', '==', puzzle.id)))
    ]);
    return {
      members: mSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      attempts: aSnap.docs.map((d) => d.data())
    };
  });

  const commit = api.commit || (({ adds, drops }) => Promise.all([
    ...adds.map((m) => setDoc(
      clubDoc(ctx.clubId, 'puzzleAttempts', attemptId(m.id, puzzle.id)),
      markedRow(ctx, puzzle, m.id)
    )),
    ...drops.map((m) => deleteDoc(
      clubDoc(ctx.clubId, 'puzzleAttempts', attemptId(m.id, puzzle.id))
    ))
  ]));

  try {
    const got = await load();
    members = (got.members || [])
      .slice()
      .sort((a, b) => String(a.username || a.email || '').localeCompare(String(b.username || b.email || '')));
    before = new Map((got.attempts || []).map((a) => [String(a.userId || ''), a]));
    ticked = new Set([...before.keys()].filter((uid) => members.some((m) => m.id === uid)));
  } catch (e) {
    console.error(e);
    body.innerHTML = '<div class="empty-state">Could not read the roster. Close this and try again.</div>';
    return;
  }

  if (!modal.isConnected) return;   // closed while we were reading

  body.innerHTML = `
    <div class="pzdone-tools">
      <label class="pz-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input type="search" data-q placeholder="Search members" aria-label="Search members" />
      </label>
      <div class="pzdone-bulk">
        <button class="btn subtle sm" data-all type="button">Tick everyone</button>
        <button class="btn subtle sm" data-none type="button">Clear all</button>
      </div>
    </div>
    <div class="pzdone-list" data-list></div>`;

  const matches = (m) => !term ||
    String(m.username || '').toLowerCase().includes(term) ||
    String(m.email || '').toLowerCase().includes(term);

  /* What each row says under the name. An attempt somebody earned is worth
     saying so, because clearing that one has a consequence a tick does not. */
  const lineFor = (m) => {
    if (!ticked.has(m.id)) return 'Not done yet';
    const row = before.get(m.id);
    if (!row) return 'Will be marked done when you save';
    if (row.source === 'admin') {
      return `Marked done${row.markedByName ? ' by ' + row.markedByName : ''}` +
        (row.completedAt ? ' · ' + fmtDate(row.completedAt) : '');
    }
    const pts = Number(row.scoreAwarded) || 0;
    return `Solved it${row.completedAt ? ' ' + fmtDate(row.completedAt) : ''}` +
      (pts ? ` · ${pts} pts earned` : '');
  };

  const paint = () => {
    const shown = members.filter(matches);
    const list = modal.querySelector('[data-list]');

    list.innerHTML = members.length
      ? (shown.length
        ? shown.map((m) => {
          const on = ticked.has(m.id);
          const row = before.get(m.id);
          const earned = on && row && row.source !== 'admin';
          return `<label class="pzdone-row${on ? ' is-on' : ''}">
            <input type="checkbox" data-uid="${esc(m.id)}"${on ? ' checked' : ''} />
            <span class="user-avatar-circle" style="background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username || m.email))}</span>
            <span class="pzdone-who">
              <span class="pzdone-name">${esc(m.username || 'Player')}
                <span class="role-pill ${esc(m.role || 'student')}">${esc(ROLE_LABEL[m.role] || 'Student')}</span>
                ${earned ? '<span class="pz-chip">Earned</span>' : ''}</span>
              <span class="pzdone-line">${esc(lineFor(m))}</span>
            </span>
          </label>`;
        }).join('')
        : '<div class="empty-state">Nobody matches that search.</div>')
      : '<div class="empty-state">There is nobody in the club yet.</div>';

    list.querySelectorAll('[data-uid]').forEach((box) => (box.onchange = () => {
      if (box.checked) ticked.add(box.dataset.uid);
      else ticked.delete(box.dataset.uid);
      paint();
    }));

    const { adds, drops } = diff();
    statusEl.textContent = adds.length || drops.length
      ? [
        adds.length ? `${adds.length} to mark done` : '',
        drops.length ? `${drops.length} to clear` : ''
      ].filter(Boolean).join(' · ')
      : `${ticked.size} of ${members.length} done`;
    statusEl.className = 'pzdone-status' + (adds.length || drops.length ? ' is-live' : '');
    saveBtn.disabled = !adds.length && !drops.length;
  };

  const diff = () => ({
    adds: members.filter((m) => ticked.has(m.id) && !before.has(m.id)),
    drops: members.filter((m) => !ticked.has(m.id) && before.has(m.id))
  });

  modal.querySelector('[data-q]').oninput = (e) => { term = e.target.value.trim().toLowerCase(); paint(); };
  modal.querySelector('[data-all]').onclick = () => {
    members.filter(matches).forEach((m) => ticked.add(m.id));
    paint();
  };
  modal.querySelector('[data-none]').onclick = () => {
    members.filter(matches).forEach((m) => ticked.delete(m.id));
    paint();
  };

  paint();

  saveBtn.onclick = async () => {
    const { adds, drops } = diff();

    /* Clearing a row somebody earned is the one move here with a tail: the
       points they were given stay given — this mechanic never moves points —
       but the puzzle goes back on their list and solving it again would pay
       out a second time. Worth saying out loud before it happens. */
    const earned = drops.filter((m) => {
      const row = before.get(m.id);
      return row && row.source !== 'admin' && (Number(row.scoreAwarded) || 0) > 0;
    });
    if (earned.length) {
      const names = earned.slice(0, 4).map((m) => m.username || m.email).join(', ');
      const ok = await confirmDialog({
        title: `Clear ${earned.length === 1 ? 'a solve somebody earned' : earned.length + ' solves people earned'}?`,
        body: `${names}${earned.length > 4 ? ` and ${earned.length - 4} more` : ''} solved this themselves ` +
              `and ${earned.length === 1 ? 'was' : 'were'} paid for it. Those points stay — nothing here ` +
              'ever moves points — but the puzzle goes back on their list, and solving it a second ' +
              'time would pay out again.',
        confirmText: 'Clear anyway',
        danger: true
      });
      if (!ok) return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await commit({ adds, drops });
      toast([
        adds.length ? `${adds.length} marked done` : '',
        drops.length ? `${drops.length} cleared` : ''
      ].filter(Boolean).join(' · ') + ' · no points changed', 'ok');
      close();
    } catch (e) {
      console.error(e);
      toast(e.code === 'permission-denied'
        ? 'Only staff can change who has finished a puzzle.'
        : 'Could not save that', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE ADMIN'S PAGE                                                       */
/* ═══════════════════════════════════════════════════════════════════════ */

async function puzzlesAdmin(ctx, host) {
  /* One column, the full width of the page. The builder is where all the
     work happens and the flowchart it draws can get wide, so everything
     else goes underneath it rather than squeezing it into two thirds.

     There is no separate library tile any more. It drew the same shelves
     the Collections tile below it already lists, one screen apart, so the
     shelves themselves open instead — see mountCollections. */
  host.innerHTML = `
    <div class="pz-admin">
      <div class="tile pz-build" id="pz-build"></div>
      <div class="tile pz-published">
        <div class="puzzle-side-header"><h3>Published</h3><span class="muted" id="pz-meta"></span></div>
        <p class="pz-pub-note">What the club itself has published. Puzzles your members built are
          not in here — they sit on the shelf they were published to, under Collections, where you
          can look one over and adopt it.</p>
        ${searchHTML('pz-q', 'Search published puzzles')}
        <div class="list" id="pz-list"></div>
        <div class="empty-state" id="pz-empty" hidden>Nothing published yet.</div>
        <div id="pz-pager"></div>
      </div>
      <div class="tile pz-colls" id="pz-colls"></div>
    </div>`;

  let puzzles = [];
  let collections = [];

  const pubPage = newPageState(10);
  let pubTerm = '';

  const builder = mountBuilder(ctx, host.querySelector('#pz-build'), {
    mode: 'staff',
    collections: () => collections,
    club: () => ctx.club
  });

  const collFor = (p) => collOf(collections, p);

  /* Adopting, editing and deleting are the same three things whether you
     reach a puzzle from the published list or from inside its shelf, so
     the shelves are handed these rather than growing their own. */
  const adopt = (p) => adoptPuzzle(ctx, p, { collections: () => collections, club: () => ctx.club });

  const removePuzzle = async (p) => {
    if (!p) return;
    if (!await confirmDialog({
      title: 'Delete this puzzle?',
      body: `"${p.title || 'Untitled puzzle'}" disappears for everyone. Points already awarded for it stay awarded.`,
      confirmText: 'Delete',
      danger: true
    })) return;
    await deleteDoc(clubDoc(ctx.clubId, 'puzzles', p.id));
    await removePublicPuzzle(ctx.clubId, p.id);
    toast('Puzzle deleted');
  };

  const colls = mountCollections(ctx, host.querySelector('#pz-colls'), {
    onPreview: (p) => openPuzzlePreview(p),
    onManage: (p) => openCompletions(ctx, p),
    onEdit: (p) => builder.edit(p),
    onAdopt: adopt,
    onDelete: removePuzzle
  });

  /* A member's own puzzle is not something the club published, and a list
     called Published that is three quarters other people's homework is no
     use to the person who has to keep the club's own set in order. They
     live on the Custom shelf, which is where you go to adopt one. */
  const clubsOwn = () => puzzles.filter((p) => !p.custom);

  const matches = (p, term) => {
    if (!term) return true;
    const coll = collFor(p);
    return [p.title, p.description, p.source, p.authorName, coll && coll.name]
      .some((v) => String(v || '').toLowerCase().includes(term));
  };

  function paintList() {
    const all = clubsOwn();
    const found = all.filter((p) => matches(p, pubTerm));
    const rows = pageSlice(pubPage, found);

    host.querySelector('#pz-meta').textContent = pubTerm
      ? `${found.length} of ${all.length}`
      : (all.length ? String(all.length) : '');

    const empty = host.querySelector('#pz-empty');
    empty.hidden = found.length > 0;
    empty.textContent = all.length
      ? 'Nothing here matches that search.'
      : 'Nothing published yet.';

    host.querySelector('#pz-pager').innerHTML = found.length
      ? pagerHTML(pubPage, found.length, 'puzzle', 'puzzles')
      : '';
    wirePager(host.querySelector('#pz-pager'), pubPage, found.length, paintList);

    host.querySelector('#pz-list').innerHTML = rows.map((p) => {
      const coll = collFor(p);
      const locked = visibilityLocked(coll);
      const vis = effectiveVisibility(p, coll);
      return `
      <div class="pz-row static">
        <span class="pz-row-info">
          <span class="pz-row-title">${esc(p.title || 'Untitled puzzle')}</span>
          <span class="pz-row-meta">${esc(String(p.points))} pts ·
            ${esc(String(p.stats.moves))} move${p.stats.moves === 1 ? '' : 's'} ·
            ${COLOR_NAME(p.playerColor)}${p.stats.branches > 1
              ? ' · ' + esc(String(p.stats.branches)) + ' lines' : ''}</span>
          ${bylineHTML(p, { showClub: false })}
          <span class="pz-row-flags">
            ${difficultyChip(p.difficulty)}
            ${visChip(vis, locked)}
            ${expiryChip(p)}
          </span>
        </span>
        <span class="pz-row-tools">
          <select class="pz-coll-select" data-setcoll="${esc(p.id)}" aria-label="Collection">
            <option value="">No collection</option>
            ${collections.map((c) => `<option value="${esc(c.id)}"${
              c.id === p.collectionId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <button class="btn subtle sm" data-flip="${esc(p.id)}" type="button"
            ${locked ? 'disabled title="Its collection is club-only, so this one follows it"' : ''}>
            ${vis === 'public' ? 'Make club only' : 'Share'}</button>
          <button class="btn subtle sm" data-play="${esc(p.id)}" title="Play it the way a member will">Preview</button>
          <button class="btn subtle sm" data-manage="${esc(p.id)}" type="button"
            title="Who has finished it">Manage</button>
          <button class="btn subtle sm" data-edit="${esc(p.id)}">Edit</button>
          <button class="btn danger sm" data-del="${esc(p.id)}" aria-label="Delete">✕</button>
        </span>
      </div>`;
    }).join('');

    const find = (id) => puzzles.find((x) => x.id === id);

    host.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => openPuzzlePreview(find(b.dataset.play))));
    host.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => builder.edit(find(b.dataset.edit))));
    host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => removePuzzle(find(b.dataset.del))));
    host.querySelectorAll('[data-manage]').forEach((b) => (b.onclick = () => openCompletions(ctx, find(b.dataset.manage))));

    host.querySelectorAll('[data-setcoll]').forEach((s) => (s.onchange = async () => {
      const p = find(s.dataset.setcoll);
      const next = s.value || '';
      try {
        await updateDoc(clubDoc(ctx.clubId, 'puzzles', p.id), { collectionId: next, updatedAt: Date.now() });
        await syncPublicPuzzle(ctx.club, { ...p, collectionId: next }, collOf(collections, { collectionId: next }));
        toast(next ? 'Moved' : 'Taken out of its collection', 'ok');
      } catch (e) {
        console.error(e);
        toast('Could not move that puzzle', 'error');
      }
    }));

    host.querySelectorAll('[data-flip]').forEach((b) => (b.onclick = async () => {
      const p = find(b.dataset.flip);
      const coll = collFor(p);
      if (visibilityLocked(coll)) {
        toast(forcedVisibility(coll) === 'public'
          ? 'It is on a members’ shelf, which is always public'
          : 'Its collection decides this one', 'error');
        return;
      }
      const next = p.visibility === 'public' ? 'club' : 'public';
      try {
        await updateDoc(clubDoc(ctx.clubId, 'puzzles', p.id), { visibility: next, updatedAt: Date.now() });
        await syncPublicPuzzle(ctx.club, { ...p, visibility: next }, coll);
        toast(next === 'public' ? 'Shared with everyone' : 'Kept inside the club', 'ok');
      } catch (e) {
        console.error(e);
        toast('Could not change that', 'error');
      }
    }));
  }

  const search = host.querySelector('#pz-q');
  search.oninput = () => {
    pubTerm = search.value.trim().toLowerCase();
    pubPage.page = 1;
    paintList();
  };

  /* One repair pass per visit, in the same spirit as syncPublicClub: a copy
     left behind by a tab that closed mid-write is put right by the next
     person who could have written it. It writes only what differs. */
  let swept = false;
  let seenColls = false;
  let seenPuzzles = false;
  const sweep = () => {
    /* Both halves first. Sweeping off half a picture would delete the
       copies of every puzzle that had not loaded yet — which is the one
       way a repair pass can do more damage than the thing it repairs. */
    if (swept || !seenColls || !seenPuzzles) return;
    swept = true;
    reconcilePublicLibrary(ctx.club, collections, puzzles);
  };

  const refresh = () => {
    paintList();
    colls.update({ collections, puzzles });
    sweep();
  };

  const stopC = onSnapshot(query(collectionCol(ctx.clubId), orderBy('createdAt', 'desc')), (s) => {
    collections = s.docs.map((d) => normalizeCollection({ id: d.id, ...d.data() }));
    seenColls = true;
    ensureDefaultCollection(ctx.clubId, ctx.club, collections);
    refresh();
  }, (e) => console.warn('Could not read the collections', e));

  const stopP = onSnapshot(query(clubCol(ctx.clubId, 'puzzles'), orderBy('createdAt', 'desc')), (s) => {
    puzzles = s.docs.map((d) => normalizePuzzle({ id: d.id, clubName: ctx.club.name, ...d.data() }));
    seenPuzzles = true;
    refresh();
  });

  return () => { stopC(); stopP(); builder.destroy(); };
}

function mountBuilder(ctx, host, options) {
  const opts = options || {};

  /* One wizard, three jobs: an admin publishing, a member building their
     own, and an admin adopting a member's. The differences between them are
     small and every one of them lives in the details step — which is the
     only reason there is one builder here rather than three that drift. */
  const student = opts.mode === 'student';

  /* Built from /library with no club behind it. The one thing that changes
     is where it is saved: there is no clubs/__global document to hold the
     original, so the mirror copy IS the puzzle and is written directly.
     Everything else about the wizard is identical, which is why this is a
     flag rather than a fourth job. */
  const globalBuild = opts.global === true;

  /* The collections and the club both move underneath the wizard while it is
     open — an admin can make a collection in the tile below without this
     being torn down — so they are asked for rather than captured. */
  const collectionList = () =>
    (typeof opts.collections === 'function' ? opts.collections() : (opts.collections || []));
  const clubOf = () =>
    (typeof opts.club === 'function' ? opts.club() : (opts.club || ctx.club));

  const freshDetails = () => ({
    title: '', description: '', source: '',
    difficulty: 5, collectionId: '', visibility: 'club', anonymous: false,
    points: student ? 0 : 10, expiry: '', latePct: student ? 0 : 25, prize: 10
  });

  let step = 0;
  let editingId = null;
  let adopt = opts.adopt || null;
  let carried = null;           // the published puzzle being edited, as stored
  let authoring = whoAmI(ctx);
  let color = 'w';
  let position = null;          // the confirmed start, as a full FEN
  let tree = normalizeTree(null);
  let at = ROOT;                // where in the line the board is standing
  let board = null;
  let game = null;
  let details = freshDetails();

  const $ = (sel) => host.querySelector(sel);

  const destroyBoard = () => { if (board && board.destroy) board.destroy(); board = null; };

  /* ── chrome ── */

  function paintShell() {
    host.innerHTML = `
      <div class="pz-wiz">
        <div class="pz-wiz-head">
          <div>
            <h3 data-title>New puzzle</h3>
            <p class="muted pz-wiz-sub" data-sub></p>
          </div>
          <button class="btn subtle sm" data-cancel type="button" hidden>Start over</button>
        </div>
        <ol class="pz-steps" data-steps></ol>
        <div class="pz-wiz-body" data-body></div>
      </div>`;
    $('[data-cancel]').onclick = async () => {
      if (!await confirmDialog({
        title: editingId ? 'Stop editing?' : 'Start over?',
        body: editingId
          ? 'The puzzle stays exactly as it was published. Anything you have changed here is dropped.'
          : 'The position and every move you have recorded are dropped.',
        confirmText: editingId ? 'Stop editing' : 'Start over',
        danger: true
      })) return;
      reset();
    };
  }

  /* Why a step cannot be opened yet, or null when it can. The rail is a way
     of moving around, not a turnstile — but there is genuinely nothing to
     draw on the Moves step before a position exists, so saying so beats
     opening an empty board. */
  const blockedBy = (i) => {
    if (i <= 1) return null;
    if (!position) return 'Set the starting position first.';
    if (i === 3 && treeStats(tree).empty) return 'Record at least one move first.';
    return null;
  };

  function paintSteps() {
    $('[data-steps]').innerHTML = STEPS.map((st, i) => {
      const why = blockedBy(i);
      const done = i < step && !why;
      return `<li class="pz-step-pill${i === step ? ' on' : ''}${done ? ' done' : ''}${why ? ' locked' : ''}"
          data-goto="${i}" tabindex="0" role="button"
          ${why ? `aria-disabled="true" title="${esc(why)}"` : ''}>
        <span class="pz-step-n">${done ? '✓' : i + 1}</span>
        <span class="pz-step-t"><b>${esc(st[0])}</b><small>${esc(why || st[1])}</small></span>
      </li>`;
    }).join('');

    const go = (li) => {
      const i = Number(li.dataset.goto);
      const why = blockedBy(i);
      if (why) { toast(why); return; }
      step = i;
      paint();
    };
    $('[data-steps]').querySelectorAll('[data-goto]').forEach((li) => {
      li.onclick = () => go(li);
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(li); } };
    });

    $('[data-title]').textContent = adopt
      ? 'Adopt this puzzle'
      : editingId ? 'Edit puzzle' : student ? 'Build your own puzzle' : 'New puzzle';
    $('[data-cancel]').hidden = !(editingId || position || step > 0);
  }

  const paint = () => {
    paintSteps();
    destroyBoard();
    if (step === 0) return paintColor();
    if (step === 1) return paintPosition();
    if (step === 2) return paintMoves();
    return paintDetails();
  };

  /* ── 1 · color ── */

  function paintColor() {
    $('[data-sub]').textContent = 'Start with the one thing everything else depends on.';
    $('[data-body]').innerHTML = `
      <div class="pz-ask">
        <h4>Who is solving this puzzle?</h4>
        <p>Whoever plays it will be this color, and the board will face their way.</p>
        <div class="pz-color-picks">
          <button class="pz-color-pick${color === 'w' ? ' on' : ''}" data-pick="w" type="button">
            <span class="pz-color-king white">♔</span>
            <b>White</b>
            <small>White moves first from the position you set</small>
          </button>
          <button class="pz-color-pick${color === 'b' ? ' on' : ''}" data-pick="b" type="button">
            <span class="pz-color-king black">♚</span>
            <b>Black</b>
            <small>Black moves first from the position you set</small>
          </button>
        </div>
      </div>`;

    $('[data-body]').querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
      const next = b.dataset.pick;
      /* Changing color after the line exists would make every recorded move
         belong to the wrong side, so it is asked about rather than silently
         applied. */
      if (next !== color && treeStats(tree).nodes) {
        confirmDialog({
          title: 'Switch to ' + COLOR_NAME(next) + '?',
          body: 'The moves you have recorded belong to the colors as they are now, so they will be cleared. The starting position is kept.',
          confirmText: 'Switch and clear the moves',
          danger: true
        }).then((ok) => {
          if (!ok) return;
          color = next;
          tree = normalizeTree(null);
          at = ROOT;
          if (position) position = startFen(position, color);
          step = 1;
          paint();
        });
        return;
      }
      color = next;
      step = 1;
      paint();
    }));
  }

  /* ── 2 · the starting position ── */

  function paintPosition() {
    destroyBoard();
    $('[data-sub]').textContent = `${COLOR_NAME(color)} is solving. Now set the board they will see.`;
    $('[data-body]').innerHTML = `
      <div class="pz-setup">
        <div class="chessboard pz-setup-board" data-board></div>
        <div class="pz-setup-foot">
          <p class="pz-stage-note">Drag pieces on from the trays, and drag them off the board to
            remove them. When it looks right, confirm it.</p>
          <div class="pz-stage-tools">
            <button class="btn subtle" data-standard type="button">Standard start</button>
            <button class="btn subtle" data-clear type="button">Clear board</button>
            <button class="btn subtle" data-fen type="button">Import FEN…</button>
            <span class="pz-tools-gap"></span>
            <button class="btn primary" data-confirm type="button">Confirm starting position</button>
          </div>
          <p class="pz-stage-err" data-err hidden></p>
          ${treeStats(tree).nodes ? `<p class="field-hint">This puzzle already has
            ${esc(String(treeStats(tree).nodes))} move${treeStats(tree).nodes === 1 ? '' : 's'} recorded.
            Changing the position clears them.</p>` : ''}
        </div>
      </div>`;

    board = window.Chessboard($('[data-board]'), {
      draggable: true,
      dropOffBoard: 'trash',
      sparePieces: true,
      position: position ? placementOf(position) : 'start',
      orientation: ORIENT(color),
      pieceTheme: PIECE_THEME
    });

    const err = $('[data-err]');
    const fail = (m) => { err.textContent = m; err.hidden = false; };

    $('[data-standard]').onclick = () => { board.position('start'); err.hidden = true; };
    $('[data-clear]').onclick = () => { board.clear(); err.hidden = true; };

    $('[data-fen]').onclick = async () => {
      const value = await promptDialog({
        title: 'Import a position',
        label: 'Paste a FEN',
        placeholder: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
        confirmText: 'Load it'
      });
      if (!value) return;
      const g = legal(value);
      if (!g) { fail('That FEN is not a position this board can read.'); return; }
      board.position(placementOf(g.fen()));
      /* The FEN says whose move it is, and that is almost always the color
         the author means to be solving — so it is taken as the answer to
         step one rather than being thrown away. */
      if (g.turn() !== color) {
        color = g.turn();
        board.orientation(ORIENT(color));
        paintSteps();
        toast(`That FEN has ${COLOR_NAME(color)} to move, so ${COLOR_NAME(color)} is solving.`);
      }
      err.hidden = true;
    };

    $('[data-confirm]').onclick = async () => {
      const fen = startFen(board.fen(), color);
      const g = legal(fen);
      if (!g) { fail('That is not a legal position — both kings have to be on the board.'); return; }
      if (!g.moves().length) {
        fail(`${COLOR_NAME(color)} has no legal moves from there, so the puzzle cannot start.`);
        return;
      }

      if (position && position !== fen && treeStats(tree).nodes) {
        const ok = await confirmDialog({
          title: 'Clear the recorded moves?',
          body: 'The moves you recorded were played from the old position, so they no longer make sense. They will be cleared.',
          confirmText: 'Change the position',
          danger: true
        });
        if (!ok) return;
        tree = normalizeTree(null);
      }
      position = fen;
      at = ROOT;
      step = 2;
      paint();
    };
  }

  /* ── 3 · the moves ── */

  function paintMoves() {
    destroyBoard();
    const whose = depthOf(tree, at) % 2 === 0 ? color : (color === 'w' ? 'b' : 'w');
    $('[data-sub]').textContent = 'Play the winning line. Every move is recorded as you make it.';
    $('[data-body]').innerHTML = `
      <div class="pz-stage">
        <div class="pz-stage-board">
          <div class="pz-turn-bar">
            <span class="pzs-chip ${whose === 'b' ? 'black' : 'white'}" data-whose>${COLOR_NAME(whose)} to move</span>
            <span class="pz-turn-note" data-note></span>
          </div>
          <div class="chessboard" data-board></div>
          <div class="pz-move-tools">
            <button class="btn subtle sm" data-back type="button">Back to start</button>
            <button class="btn subtle sm" data-undo type="button">Delete this move</button>
          </div>
        </div>
        <div class="pz-stage-side">
          <div class="pz-line-head">
            <h4>The line</h4>
            <span class="pz-line-stat" data-stat></span>
          </div>
          <div class="pz-flow-wrap" data-flow></div>
          <p class="pz-lines-help" data-help></p>
          <button class="btn primary block" data-next type="button">Next: the details</button>
        </div>
      </div>`;

    game = legal(position);
    const path = pathTo(tree, at) || [ROOT];
    for (const id of path.slice(1)) game.move(tree.nodes[id].san, { sloppy: true });

    board = window.Chessboard($('[data-board]'), {
      draggable: true,
      position: placementOf(game.fen()),
      orientation: ORIENT(color),
      pieceTheme: PIECE_THEME,
      onDrop: (from, to) => {
        if (isPromotion(game, from, to)) {
          const mover = game.turn();
          askPromotion(mover).then((choice) => {
            if (!choice) return;
            record(from, to, choice);
          });
          return 'snapback';
        }
        return record(from, to, 'q');
      },
      onSnapEnd: () => board.position(placementOf(game.fen()))
    });

    function record(from, to, promotion) {
      const move = game.move({ from, to, promotion });
      if (!move) return 'snapback';
      const r = addMove(tree, at, move.san);
      tree = r.tree;
      at = r.id;
      /* The board is about to be replaced, and replacing it from inside its
         own drop handler tears it down mid-animation — chessboard.js still
         has a snap to finish. One turn of the event loop is all it needs. */
      setTimeout(paintMoves, 0);
      return undefined;
    }

    paintFlow();

    $('[data-back]').onclick = () => { at = ROOT; paintMoves(); };
    $('[data-undo]').onclick = () => {
      if (at === ROOT) { toast('There is nothing to delete yet.'); return; }
      removeMove(at);
    };
    $('[data-next]').onclick = () => {
      if (treeStats(tree).empty) { toast('Record at least one move first', 'error'); return; }
      step = 3;
      paint();
    };
  }

  function removeMove(id) {
    const back = (parentsOf(tree)[id] || [])[0] || ROOT;
    tree = deleteNode(tree, id);
    at = tree.nodes[back] ? back : ROOT;
    paintMoves();
  }

  /* ── the flowchart ──────────────────────────────────────────────────
     A line of chess is a list until it forks, and the moment it forks a
     list stops being able to say what happened. So the moves are drawn as
     the graph they are: one box per move, laid out in rows by how deep it
     sits, with the edges drawn behind them.

     Depth is the LONGEST route to a node, not the shortest. Two branches
     that merge can arrive from different distances, and using the longest
     is what keeps every edge pointing downwards instead of doubling back.

     Rows are then ordered by where each node's parents sit — one pass of
     the usual barycenter shuffle — which is enough to keep the edges from
     crossing in anything a person would build by hand.
     ──────────────────────────────────────────────────────────────── */

  const NODE_W = 82;
  const NODE_H = 34;
  const GAP_X = 20;
  const GAP_Y = 46;

  /* ── looking around the graph ───────────────────────────────────
     A puzzle with four or five branches draws wider and deeper than any box
     on the page, and scrollbars are a poor way to read a diagram: you
     cannot see the shape of the thing while you are inside it.

     So the chart is a viewport. The wheel zooms about the pointer, a drag
     on the background pans, and Fit puts the whole graph back on screen at
     whatever scale that takes. The view is held here rather than on the
     element because every recorded move repaints the chart, and a chart
     that jumped back to the top-left after each move would be worse than
     no panning at all.
     ────────────────────────────────────────────────────── */

  const ZOOM_MIN = 0.35;
  const ZOOM_MAX = 2.5;
  let view = { z: 1, x: 0, y: 0, set: false };

  const freshView = () => { view = { z: 1, x: 0, y: 0, set: false }; };
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

  function applyView() {
    const stage = $('[data-stage]');
    if (!stage) return;
    stage.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.z + ')';
    const out = $('[data-zoom-label]');
    if (out) out.textContent = Math.round(view.z * 100) + '%';
  }

  /** Puts the whole graph on screen, centred, at the largest scale that fits. */
  function fitView(size) {
    const wrap = $('[data-flow]');
    if (!wrap || !size) return;
    const pad = 28;
    const w = Math.max(1, wrap.clientWidth - pad * 2);
    const h = Math.max(1, wrap.clientHeight - pad * 2);
    /* Never past 1 to fill the box: a three-move puzzle blown up to fill
       half a metre of screen looks like something has gone wrong. */
    const z = clampZoom(Math.min(1, Math.min(w / size.width, h / size.height)));
    view = {
      z,
      x: (wrap.clientWidth - size.width * z) / 2,
      y: pad,
      set: true
    };
    applyView();
  }

  function zoomBy(factor, at) {
    const wrap = $('[data-flow]');
    if (!wrap) return;
    const next = clampZoom(view.z * factor);
    if (next === view.z) return;

    /* About a point — the pointer for a wheel, the middle of the box for a
       button — so whatever is being looked at stays under it. */
    const box = wrap.getBoundingClientRect();
    const px = at ? at.x - box.left : wrap.clientWidth / 2;
    const py = at ? at.y - box.top : wrap.clientHeight / 2;

    view.x = px - (px - view.x) * (next / view.z);
    view.y = py - (py - view.y) * (next / view.z);
    view.z = next;
    view.set = true;
    applyView();
  }

  /** Pans so the move being stood on is inside the box, if it is not. */
  function ensureVisible(node) {
    const wrap = $('[data-flow]');
    if (!wrap || !node) return;
    const box = wrap.getBoundingClientRect();
    const n = node.getBoundingClientRect();
    const pad = 16;
    let dx = 0;
    let dy = 0;
    if (n.left < box.left + pad) dx = box.left + pad - n.left;
    else if (n.right > box.right - pad) dx = box.right - pad - n.right;
    if (n.top < box.top + pad) dy = box.top + pad - n.top;
    else if (n.bottom > box.bottom - pad) dy = box.bottom - pad - n.bottom;
    if (!dx && !dy) return;
    view.x += dx;
    view.y += dy;
    applyView();
  }

  /**
   * Wires the wheel and the drag, once per painted chart.
   *
   * A drag that starts on a move is that move's business — you are clicking
   * it, not moving the canvas — so panning begins only on the background.
   */
  function wireViewport(wrap) {
    wrap.onwheel = (e) => {
      e.preventDefault();
      zoomBy(Math.pow(0.999, e.deltaY), { x: e.clientX, y: e.clientY });
    };

    let from = null;
    wrap.onpointerdown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('[data-node], [data-merge], [data-del], [data-zoom]')) return;
      from = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      wrap.classList.add('is-panning');
    };
    wrap.onpointermove = (e) => {
      if (!from) return;
      view.x = from.vx + (e.clientX - from.x);
      view.y = from.vy + (e.clientY - from.y);
      view.set = true;
      applyView();
    };
    const stop = (e) => {
      if (!from) return;
      from = null;
      wrap.classList.remove('is-panning');
      try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    wrap.onpointerup = stop;
    wrap.onpointercancel = stop;
  }

  function chartLayout() {
    const parents = parentsOf(tree);
    const depth = {};
    const busy = new Set();
    const depthOfId = (id) => {
      if (depth[id] !== undefined) return depth[id];
      if (busy.has(id)) return 0;                 // belt and braces; the graph is acyclic
      busy.add(id);
      const ps = parents[id] || [];
      depth[id] = ps.length ? Math.max(...ps.map(depthOfId)) + 1 : 0;
      busy.delete(id);
      return depth[id];
    };
    Object.keys(tree.nodes).forEach(depthOfId);

    // first ordering: the order a depth-first walk meets them
    const rows = [];
    const placed = new Set();
    const walk = (id) => {
      if (placed.has(id)) return;
      placed.add(id);
      const d = depth[id];
      (rows[d] || (rows[d] = [])).push(id);
      for (const c of tree.nodes[id].children) walk(c);
    };
    walk(tree.root);
    for (const id of Object.keys(tree.nodes)) walk(id);   // anything stranded

    // second ordering: sit under your parents
    for (let d = 1; d < rows.length; d++) {
      const above = rows[d - 1] || [];
      const indexOf = (id) => above.indexOf(id);
      rows[d].sort((a, b) => {
        const mean = (id) => {
          const ps = (parents[id] || []).map(indexOf).filter((i) => i >= 0);
          return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 1e6;
        };
        return mean(a) - mean(b);
      });
    }

    const widest = rows.reduce((n, r) => Math.max(n, r.length), 1);
    const width = widest * NODE_W + (widest - 1) * GAP_X;
    const pos = {};
    rows.forEach((row, d) => {
      const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
      const left = (width - rowWidth) / 2;
      row.forEach((id, i) => {
        pos[id] = { x: left + i * (NODE_W + GAP_X), y: d * (NODE_H + GAP_Y), d };
      });
    });

    return {
      pos, depth, parents, rows,
      width: Math.max(width, 160),
      height: Math.max(rows.length * NODE_H + (rows.length - 1) * GAP_Y, NODE_H)
    };
  }

  /* Pairs of moves that reach the same board and are not on the same
     branch. Those — and only those — get a + between them. */
  function mergePairs() {
    const ids = Object.keys(tree.nodes).filter((id) => id !== ROOT);
    const byKey = new Map();
    for (const id of ids) {
      const k = keyAt(tree, position, id);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(id);
    }
    const pairs = [];
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (wouldLoop(tree, group[i], group[j])) continue;
          pairs.push([group[i], group[j]]);
        }
      }
    }
    return pairs;
  }

  const descendantCount = (id) => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const n = stack.pop();
      for (const c of tree.nodes[n].children) {
        if (seen.has(c)) continue;
        seen.add(c);
        stack.push(c);
      }
    }
    return seen.size;
  };

  async function doMerge(a, b) {
    /* Fold whichever side has less underneath it into the other, so a merge
       never throws away the longer piece of work. */
    const [from, into] = descendantCount(a) <= descendantCount(b) ? [a, b] : [b, a];
    const losing = descendantCount(from);

    if (losing) {
      const ok = await confirmDialog({
        title: 'Merge these two lines?',
        body: `Both reach the same position, so they can share one continuation. ` +
              `The ${losing} move${losing === 1 ? '' : 's'} recorded under ` +
              `${tree.nodes[from].san} will be dropped in favour of the other side's.`,
        confirmText: 'Merge them'
      });
      if (!ok) return;
    }

    const result = mergeNodes(tree, position, from, into);
    if (!result.ok) { toast(result.why, 'error'); return; }
    tree = result.tree;
    if (!tree.nodes[at]) at = into;
    paintMoves();
    toast('Lines merged', 'ok');
  }

  function paintFlow() {
    const stats = treeStats(tree);
    const statEl = $('[data-stat]');
    if (statEl) {
      statEl.textContent = stats.empty
        ? 'nothing recorded yet'
        : `${stats.moves} move${stats.moves === 1 ? '' : 's'} to find` +
          (stats.branches > 1 ? ` · ${stats.branches} ways` : '');
    }

    const note = $('[data-note]');
    if (note) {
      note.textContent = at === ROOT
        ? 'Play the first move of the solution.'
        : (depthOf(tree, at) % 2 === 0
          ? 'Your color again — play the next move of the solution.'
          : 'Now play the reply you want the puzzle to answer with.');
    }

    const wrap = $('[data-flow]');
    if (!wrap) return;

    if (stats.empty) {
      wrap.innerHTML = `<div class="pz-flow-empty">Drag a piece on the board and the first move
        appears here.</div>`;
      const h0 = $('[data-help]');
      if (h0) h0.textContent = 'Every move you play is recorded. Click one later to go back to it.';
      return;
    }

    const L = chartLayout();
    const pairs = mergePairs();

    const edge = (from, to) => {
      const a = L.pos[from], b = L.pos[to];
      const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2, y2 = b.y;
      const mid = (y1 + y2) / 2;
      return `<path d="M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" />`;
    };

    const edges = [];
    for (const [id, n] of Object.entries(tree.nodes)) {
      for (const c of n.children) if (L.pos[id] && L.pos[c]) edges.push(edge(id, c));
    }

    const nodeHTML = (id) => {
      const p = L.pos[id];
      const style = `left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px`;
      if (id === ROOT) {
        return `<div class="pz-node is-root${at === ROOT ? ' on' : ''}" data-node="${esc(id)}"
          style="${style}" role="button" tabindex="0" title="Back to the starting position">Start</div>`;
      }
      const mine = p.d % 2 === 1;
      const shared = (L.parents[id] || []).length > 1;
      const end = isEnd(tree, id);
      const no = Math.ceil(p.d / 2);
      return `<div class="pz-node${mine ? ' mine' : ' theirs'}${at === id ? ' on' : ''}${shared ? ' shared' : ''}"
        data-node="${esc(id)}" style="${style}" role="button" tabindex="0"
        title="${end ? 'End of this line — click to go back to it' : 'Go back to this move'}">
        <span class="pz-node-n">${no}${mine ? '.' : '…'}</span>
        <span class="pz-node-san">${esc(tree.nodes[id].san)}</span>
        ${end ? '<span class="pz-node-flag" aria-label="End of the line">⚑</span>' : ''}
        <button class="pz-node-x" data-del="${esc(id)}" type="button"
          title="Delete this move and everything under it" aria-label="Delete this move">×</button>
      </div>`;
    };

    const mergeHTML = ([a, b], i) => {
      const pa = L.pos[a], pb = L.pos[b];
      if (!pa || !pb) return '';
      const x = (pa.x + pb.x) / 2 + NODE_W / 2;
      const y = (pa.y + pb.y) / 2 + NODE_H / 2;
      return `<button class="pz-merge" data-merge="${i}" type="button"
        style="left:${x}px;top:${y}px"
        title="${esc(tree.nodes[a].san)} and ${esc(tree.nodes[b].san)} reach the same position — merge these branches"
        aria-label="Merge these two branches">+</button>`;
    };

    wrap.innerHTML = `
      <div class="pz-flow" data-stage style="width:${L.width}px;height:${L.height}px">
        <svg class="pz-flow-edges" width="${L.width}" height="${L.height}"
             viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">${edges.join('')}</svg>
        ${Object.keys(L.pos).map(nodeHTML).join('')}
        ${pairs.map(mergeHTML).join('')}
      </div>
      <div class="pz-flow-zoom" data-zoom>
        <button type="button" data-zoom-out title="Zoom out" aria-label="Zoom out">−</button>
        <span data-zoom-label>100%</span>
        <button type="button" data-zoom-in title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" data-zoom-fit title="Fit the whole line on screen">Fit</button>
      </div>`;

    wrap.querySelector('[data-zoom-in]').onclick = () => zoomBy(1.25, null);
    wrap.querySelector('[data-zoom-out]').onclick = () => zoomBy(1 / 1.25, null);
    wrap.querySelector('[data-zoom-fit]').onclick = () => fitView(L);
    wireViewport(wrap);

    const help = $('[data-help]');
    if (help) {
      help.textContent = pairs.length
        ? 'Two branches reach the same position — press + to merge them and share what comes next.'
        : 'Click any move to go back to it. Play something different from there and it becomes a second way to win.';
      help.classList.toggle('is-merge', pairs.length > 0);
    }

    wrap.querySelectorAll('[data-node]').forEach((n) => {
      const go = () => { at = n.dataset.node; paintMoves(); };
      n.onclick = (e) => { if (e.target.closest('[data-del]')) return; go(); };
      n.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    wrap.querySelectorAll('[data-del]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      removeMove(b.dataset.del);
    }));
    wrap.querySelectorAll('[data-merge]').forEach((b) => (b.onclick = () => {
      const pair = pairs[Number(b.dataset.merge)];
      if (pair) doMerge(pair[0], pair[1]);
    }));

    /* The first chart of a session is fitted; after that the view belongs to
       whoever moved it, and a repaint must not take it off them. What does
       move is the graph growing past the edge — so the move being stood on
       is nudged back into sight, and nothing else changes. */
    if (!view.set) fitView(L);
    else applyView();

    const here = wrap.querySelector('.pz-node.on');
    if (here) ensureVisible(here);
  }

  /* ── 4 · the details ── */

  function paintDetails() {
    destroyBoard();
    const stats = treeStats(tree);
    const shelves = collectionList();
    const pickable = student ? shelves.filter((c) => c.kind === 'custom') : shelves;
    const chosen = shelves.find((c) => c.id === details.collectionId) || null;
    const locked = visibilityLocked(chosen);
    const forced = forcedVisibility(chosen);

    $('[data-sub]').textContent = adopt
      ? 'Make it yours — and decide what the member who built it is paid for it.'
      : 'The last of it — what it is called and what it is worth.';

    $('[data-body]').innerHTML = `
      <div class="pz-details">
        <div class="pz-details-form">
          ${adopt ? `
          <div class="pz-adopt-note">
            <b>Adopted from ${esc(adopt.anonymous ? 'a member who asked not to be named' : (adopt.authorName || 'a member'))}</b>
            <span>Change anything you like. When you publish, their puzzle is retired, the prize
              below is paid into their points, and${adopt.anonymous
                ? ' the club is credited rather than their name.'
                : ' their name goes on it next to yours.'}</span>
          </div>` : ''}

          <div class="pz-field">
            <label for="pzd-title">Title</label>
            <input id="pzd-title" maxlength="140" value="${esc(details.title)}" placeholder="Mate in two" />
          </div>
          <div class="pz-field">
            <label for="pzd-desc">Short description <span class="opt">optional</span></label>
            <textarea id="pzd-desc" rows="2" maxlength="600"
              placeholder="A word about where it came from, or what to look for.">${esc(details.description)}</textarea>
          </div>
          <div class="pz-field">
            <label for="pzd-source">Source link <span class="opt">optional</span></label>
            <input id="pzd-source" maxlength="500" value="${esc(details.source)}"
              placeholder="lichess.org/training/12345" />
            <p class="field-hint">Shown as a button when somebody plays the puzzle.</p>
          </div>

          <div class="pz-field">
            <label for="pzd-diff">How hard is it</label>
            <div class="pz-late-row">
              <input id="pzd-diff" type="range" min="0" max="10" step="0.1"
                value="${esc(difficultyText(details.difficulty))}" />
              <output class="pz-diff-out" data-diff-out></output>
            </div>
            <p class="field-hint" data-diff-hint></p>
          </div>

          <div class="pz-field">
            <label for="pzd-coll">Collection${student ? '' : ' <span class="opt">optional</span>'}</label>
            <select id="pzd-coll">
              ${student ? '' : '<option value="">No collection</option>'}
              ${pickable.map((c) => `<option value="${esc(c.id)}"${
                c.id === details.collectionId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
            <p class="field-hint" data-coll-hint></p>
          </div>

          ${student ? `
          <p class="pz-student-note">Puzzles members build are worth no points — that is what keeps
            the way to earn points being solving them. An admin can adopt yours, and if they do you
            are paid for it.</p>` : `
          <div class="pz-field-row">
            <div class="pz-field">
              <label for="pzd-points">Points</label>
              <input id="pzd-points" type="number" min="0" step="1" value="${esc(String(details.points))}" />
            </div>
            <div class="pz-field">
              <label for="pzd-expiry">Due date <span class="opt">optional</span></label>
              <input id="pzd-expiry" type="date" value="${esc(details.expiry)}" />
            </div>
          </div>

          <div class="pz-field" data-late${details.expiry ? '' : ' hidden'}>
            <label for="pzd-late">Knocked off for solving late</label>
            <div class="pz-late-row">
              <input id="pzd-late" type="range" min="0" max="100" step="5" value="${esc(String(details.latePct))}" />
              <output class="pz-late-out" data-late-out>${esc(String(details.latePct))}%</output>
            </div>
            <p class="field-hint" data-late-hint></p>
          </div>`}

          ${adopt ? `
          <div class="pz-field pz-prize">
            <label for="pzd-prize">Prize for whoever built it</label>
            <input id="pzd-prize" type="number" min="0" step="1" value="${esc(String(details.prize))}" />
            <p class="field-hint">Paid into their club points the moment you publish. Nothing is
              taken from anybody to pay it.</p>
          </div>` : ''}

          ${student ? `
          <p class="field-hint pz-vis-follow">Who can see it is decided by the collection you put it
            in, so there is nothing to set here.</p>` : `
          <div class="pz-field">
            <label>Who can see it</label>
            <div class="pz-seg${locked ? ' is-locked' : ''}" data-visseg>
              <button type="button" data-v="club" class="${
                (locked ? forced === 'club' : details.visibility === 'club') ? 'on' : ''}"${locked ? ' disabled' : ''}>This club only</button>
              <button type="button" data-v="public" class="${
                (locked ? forced === 'public' : details.visibility === 'public') ? 'on' : ''}"${locked ? ' disabled' : ''}>Everyone</button>
            </div>
            <p class="field-hint" data-vis-hint></p>
          </div>`}

          <label class="pz-check">
            <input type="checkbox" id="pzd-anon" ${details.anonymous ? 'checked' : ''} />
            <span>Do not put my name on it — credit the club instead.</span>
          </label>
        </div>

        <aside class="pz-summary">
          <h4>What you have built</h4>
          <dl>
            <div><dt>Solving as</dt><dd>${COLOR_NAME(color)}</dd></div>
            <div><dt>Moves to find</dt><dd data-sum-moves>${esc(String(stats.moves))}</dd></div>
            <div><dt>Ways to win</dt><dd>${esc(String(Math.max(1, stats.branches)))}</dd></div>
            <div><dt>Difficulty</dt><dd data-sum-diff>—</dd></div>
            <div><dt>Collection</dt><dd data-sum-coll>—</dd></div>
            <div><dt>Seen by</dt><dd data-sum-vis>—</dd></div>
            <div><dt>Worth on time</dt><dd data-sum-full>—</dd></div>
            <div data-sum-late-row hidden><dt>Worth late</dt><dd data-sum-late>—</dd></div>
            ${adopt ? '<div><dt>Prize paid</dt><dd data-sum-prize>—</dd></div>' : ''}
          </dl>
          <p class="pz-summary-note">Moves to find is counted off the line you recorded, so there is
            no attempts box to guess at.</p>
          <button class="btn subtle block" data-preview type="button">Preview it</button>
          <button class="btn primary block" data-publish type="button">
            ${adopt ? 'Adopt and publish' : editingId ? 'Save changes' : 'Publish puzzle'}</button>
        </aside>
      </div>`;

    const val = (sel, fallback) => {
      const node = $(sel);
      return node ? node.value : fallback;
    };

    const read = () => {
      details = {
        title: $('#pzd-title').value.trim(),
        description: $('#pzd-desc').value.trim(),
        source: $('#pzd-source').value.trim(),
        difficulty: clampDifficulty(val('#pzd-diff', details.difficulty)),
        collectionId: val('#pzd-coll', ''),
        /* A student never sees the switch, so it is not read from one; the
           collection answers for them. */
        visibility: student ? 'club' : details.visibility,
        anonymous: $('#pzd-anon').checked,
        points: student ? 0 : Math.max(0, Math.trunc(Number(val('#pzd-points', 0)) || 0)),
        expiry: student ? '' : val('#pzd-expiry', ''),
        latePct: student ? 0 : Math.min(100, Math.max(0, Math.trunc(Number(val('#pzd-late', 0)) || 0))),
        prize: Math.max(0, Math.trunc(Number(val('#pzd-prize', details.prize)) || 0))
      };
      return details;
    };

    const repaintOn = (sel, fn) => { const n = $(sel); if (n) n.addEventListener('input', fn); };

    const paintWorth = () => {
      const d = read();
      const coll = shelves.find((c) => c.id === d.collectionId) || null;
      const shut = visibilityLocked(coll);
      const shutTo = forcedVisibility(coll);
      const vis = effectiveVisibility({ visibility: d.visibility }, coll);

      $('[data-diff-out]').textContent = `${difficultyText(d.difficulty)} / 10`;
      $('[data-diff-hint]').textContent = {
        easy: 'Easy — almost everybody will see it straight away.',
        gentle: 'Gentle — a moment’s looking and it is there.',
        moderate: 'Moderate — the middle of the scale, and most puzzles belong here.',
        hard: 'Hard — this one takes working out.',
        brutal: 'Brutal — expect most people not to find it.'
      }[difficultyBand(d.difficulty)] || '';
      $('[data-sum-diff]').textContent =
        `${difficultyText(d.difficulty)} / 10 · ${difficultyWord(d.difficulty)}`;

      $('[data-coll-hint]').textContent = !shelves.length
        ? (student
          ? 'There is nowhere to publish yet — an admin has to open a collection members can add to.'
          : 'No collections yet. Make one and your puzzles can be filed and shared as a set.')
        : coll
          ? (coll.kind === 'custom'
            ? `"${coll.name}" takes members’ puzzles, so everything on it is readable from the puzzle library.`
            : coll.visibility === 'public'
              ? `"${coll.name}" is shared with everybody on JagChess.`
              : `"${coll.name}" is kept inside the club, so everything in it is too.`)
          : 'Filed under nothing. It still shows in All puzzles, just not in the library.';
      $('[data-sum-coll]').textContent = coll ? coll.name : 'none';

      const seg = $('[data-visseg]');
      if (seg) {
        seg.classList.toggle('is-locked', shut);
        seg.querySelectorAll('[data-v]').forEach((b) => {
          b.disabled = shut;
          b.classList.toggle('on', b.dataset.v === (shut ? shutTo : d.visibility));
        });
      }
      const visHint = $('[data-vis-hint]');
      if (visHint) {
        visHint.textContent = shut
          ? (shutTo === 'public'
            ? 'It is on a shelf that takes members’ puzzles, and those are always readable from the puzzle library, so this one is too.'
            : 'Its collection is club-only, so this one follows it. Your own setting is kept, and comes back the moment the collection is shared again.')
          : vis === 'public'
            ? 'Anybody signed in to JagChess can find and play it from the puzzle library.'
            : 'Only members of this club can see it.';
      }
      $('[data-sum-vis]').textContent = vis === 'public' ? 'everyone' : 'this club';

      const onTime = scoreFor({ points: d.points });
      $('[data-sum-full]').textContent = d.points
        ? `${onTime.points} pt${onTime.points === 1 ? '' : 's'}`
        : 'no points';

      const lateWrap = $('[data-late]');
      if (lateWrap) {
        const expiresAt = endOfDay(d.expiry);
        lateWrap.hidden = !expiresAt;
        $('[data-late-out]').textContent = d.latePct + '%';
        const late = scoreFor({ points: d.points, expiresAt: 1, latePenaltyPct: d.latePct }, 2);
        $('[data-sum-late-row]').hidden = !expiresAt;
        $('[data-sum-late]').textContent = `${late.points} pt${late.points === 1 ? '' : 's'}`;

        const hint = $('[data-late-hint]');
        if (hint) {
          hint.textContent = d.latePct === 0
            ? 'Nothing comes off — the date is only a nudge.'
            : d.latePct === 100
              ? 'Solving late is worth nothing at all, but the puzzle stays playable.'
              : `Solve it after ${d.expiry ? fmtDate(endOfDay(d.expiry)) : 'the date'} and it is worth ` +
                `${late.points} instead of ${d.points}. Decimals are dropped, never rounded up.`;
        }
      }

      const prize = $('[data-sum-prize]');
      if (prize) prize.textContent = `${d.prize} pt${d.prize === 1 ? '' : 's'}`;
    };

    ['#pzd-points', '#pzd-expiry', '#pzd-late', '#pzd-diff', '#pzd-prize'].forEach((s) =>
      repaintOn(s, paintWorth));
    const catSel = $('#pzd-coll');
    if (catSel) catSel.addEventListener('change', paintWorth);

    host.querySelectorAll('[data-visseg] [data-v]').forEach((b) => (b.onclick = () => {
      if (b.disabled) return;
      details.visibility = b.dataset.v;
      paintWorth();
    }));

    if (student && !details.collectionId && pickable.length) details.collectionId = pickable[0].id;
    if (catSel && details.collectionId) catSel.value = details.collectionId;
    paintWorth();

    $('[data-preview]').onclick = () => {
      const d = read();
      openPuzzlePreview(payloadOf(d));
    };

    $('[data-publish]').onclick = async () => {
      const btn = $('[data-publish]');
      const d = read();
      const label = adopt ? 'Adopt and publish' : editingId ? 'Save changes' : 'Publish puzzle';
      if (!d.title) { toast('Give the puzzle a title', 'error'); $('#pzd-title').focus(); return; }
      if (treeStats(tree).empty) { toast('The puzzle has no moves recorded', 'error'); return; }
      if (d.source && !sourceHref(d.source)) { toast('That source does not look like a link', 'error'); return; }
      if (student && !d.collectionId) {
        toast('Pick a collection to publish into', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const payload = { ...payloadOf(d), updatedAt: Date.now() };
        let id = editingId;

        if (globalBuild) {
          /* No club collection to addDoc into, so the id is chosen here.
             Prefixed with the author so two people publishing in the same
             millisecond cannot land on the same document. */
          id = editingId || `${ctx.user.uid.slice(0, 8)}-${Date.now().toString(36)}`;
          await publishGlobalPuzzle({ ...payload, id, createdAt: payload.createdAt || Date.now() });
        } else {
          if (editingId) await updateDoc(clubDoc(ctx.clubId, 'puzzles', editingId), payload);
          else id = (await addDoc(clubCol(ctx.clubId, 'puzzles'), { ...payload, createdAt: Date.now() })).id;

          const coll = collectionList().find((c) => c.id === d.collectionId) || null;
          await syncPublicPuzzle(clubOf(), { ...payload, id }, coll);
        }

        if (adopt) await payTheAuthor(d);

        toast(adopt ? 'Adopted and published' : editingId ? 'Puzzle updated' : 'Puzzle published', 'ok');
        if (opts.onPublished) opts.onPublished(id);
        reset();
      } catch (e) {
        console.error(e);
        toast('Could not publish that', 'error');
        btn.disabled = false;
        btn.textContent = label;
      }
    };
  }

  /**
   * Settles up with the member an adopted puzzle came from: the prize into
   * their points, and their original retired so the same puzzle is not
   * sitting in two places under two names.
   *
   * Neither failure is fatal to the publish that has already happened, so
   * both are reported rather than thrown. An admin cannot write a founder's
   * member row — that is the rules, not a bug here — and a founder who
   * built a puzzle being adopted by an admin is exactly the case that
   * lands in the first catch.
   */
  async function payTheAuthor(d) {
    const from = adopt;
    if (!from) return;

    if (d.prize > 0 && from.authorUid && from.authorUid !== (ctx.user && ctx.user.uid)) {
      try {
        await updateDoc(memberRef(from.clubId || ctx.clubId, from.authorUid),
          { points: increment(d.prize) });
      } catch (e) {
        console.error(e);
        toast('Published, but the prize could not be paid — pay it by hand from Members', 'error');
      }
    }

    try {
      await deleteDoc(clubDoc(from.clubId || ctx.clubId, 'puzzles', from.puzzleId));
      await removePublicPuzzle(from.clubId || ctx.clubId, from.puzzleId);
    } catch (e) {
      console.warn('Could not retire the original', e);
      toast('Published, but the member’s original is still there — delete it by hand', 'error');
    }
  }

  const payloadOf = (d) => {
    const stats = treeStats(tree);
    const coll = collectionList().find((c) => c.id === d.collectionId) || null;
    const club = clubOf();

    const out = {
      title: d.title,
      description: d.description,
      source: d.source,
      fen: position,
      playerColor: color,
      points: student ? 0 : d.points,
      expiresAt: student ? 0 : endOfDay(d.expiry),
      latePenaltyPct: student ? 0 : d.latePct,
      difficulty: d.difficulty,

      collectionId: d.collectionId || '',
      /* What is stored is the author's own answer, even while a closed
         collection is overriding it. Writing 'club' here instead would be
         the one thing the cascade must not do: reopening the collection
         would then find every puzzle set to club-only and nobody would
         get their choice back. effectiveVisibility does the overriding,
         and it is what every mirror asks before it writes.

         A member has no answer of their own to keep, so theirs is simply
         the shelf's. */
      visibility: student ? (coll ? coll.visibility : 'club') : d.visibility,

      anonymous: !!d.anonymous,
      authorUid: authoring.uid,
      authorName: authoring.name,
      clubId: ctx.clubId,
      clubName: (club && club.name) || '',
      custom: student,

      tree: { root: tree.root, nodes: tree.nodes },
      /* Written down as well as derived, so a list can be drawn without
         walking every graph — and so the old `solution` field stops being
         what anything reads. */
      solveMoves: stats.moves,
      lineCount: Math.max(1, stats.branches)
    };

    if (adopt) {
      out.originalPuzzleId = adopt.puzzleId || '';
      out.originalAuthorUid = adopt.authorUid || '';
      out.originalAuthorName = adopt.authorName || '';
      out.originalAnonymous = !!adopt.anonymous;
      out.prizePoints = d.prize;
    } else if (carried) {
      /* Editing something already adopted must not quietly strip the
         person it came from off it. */
      out.originalPuzzleId = carried.originalPuzzleId || '';
      out.originalAuthorUid = carried.originalAuthorUid || '';
      out.originalAuthorName = carried.originalAuthorName || '';
      out.originalAnonymous = !!carried.originalAnonymous;
      out.prizePoints = carried.prizePoints || 0;
    }
    return out;
  };

  function reset() {
    editingId = null;
    /* An adoption is spent the moment it is published: the original has
       been retired and the prize paid, so a second publish must not do
       either again. */
    adopt = null;
    carried = null;
    authoring = whoAmI(ctx);
    step = 0;
    color = 'w';
    position = null;
    tree = normalizeTree(null);
    at = ROOT;
    freshView();
    details = freshDetails();
    paint();
  }

  paintShell();
  paint();

  return {
    /**
     * Loads a puzzle back into the wizard, at the details step.
     * `asNew` is what adopting needs: the same board and the same graph,
     * with no id — so publishing writes a new puzzle rather than editing
     * somebody else's.
     */
    edit(p, o) {
      if (!p) return;
      const asNew = !!(o && o.asNew);
      editingId = asNew ? null : p.id;
      carried = asNew ? null : p;
      /* An adopted puzzle is republished by the adopter under their own
         name; an edit leaves whoever wrote it where they are. */
      authoring = asNew ? whoAmI(ctx)
        : { uid: p.authorUid || whoAmI(ctx).uid, name: p.authorName || whoAmI(ctx).name };
      color = p.playerColor;
      position = startFen(p.fen, p.playerColor);
      tree = p.tree;
      at = ROOT;
      freshView();
      details = {
        title: p.title,
        description: p.description,
        source: p.source,
        difficulty: p.difficulty === null || p.difficulty === undefined ? 5 : p.difficulty,
        collectionId: asNew ? '' : (p.collectionId || ''),
        visibility: p.visibility || 'club',
        anonymous: asNew ? false : !!p.anonymous,
        points: asNew ? 10 : p.points,
        expiry: asNew ? '' : dateValue(p.expiresAt),
        latePct: asNew ? 25 : p.latePenaltyPct,
        prize: 10
      };
      step = 3;
      paintShell();
      paint();
      if (host.scrollIntoView) host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    destroy() { destroyBoard(); }
  };
}
