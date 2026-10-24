/* ═══════════════════════════════════════════════════════════════════════
   landing.js — the marketing page.

   The board in the hero is a real puzzle: one position, one mating move,
   played by tapping a piece and then a square. Solving it does what
   solving one in a club does — points go up. It leans towards the mouse a
   little, and flattens out when you go to play it.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PIECE = function (p) { return '/assets/vendor/chessboard/img/chesspieces/wikipedia/' + p + '.png'; };
  var NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

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

  /* ── positions ── */

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
  var idxOf = function (name) { return (8 - +name[1]) * 8 + 'abcdefgh'.indexOf(name[0]); };

  /* still boards for the product pictures */
  document.querySelectorAll('.mini[data-fen]').forEach(function (host) {
    var sq = squaresOf(host.dataset.fen);
    var marks = (host.dataset.marks || '').split(',');
    var html = '';
    for (var i = 0; i < 64; i++) {
      var f = i % 8, r = 8 - Math.floor(i / 8), name = 'abcdefgh'[f] + r;
      html += '<span class="' + ((f + r) % 2 === 0 ? 'd' : '') + (marks.indexOf(name) >= 0 ? ' hl' : '') + '">' +
        (sq[i] ? '<img src="' + PIECE(sq[i]) + '" alt="" loading="lazy">' : '') + '</span>';
    }
    host.innerHTML = html;
  });

  /* ── the hero puzzle: White to move, Rd8 is mate ──────────────────── */

  var FEN = '6k1/5ppp/p7/4n3/8/PB6/2r2PPP/3R2K1';
  var ANSWER = { from: 'd1', to: 'd8' };
  var stage = document.getElementById('stage');
  var board = document.getElementById('pz-board');
  var chip = document.getElementById('puzzle-chip');
  var goal = document.getElementById('puzzle-goal');
  var msg = document.getElementById('puzzle-msg');
  var reset = document.getElementById('pz-reset');
  var position, selected = null, solved = false, hintTimer = null;

  function draw() {
    var html = '';
    for (var i = 0; i < 64; i++) {
      var f = i % 8, r = 8 - Math.floor(i / 8), name = 'abcdefgh'[f] + r, p = position[i];
      html += '<button class="sq' + ((f + r) % 2 === 0 ? ' d' : '') + (p ? ' has' : '') + '" data-sq="' + name + '" role="gridcell"' +
        ' aria-label="' + name + (p ? ' ' + (p[0] === 'w' ? 'white ' : 'black ') + NAMES[p[1]] : '') + '">' +
        (p ? '<img src="' + PIECE(p) + '" alt="" draggable="false">' : '') + '</button>';
    }
    board.innerHTML = html;
  }
  var cell = function (name) { return board.querySelector('[data-sq="' + name + '"]'); };
  var clearMarks = function () { board.querySelectorAll('.sel,.hint').forEach(function (n) { n.classList.remove('sel', 'hint'); }); };

  /* where a white piece could go — sliding pieces, the king and pawns are
     all this position has */
  function targets(from) {
    var p = position[idxOf(from)];
    if (!p || p[0] !== 'w') return [];
    var t = p[1];
    var dirs = t === 'R' ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
      : t === 'B' ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      : t === 'K' ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : t === 'P' ? [[0, 1]] : [];
    var f0 = 'abcdefgh'.indexOf(from[0]), r0 = +from[1], out = [];
    dirs.forEach(function (d) {
      var f = f0, r = r0;
      for (;;) {
        f += d[0]; r += d[1];
        if (f < 0 || f > 7 || r < 1 || r > 8) break;
        var n = 'abcdefgh'[f] + r, q = position[idxOf(n)];
        if (q && q[0] === 'w') break;
        if (t === 'P' && q) break;
        out.push(n);
        if (q || t === 'K' || t === 'P') break;
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

  function play(from, to) {
    position[idxOf(to)] = position[idxOf(from)];
    position[idxOf(from)] = null;
    draw();
    cell(from).classList.add('last');
    cell(to).classList.add('last');
    if (from === ANSWER.from && to === ANSWER.to) return win();
    chip.classList.add('wrong');
    goal.textContent = 'Not quite';
    msg.textContent = 'The black king can still get away.';
    reset.hidden = false;
    setTimeout(function () { chip.classList.remove('wrong'); }, 500);
  }

  function win() {
    solved = true;
    clearTimeout(hintTimer);
    cell('g8').classList.add('mated');
    chip.classList.add('solved');
    goal.textContent = 'Checkmate';
    msg.textContent = 'Rd8. The king is trapped behind its own pawns.';
    reset.hidden = false;
    var pts = document.getElementById('hero-points');
    var pc = document.getElementById('chip-points');
    var from = +pts.textContent, to = from + 10, t0 = performance.now();
    pc.classList.add('bump');
    (function step(t) {
      var k = Math.min(1, (t - t0) / 700);
      pts.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
    var plus = document.createElement('span');
    plus.className = 'plus-ten';
    plus.textContent = '+10';
    pc.appendChild(plus);
    setTimeout(function () { plus.remove(); pc.classList.remove('bump'); }, 1400);
  }

  function start() {
    position = squaresOf(FEN);
    selected = null;
    solved = false;
    chip.classList.remove('solved', 'wrong');
    goal.textContent = 'White to move';
    msg.textContent = 'Find checkmate in one. Tap a piece, then a square.';
    reset.hidden = true;
    draw();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (solved || selected) return;
      msg.textContent = 'Hint: the back row. The black king has nowhere to go.';
    }, 14000);
  }

  board.addEventListener('click', function (e) {
    if (solved) return;
    var b = e.target.closest('[data-sq]');
    if (!b) return;
    var name = b.dataset.sq, p = position[idxOf(name)];
    if (selected && b.classList.contains('hint')) { var from = selected; selected = null; play(from, name); return; }
    if (p && p[0] === 'w') select(name);
    else { selected = null; clearMarks(); }
  });
  reset.addEventListener('click', start);
  start();

  /* ── the board leans towards the pointer, and settles when you play ── */

  var hero = document.getElementById('hero');
  var chips = [].slice.call(stage.querySelectorAll('.chip:not(.chip-goal)'));
  var depth = [26, 34, 18];
  if (!reduced) {
    hero.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var r = hero.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      var b = document.getElementById('board3d');
      b.style.setProperty('--tx', (x * 8).toFixed(2) + 'deg');
      b.style.setProperty('--ty', (-y * 5).toFixed(2) + 'deg');
      chips.forEach(function (c, i) {
        c.style.setProperty('--px', (-x * depth[i]).toFixed(1) + 'px');
        c.style.setProperty('--py', (-y * depth[i]).toFixed(1) + 'px');
      });
    });
    hero.addEventListener('pointerleave', function () {
      var b = document.getElementById('board3d');
      b.style.setProperty('--tx', '0deg');
      b.style.setProperty('--ty', '0deg');
    });
  }
  var scene = document.getElementById('scene');
  scene.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') stage.classList.add('engaged'); });
  scene.addEventListener('pointerleave', function () { stage.classList.remove('engaged'); });
  board.addEventListener('pointerdown', function () { stage.classList.add('engaged'); });

  // the board rises into place once the page has painted
  requestAnimationFrame(function () { requestAnimationFrame(function () { stage.classList.add('ready'); }); });

  /* ── reveals ───────────────────────────────────────────────────────── */

  var targetsToReveal = document.querySelectorAll('.reveal, .tilt-in');
  if (reduced || !('IntersectionObserver' in window)) {
    targetsToReveal.forEach(function (n) { n.classList.add('in'); });
  } else {
    // siblings that arrive together come in one after another
    var groups = new Map();
    targetsToReveal.forEach(function (n) {
      var k = n.parentElement;
      var i = groups.get(k) || 0;
      n.style.setProperty('--d', (i * 0.08).toFixed(2) + 's');
      groups.set(k, i + 1);
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    targetsToReveal.forEach(function (n) { io.observe(n); });
  }
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
