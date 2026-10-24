/* ═══════════════════════════════════════════════════════════════════════
   mail-fonts.js — the faces a newsletter can be written in.

   Every one of them is a stack, not a name, and every stack ends on a
   family the machine reading it already has. A webfont in an email is a
   request a mail client is entitled to ignore — Gmail always does — so
   PT Serif is what it looks like here and on a Mac, and Georgia is what it
   falls back to in the places that will not fetch it. Both are serifs of
   much the same colour, which is the whole trick.
   ═══════════════════════════════════════════════════════════════════════ */

/** The face a newsletter is written in unless somebody says otherwise. */
export const MAIL_SERIF =
  `'PT Serif', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', Times, serif`;

export const MAIL_FONTS = [
  { name: 'PT Serif', stack: MAIL_SERIF, note: 'the default' },
  { name: 'Georgia', stack: `Georgia, 'Times New Roman', Times, serif` },
  { name: 'Times New Roman', stack: `'Times New Roman', Times, serif` },
  { name: 'Arial', stack: `Arial, Helvetica, sans-serif` },
  { name: 'Helvetica', stack: `Helvetica, Arial, sans-serif` },
  { name: 'Verdana', stack: `Verdana, Geneva, sans-serif` },
  { name: 'Tahoma', stack: `Tahoma, Verdana, Geneva, sans-serif` },
  { name: 'Trebuchet MS', stack: `'Trebuchet MS', Tahoma, sans-serif` },
  { name: 'Courier New', stack: `'Courier New', Courier, monospace` },
];

/** The toolbar control, as markup. */
export const fontSelectHTML = (id) => `
  <select class="rte-font" ${id ? `id="${id}"` : 'data-font'}
          title="Font — changes what you have selected, or the whole message if nothing is"
          aria-label="Font">
    ${MAIL_FONTS.map((f) => `<option value="${f.stack.replace(/"/g, '&quot;')}"
      style="font-family:${f.stack.replace(/"/g, '&quot;')}">${f.name}${f.note ? ' · ' + f.note : ''}</option>`).join('')}
  </select>`;

/**
 * Wires one up.
 *
 * Two problems to get past, and both of them are the same problem: by the
 * time `change` fires, the dropdown has had focus and the editor has not.
 *
 *   · A contenteditable that has lost focus cannot be relied on to hand
 *     its selection back, so the range is remembered as it moves and put
 *     back before anything is applied.
 *   · With nothing selected there is nothing for `fontName` to act on, and
 *     picking a font appears to do nothing at all — which is exactly what
 *     it looked like. Picking a font with nothing selected now sets the
 *     whole message, because that is plainly what it was asked to do.
 *     Selecting first still restyles only what was selected.
 *
 * `styleWithCSS` is turned on for the one command and turned straight back
 * off: on, the browser writes `<span style="font-family:…">`, which is what
 * an email can carry; off, it writes `<font face>`, which several clients
 * quietly drop. Everything else in the toolbar goes on writing what it
 * always wrote.
 *
 * @returns {Function} teardown — it listens on the document, so a page that
 *                     is torn down has to say so.
 */
export function wireFontSelect(select, editor, restore) {
  if (!select || !editor) return () => {};

  let saved = null;
  const track = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      saved = sel.getRangeAt(0).cloneRange();
    }
  };
  document.addEventListener('selectionchange', track);

  const hasWords = () => !!editor.textContent.trim();

  select.addEventListener('change', () => {
    const stack = select.value;
    if (typeof restore === 'function') restore();
    editor.focus();

    const sel = window.getSelection();
    const pick = saved && !saved.collapsed ? saved : null;

    try {
      if (pick) {
        sel.removeAllRanges();
        sel.addRange(pick);
      } else if (hasWords()) {
        /* Nothing chosen, so the whole message is what was meant. */
        const all = document.createRange();
        all.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(all);
      }
    } catch { /* the node it pointed at may be gone; carry on regardless */ }

    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontName', false, stack);
    } finally {
      document.execCommand('styleWithCSS', false, false);
    }

    /* Leaving the whole message highlighted after restyling it reads as
       though something is still happening. The caret goes to the end. */
    if (!pick && hasWords()) {
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
    }
    track();
  });

  /* Opening the dropdown must not take the selection with it, or there is
     nothing left under the caret to restyle. */
  select.addEventListener('mousedown', (e) => e.stopPropagation());

  return () => document.removeEventListener('selectionchange', track);
}
