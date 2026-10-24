/* ═══════════════════════════════════════════════════════════════════════
   guide-art.js — the guide's pictures.

   Every figure is inline SVG built from a handful of primitives rather than
   a screenshot, for three reasons: it needs no login to produce, it weighs
   nothing, and it repaints itself for dark mode because the fills are CSS
   classes (see guide.css) instead of baked-in colors.

   The vocabulary is deliberately small — panel, bar, pill, avatar, label —
   so a figure reads as a diagram of a screen rather than a fake of one.
   ═══════════════════════════════════════════════════════════════════════ */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── primitives ────────────────────────────────────────────────────── */

const R = (x, y, w, h, rx, cls) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" class="${cls}"/>`;

const T = (x, y, txt, o = {}) =>
  `<text x="${x}" y="${y}" class="${o.cls || 'f-label'}" font-size="${o.size || 11}" ` +
  `text-anchor="${o.anchor || 'start'}" font-weight="${o.weight || 700}">${esc(txt)}</text>`;

/* a stand-in for a line of body copy */
const bar = (x, y, w, cls = 'f-txt2', h = 5) => R(x, y, w, h, h / 2, cls);

const circle = (cx, cy, r, cls) => `<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"/>`;

const avatar = (x, y, d, cls, ini) =>
  R(x, y, d, d, d / 3, cls) +
  T(x + d / 2, y + d / 2 + d * 0.17, ini, { cls: 'f-on-color', size: d * 0.42, anchor: 'middle', weight: 800 });

const pill = (x, y, w, txt, cls = 'f-pill') =>
  R(x, y, w, 15, 7.5, cls) + T(x + w / 2, y + 10.7, txt, { cls: cls === 'f-green' ? 'f-on-color' : 'f-pill-t', size: 8.5, anchor: 'middle', weight: 700 });

/* A callout number tied to the numbered list underneath the figure. These are
   always placed on empty space — a marker sitting on top of the thing it is
   describing hides exactly what the reader came to look at. `dark` inverts it
   for the one case that lands on the navy sidebar. */
const marker = (cx, cy, n, dark) =>
  circle(cx, cy, 9.5, dark ? 'f-marker-l' : 'f-marker') +
  T(cx, cy + 3.4, String(n), { cls: dark ? 'f-marker-lt' : 'f-marker-t', size: 10, anchor: 'middle', weight: 800 });

const wrap = (viewBox, body, caption, keys) => `
  <figure class="doc-fig">
    <div class="doc-fig-frame">
      <svg viewBox="${viewBox}" role="img" preserveAspectRatio="xMidYMid meet">${body}</svg>
    </div>
    ${caption ? `<figcaption>${caption}</figcaption>` : ''}
    ${keys && keys.length ? `<ol class="doc-fig-key">${keys.map((k) => `<li>${k}</li>`).join('')}</ol>` : ''}
  </figure>`;

/* the browser-ish chrome the full-screen figures sit inside */
const chrome = (w, url) =>
  R(0, 0, w, 26, 0, 'f-chrome') +
  circle(15, 13, 3.6, 'f-dot') + circle(27, 13, 3.6, 'f-dot') + circle(39, 13, 3.6, 'f-dot') +
  R(56, 6.5, Math.min(230, w - 80), 13, 6.5, 'f-url') +
  T(64, 16, url, { cls: 'f-url-t', size: 8.5, weight: 600 });

/* ── the club sidebar, reused by several figures ───────────────────── */

function sidebar(x, y, h, active) {
  const items = ['Dashboard', 'Events', 'Puzzles', 'Newsletters', 'Leaderboard', 'Duels', 'Tournaments', 'Store', 'Profile'];
  let s = R(x, y, 128, h, 0, 'f-nav');
  s += R(x + 12, y + 12, 26, 26, 8, 'f-green');
  s += T(x + 25, y + 30, '♞', { cls: 'f-on-color', size: 15, anchor: 'middle' });
  s += T(x + 46, y + 24, 'Your Club', { cls: 'f-nav-t', size: 9.5, weight: 800 });
  s += T(x + 46, y + 34, 'Founder', { cls: 'f-nav-m', size: 7.5, weight: 600 });
  items.forEach((label, i) => {
    const iy = y + 54 + i * 20;
    if (label === active) s += R(x + 8, iy - 10, 112, 18, 6, 'f-nav-on');
    s += R(x + 16, iy - 4, 8, 8, 2, label === active ? 'f-nav-ico-on' : 'f-nav-ico');
    s += T(x + 30, iy + 3, label, { cls: label === active ? 'f-nav-t' : 'f-nav-m', size: 8.5, weight: label === active ? 800 : 600 });
  });
  return s;
}

/* ═══ FIGURES ═══════════════════════════════════════════════════════ */

/* The club, laid out — what every part of the screen is called. */
export const clubShell = () => wrap('0 0 720 400', [
  R(0, 0, 720, 400, 10, 'f-bg'),
  chrome(720, 'jagchess.web.app/clubs/your-club'),
  sidebar(0, 26, 374, 'Dashboard'),
  R(128, 26, 592, 42, 0, 'f-topbar'),
  T(146, 44, 'Dashboard', { cls: 'f-h', size: 13, weight: 800 }),
  T(146, 57, 'Everything your club is doing, in one place.', { cls: 'f-m', size: 8 }),
  pill(500, 38, 54, '★ 1,240 pts', 'f-gold-soft'),
  pill(560, 38, 46, '12 day', 'f-orange-soft'),
  R(614, 36, 44, 18, 9, 'f-green'),
  T(636, 48, 'Invite', { cls: 'f-on-color', size: 8, anchor: 'middle', weight: 800 }),

  R(144, 82, 340, 88, 10, 'f-card'),
  T(158, 104, 'Good afternoon, Sam.', { cls: 'f-h', size: 12, weight: 800 }),
  bar(158, 116, 220), bar(158, 128, 170),
  R(158, 142, 66, 18, 9, 'f-green'),
  T(191, 154, 'Solve puzzle', { cls: 'f-on-color', size: 7.5, anchor: 'middle', weight: 800 }),
  R(232, 142, 62, 18, 9, 'f-chip'),
  T(263, 154, 'Calendar', { cls: 'f-m', size: 7.5, anchor: 'middle', weight: 700 }),

  R(496, 82, 208, 88, 10, 'f-card'),
  T(510, 100, 'Quick duel', { cls: 'f-h', size: 10, weight: 800 }),
  T(552, 128, '1042', { cls: 'f-h', size: 18, anchor: 'middle', weight: 800 }),
  T(552, 140, 'Club', { cls: 'f-m', size: 7.5, anchor: 'middle' }),
  T(648, 128, '988', { cls: 'f-h', size: 18, anchor: 'middle', weight: 800 }),
  T(648, 140, 'Global', { cls: 'f-m', size: 7.5, anchor: 'middle' }),
  R(510, 148, 90, 16, 8, 'f-green'),
  T(555, 159.5, 'Play in club', { cls: 'f-on-color', size: 7.5, anchor: 'middle', weight: 800 }),
  R(604, 148, 90, 16, 8, 'f-blue'),
  T(649, 159.5, 'Play globally', { cls: 'f-on-color', size: 7.5, anchor: 'middle', weight: 800 }),

  R(144, 182, 216, 128, 10, 'f-card'),
  T(158, 202, 'Upcoming events', { cls: 'f-h', size: 10, weight: 800 }),
  [0, 1, 2].map((i) =>
    R(158, 214 + i * 32, 28, 26, 7, 'f-blue-soft') +
    T(172, 226 + i * 32, String(11 + i * 4), { cls: 'f-blue-t', size: 10, anchor: 'middle', weight: 800 }) +
    T(172, 235 + i * 32, 'SEP', { cls: 'f-blue-t', size: 5.5, anchor: 'middle', weight: 700 }) +
    bar(194, 220 + i * 32, 96, 'f-txt') + bar(194, 231 + i * 32, 60)).join(''),

  R(372, 182, 156, 128, 10, 'f-card'),
  T(386, 202, 'Leaderboard', { cls: 'f-h', size: 10, weight: 800 }),
  [0, 1, 2, 3].map((i) =>
    T(392, 224 + i * 22, String(i + 1), { cls: i === 0 ? 'f-gold-t' : 'f-m', size: 9, weight: 800 }) +
    avatar(402, 215 + i * 22, 14, ['f-green', 'f-blue', 'f-purple', 'f-orange'][i], ['SM', 'AK', 'JL', 'RP'][i]) +
    bar(422, 221 + i * 22, 54, 'f-txt') +
    T(516, 225 + i * 22, String(1240 - i * 180), { cls: 'f-h', size: 8.5, anchor: 'end', weight: 800 })).join(''),

  R(540, 182, 164, 128, 10, 'f-card'),
  T(554, 202, 'Tournaments', { cls: 'f-h', size: 10, weight: 800 }),
  R(554, 212, 136, 40, 8, 'f-purple-soft'),
  T(564, 228, 'Friday Night Arena', { cls: 'f-purple-t', size: 8.5, weight: 800 }),
  T(564, 241, 'Starts in 2h 14m · 5+3', { cls: 'f-purple-t', size: 7.5, weight: 600 }),
  R(554, 260, 136, 40, 8, 'f-chip'),
  T(564, 276, 'Club Championship', { cls: 'f-h', size: 8.5, weight: 800 }),
  T(564, 289, 'Lichess arena · 16 players', { cls: 'f-m', size: 7.5, weight: 600 }),

  R(144, 322, 560, 62, 10, 'f-card'),
  T(158, 342, 'Blocks you add appear in the sidebar; widgets you add appear on this grid.', { cls: 'f-m', size: 9, weight: 600 }),
  bar(158, 354, 400), bar(158, 366, 320),

  marker(104, 330, 1, true), marker(700, 47, 2), marker(686, 352, 3)
].join(''), 'The anatomy of a club page.', [
  '<b>Sidebar</b> — every block your club has added, plus Dashboard and Profile. Each entry is a full page: events, puzzles, tournaments, and so on. Admins also get Members and Club settings.',
  '<b>Topbar</b> — your points and streak follow you onto every page, with the invite button beside them.',
  '<b>Dashboard grid</b> — twelve columns of widgets. Admins drag and resize them in editor mode.'
]);

/* The hub, with its four tabs. */
export const hubFig = () => wrap('0 0 720 300', [
  R(0, 0, 720, 300, 10, 'f-bg'),
  chrome(720, 'jagchess.web.app/clubs'),
  R(0, 26, 720, 40, 0, 'f-topbar'),
  R(18, 34, 24, 24, 8, 'f-green'),
  T(30, 51, '♞', { cls: 'f-on-color', size: 14, anchor: 'middle' }),
  T(50, 51, 'JagChess', { cls: 'f-h', size: 12, weight: 900 }),
  ['My clubs', 'Play a match', 'Tournaments', 'Leaderboard', 'Guide'].map((t, i) => {
    const x = 128 + i * 78;
    return (i === 0 ? R(x - 8, 36, 72, 20, 10, 'f-green-soft') : '') +
      T(x + 28, 50, t, { cls: i === 0 ? 'f-green-t' : 'f-m', size: 8.5, anchor: 'middle', weight: i === 0 ? 800 : 600 });
  }).join(''),
  avatar(644, 36, 20, 'f-blue', 'SM'),
  T(670, 50, 'Sam', { cls: 'f-h', size: 9, weight: 700 }),

  T(28, 96, 'My clubs', { cls: 'f-h', size: 17, weight: 900 }),
  T(28, 112, "You're in 2 clubs.", { cls: 'f-m', size: 9 }),
  R(556, 88, 62, 22, 11, 'f-chip'),
  T(587, 102.5, 'Join a club', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }),
  R(626, 88, 66, 22, 11, 'f-green'),
  T(659, 102.5, 'Create your own', { cls: 'f-on-color', size: 7.5, anchor: 'middle', weight: 800 }),

  [0, 1].map((i) => {
    const x = 28 + i * 232;
    return R(x, 130, 216, 122, 12, 'f-card') +
      R(x + 16, 146, 34, 34, 11, i ? 'f-blue' : 'f-green') +
      T(x + 33, 170, '♞', { cls: 'f-on-color', size: 18, anchor: 'middle' }) +
      pill(x + 150, 154, 50, i ? 'Student' : 'Founder', i ? 'f-chip' : 'f-gold-soft') +
      T(x + 16, 202, i ? 'Eastside Knights' : 'North Creek Chess', { cls: 'f-h', size: 11, weight: 800 }) +
      bar(x + 16, 212, 150) + bar(x + 16, 224, 110) +
      T(x + 16, 244, (i ? 34 : 128) + ' members', { cls: 'f-m', size: 8, weight: 600 }) +
      T(x + 200, 244, 'Open →', { cls: 'f-green-t', size: 8, anchor: 'end', weight: 800 });
  }).join(''),
  marker(156, 76, 1), marker(234, 76, 2), marker(312, 76, 3), marker(390, 76, 4)
].join(''), 'The hub you land on after signing in.', [
  '<b>My clubs</b> — every club you belong to, with your role in each.',
  '<b>Play a match</b> — a global game without opening a club first.',
  '<b>Tournaments</b> — global tournaments anyone can host or enter.',
  '<b>Leaderboard</b> — every player on JagChess by global rating and record.'
]);

/* Creating a club. */
export const createClub = () => wrap('0 0 470 400', [
  R(0, 0, 470, 400, 10, 'f-scrim'),
  R(35, 18, 400, 364, 14, 'f-card'),
  T(56, 48, 'Create your club', { cls: 'f-h', size: 15, weight: 900 }),
  T(414, 46, '✕', { cls: 'f-m', size: 12, anchor: 'middle' }),

  T(56, 74, 'Club name', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 80, 358, 24, 8, 'f-input'),
  T(66, 96, 'North Creek Chess Club', { cls: 'f-h', size: 9, weight: 600 }),
  T(56, 118, 'jagchess.web.app/clubs/', { cls: 'f-m', size: 8, weight: 600 }),
  T(158, 118, 'north-creek-chess-club', { cls: 'f-green-t', size: 8, weight: 800 }),
  T(300, 118, 'available', { cls: 'f-green-t', size: 8, weight: 700 }),

  T(56, 142, 'Club icon', { cls: 'f-m', size: 8.5, weight: 700 }),
  ['♞', '♜', '♛', '♚', '♝'].map((g, i) =>
    R(56 + i * 28, 148, 24, 24, 8, i === 0 ? 'f-green-soft' : 'f-chip') +
    T(68 + i * 28, 165, g, { cls: i === 0 ? 'f-green-t' : 'f-m', size: 12, anchor: 'middle' })).join(''),
  T(232, 142, 'Club color', { cls: 'f-m', size: 8.5, weight: 700 }),
  ['f-green', 'f-blue', 'f-purple', 'f-orange', 'f-red'].map((c, i) =>
    circle(244 + i * 26, 160, 10, c)).join(''),

  T(56, 196, 'Who can join?', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 202, 176, 40, 9, 'f-green-soft'),
  T(70, 218, 'Public', { cls: 'f-green-t', size: 9, weight: 800 }),
  T(70, 231, 'Listed in search, anyone joins', { cls: 'f-green-t', size: 7, weight: 600 }),
  R(238, 202, 176, 40, 9, 'f-chip'),
  T(252, 218, 'Private', { cls: 'f-h', size: 9, weight: 800 }),
  T(252, 231, 'Join code required', { cls: 'f-m', size: 7, weight: 600 }),

  T(56, 264, 'Join code', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 270, 96, 24, 8, 'f-input'),
  T(104, 286, 'K7M2QD', { cls: 'f-h', size: 11, anchor: 'middle', weight: 800 }),
  R(160, 270, 62, 24, 8, 'f-chip'),
  T(191, 286, 'Regenerate', { cls: 'f-m', size: 7.5, anchor: 'middle', weight: 700 }),

  T(56, 316, 'Start from', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 322, 176, 38, 9, 'f-green-soft'),
  T(70, 338, '♟  Starter chess club', { cls: 'f-green-t', size: 8.5, weight: 800 }),
  T(70, 350, 'Every block, set up', { cls: 'f-green-t', size: 7, weight: 600 }),
  R(238, 322, 176, 38, 9, 'f-chip'),
  T(252, 338, '◻  Blank', { cls: 'f-h', size: 8.5, weight: 800 }),
  T(252, 350, 'Dashboard and profiles only', { cls: 'f-m', size: 7, weight: 600 }),
  marker(46, 92, 1), marker(46, 222, 2), marker(46, 282, 3), marker(46, 340, 4)
].join(''), 'Create your own — the whole form.', [
  '<b>Name</b> sets the address. It is fixed once the club exists, so member links never break.',
  '<b>Public</b> shows the club in search; <b>private</b> demands the join code.',
  '<b>Join code</b> is what you hand out. You can regenerate it any time from Club settings.',
  '<b>Starter</b> gives you every block already arranged; <b>Blank</b> starts you at a dashboard.'
]);

/* Adding a block. */
export const blockPicker = () => wrap('0 0 440 300', [
  R(0, 0, 440, 300, 10, 'f-scrim'),
  R(30, 16, 380, 268, 14, 'f-card'),
  T(50, 46, 'Add a block', { cls: 'f-h', size: 14, weight: 900 }),
  T(50, 62, "Blocks are pages in your club's sidebar.", { cls: 'f-m', size: 8.5 }),
  R(50, 72, 340, 24, 8, 'f-input'),
  T(62, 88, 'Search blocks and templates…', { cls: 'f-m', size: 8.5, weight: 600 }),
  [['Events', 'Practices, tournaments and meetings', 'f-blue-soft', 'f-blue-t'],
   ['Tournaments', 'Arenas, and live Lichess events', 'f-purple-soft', 'f-purple-t'],
   ['Puzzles', 'Tactics worth points', 'f-green-soft', 'f-green-t'],
   ['Leaderboard', 'Points, ratings and records', 'f-gold-soft', 'f-gold-t']]
    .map(([n, d, tint, tcls], i) => {
      const y = 108 + i * 42;
      return R(50, y, 340, 36, 9, 'f-chip') +
        R(58, y + 6, 24, 24, 8, tint) +
        T(70, y + 22, '▦', { cls: tcls, size: 11, anchor: 'middle' }) +
        T(92, y + 17, n, { cls: 'f-h', size: 9.5, weight: 800 }) +
        T(92, y + 28, d, { cls: 'f-m', size: 7.5, weight: 600 }) +
        T(376, y + 23, '+', { cls: 'f-green-t', size: 15, anchor: 'middle', weight: 800 });
    }).join('')
].join(''), 'The block picker, reached from the + beside "Pages" in the sidebar.');

/* Editor mode. */
export const editorMode = () => wrap('0 0 720 320', [
  R(0, 0, 720, 320, 10, 'f-bg'),
  chrome(720, 'jagchess.web.app/clubs/your-club#dashboard'),
  sidebar(0, 26, 294, 'Dashboard'),
  R(128, 26, 592, 30, 0, 'f-purple-soft'),
  circle(146, 41, 4, 'f-purple'),
  T(158, 44, 'Editor mode', { cls: 'f-purple-t', size: 9.5, weight: 800 }),
  T(232, 44, 'Drag blocks to move them, pull the corner to resize.', { cls: 'f-purple-t', size: 8.5, weight: 600 }),
  R(556, 33, 60, 16, 8, 'f-chip'),
  T(586, 44.5, 'Reset layout', { cls: 'f-m', size: 7, anchor: 'middle', weight: 700 }),
  R(624, 33, 78, 16, 8, 'f-green'),
  T(663, 44.5, 'Done editing', { cls: 'f-on-color', size: 7, anchor: 'middle', weight: 800 }),

  [[144, 70, 340, 96, 'Welcome banner'], [496, 70, 208, 96, 'Quick duel'],
   [144, 178, 216, 118, 'Upcoming events'], [372, 178, 156, 118, 'Leaderboard'],
   [540, 178, 164, 118, 'Tournaments']].map(([x, y, w, h, name], i) =>
    R(x, y, w, h, 10, i === 2 ? 'f-card-drag' : 'f-card') +
    R(x, y, w, 18, 10, 'f-chip') +
    T(x + 10, y + 13, name, { cls: 'f-m', size: 7.5, weight: 700 }) +
    T(x + w - 10, y + 13, '✕', { cls: 'f-m', size: 8, anchor: 'end', weight: 700 }) +
    bar(x + 12, y + 32, w - 60, 'f-txt') + bar(x + 12, y + 44, w - 90) +
    `<path d="M${x + w - 16} ${y + h - 5} L${x + w - 5} ${y + h - 16} M${x + w - 9} ${y + h - 5} L${x + w - 5} ${y + h - 9}" class="f-grip"/>`).join(''),
  marker(256, 246, 1), marker(324, 288, 2), marker(538, 41, 3)
].join(''), 'Editor mode. Nothing here changes your club’s data — only its layout.', [
  'Grab a widget anywhere that is not a button and drag it. Everything it lands on moves down.',
  'Pull the corner handle to resize. Each widget has a minimum size it will not go below.',
  '<b>Done editing</b> returns to the normal view. The layout saves as you go, for every member.'
]);

/* The events calendar. */
export const calendarFig = () => wrap('0 0 620 300', [
  R(0, 0, 620, 300, 10, 'f-bg'),
  R(16, 16, 380, 268, 12, 'f-card'),
  T(30, 42, '←', { cls: 'f-m', size: 11 }),
  T(206, 44, 'September 2026', { cls: 'f-h', size: 12, anchor: 'middle', weight: 800 }),
  T(382, 42, '→', { cls: 'f-m', size: 11, anchor: 'end' }),
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) =>
    T(49 + i * 52, 62, d, { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 })).join(''),
  Array.from({ length: 28 }, (_, i) => {
    const col = i % 7, row = Math.floor(i / 7);
    const x = 26 + col * 52, y = 70 + row * 52;
    const day = i + 1;
    const evt = day === 8 ? ['f-blue-soft', 'f-blue-t', 'Practice']
      : day === 11 ? ['f-purple-soft', 'f-purple-t', 'Arena']
      : day === 19 ? ['f-gold-soft', 'f-gold-t', 'Tournament'] : null;
    return R(x, y, 46, 46, 7, day === 9 ? 'f-green-soft' : 'f-surface') +
      T(x + 6, y + 14, String(day), { cls: day === 9 ? 'f-green-t' : 'f-m', size: 7.5, weight: 700 }) +
      (evt ? R(x + 4, y + 20, 38, 12, 5, evt[0]) +
        T(x + 23, y + 28.5, evt[2], { cls: evt[1], size: 5.2, anchor: 'middle', weight: 700 }) : '');
  }).join(''),

  R(408, 16, 196, 268, 12, 'f-card'),
  T(422, 42, 'Add event', { cls: 'f-h', size: 11, weight: 800 }),
  [['Title', 'Club Championship'], ['Date', '19 Sep 2026'], ['Time', '15:30'], ['Type', 'Tournament']]
    .map(([l, v], i) => T(422, 62 + i * 34, l, { cls: 'f-m', size: 7.5, weight: 700 }) +
      R(422, 68 + i * 34, 168, 20, 7, 'f-input') +
      T(432, 82 + i * 34, v, { cls: 'f-h', size: 8, weight: 600 })).join(''),
  R(422, 210, 168, 22, 11, 'f-green'),
  T(506, 224.5, 'Add event', { cls: 'f-on-color', size: 8.5, anchor: 'middle', weight: 800 }),
  T(422, 254, 'Scheduling a tournament adds', { cls: 'f-m', size: 7.5, weight: 600 }),
  T(422, 266, 'its calendar entry for you.', { cls: 'f-m', size: 7.5, weight: 600 })
].join(''), 'The Events block. A tournament with a date lands here automatically.');

/* A duel in progress. */
export function duelBoard() {
  const bx = 176, by = 58, sq = 30;
  const backB = ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'];
  const backW = ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖'];
  let board = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      board += R(bx + c * sq, by + r * sq, sq, sq, 0, (r + c) % 2 ? 'f-sq-d' : 'f-sq-l');
    }
  }
  board += R(bx + 6 * sq, by + 7 * sq, sq, sq, 0, 'f-sq-from');
  backB.forEach((g, c) => { board += T(bx + c * sq + sq / 2, by + sq * 0.72, g, { cls: 'f-piece-b', size: 20, anchor: 'middle' }); });
  for (let c = 0; c < 8; c++) board += T(bx + c * sq + sq / 2, by + sq * 1.72, '♟', { cls: 'f-piece-b', size: 20, anchor: 'middle' });
  for (let c = 0; c < 8; c++) if (c !== 4) board += T(bx + c * sq + sq / 2, by + sq * 6.72, '♙', { cls: 'f-piece-w', size: 20, anchor: 'middle' });
  board += T(bx + 4 * sq + sq / 2, by + sq * 4.72, '♙', { cls: 'f-piece-w', size: 20, anchor: 'middle' });
  backW.forEach((g, c) => { board += T(bx + c * sq + sq / 2, by + sq * 7.72, g, { cls: 'f-piece-w', size: 20, anchor: 'middle' }); });
  board += circle(bx + 5 * sq + sq / 2, by + 5 * sq + sq / 2, 5, 'f-hint');
  board += circle(bx + 7 * sq + sq / 2, by + 5 * sq + sq / 2, 5, 'f-hint');

  return wrap('0 0 700 380', [
    R(0, 0, 700, 380, 10, 'f-bg'),
    R(0, 0, 700, 30, 10, 'f-topbar'),
    T(18, 20, '← Back to duels', { cls: 'f-m', size: 9, weight: 700 }),
    pill(430, 8, 44, '5+3 Blitz'), pill(480, 8, 36, 'Rated', 'f-green-soft'), pill(522, 8, 48, 'Club duel'),
    T(676, 20, '3 watching', { cls: 'f-m', size: 8, anchor: 'end', weight: 700 }),

    R(176, 36, 240, 18, 6, 'f-card'),
    avatar(180, 38, 14, 'f-purple', 'AK'),
    T(200, 49, 'Aria K.', { cls: 'f-h', size: 8.5, weight: 800 }),
    T(240, 49, '1104', { cls: 'f-m', size: 7.5, weight: 600 }),
    R(370, 38, 42, 14, 5, 'f-chip'),
    T(391, 48.5, '4:12', { cls: 'f-h', size: 8.5, anchor: 'middle', weight: 800 }),

    board,

    R(176, 302, 240, 18, 6, 'f-card'),
    avatar(180, 304, 14, 'f-blue', 'SM'),
    T(200, 315, 'Sam M.', { cls: 'f-h', size: 8.5, weight: 800 }),
    T(240, 315, '1042', { cls: 'f-m', size: 7.5, weight: 600 }),
    R(370, 304, 42, 14, 5, 'f-green'),
    T(391, 314.5, '3:58', { cls: 'f-on-color', size: 8.5, anchor: 'middle', weight: 800 }),

    R(432, 36, 250, 284, 10, 'f-card'),
    T(446, 56, 'Moves', { cls: 'f-h', size: 10, weight: 800 }),
    T(668, 56, '9 played', { cls: 'f-m', size: 8, anchor: 'end' }),
    [['1.', 'e4', 'e5'], ['2.', 'Nf3', 'Nc6'], ['3.', 'Bb5', 'a6'], ['4.', 'Ba4', 'Nf6'], ['5.', 'O-O', '']]
      .map(([n, w, b], i) => T(446, 78 + i * 18, n, { cls: 'f-m', size: 8.5, weight: 700 }) +
        T(474, 78 + i * 18, w, { cls: 'f-h', size: 8.5, weight: 700 }) +
        T(524, 78 + i * 18, b, { cls: 'f-h', size: 8.5, weight: 700 })).join(''),
    R(446, 258, 110, 22, 11, 'f-chip'),
    T(501, 272.5, 'Offer draw', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }),
    R(562, 258, 106, 22, 11, 'f-red-soft'),
    T(615, 272.5, 'Resign', { cls: 'f-red-t', size: 8, anchor: 'middle', weight: 800 }),
    marker(162, 311, 1), marker(162, 45, 2), marker(162, 223, 3)
  ].join(''), 'A duel. Playing and spectating are the same screen — spectators just have no clock and no buttons.', [
    'Your clock runs green while it is your move, and turns red under twenty seconds.',
    'Your opponent’s clock and rating sit at the top. The board flips so you are always at the bottom.',
    'Pick a piece up — or tap it — and every legal square is dotted.'
  ]);
}

/* Sending a match link. */
export const matchLinkFig = () => wrap('0 0 440 290', [
  R(0, 0, 440, 290, 10, 'f-scrim'),
  R(40, 16, 360, 258, 14, 'f-card'),
  T(60, 48, 'Your match link', { cls: 'f-h', size: 14, weight: 900 }),
  T(60, 66, 'Send it to anyone. The game starts when they open it.', { cls: 'f-m', size: 8.5 }),
  R(60, 80, 320, 30, 9, 'f-input'),
  T(72, 99, 'jagchess.web.app/m/7QK2M4XD', { cls: 'f-h', size: 9.5, weight: 700 }),
  R(300, 84, 70, 22, 8, 'f-green'),
  T(335, 98.5, 'Copy link', { cls: 'f-on-color', size: 8, anchor: 'middle', weight: 800 }),
  pill(60, 122, 46, '5+3 Blitz'), pill(112, 122, 40, 'Rated', 'f-green-soft'), pill(158, 122, 56, 'Club only'),
  R(60, 152, 320, 60, 10, 'f-blue-soft'),
  T(74, 172, 'Who can use this link', { cls: 'f-blue-t', size: 9, weight: 800 }),
  T(74, 187, 'Both of you must be signed in to JagChess.', { cls: 'f-blue-t', size: 8, weight: 600 }),
  T(74, 200, 'A club link only opens for members of that club.', { cls: 'f-blue-t', size: 8, weight: 600 }),
  R(60, 224, 320, 32, 9, 'f-chip'),
  T(74, 244, 'Waiting for someone to open it…', { cls: 'f-m', size: 9, weight: 700 }),
  circle(360, 240, 5, 'f-green')
].join(''), 'A match link. One opponent, first to open it, and then the link is spent.');

/* Arena tournament. */
export const arenaFig = () => wrap('0 0 722 350', [
  R(0, 0, 722, 350, 10, 'f-bg'),
  R(16, 16, 668, 74, 12, 'f-purple-soft'),
  T(34, 44, 'Friday Night Arena', { cls: 'f-purple-t', size: 15, weight: 900 }),
  T(34, 62, '5+3 Blitz · Rated · North Creek Chess Club', { cls: 'f-purple-t', size: 9, weight: 600 }),
  T(34, 78, 'Hosted by Sam M.', { cls: 'f-purple-t', size: 8, weight: 600 }),
  T(556, 46, '48:12', { cls: 'f-purple-t', size: 22, anchor: 'middle', weight: 900 }),
  T(556, 62, 'remaining', { cls: 'f-purple-t', size: 8, anchor: 'middle', weight: 600 }),
  R(610, 34, 60, 26, 13, 'f-green'),
  T(640, 50.5, 'Join', { cls: 'f-on-color', size: 9.5, anchor: 'middle', weight: 800 }),

  R(16, 102, 420, 232, 12, 'f-card'),
  T(32, 126, 'Standings', { cls: 'f-h', size: 11, weight: 800 }),
  T(420, 126, '24 players', { cls: 'f-m', size: 8, anchor: 'end' }),
  T(32, 148, '#', { cls: 'f-m', size: 7.5, weight: 700 }),
  T(78, 148, 'Player', { cls: 'f-m', size: 7.5, weight: 700 }),
  T(300, 148, 'W/D/L', { cls: 'f-m', size: 7.5, anchor: 'middle', weight: 700 }),
  T(420, 148, 'Score', { cls: 'f-m', size: 7.5, anchor: 'end', weight: 700 }),
  [['Aria K.', '1104', '6/1/0', 15, 'f-purple', 'AK', true],
   ['Sam M.', '1042', '5/2/1', 12, 'f-blue', 'SM', false],
   ['Jo L.', '1130', '5/0/2', 10, 'f-green', 'JL', false],
   ['Rui P.', '986', '4/1/2', 9, 'f-orange', 'RP', false],
   ['Nia B.', '1011', '3/2/3', 8, 'f-red', 'NB', false]]
    .map(([n, r, wdl, sc, col, ini, fire], i) => {
      const y = 172 + i * 32;
      return (i === 1 ? R(24, y - 12, 404, 28, 8, 'f-green-soft') : '') +
        T(34, y + 5, String(i + 1), { cls: i === 0 ? 'f-gold-t' : 'f-m', size: 9.5, weight: 800 }) +
        avatar(52, y - 8, 20, col, ini) +
        T(78, y + 5, n, { cls: 'f-h', size: 9, weight: 800 }) +
        T(78 + n.length * 5.4 + 8, y + 5, r, { cls: 'f-m', size: 7.5, weight: 600 }) +
        (fire ? T(238, y + 5, 'streak', { cls: 'f-orange-t', size: 7.5, weight: 800 }) : '') +
        T(300, y + 5, wdl, { cls: 'f-m', size: 8.5, anchor: 'middle', weight: 600 }) +
        T(420, y + 5, String(sc), { cls: 'f-h', size: 11, anchor: 'end', weight: 800 });
    }).join(''),

  R(452, 102, 232, 110, 12, 'f-card'),
  T(468, 126, 'Your next game', { cls: 'f-h', size: 10, weight: 800 }),
  R(468, 138, 200, 40, 9, 'f-green-soft'),
  avatar(478, 148, 20, 'f-orange', 'RP'),
  T(504, 156, 'Rui P.', { cls: 'f-green-t', size: 9, weight: 800 }),
  T(504, 168, '986 · you are White', { cls: 'f-green-t', size: 7.5, weight: 600 }),
  R(468, 186, 200, 18, 9, 'f-green'),
  T(568, 198.5, 'Enter the game', { cls: 'f-on-color', size: 8, anchor: 'middle', weight: 800 }),

  R(452, 224, 232, 110, 12, 'f-card'),
  T(468, 248, 'How scoring works', { cls: 'f-h', size: 10, weight: 800 }),
  [['Win', '2'], ['Draw', '1'], ['Loss', '0'], ['On a streak', 'double']]
    .map(([l, v], i) => T(468, 268 + i * 17, l, { cls: 'f-m', size: 8.5, weight: 600 }) +
      T(668, 268 + i * 17, v, { cls: 'f-h', size: 8.5, anchor: 'end', weight: 800 })).join(''),
  marker(704, 47, 1), marker(704, 168, 2), marker(704, 290, 3)
].join(''), 'An arena in progress.', [
  'The clock counts the whole tournament down. When it hits zero, whoever leads wins.',
  'You are paired automatically whenever you are free — with whoever is nearest you on score.',
  'Two wins in a row starts a streak, and everything after it is worth double until you fail to win.'
]);

/* Creating a tournament. */
export const tournamentForm = () => wrap('0 0 470 400', [
  R(0, 0, 470, 400, 10, 'f-scrim'),
  R(35, 12, 400, 376, 14, 'f-card'),
  T(56, 42, 'New tournament', { cls: 'f-h', size: 15, weight: 900 }),
  T(56, 66, 'Where does it run?', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 72, 176, 44, 9, 'f-purple-soft'),
  T(70, 90, 'JagChess arena', { cls: 'f-purple-t', size: 9.5, weight: 800 }),
  T(70, 103, 'Timed, auto-paired', { cls: 'f-purple-t', size: 7, weight: 600 }),
  R(238, 72, 176, 44, 9, 'f-chip'),
  T(252, 90, 'Lichess tournament', { cls: 'f-h', size: 9.5, weight: 800 }),
  T(252, 103, 'Arena or Swiss, on lichess', { cls: 'f-m', size: 7, weight: 600 }),

  [['Name', 'Friday Night Arena'], ['Starts', '11 Sep 2026, 19:00']]
    .map(([l, v], i) => T(56, 138 + i * 44, l, { cls: 'f-m', size: 8.5, weight: 700 }) +
      R(56, 144 + i * 44, 358, 22, 8, 'f-input') +
      T(66, 159 + i * 44, v, { cls: 'f-h', size: 8.5, weight: 600 })).join(''),

  T(56, 226, 'Time control', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 232, 172, 22, 8, 'f-input'),
  T(66, 247, '5 + 3  (Blitz)', { cls: 'f-h', size: 8.5, weight: 600 }),
  T(242, 226, 'Lasts', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(242, 232, 172, 22, 8, 'f-input'),
  T(252, 247, '60 minutes', { cls: 'f-h', size: 8.5, weight: 600 }),

  T(56, 274, 'Stakes', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(56, 280, 88, 22, 11, 'f-green'),
  T(100, 294.5, 'Rated', { cls: 'f-on-color', size: 8.5, anchor: 'middle', weight: 800 }),
  R(150, 280, 88, 22, 11, 'f-chip'),
  T(194, 294.5, 'Casual', { cls: 'f-m', size: 8.5, anchor: 'middle', weight: 700 }),
  T(250, 295, 'Rated moves the club rating.', { cls: 'f-m', size: 7.5, weight: 600 }),

  R(56, 314, 358, 32, 9, 'f-chip'),
  T(70, 334, 'Allow berserk — halve your clock for a bonus point', { cls: 'f-m', size: 8.5, weight: 700 }),
  R(376, 320, 28, 16, 8, 'f-off'), circle(385, 328, 6, 'f-knob'),
  R(56, 356, 358, 24, 12, 'f-green'),
  T(235, 372, 'Create tournament', { cls: 'f-on-color', size: 9.5, anchor: 'middle', weight: 800 }),
  marker(46, 94, 1), marker(46, 243, 2), marker(46, 291, 3), marker(46, 330, 4)
].join(''), 'Creating a tournament. Choosing Lichess opens lichess’s own setup instead.', [
  '<b>Where it runs</b> decides everything else. A JagChess arena is this form; a Lichess tournament opens the full lichess setup — arena or Swiss, variants, entry conditions.',
  '<b>Time control</b> and <b>duration</b> — how long one game lasts, and how long the arena runs.',
  '<b>Rated</b> moves the club rating (or global rating, outside a club). Casual moves nothing.',
  '<b>Berserk</b> is off unless you turn it on.'
]);

/* The leaderboard, with records. */
export const leaderboardFig = () => wrap('0 0 640 300', [
  R(0, 0, 640, 300, 10, 'f-bg'),
  R(16, 16, 608, 268, 12, 'f-card'),
  ['Points', 'Club rating', 'Global rating'].map((t, i) =>
    R(32 + i * 92, 32, 86, 24, 12, i === 1 ? 'f-green-soft' : 'f-chip') +
    T(75 + i * 92, 48, t, { cls: i === 1 ? 'f-green-t' : 'f-m', size: 8.5, anchor: 'middle', weight: i === 1 ? 800 : 700 })).join(''),
  T(38, 82, 'Rank', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }),
  T(86, 82, 'Player', { cls: 'f-m', size: 8, weight: 700 }),
  T(400, 82, 'Rating', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }),
  T(492, 82, 'W / D / L', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }),
  [['Jo L.', '1130', '42/8/19', 'f-green', 'JL', false],
   ['Aria K.', '1104', '38/11/22', 'f-purple', 'AK', false],
   ['Sam M.', '1042', '30/6/24', 'f-blue', 'SM', true],
   ['Nia B.', '1011', '25/9/26', 'f-red', 'NB', false],
   ['Rui P.', '?', '0/0/0', 'f-orange', 'RP', false]]
    .map(([n, r, wdl, col, ini, me], i) => {
      const y = 112 + i * 34;
      return (me ? R(24, y - 12, 592, 30, 8, 'f-green-soft') : '') +
        T(38, y + 6, String(i + 1), { cls: i === 0 ? 'f-gold-t' : 'f-m', size: 10, anchor: 'middle', weight: 800 }) +
        avatar(58, y - 8, 22, col, ini) +
        T(86, y + 6, n, { cls: 'f-h', size: 9.5, weight: 800 }) +
        (me ? pill(86 + n.length * 5.8 + 6, y - 5, 26, 'You', 'f-green') : '') +
        T(400, y + 6, r, { cls: r === '?' ? 'f-faint' : 'f-h', size: 10, anchor: 'middle', weight: 800 }) +
        T(492, y + 6, wdl, { cls: 'f-m', size: 9, anchor: 'middle', weight: 600 }) +
        (me ? '' : R(548, y - 8, 60, 22, 11, 'f-chip') +
          T(578, y + 6, 'Duel', { cls: 'f-m', size: 8, anchor: 'middle', weight: 700 }));
    }).join(''),
  T(34, 274, 'A "?" rating means that player has not finished a rated game yet.', { cls: 'f-m', size: 8, weight: 600 })
].join(''), 'The leaderboard. Three tabs, and a win / draw / loss record on every row.');

/* Invite link and QR. */
export const inviteFig = () => wrap('0 0 400 260', [
  R(0, 0, 400, 260, 10, 'f-scrim'),
  R(30, 14, 340, 232, 14, 'f-card'),
  T(50, 44, 'Invite to your club', { cls: 'f-h', size: 13, weight: 900 }),
  R(50, 58, 96, 96, 10, 'f-qr'),
  Array.from({ length: 36 }, (_, i) => {
    const c = i % 6, r = Math.floor(i / 6);
    return (c * 7 + r * 3) % 4 < 2 ? R(58 + c * 14, 66 + r * 14, 11, 11, 2, 'f-qr-px') : '';
  }).join(''),
  T(164, 78, 'Join code', { cls: 'f-m', size: 8, weight: 700 }),
  R(164, 84, 120, 26, 8, 'f-input'),
  T(224, 102, 'K7M2QD', { cls: 'f-h', size: 12, anchor: 'middle', weight: 800 }),
  T(164, 130, 'Invite link', { cls: 'f-m', size: 8, weight: 700 }),
  R(164, 136, 186, 22, 8, 'f-input'),
  T(174, 151, 'jagchess.web.app/clubs/…', { cls: 'f-h', size: 8, weight: 600 }),
  R(50, 172, 148, 24, 12, 'f-green'),
  T(124, 188, 'Copy link', { cls: 'f-on-color', size: 9, anchor: 'middle', weight: 800 }),
  R(206, 172, 144, 24, 12, 'f-chip'),
  T(278, 188, 'Download QR', { cls: 'f-m', size: 9, anchor: 'middle', weight: 700 }),
  T(50, 218, 'A private club’s link carries its join code, so only', { cls: 'f-m', size: 8, weight: 600 }),
  T(50, 230, 'admins and the founder can hand it out.', { cls: 'f-m', size: 8, weight: 600 })
].join(''), 'The invite sheet, from the Invite button or Club settings.');

/* Roles. */
export const rolesFig = () => wrap('0 0 620 210', [
  R(0, 0, 620, 210, 10, 'f-bg'),
  [['Founder', 'f-gold-soft', 'f-gold-t', ['Everything an admin can do', 'Set and change roles', 'Moderate admins', 'Transfer the club', 'Cannot be kicked or demoted']],
   ['Admin', 'f-blue-soft', 'f-blue-t', ['Add, rename, remove blocks', 'Arrange the dashboard', 'Publish puzzles and events', 'Run tournaments', 'Moderate students']],
   ['Student', 'f-green-soft', 'f-green-t', ['Read every block', 'Earn points and streaks', 'Play duels and tournaments', 'Spend points in the store', 'Edit their own profile']]]
    .map(([name, tint, tcls, rows], i) => {
      const x = 16 + i * 198;
      return R(x, 16, 188, 178, 12, tint) +
        T(x + 16, 44, name, { cls: tcls, size: 13, weight: 900 }) +
        rows.map((r, j) =>
          T(x + 16, 68 + j * 22, '✓', { cls: tcls, size: 9, weight: 800 }) +
          T(x + 30, 68 + j * 22, r, { cls: tcls, size: 8, weight: 600 })).join('');
    }).join('')
].join(''), 'What each role can do. A club has exactly one founder.');
