/* ═══════════════════════════════════════════════════════════════════════
   mini-board.js — a still picture of a position, for places that show a
   board without playing on it: the dashboard's puzzle card, a finished
   game's thumbnail, the landing page. Plain markup, no chessboard.js, so
   it costs nothing to draw a dozen of them.
   ═══════════════════════════════════════════════════════════════════════ */

const PIECE = (p) => `/assets/vendor/chessboard/img/chesspieces/wikipedia/${p}.png`;

/** The 64 squares of a FEN's placement field, a8 first. */
export function squaresOf(fen) {
  const placement = String(fen || '').trim().split(/\s+/)[0] || '8/8/8/8/8/8/8/8';
  const out = [];
  for (const row of placement.split('/').slice(0, 8)) {
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) out.push(null);
      else out.push((ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase());
    }
  }
  while (out.length < 64) out.push(null);
  return out.slice(0, 64);
}

/**
 * @param {string} fen
 * @param {{flip?: boolean, highlight?: string[], className?: string}} opts
 *        highlight takes square names ('e4') to tint, e.g. the last move
 */
export function miniBoardHTML(fen, opts = {}) {
  const squares = squaresOf(fen);
  const marks = new Set(opts.highlight || []);
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const idx = opts.flip ? 63 - i : i;
    const file = idx % 8;
    const rank = 8 - Math.floor(idx / 8);
    const name = 'abcdefgh'[file] + rank;
    const dark = (file + rank) % 2 === 0;
    const piece = squares[idx];
    cells.push(`<span class="mb-sq${dark ? ' d' : ''}${marks.has(name) ? ' hl' : ''}">${
      piece ? `<img src="${PIECE(piece)}" alt="" draggable="false">` : ''}</span>`);
  }
  return `<div class="mini-board ${opts.className || ''}" aria-hidden="true">${cells.join('')}</div>`;
}
