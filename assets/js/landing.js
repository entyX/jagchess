/* ═══════════════════════════════════════════════════════════════════════
   landing.js — the marketing page: the nav, and the puzzle in the hero.

   The puzzle is real. It is one position with one mating move, played by
   tapping or dragging, and solving it does what solving one in a club
   does: points go up. No chess library on this page — one fixed answer
   doesn't need one.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  var PIECE = function (p) { return '/assets/vendor/chessboard/img/chesspieces/wikipedia/' + p + '.png'; };

  /* ── nav ── */

  var nav = document.getElementById('nav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var burger = document.getElementById('nav-burger');
  var sheet = document.getElementById('nav-sheet');
  burger.addEventListener('click', function () {
    var open = sheet.hidden;
    sheet.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sheet-open', open);
  });
  sheet.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      sheet.hidden = true;
      burger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('sheet-open');
    });
  });

  /* ── boards ── */

  function squaresOf(fen) {
    var out = [];
    fen.split(' ')[0].split('/').forEach(function (row) {
      row.split('').forEach(function (ch) {
        if (/\d/.test(ch)) { for (var i = 0; i < +ch; i++) out.push(null); }
        else out.push((ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase());
      });
    });
    return out;
  }

  function nameOf(i, flip) {
    var idx = flip ? 63 - i : i;
    return 'abcdefgh'[idx % 8] + (8 - Math.floor(idx / 8));
  }

  /* draws a still board into a host, for the product pictures further down */
  function still(host, fen, opts) {
    if (!host) return;
    opts = opts || {};
    var sq = squaresOf(fen);
    var marks = opts.marks || [];
    var html = '';
    for (var i = 0; i < 64; i++) {
      var idx = opts.flip ? 63 - i : i;
      var f = idx % 8, r = 8 - Math.floor(idx / 8);
      var name = 'abcdefgh'[f] + r;
      var p = sq[idx];
      html += '<span class="sq' + ((f + r) % 2 === 0 ? ' d' : '') + (marks.indexOf(name) >= 0 ? ' hl' : '') + '">' +
        (p ? '<img src="' + PIECE(p) + '" alt="" draggable="false">' : '') + '</span>';
    }
    host.innerHTML = html;
  }

  still(document.getElementById('shot-board'), 'r2q1rk1/ppp2ppp/2n5/3np3/2B5/2N2N2/PPP2PPP/R2Q1RK1', { flip: true, marks: ['d5'] });
  still(document.getElementById('shot-game'), 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R', { marks: ['d2', 'd3'] });

  /* ── the hero puzzle: White to move, Rd8 is mate ──────────────────── */

  var FEN = '6k1/5ppp/p7/4n3/8/PB6/2r2PPP/3R2K1';
  var ANSWER = { from: 'd1', to: 'd8' };
  var board = document.getElementById('pz-board');
  var msg = document.getElementById('puzzle-msg');
  var goal = document.getElementById('puzzle-goal');
  var reset = document.getElementById('pz-reset');
  var puzzle = document.getElementById('puzzle');
  var position, selected = null, solved = false, hintTimer = null;

  function draw() {
    var html = '';
    for (var i = 0; i < 64; i++) {
      var f = i % 8, r = 8 - Math.floor(i / 8);
      var name = 'abcdefgh'[f] + r;
      var p = position[i];
      html += '<button class="sq' + ((f + r) % 2 === 0 ? ' d' : '') + '" data-sq="' + name + '"' +
        ' aria-label="' + name + (p ? ' ' + ({ K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' })[p[1]] : '') + '"' +
        ' role="gridcell">' +
        (f === 0 ? '<small class="rk">' + r + '</small>' : '') +
        (r === 1 ? '<small class="fl">' + 'abcdefgh'[f] + '</small>' : '') +
        (p ? '<img src="' + PIECE(p) + '" alt="" draggable="false" data-piece="' + p + '">' : '') +
        '</button>';
    }
    board.innerHTML = html;
  }

  function idxOf(name) { return (8 - +name[1]) * 8 + 'abcdefgh'.indexOf(name[0]); }
  function cell(name) { return board.querySelector('[data-sq="' + name + '"]'); }
  function clearMarks() { board.querySelectorAll('.sel,.hint').forEach(function (n) { n.classList.remove('sel', 'hint'); }); }

  /* Rook and bishop moves, enough to show where a piece can go. */
  function targets(from) {
    var p = position[idxOf(from)];
    if (!p || p[0] !== 'w') return [];
    var dirs = p[1] === 'R' ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
      : p[1] === 'B' ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      : p[1] === 'K' ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : p[1] === 'P' ? [[0, 1]] : [];
    var f0 = 'abcdefgh'.indexOf(from[0]), r0 = +from[1], out = [];
    dirs.forEach(function (d) {
      var f = f0, r = r0;
      for (;;) {
        f += d[0]; r += d[1];
        if (f < 0 || f > 7 || r < 1 || r > 8) break;
        var n = 'abcdefgh'[f] + r;
        var q = position[idxOf(n)];
        if (q && q[0] === 'w') break;
        out.push(n);
        if (q || p[1] === 'K' || p[1] === 'P') break;
      }
    });
    return out;
  }

  function select(name) {
    clearMarks();
    selected = name;
    cell(name).classList.add('sel');
    targets(name).forEach(function (t) { cell(t).classList.add('hint'); });
  }

  function tryMove(from, to) {
    var piece = position[idxOf(from)];
    position[idxOf(to)] = piece;
    position[idxOf(from)] = null;
    draw();
    cell(from).classList.add('last'); cell(to).classList.add('last');
    if (from === ANSWER.from && to === ANSWER.to) return win();
    puzzle.classList.add('wrong');
    msg.textContent = 'Not quite. Black can still escape.';
    reset.hidden = false;
    setTimeout(function () { puzzle.classList.remove('wrong'); }, 500);
  }

  function win() {
    solved = true;
    clearTimeout(hintTimer);
    cell('g8').classList.add('mated');
    puzzle.classList.add('solved');
    goal.textContent = 'Checkmate';
    msg.innerHTML = '<b>Rd8 is mate.</b> The king is trapped behind its own pawns.';
    reset.hidden = false;
    reset.textContent = 'Play it again';
    // what a solve does in a real club: points
    var pts = document.getElementById('hero-points');
    var chip = document.getElementById('chip-points');
    var from = +pts.textContent, to = from + 10, t0 = performance.now();
    chip.classList.add('bump');
    (function step(t) {
      var k = Math.min(1, (t - t0) / 600);
      pts.textContent = Math.round(from + (to - from) * k);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
    var plus = document.createElement('span');
    plus.className = 'plus-ten';
    plus.textContent = '+10';
    chip.appendChild(plus);
    setTimeout(function () { plus.remove(); chip.classList.remove('bump'); }, 1400);
  }

  function start() {
    position = squaresOf(FEN);
    selected = null;
    solved = false;
    puzzle.classList.remove('solved', 'wrong');
    goal.textContent = 'Find checkmate in one';
    msg.textContent = 'Tap a white piece, then tap where it goes.';
    reset.hidden = true;
    reset.textContent = 'Try again';
    draw();
    clearTimeout(hintTimer);
    // a gentle nudge for anyone who stares at it for a while
    hintTimer = setTimeout(function () {
      if (solved || selected) return;
      msg.textContent = 'Hint: look at the back row. The black king has no way out.';
    }, 12000);
  }

  board.addEventListener('click', function (e) {
    if (solved) return;
    var b = e.target.closest('[data-sq]');
    if (!b) return;
    var name = b.dataset.sq;
    var p = position[idxOf(name)];
    if (selected && b.classList.contains('hint')) { var from = selected; selected = null; tryMove(from, name); return; }
    if (p && p[0] === 'w') select(name);
    else { selected = null; clearMarks(); }
  });

  /* dragging, for anyone who reaches for the piece */
  var drag = null;
  board.addEventListener('pointerdown', function (e) {
    if (solved) return;
    var img = e.target.closest('img[data-piece]');
    if (!img || img.dataset.piece[0] !== 'w') return;
    var from = img.parentElement.dataset.sq;
    select(from);
    var r = img.getBoundingClientRect();
    var ghost = img.cloneNode();
    ghost.className = 'pz-ghost';
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    img.style.opacity = '.3';
    drag = { from: from, ghost: ghost, img: img, w: r.width, moved: false };
    var move = function (ev) {
      drag.moved = true;
      ghost.style.transform = 'translate(' + (ev.clientX - drag.w / 2) + 'px,' + (ev.clientY - drag.w / 2) + 'px)';
    };
    move(e);
    var up = function (ev) {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      ghost.remove();
      img.style.opacity = '';
      var under = document.elementFromPoint(ev.clientX, ev.clientY);
      var target = under && under.closest && under.closest('[data-sq]');
      if (drag.moved && target && target.classList.contains('hint')) { selected = null; tryMove(drag.from, target.dataset.sq); }
      drag = null;
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    e.preventDefault();
  });

  reset.addEventListener('click', start);
  start();

  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
