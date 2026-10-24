/* ═══════════════════════════════════════════════════════════════════════
   welcome.js — everything on the marketing page that isn't WebGL.

   Two sections are driven by scroll rather than by time: the pile of
   group-chat-and-spreadsheet scraps that collapses into one JagChess
   window, and the tour, which tells the 3D scene which piece to show.
   Both write a single number and let the stylesheet do the rest.

   The puzzle in the students section is a real one: White to move, Rd8 is
   mate. Solving it does what solving one in a club does — points go up.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PIECE = function (p) { return '/assets/vendor/chessboard/img/chesspieces/wikipedia/' + p + '.png'; };
  var NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
  var clamp01 = function (v) { return Math.max(0, Math.min(1, v)); };

  /* ── nav ── */

  var nav = document.getElementById('nav');
  var burger = document.getElementById('burger');
  var sheet = document.getElementById('sheet');
  function setSheet(open) {
    sheet.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('sheet-open', open);
  }
  burger.addEventListener('click', function () { setSheet(sheet.hidden); });
  sheet.addEventListener('click', function (e) { if (e.target.closest('a')) setSheet(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) setSheet(false); });

  /* ── still boards ── */

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

  /* ── real QR codes, pointing where a student would actually go ── */

  var qrHosts = document.querySelectorAll('[data-qr]');
  if (qrHosts.length) {
    import('/assets/js/qr.js').then(function (qr) {
      var svg = qr.toSVG('https://jagchess.web.app/clubs', { margin: 1, dark: '#1a1d24' });
      qrHosts.forEach(function (h) { h.innerHTML = svg; });
    }).catch(function () {});
  }

  /* ── scroll-driven sections ────────────────────────────────────────── */

  var merge = document.querySelector('.merge');
  var tourEl = document.getElementById('tour');
  var steps = [].slice.call(document.querySelectorAll('.step'));
  var rail = [].slice.call(document.querySelectorAll('.tour-rail li'));
  var stepsList = document.querySelector('.steps');
  var current = -1;

  function setStep(i) {
    if (i === current) return;
    current = i;
    steps.forEach(function (s, k) { s.classList.toggle('on', k === i); });
    rail.forEach(function (li, k) { li.classList.toggle('on', k === i); });
    tourEl.dataset.tone = steps[i].dataset.tone;
    document.documentElement.dataset.tour = i;
    document.dispatchEvent(new CustomEvent('tour-step', { detail: i }));
  }

  var ticking = false;
  function onScroll() {
    ticking = false;
    var vh = window.innerHeight;
    nav.classList.toggle('scrolled', window.scrollY > 10);

    if (merge && !reduced) {
      var r = merge.getBoundingClientRect();
      var p = clamp01(-r.top / Math.max(1, r.height - vh));
      merge.style.setProperty('--p', p.toFixed(4));
    }

    // the step whose middle is nearest the middle of the screen
    var best = 0, bestD = Infinity;
    steps.forEach(function (s, k) {
      var b = s.getBoundingClientRect();
      var d = Math.abs(b.top + b.height / 2 - vh * 0.55);
      if (d < bestD) { bestD = d; best = k; }
    });
    setStep(best);

    if (stepsList) {
      var sr = stepsList.getBoundingClientRect();
      stepsList.style.setProperty('--sp', clamp01((vh * 0.7 - sr.top) / sr.height).toFixed(3));
    }
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  rail.forEach(function (li) {
    li.querySelector('button').addEventListener('click', function () {
      var s = steps[+li.dataset.go];
      var b = s.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + b.top + b.height / 2 - window.innerHeight * 0.55, behavior: reduced ? 'auto' : 'smooth' });
    });
  });

  /* things that animate once, the first time they're seen */
  var once = document.querySelectorAll('.c-insight, .stat.rating');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in-view'); io.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    once.forEach(function (n) { io.observe(n); });
  } else once.forEach(function (n) { n.classList.add('in-view'); });

  /* ── the clock in the games step runs down while you read ── */

  var clock = document.querySelector('[data-clock]');
  if (clock && !reduced) {
    var left = +clock.dataset.clock;
    setInterval(function () {
      if (current !== 3) return;
      left = left > 20 ? left - 1 : 185;
      clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }, 1000);
  }

  /* ── organizer tools you can poke ── */

  var brandbox = document.getElementById('brandbox');
  if (brandbox) {
    brandbox.querySelectorAll('[role="radio"]').forEach(function (b) {
      b.addEventListener('click', function () {
        brandbox.querySelectorAll('[role="radio"]').forEach(function (o) { o.setAttribute('aria-checked', String(o === b)); });
        brandbox.style.setProperty('--brand', b.style.getPropertyValue('--s'));
      });
    });
  }
  var approvals = document.getElementById('approvals');
  if (approvals) {
    approvals.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.closest('li').classList.contains('done')) return;
      b.closest('li').classList.add('done');
      b.textContent = 'Approved';
    });
  }

  /* ── the puzzle: White to move, Rd8 is mate ────────────────────────── */

  var FEN = '6k1/5ppp/p7/4n3/8/PB6/2r2PPP/3R2K1';
  var ANSWER = { from: 'd1', to: 'd8' };
  var puzzle = document.getElementById('puzzle');
  var board = document.getElementById('pz-board');
  var status = document.getElementById('pz-status');
  var goal = document.getElementById('pz-goal');
  var msg = document.getElementById('pz-msg');
  var ico = document.getElementById('pz-ico');
  var again = document.getElementById('pz-again');
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

  /* where a white piece could go: sliding pieces, the king and pawns are
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
    status.classList.add('wrong');
    goal.textContent = 'Not quite';
    msg.textContent = 'The black king can still get away.';
    again.hidden = false;
    setTimeout(function () { status.classList.remove('wrong'); }, 500);
  }

  function win() {
    solved = true;
    clearTimeout(hintTimer);
    cell('g8').classList.add('mated');
    status.classList.add('solved');
    ico.textContent = '✓';
    goal.textContent = 'Checkmate';
    msg.textContent = 'Rd8. The king is trapped behind its own pawns.';
    again.hidden = false;
    var pts = document.getElementById('pz-pts');
    var box = document.getElementById('pz-points');
    var from = +pts.textContent, to = from + 10, t0 = performance.now();
    box.classList.add('bump');
    (function step(t) {
      var k = Math.min(1, (t - t0) / 700);
      pts.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
    var plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '+10';
    box.appendChild(plus);
    setTimeout(function () { plus.remove(); box.classList.remove('bump'); }, 1300);
  }

  function start() {
    position = squaresOf(FEN);
    selected = null;
    solved = false;
    status.classList.remove('solved', 'wrong');
    ico.textContent = '♔';
    goal.textContent = 'White to move';
    msg.textContent = 'Find checkmate in one. Tap a piece, then a square.';
    again.hidden = true;
    draw();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (solved || selected) return;
      msg.textContent = 'Hint: look at the back row. The black king has nowhere to go.';
    }, 20000);
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
  board.addEventListener('pointerdown', function () { puzzle.classList.add('engaged'); });
  again.addEventListener('click', start);
  start();

  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
