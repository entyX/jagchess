/* ═══════════════════════════════════════════════════════════════════════
   ui-select.js — progressive enhancement for native <select> elements.

   The real <select> stays in the DOM (visually hidden) so every existing
   `el.value` read and `change` listener keeps working. We just draw a nicer
   control on top and mirror the two in both directions.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9.5 12 15.5 18 9.5"/></svg>';

  var CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  var openMenu = null;

  function closeOpen() {
    if (!openMenu) return;
    openMenu.wrap.classList.remove('open');
    openMenu.btn.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function enhance(select) {
    if (select.dataset.jcSelect === '1' || select.multiple || select.size > 1) return;
    select.dataset.jcSelect = '1';

    var wrap = document.createElement('div');
    wrap.className = 'jc-select';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jc-select-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="jc-select-label"></span>' + CHEVRON;

    var menu = document.createElement('div');
    menu.className = 'jc-select-menu';
    menu.setAttribute('role', 'listbox');

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    select.classList.add('jc-select-native');

    var label = btn.querySelector('.jc-select-label');

    function syncLabel() {
      var opt = select.options[select.selectedIndex];
      var text = opt ? opt.textContent.trim() : '';
      label.textContent = text;
      wrap.classList.toggle('is-placeholder', !opt || opt.value === '');
      Array.prototype.forEach.call(menu.children, function (el) {
        var on = el.dataset.value === select.value;
        el.classList.toggle('on', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    function build() {
      menu.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (opt) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'jc-select-opt';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.disabled = opt.disabled;
        item.innerHTML = '<span>' + opt.textContent + '</span>' + CHECK;
        item.addEventListener('click', function () {
          if (select.value === opt.value) { closeOpen(); return; }
          select.value = opt.value;
          syncLabel();
          closeOpen();
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        menu.appendChild(item);
      });
      syncLabel();
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (select.disabled) return;
      var wasOpen = wrap.classList.contains('open');
      closeOpen();
      if (wasOpen) return;

      // flip upward when there isn't room below
      var r = btn.getBoundingClientRect();
      wrap.classList.toggle('up', window.innerHeight - r.bottom < 240 && r.top > 260);
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      openMenu = { wrap: wrap, btn: btn };
      var sel = menu.querySelector('.jc-select-opt.on');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    });

    btn.addEventListener('keydown', function (e) {
      var i = select.selectedIndex;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (next < 0 || next >= select.options.length) return;
        select.selectedIndex = next;
        syncLabel();
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (e.key === 'Escape') {
        closeOpen();
      }
    });

    // keep in sync when other code changes the value or rebuilds the options
    select.addEventListener('change', syncLabel);
    new MutationObserver(build).observe(select, { childList: true, subtree: true });

    build();
  }

  function scan(root) {
    (root || document).querySelectorAll('select').forEach(enhance);
  }

  document.addEventListener('click', closeOpen);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOpen(); });
  window.addEventListener('resize', closeOpen);
  document.addEventListener('scroll', closeOpen, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(); });
  } else {
    scan();
  }

  // selects added later (modals, dynamic forms) get picked up automatically
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'SELECT') enhance(n);
        else if (n.querySelectorAll) scan(n);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.JagSelect = { scan: scan };
})();
