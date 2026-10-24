/* JagChess — landing page interactions */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── sticky nav ─────────────────────────────────────────────────── */
  var nav = document.getElementById('lp-nav');
  var onScroll = function () {
    nav.classList.toggle('stuck', window.scrollY > 14);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ── mobile menu ────────────────────────────────────────────────── */
  var burger = document.getElementById('lp-burger');
  var mobile = document.getElementById('lp-mobile');
  burger.addEventListener('click', function () {
    var open = mobile.classList.toggle('open');
    document.body.style.overflow = open ? 'hidden' : '';
  });
  mobile.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      mobile.classList.remove('open');
      document.body.style.overflow = '';
    });
  });

  /* ── hero 3-D parallax ──────────────────────────────────────────── */
  var stage = document.getElementById('stage');
  var inner = document.getElementById('stage-inner');
  if (stage && inner && !reduce && window.matchMedia('(pointer: fine)').matches) {
    var raf = null;
    var target = { x: 0, y: 0 };
    var current = { x: 0, y: 0 };

    var tick = function () {
      current.x += (target.x - current.x) * 0.09;
      current.y += (target.y - current.y) * 0.09;
      inner.style.transform = 'rotateX(' + current.y.toFixed(2) + 'deg) rotateY(' + current.x.toFixed(2) + 'deg)';
      if (Math.abs(target.x - current.x) > 0.01 || Math.abs(target.y - current.y) > 0.01) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
      }
    };

    var move = function (e) {
      var r = stage.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      target.x = px * 17;
      target.y = -py * 13;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    window.addEventListener('mousemove', move, { passive: true });
    inner.style.transition = 'none';
  }

  /* ── scroll reveal ──────────────────────────────────────────────── */
  var revealables = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var delay = el.parentElement && el.parentElement.children.length > 2
          ? Array.prototype.indexOf.call(el.parentElement.children, el) * 70
          : 0;
        setTimeout(function () { el.classList.add('in'); }, Math.min(delay, 420));
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('in'); });
  }

  /* ── bento 3-D tilt ─────────────────────────────────────────────── */
  if (!reduce && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.tilt').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform =
          'perspective(900px) rotateX(' + (-py * 7).toFixed(2) + 'deg) rotateY(' +
          (px * 9).toFixed(2) + 'deg) translateY(-5px)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  /* ── builder: blocks drop in when the canvas scrolls into view ──── */
  var canvas = document.getElementById('canvas');
  if (canvas && 'IntersectionObserver' in window) {
    var blocks = canvas.querySelectorAll('[data-block]');
    var bo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        blocks.forEach(function (b, i) {
          setTimeout(function () { b.classList.add('in'); }, 260 + i * 220);
        });
        bo.disconnect();
      });
    }, { threshold: 0.35 });
    bo.observe(canvas);

    // clicking a palette block "adds" the next empty slot
    var chips = document.querySelectorAll('.block-chip');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var next = canvas.querySelector('.cv-block:not(.solid)');
        if (!next) return;
        next.classList.add('solid');
        next.innerHTML = chip.innerHTML.replace('<span class="grip">⠿</span>', '');
        next.style.transform = 'scale(1.03)';
        setTimeout(function () { next.style.transform = ''; }, 220);
      });
    });
  }

  /* ── builder: club color swatches ──────────────────────────────── */
  var swatches = document.querySelectorAll('.swatch');
  swatches.forEach(function (s) {
    s.addEventListener('click', function () {
      swatches.forEach(function (o) { o.classList.remove('on'); });
      s.classList.add('on');
      if (!canvas) return;
      canvas.style.setProperty('--accent-a', s.dataset.a);
      canvas.style.setProperty('--accent-b', s.dataset.b);
    });
  });

  /* ── metrics count-up ───────────────────────────────────────────── */
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        co.unobserve(el);
        if (el.dataset.literal) { el.textContent = el.dataset.literal; return; }
        var end = parseInt(el.dataset.count, 10) || 0;
        var suffix = el.dataset.suffix || '';
        if (reduce) { el.textContent = end + suffix; return; }
        var start = performance.now();
        var dur = 1100;
        var step = function (now) {
          var p = Math.min((now - start) / dur, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(end * eased) + suffix;
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { co.observe(el); });
  }

  /* ── pricing toggle ─────────────────────────────────────────────── */
  var toggle = document.getElementById('bill-toggle');
  if (toggle) {
    toggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-cycle]');
      if (!btn) return;
      toggle.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      var yearly = btn.dataset.cycle === 'year';
      document.querySelectorAll('[data-price-month]').forEach(function (el) {
        el.textContent = yearly ? el.dataset.priceYear : el.dataset.priceMonth;
      });
      document.querySelectorAll('[data-cycle-label]').forEach(function (el) {
        el.textContent = yearly ? '/month, billed yearly' : '/month';
      });
    });
  }

  /* ── FAQ accordion ──────────────────────────────────────────────── */
  document.querySelectorAll('.qa-q').forEach(function (q) {
    q.addEventListener('click', function () {
      var qa = q.parentElement;
      var body = qa.querySelector('.qa-a');
      var isOpen = qa.classList.contains('open');
      document.querySelectorAll('.qa.open').forEach(function (other) {
        other.classList.remove('open');
        other.querySelector('.qa-a').style.maxHeight = '';
      });
      if (!isOpen) {
        qa.classList.add('open');
        body.style.maxHeight = body.scrollHeight + 'px';
      }
    });
  });

  /* ── year ───────────────────────────────────────────────────────── */
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
