/* ═══════════════════════════════════════════════════════════════════════
   lichess-board.js — a lichess game, played or watched from this site.

   Two completely different data paths behind one board, because lichess
   offers two and they are not interchangeable:

     PLAYING   /api/board/game/stream/{id}     (board:play, your game only)
               → gameFull / gameState lines, no delay, and you may move
               Moves go out through POST /api/board/game/{id}/move/{uci}.
               Resign, draw offers and berserk have their own endpoints.

     WATCHING  /api/stream/game/{id}           (public, any ongoing game)
               → a description, then one line per move
               Lichess delays this by three moves ON PURPOSE, to stop cheat
               bots reading live positions. That delay is not a bug and is
               not worked around here; the board says it is delayed.

   A finished game is neither: it is read once from /game/export/{id} and
   replayed locally, which is also the fallback when the public move stream
   is not reachable from a browser.

   ─── on being instant ──────────────────────────────────────────────────
   The clock is already running when this opens, so NOTHING here waits for a
   round trip before drawing. The board, both player cards and the clocks are
   painted from the seed the caller already has — the pairing row the
   tournament page was showing a moment ago — and the network fills in the
   detail as it arrives. When the caller knows the game is yours (it came
   from a gameStart event, or your name is on the pairing) the export call is
   skipped entirely and the board stream is opened first, because gameFull
   carries everything the export would have told us.

   chess.js is the rules — legality, check, promotion, game over. This file
   never decides whether a move is legal, and it never invents a result: the
   authority on both is lichess, and chess.js is there so the board can
   refuse an illegal drag before it wastes a request.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, toast, confirmDialog } from './club-core.js';
import * as api from './lichess-api.js';
import { session, ensureScopes, hasScopes, SCOPES } from './lichess-auth.js';

const PIECE_THEME = (p) => `/assets/vendor/chessboard/img/chesspieces/wikipedia/${p}.png`;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

const fmtClock = (ms) => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

/* ── the one open stage ────────────────────────────────────────────── */

let stage = null;

export function closeLichessGame() {
  if (!stage) return;
  try { stage.destroy(); } catch (e) { console.error(e); }
  stage = null;
}

export const openGameId = () => (stage ? stage.gameId : null);

/**
 * Opens a lichess game on this site.
 *
 * @param {object} opts
 *   gameId       lichess game id
 *   backHash     where the ← button goes
 *   tournament   the stored tournament row, for the header
 *   seed         what we already know: { white:{username,rating}, black:{…},
 *                fen, clock, rated, variant } — painted before any request
 *   mine         true when this is known to be the signed-in player's game
 *   onFinish     called once with the final state
 */
export function openLichessGame(opts) {
  const { gameId } = opts;
  if (stage && stage.gameId === gameId) return stage;
  closeLichessGame();

  const seed = opts.seed || {};

  const root = el(`
    <div class="duel-stage li-stage">
      <div class="duel-stage-bar">
        <button class="duel-exit" id="li-exit">← Back to the tournament</button>
        <div class="duel-stage-tags" id="li-tags"></div>
        <div class="duel-stage-views" id="li-source"></div>
      </div>
      <div class="duel-stage-body">
        <div class="duel-board-col">
          <div class="duel-player" id="li-top"></div>
          <div class="duel-board-wrap"><div id="li-board" class="chessboard"></div></div>
          <div class="duel-player" id="li-bottom"></div>
        </div>
        <aside class="duel-side">
          <div class="li-notice" id="li-notice" hidden></div>
          <div class="duel-result" id="li-result" hidden></div>
          <div class="duel-side-head"><h4>Moves</h4><span class="muted" id="li-movecount"></span></div>
          <div class="duel-moves" id="li-moves"></div>
          <div class="li-nav" id="li-nav"></div>
          <div class="duel-side-actions" id="li-actions"></div>
        </aside>
      </div>
    </div>`);
  document.body.appendChild(root);
  document.body.classList.add('duel-open');

  const S = {
    gameId,
    destroyed: false,
    mode: opts.mine ? 'play' : 'loading',   // 'play' | 'watch' | 'replay'
    myColor: seedColor(seed),
    chess: new window.Chess(),
    board: null,
    game: seedGame(seed),
    state: null,
    abort: new AbortController(),
    poll: null,
    clockTimer: null,
    lastTickAt: Date.now(),
    /* null means "following the live position"; a number is the half-move
       the viewer has stepped back to. */
    review: null,
    connected: false,
    destroy
  };
  stage = S;

  const q = (sel) => root.querySelector(sel);
  const backTo = () => { location.hash = opts.backHash || 'tournaments'; };
  q('#li-exit').onclick = backTo;

  /* ── the board ─────────────────────────────────────────────────── */

  const boardHost = q('#li-board');
  const boardCol = root.querySelector('.duel-board-col');

  const sizeBoard = () => {
    const cards = [...root.querySelectorAll('.duel-player')].reduce((h, n) => h + n.offsetHeight, 0);
    const avail = boardCol.clientHeight - cards - 20;
    const size = Math.max(200, Math.floor(Math.min(boardCol.clientWidth, avail)));
    boardCol.style.setProperty('--duel-board', size + 'px');
    if (S.board && S.board.resize) S.board.resize();
  };
  const onResize = () => sizeBoard();
  window.addEventListener('resize', onResize);

  let selected = null;

  const buildBoard = (fen) => {
    if (S.board && S.board.destroy) { try { S.board.destroy(); } catch (_) {} }
    S.board = window.Chessboard(boardHost, {
      draggable: true,
      position: fen || START_FEN,
      orientation: S.myColor === 'b' ? 'black' : 'white',
      pieceTheme: PIECE_THEME,
      moveSpeed: 180, snapbackSpeed: 180, snapSpeed: 50,
      appearSpeed: 140, trashSpeed: 120,
      dropOffBoard: 'snapback',
      onDragStart: (src, piece) => {
        if (!canMove()) return false;
        if (piece[0] !== S.myColor) return false;
        if (S.chess.turn() !== S.myColor) return false;
        selected = null;
        showHints(src);
      },
      onDrop: (from, to) => { clearHints(); return attemptMove(from, to); },
      onSnapEnd: () => { if (S.review == null) S.board.position(S.chess.fen()); }
    });
    sizeBoard();
  };

  /* Moving is only ever possible on the live position of your own running
     game — never while reviewing, which is the bug that makes a review
     feature feel dangerous. */
  const canMove = () => S.mode === 'play' && S.myColor && S.review == null &&
    S.state && (S.state.status === 'started' || S.state.status === 'created');

  const squareEl = (sq) => boardHost.querySelector('.square-' + sq);
  const squareOf = (node) => {
    const cell = node && node.closest && node.closest('.square-55d63');
    if (!cell) return null;
    const c = [...cell.classList].find((x) => /^square-[a-h][1-8]$/.test(x));
    return c ? c.slice(7) : null;
  };
  const clearHints = () => boardHost.querySelectorAll('.duel-from, .duel-to, .duel-take')
    .forEach((n) => n.classList.remove('duel-from', 'duel-to', 'duel-take'));
  const showHints = (from) => {
    clearHints();
    if (!canMove() || S.chess.turn() !== S.myColor) return false;
    const moves = S.chess.moves({ square: from, verbose: true });
    if (!moves.length) return false;
    const src = squareEl(from);
    if (src) src.classList.add('duel-from');
    moves.forEach((m) => {
      const t = squareEl(m.to);
      if (t) t.classList.add(m.captured ? 'duel-take' : 'duel-to');
    });
    return true;
  };

  boardHost.addEventListener('click', (e) => {
    if (!canMove()) return;
    const sq = squareOf(e.target);
    if (!sq) return;
    if (selected && sq !== selected) {
      const legal = S.chess.moves({ square: selected, verbose: true }).some((m) => m.to === sq);
      if (legal) { const from = selected; selected = null; clearHints(); attemptMove(from, sq); return; }
    }
    const piece = S.chess.get(sq);
    if (piece && piece.color === S.myColor && S.chess.turn() === S.myColor && sq !== selected) {
      selected = sq; showHints(sq);
    } else { selected = null; clearHints(); }
  });

  function attemptMove(from, to) {
    if (!canMove() || S.chess.turn() !== S.myColor) return 'snapback';
    const legal = S.chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
    if (!legal.length) return 'snapback';
    if (legal.some((m) => m.flags.includes('p'))) {
      askPromotion(S.myColor, (choice) => {
        if (choice) send(from, to, choice);
        else S.board.position(S.chess.fen());
      });
      return 'snapback';
    }
    send(from, to, null);
    return undefined;
  }

  /**
   * Plays the move locally for the feel of it, then asks lichess.
   *
   * Lichess is the authority: if it refuses the move, the optimistic one is
   * rolled back and the board returns to the position the stream last gave
   * us. Nothing is ever recorded here as having happened.
   */
  async function send(from, to, promotion) {
    const before = S.chess.fen();
    const m = S.chess.move({ from, to, promotion: promotion || 'q' });
    if (!m) return;
    S.board.position(S.chess.fen());
    paintMoves();
    const uci = from + to + (promotion || (m.flags.includes('p') ? 'q' : ''));
    try {
      await api.boardMove(S.gameId, uci, session().token);
    } catch (e) {
      S.chess.load(before);
      S.board.position(before);
      paintMoves();
      toast(e.status === 400
        ? 'Lichess would not accept that move.'
        : 'That move did not reach lichess.', 'error');
    }
  }

  function askPromotion(color, done) {
    const pieces = color === 'w' ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
    const glyph = { Q: '♕', R: '♖', B: '♗', N: '♘', q: '♛', r: '♜', b: '♝', n: '♞' };
    const m = el(`<div class="modal duel-promo"><div class="modal-card" style="max-width:320px;text-align:center">
      <h3>Promote to</h3>
      <div class="duel-promo-row">${pieces.map((p) =>
        `<button data-p="${p.toLowerCase()}" title="${p}">${glyph[p]}</button>`).join('')}</div>
    </div></div>`);
    document.body.appendChild(m);
    m.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { m.remove(); done(b.dataset.p); }));
    m.onclick = (e) => { if (e.target === m) { m.remove(); done(null); } };
  }

  /* ── applying what lichess says ────────────────────────────────── */

  /* UCI in, chess.js out. Replaying from the start rather than loading a FEN
     is what keeps the move list in algebraic notation and lets chess.js see
     a repetition. */
  function replayUci(uciString, initialFen) {
    const c = new window.Chess();
    if (initialFen && initialFen !== 'startpos') c.load(initialFen);
    const list = String(uciString || '').trim();
    if (list) {
      for (const uci of list.split(/\s+/)) {
        const move = c.move({
          from: uci.slice(0, 2), to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined
        });
        if (!move) break;   // a variant we cannot replay; stop where we are
      }
    }
    return c;
  }

  function applyState(st) {
    const wasAtLive = S.review == null;
    const before = S.chess.history().length;
    S.state = st;
    S.chess = replayUci(st.moves, S.game && S.game.initialFen);
    S.lastTickAt = Date.now();

    /* Somebody stepping back through the game keeps their place while new
       moves arrive behind them — except that a new move while they were at
       the end should still follow along. */
    if (!wasAtLive && S.review != null && S.review >= S.chess.history().length) {
      S.review = null;
    }
    if (wasAtLive) {
      selected = null;
      clearHints();
      if (S.board) S.board.position(S.chess.fen());
    } else if (S.chess.history().length !== before) {
      flashNewMove();
    }
    paintAll();
  }

  const flashNewMove = () => {
    const n = q('#li-nav');
    if (n) n.classList.add('has-new');
  };

  /* ── painting ──────────────────────────────────────────────────── */

  const remaining = (color) => {
    const st = S.state;
    if (!st) {
      const s = seed.clockMs && seed.clockMs[color];
      return s != null ? s : null;
    }
    const base = color === 'w' ? st.wtime : st.btime;
    if (base == null) return null;
    /* A clock does not start until both sides have moved, which is why a
       fresh pairing shows a still clock rather than one already draining. */
    const live = st.status === 'started' && S.chess.history().length >= 2;
    const ticking = live && S.review == null && S.chess.turn() === color;
    return ticking ? Math.max(0, base - (Date.now() - S.lastTickAt)) : base;
  };

  function playerCard(node, color) {
    const p = (S.game && (color === 'w' ? S.game.white : S.game.black)) || {};
    const ms = remaining(color);
    const live = S.state && S.state.status === 'started' && S.chess.turn() === color && S.review == null;
    node.className = 'duel-player' + (live ? ' live' : '') + (ms != null && ms < 20000 && live ? ' low' : '');
    const me = session();
    const isMe = me && p.name && p.name.toLowerCase() === (me.username || '').toLowerCase();
    node.innerHTML = `
      <span class="li-avatar">${esc((p.name || '?').slice(0, 2).toUpperCase())}</span>
      <div class="duel-player-id">
        <b>${p.title ? `<span class="li-title">${esc(p.title)}</span> ` : ''}${esc(p.name || '…')}${isMe ? ' <span class="lb-me-badge">You</span>' : ''}</b>
        <small>${p.rating ? esc(String(p.rating)) + (p.provisional ? '?' : '') : ''}${S.game && S.game.rated === false ? ' · casual' : ''}</small>
      </div>
      <div class="duel-clock" data-c="${color}">${fmtClock(ms)}</div>`;
  }

  function paintClocks() {
    root.querySelectorAll('.duel-clock').forEach((n) => {
      const ms = remaining(n.dataset.c);
      n.textContent = fmtClock(ms);
      n.parentElement.classList.toggle('low',
        ms != null && ms < 20000 && S.state && S.state.status === 'started' && S.chess.turn() === n.dataset.c);
    });
  }

  function paintMoves() {
    const hist = S.chess.history();
    const at = S.review == null ? hist.length - 1 : S.review;
    const rows = [];
    for (let i = 0; i < hist.length; i += 2) {
      rows.push(`<div class="duel-move-row">
        <span class="duel-move-n">${i / 2 + 1}.</span>
        <span class="li-move${i === at ? ' on' : ''}" data-i="${i}">${esc(hist[i] || '')}</span>
        <span class="li-move${i + 1 === at ? ' on' : ''}" data-i="${i + 1}">${esc(hist[i + 1] || '')}</span>
      </div>`);
    }
    const box = q('#li-moves');
    box.innerHTML = rows.join('') || '<div class="empty-state">No moves yet.</div>';
    box.querySelectorAll('.li-move').forEach((n) => {
      if (!n.textContent.trim()) return;
      n.onclick = () => gotoPly(+n.dataset.i);
    });
    const on = box.querySelector('.li-move.on');
    if (on && S.review != null) on.scrollIntoView({ block: 'nearest' });
    else box.scrollTop = box.scrollHeight;
    q('#li-movecount').textContent = hist.length ? hist.length + ' played' : '';
    paintNav();
  }

  /* ── stepping through the game ─────────────────────────────────── */

  /*  Works on a finished game and on a live one. Stepping back during a live
      game is a viewer's right — it just has to be obvious that you have left
      the live position, and one press must bring you back.                */

  function paintNav() {
    const hist = S.chess.history();
    const nav = q('#li-nav');
    if (!hist.length) { nav.innerHTML = ''; nav.classList.remove('has-new'); return; }
    const at = S.review == null ? hist.length - 1 : S.review;
    const first = at < 0;
    const last = S.review == null;
    const liveGame = S.state && (S.state.status === 'started' || S.state.status === 'created');
    nav.innerHTML = `
      <button class="li-nav-btn" data-go="start" ${first ? 'disabled' : ''} title="First move (Home)">⏮</button>
      <button class="li-nav-btn" data-go="prev" ${first ? 'disabled' : ''} title="Previous move (←)">◀</button>
      <span class="li-nav-at">${at < 0 ? 'Start' : `${Math.floor(at / 2) + 1}${at % 2 === 0 ? '.' : '…'} ${esc(hist[at])}`}</span>
      <button class="li-nav-btn" data-go="next" ${last ? 'disabled' : ''} title="Next move (→)">▶</button>
      <button class="li-nav-btn" data-go="end" ${last ? 'disabled' : ''} title="${liveGame ? 'Back to live' : 'Last move'} (End)">⏭</button>
      ${!last && liveGame ? '<button class="li-nav-live" data-go="end">Back to live</button>' : ''}`;
    nav.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => step(b.dataset.go);
    });
    if (last) nav.classList.remove('has-new');
  }

  function step(where) {
    const hist = S.chess.history();
    if (!hist.length) return;
    const at = S.review == null ? hist.length - 1 : S.review;
    if (where === 'start') gotoPly(-1);
    else if (where === 'prev') gotoPly(at - 1);
    else if (where === 'next') gotoPly(at + 1);
    else gotoPly(hist.length - 1);
  }

  /** @param {number} ply  half-move index; -1 is the starting position */
  function gotoPly(ply) {
    const hist = S.chess.history();
    const clamped = Math.max(-1, Math.min(ply, hist.length - 1));
    S.review = clamped >= hist.length - 1 ? null : clamped;

    const c = new window.Chess();
    if (S.game && S.game.initialFen && S.game.initialFen !== 'startpos') c.load(S.game.initialFen);
    for (let k = 0; k <= clamped; k++) c.move(hist[k]);

    selected = null;
    clearHints();
    if (S.board) S.board.position(c.fen());
    paintMoves();
    paintActions();
  }

  const onKey = (e) => {
    if (S.destroyed) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step('next'); }
    else if (e.key === 'Home') { e.preventDefault(); step('start'); }
    else if (e.key === 'End') { e.preventDefault(); step('end'); }
    else if (e.key === 'Escape' && S.review != null) { e.preventDefault(); step('end'); }
    else if (e.key === 'f' || e.key === 'F') { flipBoard(); }
  };
  document.addEventListener('keydown', onKey);

  function flipBoard() {
    if (!S.board) return;
    S.board.flip();
    sizeBoard();
  }

  /* ── the rest of the panel ─────────────────────────────────────── */

  function paintResult() {
    const box = q('#li-result');
    const st = S.state;
    if (!st || st.status === 'started' || st.status === 'created') { box.hidden = true; return; }
    box.hidden = false;
    const me = session();
    const myName = ((me && me.username) || '').toLowerCase();
    const winnerName = st.winner === 'white' ? (S.game.white || {}).name
      : st.winner === 'black' ? (S.game.black || {}).name : null;
    const drew = !st.winner;
    const iWon = winnerName && winnerName.toLowerCase() === myName;
    const head = drew ? 'Draw'
      : S.myColor ? (iWon ? 'You won' : 'You lost')
        : `${esc(winnerName || '')} won`;
    box.className = 'duel-result ' + (drew ? 'draw' : (!S.myColor || iWon) ? 'win' : 'loss');
    box.innerHTML = `<b>${head}</b><span>${esc(TERMINATION[st.status] || st.status)}</span>`;
  }

  function paintActions() {
    const box = q('#li-actions');
    const st = S.state;

    if (S.mode !== 'play') {
      box.innerHTML = `<div class="duel-spectating">${S.mode === 'replay'
        ? 'This game is over. Step through it with the arrows, or click any move.'
        : S.mode === 'watch' ? 'You are watching this game.' : 'Connecting…'}</div>
        <button class="btn subtle block sm" id="li-flip">Flip the board</button>
        <a class="btn subtle block sm" target="_blank" rel="noopener"
           href="${esc(api.gameUrl(S.gameId))}">Open on lichess ↗</a>`;
      const f = box.querySelector('#li-flip');
      if (f) f.onclick = flipBoard;
      return;
    }
    if (!st || (st.status !== 'started' && st.status !== 'created')) {
      box.innerHTML = `<button class="btn primary block" id="li-back-2">Back to the tournament</button>
        <button class="btn subtle block sm" id="li-flip">Flip the board</button>`;
      const b = box.querySelector('#li-back-2');
      if (b) b.onclick = backTo;
      const f = box.querySelector('#li-flip');
      if (f) f.onclick = flipBoard;
      return;
    }

    const theirs = S.myColor === 'w' ? 'bdraw' : 'wdraw';
    const mine = S.myColor === 'w' ? 'wdraw' : 'bdraw';
    const offeredToMe = !!st[theirs];
    const canBerserk = opts.tournament && opts.tournament.berserkable &&
      S.chess.history().length === 0 && st.status === 'started';

    box.innerHTML = offeredToMe
      ? `<div class="duel-draw-offer">Draw offered
           <button class="btn primary sm" id="li-draw-yes">Accept</button>
           <button class="btn subtle sm" id="li-draw-no">Decline</button>
         </div>`
      : `${canBerserk ? '<button class="btn subtle" id="li-berserk">Berserk</button>' : ''}
         <button class="btn subtle" id="li-draw">${st[mine] ? 'Draw offered…' : 'Offer draw'}</button>
         <button class="btn subtle danger" id="li-resign">Resign</button>`;

    const w = (id, fn) => { const n = box.querySelector('#' + id); if (n) n.onclick = fn; };
    const tok = () => session().token;
    w('li-draw', () => api.boardDraw(S.gameId, tok(), true).catch(() => toast('Could not offer a draw', 'error')));
    w('li-draw-yes', () => api.boardDraw(S.gameId, tok(), true).catch(() => toast('Could not accept', 'error')));
    w('li-draw-no', () => api.boardDraw(S.gameId, tok(), false).catch(() => toast('Could not decline', 'error')));
    w('li-berserk', () => api.boardBerserk(S.gameId, tok())
      .then(() => toast('Berserk — half the clock, an extra point on a win', 'ok'))
      .catch(() => toast('Lichess would not allow berserk here', 'error')));
    w('li-resign', async () => {
      const ok = await confirmDialog({
        title: 'Resign this game?', body: 'Your opponent takes the point on lichess.',
        confirmText: 'Resign', danger: true
      });
      if (ok) api.boardResign(S.gameId, tok()).catch(() => toast('Could not resign', 'error'));
    });
  }

  function paintTags() {
    const g = S.game || {};
    const t = opts.tournament;
    q('#li-tags').innerHTML = `
      <span class="duel-pill">${esc(clockLabel(g.clock))}</span>
      <span class="duel-pill ${g.rated ? 'rated' : ''}">${g.rated ? 'Rated' : 'Casual'}</span>
      <span class="duel-pill soft">${esc(g.variant || 'standard')}</span>
      ${t ? `<span class="duel-pill tourn">${esc(t.name || 'Lichess tournament')}</span>` : ''}`;
    q('#li-source').innerHTML = `<span class="li-src ${S.mode}">${
      S.mode === 'play' ? (S.connected ? 'Playing · live from Lichess' : 'Connecting to Lichess…')
        : S.mode === 'watch' ? 'Live from Lichess · delayed 3 moves'
          : S.mode === 'replay' ? 'Replay'
            : 'Loading…'}</span>`;
  }

  const notice = (html) => {
    const n = q('#li-notice');
    n.hidden = !html;
    n.innerHTML = html || '';
  };

  function paintAll() {
    if (S.destroyed) return;
    const top = S.myColor === 'b' ? 'w' : 'b';
    playerCard(q('#li-top'), top);
    playerCard(q('#li-bottom'), top === 'w' ? 'b' : 'w');
    paintTags();
    paintMoves();
    paintResult();
    paintActions();
  }

  /* ── connecting ────────────────────────────────────────────────── */

  /* Painted before a single byte has been asked for. */
  buildBoard(seed.fen || START_FEN);
  paintAll();
  requestAnimationFrame(sizeBoard);

  (async function start() {
    /* The fast path: we already know it is ours, so the board stream is
       opened first and gameFull tells us everything the export would have. */
    if (opts.mine && session() && hasScopes([SCOPES.board])) {
      streamOwnGame();
      return;
    }

    let head = null;
    try {
      head = await api.exportGame(gameId, { moves: true, clocks: true });
    } catch (e) {
      if (S.destroyed) return;
      notice('<b>That game could not be loaded from lichess.</b><span>It may be private, or lichess may be unreachable.</span>');
      S.mode = 'replay';
      paintAll();
      return;
    }
    if (S.destroyed) return;

    const w = ((head.players || {}).white || {});
    const b = ((head.players || {}).black || {});
    const nameOf = (p) => (p.user && (p.user.name || p.user.id)) || (p.aiLevel ? 'Stockfish' : 'Anonymous');
    S.game = {
      initialFen: head.initialFen || 'startpos',
      rated: !!head.rated,
      variant: head.variant || 'standard',
      clock: head.clock || S.game.clock || null,
      white: { name: nameOf(w), rating: w.rating, title: (w.user && w.user.title) || null, provisional: !!w.provisional },
      black: { name: nameOf(b), rating: b.rating, title: (b.user && b.user.title) || null, provisional: !!b.provisional }
    };

    const running = head.status === 'started' || head.status === 'created';
    const me = session();
    const myName = ((me && me.username) || '').toLowerCase();
    const iAmWhite = myName && S.game.white.name.toLowerCase() === myName;
    const iAmBlack = myName && S.game.black.name.toLowerCase() === myName;
    const nextColor = iAmWhite ? 'w' : iAmBlack ? 'b' : null;
    if (nextColor !== S.myColor) {
      S.myColor = nextColor;
      buildBoard(S.chess.fen());
    }

    applyState({
      moves: uciFromExport(head),
      wtime: clockMs(head, 'white'), btime: clockMs(head, 'black'),
      status: head.status, winner: head.winner
    });

    if (!running) { S.mode = 'replay'; paintAll(); return; }

    if (S.myColor && me) {
      const ok = await ensureScopes([SCOPES.board]);
      if (!ok) return;   // the browser is on its way to lichess
      S.mode = 'play';
      paintAll();
      streamOwnGame();
      return;
    }

    S.mode = 'watch';
    paintAll();
    watchGame();
  })();

  /* Your own game, through the Board API. */
  async function streamOwnGame() {
    S.mode = 'play';
    paintTags();
    try {
      await api.streamBoardGame(gameId, session().token, (line) => {
        if (S.destroyed) return;
        S.connected = true;
        if (line.type === 'gameFull') {
          S.game = {
            initialFen: line.initialFen || 'startpos',
            rated: !!line.rated,
            variant: (line.variant && line.variant.key) || 'standard',
            clock: line.clock || null,
            white: { name: line.white.name, rating: line.white.rating, title: line.white.title, provisional: !!line.white.provisional },
            black: { name: line.black.name, rating: line.black.rating, title: line.black.title, provisional: !!line.black.provisional }
          };
          const myName = (session().username || '').toLowerCase();
          const next = S.game.white.name.toLowerCase() === myName ? 'w'
            : S.game.black.name.toLowerCase() === myName ? 'b' : null;
          if (next !== S.myColor) { S.myColor = next; buildBoard(S.chess.fen()); }
          if (!next) {
            /* We were told this was ours and it is not. Watch it instead
               rather than showing a board nobody can move. */
            S.mode = 'watch';
            try { S.abort.abort(); } catch (_) {}
            S.abort = new AbortController();
            applyState(line.state);
            watchGame();
            return;
          }
          notice('');
          applyState(line.state);
        } else if (line.type === 'gameState') {
          applyState(line);
        } else if (line.type === 'opponentGone') {
          notice(line.gone
            ? `<b>Your opponent has left.</b><span>${line.claimWinInSeconds != null
              ? 'You can claim the win in ' + line.claimWinInSeconds + 's.'
              : 'Lichess is waiting for them.'}</span>`
            : '');
        }
      }, S.abort.signal);
    } catch (e) {
      if (S.destroyed) return;
      if (e && (e.status === 404 || e.status === 401)) {
        /* Not our game after all — or the token cannot play. Watch instead. */
        S.mode = 'watch';
        paintAll();
        watchGame();
        return;
      }
      S.connected = false;
      paintTags();
      notice('<b>The live connection to lichess dropped.</b><span>Reconnecting…</span>');
      setTimeout(() => { if (!S.destroyed) streamOwnGame(); }, 2500);
      return;
    }
    /* The stream closes when the game ends. One last export settles the
       result rather than leaving the board on the final position with no
       verdict on it. */
    if (!S.destroyed) refreshFinished();
  }

  /* Somebody else's game: the public, deliberately delayed move stream. */
  async function watchGame() {
    S.mode = 'watch';
    notice('<b>Watching live.</b><span>Lichess delays ongoing games by three moves for everyone, including this page. What you see is a little behind.</span>');
    paintTags();
    try {
      await api.streamGame(gameId, (line) => {
        if (S.destroyed) return;
        S.connected = true;
        if (line.id && !line.wc) return;                 // the description line
        if (!line.fen) return;
        /* The public stream sends positions, not a move list, so the board is
           set from the FEN. The move list stops growing, which is why the
           notice says what it says. */
        if (S.review == null) {
          S.chess.load(line.fen);
          if (S.board) S.board.position(line.fen);
        }
        S.state = {
          moves: (S.state && S.state.moves) || '',
          wtime: line.wc != null ? line.wc * 1000 : null,
          btime: line.bc != null ? line.bc * 1000 : null,
          status: 'started'
        };
        S.lastTickAt = Date.now();
        paintAll();
      }, S.abort.signal);
    } catch (e) {
      if (S.destroyed) return;
      /* The public stream is capped at eight per IP and is not promised a
         CORS header. Polling the export endpoint is the documented, allowed
         alternative and it always works from a browser. */
      pollWatch();
      return;
    }
    if (!S.destroyed) refreshFinished();
  }

  function pollWatch() {
    notice('<b>Watching.</b><span>The live stream was unavailable, so this board refreshes from the lichess game export every few seconds.</span>');
    const beat = async () => {
      if (S.destroyed) return;
      try {
        const g = await api.exportGame(gameId, { moves: true, clocks: true });
        applyState({
          moves: uciFromExport(g),
          wtime: clockMs(g, 'white'), btime: clockMs(g, 'black'),
          status: g.status, winner: g.winner
        });
        if (g.status !== 'started' && g.status !== 'created') {
          S.mode = 'replay';
          clearInterval(S.poll);
          notice('');
          paintAll();
        }
      } catch (_) { /* stale is better than broken; try again next time */ }
    };
    S.poll = setInterval(beat, 3500);
    beat();
  }

  async function refreshFinished() {
    try {
      const g = await api.exportGame(gameId, { moves: true, clocks: true });
      if (S.destroyed) return;
      S.mode = 'replay';
      notice('');
      applyState({
        moves: uciFromExport(g),
        wtime: clockMs(g, 'white'), btime: clockMs(g, 'black'),
        status: g.status, winner: g.winner
      });
      if (opts.onFinish) { try { opts.onFinish(g); } catch (_) {} }
    } catch (_) { /* the board already shows the last position it had */ }
  }

  S.clockTimer = setInterval(() => { if (!S.destroyed) paintClocks(); }, 200);

  function destroy() {
    S.destroyed = true;
    try { S.abort.abort(); } catch (_) {}
    if (S.poll) clearInterval(S.poll);
    if (S.clockTimer) clearInterval(S.clockTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    if (S.board && S.board.destroy) { try { S.board.destroy(); } catch (_) {} }
    root.remove();
    document.body.classList.remove('duel-open');
  }

  return S;
}

/* ── shared bits ───────────────────────────────────────────────────── */

/* What to draw before the network answers. The pairing row the tournament
   page already had is enough for both names, both ratings and the clock. */
function seedGame(seed) {
  const side = (s) => ({
    name: (s && s.username) || '…',
    rating: (s && s.rating) || null,
    title: (s && s.title) || null,
    provisional: false
  });
  return {
    initialFen: 'startpos',
    rated: seed.rated !== false,
    variant: seed.variant || 'standard',
    clock: seed.clock || null,
    white: side(seed.white),
    black: side(seed.black)
  };
}

function seedColor(seed) {
  if (seed.myColor) return seed.myColor;
  const me = session();
  const myName = ((me && me.username) || '').toLowerCase();
  if (!myName || !seed.white || !seed.black) return null;
  if ((seed.white.username || '').toLowerCase() === myName) return 'w';
  if ((seed.black.username || '').toLowerCase() === myName) return 'b';
  return null;
}

/* The export endpoint answers in algebraic notation by default; the board
   works in UCI. Rather than convert, the SAN list is replayed straight into
   chess.js, so this hands back whichever the caller can use. */
function uciFromExport(g) {
  const moves = String(g.moves || '').trim();
  if (!moves) return '';
  if (/^[a-h][1-8][a-h][1-8]/.test(moves)) return moves;   // already UCI
  const c = new window.Chess();
  if (g.initialFen && g.initialFen !== 'startpos') c.load(g.initialFen);
  const out = [];
  for (const san of moves.split(/\s+/)) {
    const m = c.move(san, { sloppy: true });
    if (!m) break;
    out.push(m.from + m.to + (m.promotion || ''));
  }
  return out.join(' ');
}

/* `clocks` is a list of centiseconds remaining after each half-move, so the
   last entry for a colour is that colour's clock. */
function clockMs(g, color) {
  const cl = g.clocks;
  if (!Array.isArray(cl) || !cl.length) return null;
  const wantEven = color === 'white';
  for (let i = cl.length - 1; i >= 0; i--) {
    if ((i % 2 === 0) === wantEven) return cl[i] * 10;
  }
  return null;
}

const clockLabel = (clock) => {
  if (!clock) return 'Correspondence';
  const init = clock.initial != null ? clock.initial
    : clock.limit != null ? clock.limit * 1000 : 0;
  const incRaw = clock.increment != null ? clock.increment : 0;
  const inc = incRaw > 1000 ? incRaw / 1000 : incRaw;
  const mins = init >= 60000 ? Math.round(init / 60000)
    : String(Number((init / 60000).toFixed(2)));
  return `${mins} + ${inc}`;
};

/* lichess's own words for how a game ended. */
const TERMINATION = {
  mate: 'Checkmate',
  resign: 'Resignation',
  stalemate: 'Stalemate',
  timeout: 'Left the game',
  outoftime: 'Time out',
  draw: 'Draw agreed',
  cheat: 'Cheat detected',
  noStart: 'Never started',
  unknownFinish: 'Finished',
  variantEnd: 'Variant ending',
  aborted: 'Aborted'
};
