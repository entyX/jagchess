/* ═══════════════════════════════════════════════════════════════════════
   puzzle-pager.js — paging and searching, for the two lists on the club's
   puzzles page that outgrow a screen: everything published, and every
   collection.

   It is deliberately state-in-a-plain-object rather than a component. Both
   callers already own their own repaint; all they are missing is somewhere
   to keep which page they are on and something that draws the control.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── pages ─────────────────────────────────────────────────────────────
   A club that has been running a while has hundreds of puzzles, and an
   admin page that draws all of them at once is slow to open and impossible
   to find anything in. Both lists on this page take the same control: the
   numbers worth pressing, a box to type a page into, and how many rows you
   want at a time.

   None of it is saved anywhere, deliberately. It is how you are looking at
   the list this minute, not a setting you have to unset later.
   ─────────────────────────────────────────────────────────────────── */

const PAGE_SIZES = [5, 10, 20, 30, 50];

export const newPageState = (size) => ({ page: 1, size: size || 10, custom: false });

/** How many pages `total` rows make at this size. */
const pageCount = (state, total) => Math.max(1, Math.ceil(total / Math.max(1, state.size)));

/* 1 … 6 7 8 … 40 — the ends, because they are where you jump to, and the
   neighbours, because they are where you step. */
function pageWindow(page, pages) {
  const want = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) { want.add(2); want.add(3); }
  if (page >= pages - 2) { want.add(pages - 1); want.add(pages - 2); }
  return [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
}

/** The slice to draw, with the page clamped if the list shrank underneath it. */
export function pageSlice(state, rows) {
  const pages = pageCount(state, rows.length);
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;
  const from = (state.page - 1) * state.size;
  return rows.slice(from, from + state.size);
}

export function pagerHTML(state, total, one, many) {
  const pages = pageCount(state, total);
  let last = 0;
  const nums = pageWindow(state.page, pages).map((n) => {
    const gap = n - last > 1 ? '<span class="pg-gap">…</span>' : '';
    last = n;
    return `${gap}<button class="pg-num${n === state.page ? ' on' : ''}" data-page="${n}"
      type="button" aria-label="Page ${n}"${n === state.page ? ' aria-current="page"' : ''}>${n}</button>`;
  }).join('');

  return `<div class="pg">
    <div class="pg-steps">
      <span class="pg-of">Page ${state.page} of ${pages}</span>
      <button class="pg-btn" data-step="-1" type="button" aria-label="Previous page"
        ${state.page <= 1 ? 'disabled' : ''}>‹</button>
      <span class="pg-nums">${nums}</span>
      <button class="pg-btn" data-step="1" type="button" aria-label="Next page"
        ${state.page >= pages ? 'disabled' : ''}>›</button>
    </div>
    <div class="pg-opts">
      <label class="pg-jump">Go to
        <input type="number" min="1" max="${pages}" data-goto placeholder="${state.page}"
          aria-label="Go to page" /></label>
      <label class="pg-size">Show
        <select data-size aria-label="Rows per page">
          ${PAGE_SIZES.map((n) => `<option value="${n}"${
            !state.custom && state.size === n ? ' selected' : ''}>${n}</option>`).join('')}
          <option value="custom"${state.custom ? ' selected' : ''}>Custom</option>
        </select></label>
      ${state.custom ? `<input class="pg-custom" type="number" min="1" max="500" data-custom
        value="${state.size}" aria-label="How many rows per page" />` : ''}
      <span class="pg-total">${total} ${total === 1 ? one : many}</span>
    </div>
  </div>`;
}

/**
 * Wires a control that pagerHTML just drew.
 * `repaint` redraws the list and this control with it, so anything that
 * needs the caret back afterwards has to ask for it again — which is what
 * the custom box does.
 */
export function wirePager(host, state, total, repaint) {
  const pages = pageCount(state, total);
  const go = (n) => {
    const next = Math.min(pages, Math.max(1, n));
    if (next === state.page) return;
    state.page = next;
    repaint();
  };

  host.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => go(Number(b.dataset.page))));
  host.querySelectorAll('[data-step]').forEach((b) =>
    (b.onclick = () => go(state.page + Number(b.dataset.step))));

  const jump = host.querySelector('[data-goto]');
  if (jump) {
    const send = () => {
      const n = parseInt(jump.value, 10);
      jump.value = '';
      if (n) go(n);
    };
    jump.onchange = send;
    jump.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
  }

  const size = host.querySelector('[data-size]');
  if (size) size.onchange = () => {
    if (size.value === 'custom') state.custom = true;
    else { state.custom = false; state.size = Number(size.value); }
    state.page = 1;
    repaint();
    const box = host.querySelector('[data-custom]');
    if (box) box.focus();
  };

  const custom = host.querySelector('[data-custom]');
  if (custom) custom.onchange = () => {
    const n = parseInt(custom.value, 10);
    if (!(n >= 1)) { custom.value = state.size; return; }
    state.size = Math.min(500, n);
    state.page = 1;
    repaint();
    const box = host.querySelector('[data-custom]');
    if (box) { box.focus(); box.select(); }
  };
}

/** The search box both lists use. */
export const searchHTML = (id, placeholder) => `
  <label class="pz-search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
    <input type="search" ${id ? `id="${id}"` : 'data-q'} placeholder="${placeholder}"
      aria-label="${placeholder}" />
  </label>`;
