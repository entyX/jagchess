/* ═══════════════════════════════════════════════════════════════════════
   nav-reorder.js — dragging the club's pages into a different order.

   Pointer events, the same way the dashboard widgets move: one code path
   that works with a mouse, a trackpad and a finger, instead of HTML5
   drag-and-drop, which has never worked on touch.

   The moves are tracked on `window` rather than through setPointerCapture on
   the grip, and that is not a style choice. Reordering moves the dragged row
   — grip and all — inside the DOM, and moving a capturing element releases
   its capture: the drag would swap exactly one neighbour, then go dead, and
   pointerup would never arrive to save anything. Listening on the window has
   no such failure mode, and it keeps working when the pointer leaves the
   list entirely.

   The list is reordered in the DOM as you drag and read back off the DOM
   when you let go, so what you saw during the drag is exactly what gets
   saved. Nothing is written if the order came back where it started.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * @param {HTMLElement} host      the container holding the rows
 * @param {object} opts
 *   item      — selector for a draggable row (default '.tab')
 *   handle    — selector for the grip inside it (default '[data-grip]')
 *   key       — row -> stable id (default: its data-page)
 *   onReorder — called with the new list of ids, only when it changed
 */
export function enableReorder(host, opts = {}) {
  const {
    item = '.tab',
    handle = '[data-grip]',
    key = (el) => el.dataset.page,
    onReorder = () => {}
  } = opts;

  const rows = () => [...host.querySelectorAll(item)];
  const order = () => rows().map(key);

  host.querySelectorAll(handle).forEach((grip) => {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // the grip is inside a button; without this the row is "clicked"
      e.preventDefault();
      e.stopPropagation();

      const el = grip.closest(item);
      if (!el) return;
      const before = order().join();

      el.classList.add('dragging');
      host.classList.add('reordering');

      /* Swap with whichever neighbour the pointer has passed the middle of.
         Comparing against midpoints rather than edges is what stops a row
         flickering between two places when it is level with its neighbour. */
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const list = rows();
        const from = list.indexOf(el);
        for (let i = 0; i < list.length; i++) {
          if (list[i] === el) continue;
          const r = list[i].getBoundingClientRect();
          const mid = r.top + r.height / 2;
          if (i < from && ev.clientY < mid) { host.insertBefore(el, list[i]); return; }
          if (i > from && ev.clientY > mid) { host.insertBefore(el, list[i].nextSibling); return; }
        }
      };

      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.classList.remove('dragging');
        host.classList.remove('reordering');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (order().join() !== before) onReorder(order());
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
}
