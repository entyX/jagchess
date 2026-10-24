/* ═══════════════════════════════════════════════════════════════════════
   club-dash.js — the club home page.

   Two states. Most of the time it is just a page: widgets laid out the
   way the club's admins arranged them, nothing to drag, nothing that looks
   like an editor. When an admin presses Customize it becomes a canvas:
   widgets move and resize on a 12-column grid, each one opens a settings
   drawer, and new ones come from a gallery.

   Widgets are absolutely positioned rather than placed with CSS grid so
   that every move can animate — the one being dragged follows the pointer
   and the rest slide out of its way. Below 900px the canvas gives up on
   positions entirely and stacks widgets in reading order.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  clubRef, clubCol, clubDoc, updateDoc, getDoc, getDocs, setDoc, query, orderBy, limit,
  esc, fmtDate, fmtTime, toast
} from './club-core.js';

import { displayRating } from './glicko2.js';
import { loadMyRatings, setDuelIntent, duelsHash, tcLabel } from './club-duels.js';
import { listTournaments, phaseOf, arenaEndsAt, FORMATS } from './tournaments-core.js';
import { miniBoardHTML } from './mini-board.js';

const COLS = 12;
const ROW = 40;       // one grid row, in px
const GAP = 16;
const UNIT = ROW + GAP;
const LAYOUT_V = 2;   // layouts saved before this used rows twice as tall

/* ── layout maths ──────────────────────────────────────────────────── */

const hit = (a, b) =>
  a.i !== b.i && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/* The moved widget keeps the cell it was dropped on; whatever it lands on
   is pushed down, and anything that push lands on is pushed in turn. */
function resolve(layout, moved) {
  let guard = 0;
  let changed = true;
  while (changed && guard++ < 120) {
    changed = false;
    const others = layout.filter((w) => w.i !== moved.i).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const o of others) {
      if (hit(moved, o)) { o.y = moved.y + moved.h; changed = true; }
    }
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        if (hit(others[i], others[j])) { others[j].y = others[i].y + others[i].h; changed = true; }
      }
    }
  }
}

/* Everything floats up as far as it can, so the page never grows holes.
   `pinned` stays where it is — the widget under the pointer mid-drag. */
function compact(layout, pinned) {
  const order = layout.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = [];
  for (const it of order) {
    if (it !== pinned) {
      while (it.y > 0) {
        const test = { ...it, y: it.y - 1 };
        if (placed.some((p) => hit(test, p)) || (pinned && hit(test, pinned))) break;
        it.y--;
      }
    }
    placed.push(it);
  }
}

/* The first free spot a widget of this size fits, scanning top-down. */
function firstFit(layout, w, h) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x + w <= COLS; x++) {
      const probe = { i: '__probe', x, y, w, h };
      if (!layout.some((o) => hit(probe, o))) return { x, y };
    }
  }
  return { x: 0, y: layout.reduce((m, o) => Math.max(m, o.y + o.h), 0) };
}

/* A first look that makes sense for a club that has done nothing yet: who
   you are and what to do, then the three things that change week to week. */
const DEFAULT_LAYOUT = [
  { i: 'w1', type: 'welcome',      x: 0, y: 0,  w: 8, h: 5 },
  { i: 'w2', type: 'quick-duel',   x: 8, y: 0,  w: 4, h: 5 },
  { i: 'w3', type: 'events-next',  x: 0, y: 5,  w: 4, h: 7 },
  { i: 'w4', type: 'puzzle-daily', x: 4, y: 5,  w: 4, h: 7 },
  { i: 'w5', type: 'leaderboard',  x: 8, y: 5,  w: 4, h: 7 },
  { i: 'w6', type: 'news-latest',  x: 0, y: 12, w: 6, h: 5 },
  { i: 'w7', type: 'tournaments',  x: 6, y: 12, w: 6, h: 5 }
];

const TIPS = [
  'Control the centre. Pieces in the middle reach more squares.',
  'Move each piece once before you move any piece twice.',
  'Castle early: it tucks your king away and connects your rooks.',
  'A knight on the rim is dim. Bring it towards the centre.',
  'Ahead in material? Trade pieces and the win gets simpler.',
  'Before every move, ask what your opponent is threatening.',
  'Rooks love open files. Put one where no pawns are in the way.'
];

/* ── the widget catalogue ──────────────────────────────────────────── */

/* `group` is the gallery shelf it sits on. `settings` lists what its drawer
   lets you change beyond the title, which everything has. */
export const WIDGETS = {
  welcome:        { name: 'Welcome', desc: 'A greeting with the club\'s next step', group: 'Club', w: 8, h: 5, minW: 4, minH: 4, icon: 'wave' },
  announcement:   { name: 'Announcement', desc: 'A coloured card for news nobody should miss', group: 'Club', w: 6, h: 4, minW: 3, minH: 3, icon: 'megaphone', settings: ['color', 'emoji', 'body', 'button'] },
  banner:         { name: 'Image banner', desc: 'A photo, poster or sponsor ad that fits itself to the space', group: 'Club', w: 12, h: 5, minW: 3, minH: 2, icon: 'image', settings: ['image', 'link'] },
  text:           { name: 'Text', desc: 'Club rules, a meeting room, what to bring', group: 'Club', w: 4, h: 4, minW: 2, minH: 2, icon: 'text', settings: ['body'] },
  link:           { name: 'Button link', desc: 'Send people to a sign-up sheet, group chat or form', group: 'Club', w: 4, h: 2, minW: 2, minH: 2, icon: 'link', settings: ['color', 'emoji', 'url', 'desc'] },
  countdown:      { name: 'Countdown', desc: 'Days until the next meeting or a big tournament', group: 'Club', w: 4, h: 4, minW: 3, minH: 3, icon: 'timer', settings: ['date', 'color'] },
  video:          { name: 'Video', desc: 'A YouTube lesson or highlight', group: 'Club', w: 6, h: 7, minW: 3, minH: 4, icon: 'play', settings: ['video'] },

  'events-next':  { name: 'Upcoming events', desc: 'The next few dates on the calendar', group: 'Activity', w: 4, h: 7, minW: 3, minH: 4, icon: 'calendar' },
  'news-latest':  { name: 'Latest news', desc: 'The newest newsletters', group: 'Activity', w: 6, h: 5, minW: 3, minH: 3, icon: 'mail' },
  leaderboard:    { name: 'Leaderboard', desc: 'Who has the most points', group: 'Activity', w: 4, h: 7, minW: 3, minH: 4, icon: 'trophy' },
  tournaments:    { name: 'Tournaments', desc: 'What is running and what is next', group: 'Activity', w: 6, h: 5, minW: 3, minH: 3, icon: 'bracket' },
  'club-stats':   { name: 'Club stats', desc: 'Members, events and points at a glance', group: 'Activity', w: 12, h: 2, minW: 4, minH: 2, icon: 'chart' },
  'stat-members': { name: 'Member count', desc: 'How many people are in the club', group: 'Activity', w: 3, h: 3, minW: 2, minH: 2, icon: 'people' },

  'quick-duel':   { name: 'Quick game', desc: 'Your ratings and a button straight into a game', group: 'Play and learn', w: 4, h: 5, minW: 3, minH: 4, icon: 'swords' },
  'puzzle-daily': { name: 'Puzzle of the day', desc: 'The newest puzzle, with its board', group: 'Play and learn', w: 4, h: 7, minW: 3, minH: 5, icon: 'puzzle' },
  tip:            { name: 'Tip of the day', desc: 'A short chess tip that changes daily', group: 'Play and learn', w: 4, h: 3, minW: 3, minH: 2, icon: 'bulb' },
  'store-preview':{ name: 'Store preview', desc: 'A few things members can spend points on', group: 'Play and learn', w: 4, h: 5, minW: 3, minH: 3, icon: 'bag' }
};

const GROUPS = ['Club', 'Activity', 'Play and learn'];

/* The colours an announcement, link or countdown can take. */
const TONES = {
  green:  'Green',
  blue:   'Blue',
  purple: 'Purple',
  orange: 'Orange',
  pink:   'Pink',
  felt:   'Board green',
  plain:  'White'
};

const GLYPH = {
  wave: '<path d="M7.5 11.5V6.2a1.6 1.6 0 0 1 3.2 0v4.6M10.7 10V4.6a1.6 1.6 0 0 1 3.2 0V10M13.9 10V5.8a1.6 1.6 0 0 1 3.2 0v6.7c0 4.3-2.7 7.7-6.9 7.7-2.6 0-4.3-1.3-5.6-3.4l-2-3.4a1.6 1.6 0 0 1 2.7-1.7l1.4 2"/>',
  megaphone: '<path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H7l5 4V4.5l-5 4H5.5A1.5 1.5 0 0 0 4 10Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17.5 4.6-4.6a1.5 1.5 0 0 1 2.1 0L16 18.2M14 15.8l1.6-1.6a1.5 1.5 0 0 1 2.1 0l2.8 2.8"/>',
  text: '<path d="M5 6h14M5 10.5h14M5 15h9"/>',
  link: '<path d="M10.4 13.6a3.7 3.7 0 0 0 5.6.4l2.6-2.6a3.7 3.7 0 1 0-5.2-5.2l-1.5 1.5"/><path d="M13.6 10.4a3.7 3.7 0 0 0-5.6-.4l-2.6 2.6a3.7 3.7 0 1 0 5.2 5.2l1.5-1.5"/>',
  timer: '<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.8l2.4 1.6M10 3h4"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10.2 9.2 4.6 2.8-4.6 2.8Z"/>',
  calendar: '<rect x="3" y="4.8" width="18" height="16.2" rx="3.2"/><path d="M3 9.8h18M8 2.6v4.2M16 2.6v4.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3.6 7 7.3 5.3a2 2 0 0 0 2.2 0L20.4 7"/>',
  trophy: '<path d="M7.6 4.2h8.8v4.6a4.4 4.4 0 0 1-8.8 0Z"/><path d="M7.6 5.8H4.9v1a3 3 0 0 0 2.9 3M16.4 5.8h2.7v1a3 3 0 0 1-2.9 3"/><path d="M12 13.2v3.4M8.4 20.2h7.2l-.9-3.6H9.3Z"/>',
  bracket: '<path d="M3.2 5.6h5.2v4.2H3.2zM3.2 14.2h5.2v4.2H3.2z"/><path d="M10.8 9.9h4.6v4.2h-4.6z"/><path d="M8.4 7.7h2.4v6.4M8.4 16.3h2.4"/><path d="M15.4 12h5.4"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3.4" height="6.5" rx="1"/><rect x="10.3" y="6.5" width="3.4" height="11" rx="1"/><rect x="15.1" y="3.5" width="3.4" height="14" rx="1"/>',
  people: '<circle cx="9" cy="8.4" r="3.2"/><path d="M2.6 19.4c0-3.3 2.9-5.6 6.4-5.6s6.4 2.3 6.4 5.6"/><path d="M16.6 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.2 19.4c0-2-.5-3.6-1.5-4.7"/>',
  swords: '<path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/>',
  puzzle: '<rect x="3" y="3" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="3" width="7.4" height="7.4" rx="2"/><rect x="3" y="13.6" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="13.6" width="7.4" height="7.4" rx="2"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>',
  bag: '<path d="M5.4 8h13.2l-1.1 12.2H6.5Z"/><path d="M9 8V5.9a3 3 0 0 1 6 0V8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4Z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.6"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.8 1.8 0 0 0 1.8 1.6h5.6a1.8 1.8 0 0 0 1.8-1.6L17.5 7"/>',
  arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

const svg = (name, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${GLYPH[name] || ''}</svg>`;

/* ── data ──────────────────────────────────────────────────────────── */

async function loadData(ctx, layout) {
  const id = ctx.clubId;
  const safe = async (p, fallback) => { try { return await p; } catch (e) { console.warn(e); return fallback; } };
  const wants = (...types) => layout.some((w) => types.includes(w.type));
  const none = { docs: [] };

  const [events, members, news, puzzles, items, tourns, ratings] = await Promise.all([
    safe(getDocs(query(clubCol(id, 'events'), orderBy('date', 'asc'))), none),
    safe(getDocs(query(clubCol(id, 'members'), orderBy('points', 'desc'), limit(20))), none),
    wants('news-latest') ? safe(getDocs(query(clubCol(id, 'announcements'), orderBy('createdAt', 'desc'), limit(4))), none) : none,
    safe(getDocs(query(clubCol(id, 'puzzles'), orderBy('createdAt', 'desc'), limit(1))), none),
    wants('store-preview') ? safe(getDocs(query(clubCol(id, 'shopItems'), limit(4))), none) : none,
    wants('tournaments', 'club-stats') ? safe(listTournaments(ctx), []) : [],
    wants('quick-duel') ? safe(loadMyRatings(ctx), null) : null
  ]);

  const map = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const now = Date.now();
  const staffHidden = ctx.club.hideStaffFromLeaderboard === true;
  const isStaffRole = (r) => r === 'admin' || r === 'founder';
  /* live first, then whatever starts soonest */
  const live = (tourns || []).filter((t) => {
    const p = phaseOf(t, now);
    return p === 'running' || p === 'ending' || p === 'scheduled';
  }).sort((a, b) => {
    const rank = (t) => (phaseOf(t, now) === 'scheduled' ? 1 : 0);
    return rank(a) - rank(b) || (a.startsAt || 0) - (b.startsAt || 0);
  });

  const allEvents = map(events);
  return {
    events: allEvents.filter((e) => e.date >= now - 3 * 3600e3).slice(0, 6),
    eventsThisMonth: allEvents.filter((e) => e.date >= now && e.date < now + 30 * 86400e3).length,
    members: map(members).filter((m) => !(staffHidden && isStaffRole(m.role))).slice(0, 8),
    news: map(news),
    puzzle: map(puzzles)[0] || null,
    items: map(items),
    tournaments: live.slice(0, 4),
    ratings,
    media: {}
  };
}

/* Banner pictures live one per document beside the club, never on the club
   document itself — a few posters would fill the club's whole size limit. */
const mediaCache = new Map();

async function loadMedia(ctx, ids) {
  const out = {};
  await Promise.all(ids.map(async (mid) => {
    if (mediaCache.has(mid)) { out[mid] = mediaCache.get(mid); return; }
    try {
      const s = await getDoc(clubDoc(ctx.clubId, 'media', mid));
      if (s.exists()) { mediaCache.set(mid, s.data()); out[mid] = s.data(); }
    } catch (e) { console.warn('Could not load a picture', e); }
  }));
  return out;
}

/* "in 3 days", "in 2h", "in 14m" — enough to know whether to care. */
const relative = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return `in ${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `in ${Math.floor(s / 3600)}h`;
  if (s >= 60) return `in ${Math.floor(s / 60)}m`;
  return 'any moment';
};

/* A tiny, safe subset of markdown for text the club writes itself:
   **bold**, *italic*, links, and line breaks. Everything is escaped first. */
export function richText(raw) {
  let s = esc(raw || '');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>');
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '')}</a>`);
  return s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

const safeUrl = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return 'https://' + s;
  return '';
};

/* A YouTube watch, share or shorts address, to the id it plays. */
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

/* ── widget bodies ─────────────────────────────────────────────────── */

const head = (title, go, label) => `<div class="w-head">
    <h3 class="w-title">${esc(title)}</h3>
    ${go ? `<button class="w-link" data-go="${go}">${esc(label || 'See all')}</button>` : ''}
  </div>`;

function emptyRow(text, action, go) {
  return `<div class="w-empty"><span>${esc(text)}</span>${action ? `<button class="btn subtle sm" data-go="${go}">${esc(action)}</button>` : ''}</div>`;
}

function widgetHTML(w, ctx, data) {
  const me = ctx.member;
  const cfg = w.cfg || {};
  const title = (fallback) => cfg.title || fallback;

  switch (w.type) {
    case 'welcome': {
      const h = new Date().getHours();
      const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
      const first = (me.username || '').split(' ')[0] || 'player';
      const next = data.events.find((e) => e.date >= Date.now());
      const nextLine = next
        ? `Next up: <b>${esc(next.title)}</b>, ${esc(fmtDate(next.date, { weekday: 'long' }))} at ${esc(fmtTime(next.date))}.`
        : esc(ctx.club.description || 'Solve a puzzle, play a game, climb the leaderboard.');
      return `<div class="w-welcome">
        <div class="w-welcome-copy">
          <h2 class="w-welcome-title">${esc(cfg.title || `${greet}, ${first}`)}</h2>
          <p class="w-welcome-sub">${nextLine}</p>
          <div class="w-welcome-cta">
            ${data.puzzle ? '<button class="btn primary" data-go="puzzles">Solve today\'s puzzle</button>' : ''}
            <button class="btn subtle" data-duel="club">Play a game</button>
          </div>
        </div>
        <div class="w-welcome-art">${miniBoardHTML('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1', { highlight: ['e1', 'g1'] })}</div>
      </div>`;
    }

    case 'announcement': {
      const url = safeUrl(cfg.url);
      return `<div class="w-announce tone-${esc(cfg.color || 'green')}">
        ${cfg.emoji ? `<span class="w-announce-emoji">${esc(cfg.emoji)}</span>` : ''}
        <h3 class="w-announce-title">${esc(cfg.title || 'Your announcement')}</h3>
        <div class="w-rich">${richText(cfg.body || (ctx.isAdmin ? 'Press Customize, then click this card to write what it says.' : ''))}</div>
        ${url && cfg.button ? `<a class="btn w-announce-btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(cfg.button)}</a>` : ''}
      </div>`;
    }

    case 'banner': {
      const m = cfg.media && data.media[cfg.media];
      const url = safeUrl(cfg.url);
      if (!m) {
        return `<div class="w-placeholder">${svg('image')}<b>Add a picture</b>
          <span>A poster, a team photo or a sponsor's ad. Any shape fits.</span></div>`;
      }
      const fit = cfg.fit === 'cover' ? 'cover' : 'contain';
      const pos = `${cfg.px ?? 50}% ${cfg.py ?? 50}%`;
      const inner = `
        ${fit === 'contain' ? `<div class="w-banner-fill" style="background-image:url('${m.data}')"></div>` : ''}
        <img class="w-banner-img fit-${fit}" src="${m.data}" alt="${esc(cfg.caption || '')}" style="object-position:${pos}">`;
      return url
        ? `<a class="w-banner" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="w-banner">${inner}</div>`;
    }

    case 'text':
      return `${cfg.title ? `<div class="w-head"><h3 class="w-title">${esc(cfg.title)}</h3></div>` : ''}
        <div class="w-scroll w-rich">${richText(cfg.body || (ctx.isAdmin ? 'Press Customize, then click this card to write something. Meeting room, club rules, what to bring.' : ''))}</div>`;

    case 'link': {
      const url = safeUrl(cfg.url);
      const tag = url ? 'a' : 'div';
      return `<${tag} class="w-linkcard tone-${esc(cfg.color || 'blue')}"${url ? ` href="${esc(url)}" target="_blank" rel="noopener"` : ''}>
        <span class="w-linkcard-emoji">${esc(cfg.emoji || '👉')}</span>
        <span class="w-linkcard-body">
          <b>${esc(cfg.title || 'Button link')}</b>
          <small>${esc(cfg.desc || (url ? url.replace(/^https?:\/\//, '') : 'Add a web address in Customize'))}</small>
        </span>
        ${svg('arrow', 'class="w-linkcard-arrow"')}
      </${tag}>`;
    }

    case 'countdown': {
      const next = data.events.find((e) => e.date >= Date.now());
      const target = cfg.date ? new Date(cfg.date).getTime() : next ? next.date : null;
      const label = cfg.title || (cfg.date ? 'Countdown' : next ? next.title : 'Countdown');
      if (!target || isNaN(target)) {
        return `<div class="w-count tone-${esc(cfg.color || 'felt')}"><span class="w-count-label">${esc(label)}</span>
          <b class="w-count-num">–</b><span class="w-count-unit">Pick a date, or add an event to the calendar</span></div>`;
      }
      return `<div class="w-count tone-${esc(cfg.color || 'felt')}" data-countdown="${target}">
        <span class="w-count-label">${esc(label)}</span>
        <b class="w-count-num tabular">–</b>
        <span class="w-count-unit"></span>
        <span class="w-count-date">${esc(fmtDate(target, { weekday: 'long', month: 'short', day: 'numeric' }))}</span>
      </div>`;
    }

    case 'video': {
      const id = youtubeId(cfg.url);
      if (!id) {
        return `<div class="w-placeholder">${svg('play')}<b>Add a video</b><span>Paste a YouTube link in Customize.</span></div>`;
      }
      return `${cfg.title ? `<div class="w-head"><h3 class="w-title">${esc(cfg.title)}</h3></div>` : ''}
        <div class="w-video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="${esc(cfg.title || 'Video')}"
          loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
    }

    case 'quick-duel': {
      const r = data.ratings || {};
      return `${head(title('Play a game'), 'duels', 'Open')}
        <div class="w-duel-ratings">
          <div class="w-duel-rating"><b class="tabular">${displayRating(r.club)}</b><span>Club rating</span></div>
          <div class="w-duel-rating"><b class="tabular">${displayRating(r.global)}</b><span>Global rating</span></div>
        </div>
        <div class="w-duel-btns">
          <button class="btn primary" data-duel="club">Play the club</button>
          <button class="btn subtle" data-duel="global">Play anyone</button>
        </div>`;
    }

    case 'stat-members':
      return `<div class="w-single">
        <b class="w-single-num tabular">${ctx.club.memberCount || data.members.length || 1}</b>
        <span class="w-single-label">${esc(title('Members'))}</span>
      </div>`;

    case 'club-stats':
      return `<div class="w-stats">
        <div><b class="tabular">${ctx.club.memberCount || 1}</b><span>Members</span></div>
        <div><b class="tabular">${data.eventsThisMonth}</b><span>Events this month</span></div>
        <div><b class="tabular">${data.members.reduce((s, m) => s + (m.points || 0), 0)}</b><span>Points earned</span></div>
        <div><b class="tabular">${data.tournaments.length}</b><span>Tournaments on</span></div>
      </div>`;

    case 'events-next':
      return `${head(title('Coming up'), 'events', 'Calendar')}
        <div class="w-scroll">${data.events.length ? data.events.map((e) => `
          <button class="w-row w-ev" data-go="events">
            <span class="w-ev-date"><small>${esc(new Date(e.date).toLocaleString(undefined, { month: 'short' }))}</small><b>${new Date(e.date).getDate()}</b></span>
            <span class="w-row-body">
              <b>${esc(e.title)}</b>
              <small>${esc(fmtDate(e.date, { weekday: 'long' }))}, ${esc(fmtTime(e.date))}</small>
            </span>
          </button>`).join('') : emptyRow('Nothing on the calendar yet.', ctx.isAdmin ? 'Add an event' : null, 'events')}</div>`;

    case 'leaderboard': {
      const rows = data.members;
      if (!rows.length) return `${head(title('Leaderboard'), 'leaderboard')}${emptyRow('No points yet. Solve a puzzle to get on the board.')}`;
      return `${head(title('Leaderboard'), 'leaderboard', 'Full board')}
        <div class="w-scroll w-lb">${rows.slice(0, 7).map((m, i) => `
          <div class="w-lb-row${m.uid === ctx.user.uid ? ' me' : ''}${i < 3 ? ' top' + (i + 1) : ''}">
            <span class="w-lb-rank tabular">${i + 1}</span>
            <span class="lb-avatar" style="background:${esc(m.avatarColor || '#2e90fa')};width:30px;height:30px;font-size:11px">${esc((m.username || '?').slice(0, 2).toUpperCase())}</span>
            <span class="w-lb-name">${esc(m.username || 'Player')}${m.uid === ctx.user.uid ? ' <small>you</small>' : ''}</span>
            <b class="w-lb-pts tabular">${m.points || 0}</b>
          </div>`).join('')}</div>`;
    }

    case 'news-latest':
      return `${head(title('Latest news'), 'newsletters')}
        <div class="w-scroll">${data.news.length ? data.news.map((n) => `
          <button class="w-row" data-go="newsletters">
            <span class="w-row-body"><b>${esc(n.title)}</b>
            <small>${esc(fmtDate(n.createdAt, { month: 'long', day: 'numeric' }))}</small></span>
          </button>`).join('') : emptyRow('No newsletters yet.', ctx.isAdmin ? 'Write one' : null, 'newsletters')}</div>`;

    case 'puzzle-daily': {
      const p = data.puzzle;
      if (!p) return `${head(title('Puzzle of the day'))}${emptyRow('No puzzles posted yet.', ctx.isAdmin ? 'Post a puzzle' : null, 'puzzles')}`;
      const color = p.playerColor === 'b' ? 'Black' : 'White';
      return `${head(title('Puzzle of the day'), 'puzzles', 'All puzzles')}
        <button class="w-puzzle" data-go="puzzles">
          ${miniBoardHTML(p.fen, { flip: p.playerColor === 'b' })}
          <span class="w-puzzle-meta">
            <b>${esc(p.title || 'Find the best move')}</b>
            <small>${color} to move, worth ${p.points || 10} points</small>
          </span>
        </button>`;
    }

    case 'tournaments': {
      const now = Date.now();
      const brief = (t) => {
        const p = phaseOf(t, now);
        if (p === 'scheduled') return 'Starts ' + relative(t.startsAt - now);
        if (p === 'running' && t.format === 'arena') return relative(arenaEndsAt(t) - now).replace('in ', '') + ' left';
        return 'Live now';
      };
      return `${head(title('Tournaments'), 'tournaments')}
        <div class="w-scroll">${data.tournaments.length ? data.tournaments.map((t) => {
          const p = phaseOf(t, now);
          const live = p === 'running' || p === 'ending';
          return `<button class="w-row w-tourn${live ? ' live' : ''}" data-tourn="${esc(t.id)}">
            <span class="w-row-body"><b>${esc(t.name)}</b>
            <small>${esc(brief(t))}. ${esc(FORMATS[t.format].name)}, ${tcLabel(t.tc)}</small></span>
            ${live ? '<span class="live-dot">Live</span>' : ''}
          </button>`;
        }).join('') : emptyRow('No tournaments scheduled.', ctx.isAdmin ? 'Create one' : null, 'tournaments')}</div>`;
    }

    case 'tip':
      return `<div class="w-tip">
        <span class="w-tip-ico">${svg('bulb')}</span>
        <div><h3 class="w-title">${esc(title('Tip of the day'))}</h3><p>${esc(TIPS[new Date().getDay() % TIPS.length])}</p></div>
      </div>`;

    case 'store-preview':
      return `${head(title('Store'), 'store', 'Browse')}
        <div class="w-scroll">${data.items.length ? data.items.map((it) => `
          <button class="w-row w-store" data-go="store">
            <span class="w-store-thumb">${it.imageBase64 ? `<img src="${esc(it.imageBase64)}" alt="">` : '🎁'}</span>
            <span class="w-row-body"><b>${esc(it.name)}</b></span>
            <small class="w-store-cost tabular">${it.pointCost} pts</small>
          </button>`).join('') : emptyRow('Nothing in the store yet.', ctx.isAdmin ? 'Add an item' : null, 'store')}</div>`;

    default:
      return '<div class="empty-state">This widget is no longer available.</div>';
  }
}

/* ── rendering ─────────────────────────────────────────────────────── */

/* Layouts saved before v2 used rows twice as tall, and widgets without an
   id or a known type are dropped rather than drawn as holes. */
function readLayout(club) {
  const raw = club.layout && club.layout.length ? club.layout : null;
  if (!raw) return DEFAULT_LAYOUT.map((w) => ({ ...w }));
  const scale = club.layoutV === LAYOUT_V ? 1 : 2;
  return raw
    .map((w) => ({ ...w, type: w.type === 'stat-points' ? 'quick-duel' : w.type }))
    .filter((w) => w.i && WIDGETS[w.type])
    .map((w) => ({
      ...w,
      y: w.y * scale,
      h: Math.max(WIDGETS[w.type].minH || 2, w.h * scale),
      w: Math.max(WIDGETS[w.type].minW || 2, Math.min(COLS, w.w))
    }));
}

/* Firestore will not store `undefined`, and a drag leaves bookkeeping on
   the items; what is saved is only what a layout is. */
const cleanLayout = (layout) => layout.map((w) => {
  const out = { i: w.i, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h };
  if (w.cfg && Object.keys(w.cfg).length) out.cfg = w.cfg;
  return out;
});

export async function renderDashboard(ctx, host) {
  const editing = ctx.isAdmin && ctx.editing;
  let layout = readLayout(ctx.club);

  ensureDuelsPage(ctx, layout);
  runPendingMove(ctx);

  host.classList.add('is-dash');
  host.innerHTML = `
    <div class="dash${editing ? ' editing' : ''}">
      ${editing ? `<div class="dash-add-row">
        <button class="btn primary" id="dash-add">${svg('plus')}Add a widget</button>
        <span class="dash-add-hint">Tip: click any widget to change what it says.</span>
      </div>` : ''}
      <div class="dash-canvas" id="dash-canvas">
        <div class="dash-skeleton"><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </div>`;

  const canvas = host.querySelector('#dash-canvas');
  let data;
  try { data = await loadData(ctx, layout); }
  catch (e) {
    console.error(e);
    canvas.innerHTML = '<div class="empty-state">The home page could not be loaded. Refresh to try again.</div>';
    return () => {};
  }

  const mediaIds = () => [...new Set(layout.filter((w) => w.cfg && w.cfg.media).map((w) => w.cfg.media))];
  data.media = await loadMedia(ctx, mediaIds());

  const stacked = () => window.innerWidth <= 900;
  let colW = 0;

  const box = (w) => ({
    left: w.x * (colW + GAP),
    top: w.y * UNIT,
    width: w.w * colW + (w.w - 1) * GAP,
    height: w.h * ROW + (w.h - 1) * GAP
  });

  const measure = () => { colW = (canvas.clientWidth - GAP * (COLS - 1)) / COLS; };

  /* Positions only — the widgets themselves are untouched, so nothing a
     member is reading or typing is thrown away. */
  const place = (skip) => {
    canvas.classList.toggle('stacked', stacked());
    if (stacked()) {
      canvas.style.height = '';
      // reading order on a phone is the order a desktop reader would scan
      layout.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach((w, n) => {
        const node = canvas.querySelector(`[data-i="${w.i}"]`);
        if (node) node.style.cssText = `order:${n};--h:${w.h}`;
      });
      return;
    }
    measure();
    layout.forEach((w) => {
      if (w.i === skip) return;
      const node = canvas.querySelector(`[data-i="${w.i}"]`);
      if (!node) return;
      const b = box(w);
      node.style.cssText = `transform:translate(${b.left}px,${b.top}px);width:${b.width}px;height:${b.height}px`;
    });
    const rows = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    canvas.style.height = Math.max(0, rows * UNIT - GAP + (editing ? UNIT * 3 : 0)) + 'px';
  };

  const nodeHTML = (w) => {
    const meta = WIDGETS[w.type] || { name: w.type };
    return `<section class="widget w-${esc(w.type)}" data-i="${esc(w.i)}">
        <div class="widget-body">${widgetHTML(w, ctx, data)}</div>
        ${editing ? `
          <div class="widget-shield" title="Drag to move. Click to edit."></div>
          <div class="widget-tools">
            <span class="widget-name">${esc(meta.name)}</span>
            <button data-edit title="Edit" aria-label="Edit ${esc(meta.name)}">${svg('gear')}</button>
            <button data-dup title="Duplicate" aria-label="Duplicate ${esc(meta.name)}">${svg('copy')}</button>
            <button data-del title="Remove" aria-label="Remove ${esc(meta.name)}">${svg('trash')}</button>
          </div>
          <span class="widget-resize se" data-resize="se" title="Drag to resize"></span>
          <span class="widget-resize e" data-resize="e"></span>
          <span class="widget-resize s" data-resize="s"></span>` : ''}
      </section>`;
  };

  const wireContent = (scope) => {
    scope.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => {
        const type = b.dataset.go;
        const target = (ctx.club.blocks || []).find((x) => x.type === type);
        if (target) { location.hash = target.id; return; }
        if (type === 'duels' || type === 'tournaments') { location.hash = type; return; }
        toast('That page hasn\'t been added to this club yet.');
      };
    });
    scope.querySelectorAll('[data-duel]').forEach((b) => {
      b.onclick = () => {
        setDuelIntent({ scope: b.dataset.duel });
        location.hash = duelsHash(ctx);
      };
    });
    scope.querySelectorAll('[data-tourn]').forEach((b) => {
      b.onclick = () => { location.hash = 'tournament/' + b.dataset.tourn; };
    });
  };

  const paint = () => {
    canvas.innerHTML = layout.map(nodeHTML).join('');
    wireContent(canvas);
    if (editing) canvas.querySelectorAll('.widget').forEach(wireEdit);
    place();
    tickCountdowns();
    requestAnimationFrame(() => canvas.classList.add('ready'));
  };

  /* Re-draws one widget's body after its settings change. */
  const repaintOne = (w) => {
    const node = canvas.querySelector(`[data-i="${w.i}"]`);
    if (!node) return;
    const t = document.createElement('div');
    t.innerHTML = nodeHTML(w);
    node.querySelector('.widget-body').replaceWith(t.firstElementChild.querySelector('.widget-body'));
    wireContent(node);
    tickCountdowns();
  };

  /* ── countdowns tick once a minute; nobody needs seconds ── */

  function tickCountdowns() {
    canvas.querySelectorAll('[data-countdown]').forEach((n) => {
      const ms = +n.dataset.countdown - Date.now();
      const num = n.querySelector('.w-count-num');
      const unit = n.querySelector('.w-count-unit');
      if (ms <= 0) { num.textContent = 'Today'; unit.textContent = ''; return; }
      const d = Math.floor(ms / 86400e3);
      const h = Math.floor(ms / 3600e3);
      if (d >= 1) { num.textContent = d; unit.textContent = d === 1 ? 'day to go' : 'days to go'; }
      else if (h >= 1) { num.textContent = h; unit.textContent = h === 1 ? 'hour to go' : 'hours to go'; }
      else { num.textContent = Math.max(1, Math.floor(ms / 60000)); unit.textContent = 'minutes to go'; }
    });
  }
  const tick = setInterval(tickCountdowns, 60000);

  /* ── saving: debounced, so a drag or a sentence is one write ── */

  let saveTimer = null;
  const persist = () => {
    const clean = cleanLayout(layout);
    ctx.club.layout = clean;
    ctx.club.layoutV = LAYOUT_V;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await updateDoc(clubRef(ctx.clubId), { layout: clean, layoutV: LAYOUT_V, layoutCustomized: true });
        ctx.club.layoutCustomized = true;
      } catch (e) { console.error(e); toast('Could not save the home page', 'error'); }
    }, 400);
  };

  /* ── editing: drag, resize, tools ── */

  function wireEdit(el) {
    const id = el.dataset.i;
    el.querySelector('[data-edit]').onclick = () => openSettings(id);
    el.querySelector('[data-dup]').onclick = () => duplicate(id);
    el.querySelector('[data-del]').onclick = () => removeWidget(id);

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.widget-tools')) return;
      const item = layout.find((w) => w.i === id);
      if (!item) return;
      if (stacked()) { openSettings(id); return; }
      const handle = e.target.closest('[data-resize]');
      const mode = handle ? handle.dataset.resize : 'move';

      e.preventDefault();
      measure();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...item };
      const startBox = box(item);
      const before = new Map(layout.map((o) => [o.i, o.y]));
      let moved = false;
      let ghost = null;

      el.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dxPx = ev.clientX - startX;
        const dyPx = ev.clientY - startY;
        if (!moved && Math.hypot(dxPx, dyPx) < 5) return;
        if (!moved) {
          moved = true;
          el.classList.add(mode === 'move' ? 'dragging' : 'resizing');
          canvas.classList.add('busy');
          ghost = document.createElement('div');
          ghost.className = 'dash-ghost';
          canvas.appendChild(ghost);
        }
        const meta = WIDGETS[item.type] || {};
        const dx = Math.round(dxPx / (colW + GAP));
        const dy = Math.round(dyPx / UNIT);

        if (mode === 'move') {
          item.x = Math.max(0, Math.min(COLS - item.w, start.x + dx));
          item.y = Math.max(0, start.y + dy);
          // the widget follows the pointer exactly; the grid underneath snaps
          el.style.transform = `translate(${startBox.left + dxPx}px,${startBox.top + dyPx}px)`;
        } else {
          if (mode !== 's') item.w = Math.max(meta.minW || 2, Math.min(COLS - item.x, start.w + dx));
          if (mode !== 'e') item.h = Math.max(meta.minH || 2, start.h + dy);
          if (mode !== 's') el.style.width = Math.max(colW * (meta.minW || 2), startBox.width + dxPx) + 'px';
          if (mode !== 'e') el.style.height = Math.max(ROW * (meta.minH || 2), startBox.height + dyPx) + 'px';
        }
        /* Everyone else starts from where they were when the drag began, so
           a widget nudged aside slides back once the drag moves on. */
        layout.forEach((o) => { if (o !== item) o.y = before.get(o.i); });
        resolve(layout, item);
        compact(layout, item);
        place(item.i);
        const b = box(item);
        ghost.style.cssText = `transform:translate(${b.left}px,${b.top}px);width:${b.width}px;height:${b.height}px`;
      };

      const up = () => {
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        canvas.classList.remove('busy');
        if (ghost) ghost.remove();
        el.classList.remove('dragging', 'resizing');
        if (!moved) {
          if (mode === 'move') openSettings(id);   // a click, not a drag
          return;
        }
        compact(layout);
        place();
        persist();
      };

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  function addWidget(type, cfg) {
    const meta = WIDGETS[type];
    const spot = firstFit(layout, meta.w, meta.h);
    const w = { i: 'w' + Date.now().toString(36), type, x: spot.x, y: spot.y, w: meta.w, h: meta.h };
    if (cfg) w.cfg = cfg;
    layout.push(w);
    compact(layout);
    paint();
    persist();
    const node = canvas.querySelector(`[data-i="${w.i}"]`);
    if (node) {
      node.classList.add('just-added');
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (meta.settings) setTimeout(() => openSettings(w.i), 280);
    else toast(meta.name + ' added', 'ok');
  }

  function duplicate(i) {
    const src = layout.find((w) => w.i === i);
    if (src) addWidget(src.type, src.cfg ? JSON.parse(JSON.stringify(src.cfg)) : undefined);
  }

  function removeWidget(i) {
    const w = layout.find((x) => x.i === i);
    if (!w) return;
    closeSettings();
    layout = layout.filter((x) => x.i !== i);
    compact(layout);
    paint();
    persist();
    undoToast(`${(WIDGETS[w.type] || {}).name || 'Widget'} removed`, () => {
      layout.push(w);
      resolve(layout, w);
      compact(layout);
      paint();
      persist();
    });
  }

  /* ── the settings drawer ── */

  let drawer = null;

  function closeSettings() {
    if (!drawer) return;
    drawer.remove();
    drawer = null;
    canvas.querySelectorAll('.widget.selected').forEach((n) => n.classList.remove('selected'));
  }

  function openSettings(i) {
    closeSettings();
    const w = layout.find((x) => x.i === i);
    if (!w) return;
    const meta = WIDGETS[w.type];
    const cfg = w.cfg || (w.cfg = {});
    const has = (k) => (meta.settings || []).includes(k);
    const media = cfg.media && data.media[cfg.media];
    canvas.querySelector(`[data-i="${i}"]`)?.classList.add('selected');

    drawer = document.createElement('aside');
    drawer.className = 'dash-drawer';
    drawer.setAttribute('aria-label', meta.name + ' settings');
    drawer.innerHTML = `
      <div class="dash-drawer-head">
        <span class="dash-drawer-ico">${svg(meta.icon)}</span>
        <div><b>${esc(meta.name)}</b><small>${esc(meta.desc)}</small></div>
        <button class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="dash-drawer-body">
        ${has('image') ? `
          <div class="field">
            <label>Picture</label>
            <button class="img-drop${media ? ' has' : ''}" data-drop type="button">
              ${media ? `<img src="${media.data}" alt="">` : `${svg('image')}<b>Upload a picture</b><small>Drop it here or click. Big photos are shrunk for you.</small>`}
            </button>
            <input type="file" accept="image/*" data-file hidden>
            ${media ? '<button class="btn subtle sm" data-pick type="button">Replace picture</button>' : ''}
          </div>
          <div class="field">
            <label>How it fits</label>
            <div class="seg" data-fit>
              <button class="seg-btn${cfg.fit !== 'cover' ? ' on' : ''}" data-v="contain" type="button">Show all of it</button>
              <button class="seg-btn${cfg.fit === 'cover' ? ' on' : ''}" data-v="cover" type="button">Fill the space</button>
            </div>
            <small class="field-hint">${cfg.fit === 'cover'
              ? 'The edges may be trimmed. Drag the dot to choose what stays in view.'
              : 'The whole picture shows, with a soft blur filling any gap around it.'}</small>
          </div>
          ${cfg.fit === 'cover' && media ? `
          <div class="field">
            <label>Focus point</label>
            <div class="focal" data-focal><img src="${media.data}" alt=""><i style="left:${cfg.px ?? 50}%;top:${cfg.py ?? 50}%"></i></div>
          </div>` : ''}
          <div class="field">
            <label for="ws-cap">What it shows</label>
            <input id="ws-cap" data-k="caption" value="${esc(cfg.caption || '')}" placeholder="Our team at the state championship" maxlength="120">
            <small class="field-hint">Read aloud to people using a screen reader.</small>
          </div>` : `
          <div class="field">
            <label for="ws-title">Title</label>
            <input id="ws-title" data-k="title" value="${esc(cfg.title || '')}" placeholder="${esc(defaultTitle(w.type))}" maxlength="80">
          </div>`}
        ${has('emoji') ? `<div class="field"><label for="ws-emoji">Emoji</label>
          <input id="ws-emoji" data-k="emoji" value="${esc(cfg.emoji || '')}" placeholder="📣" maxlength="4" class="emoji-input"></div>` : ''}
        ${has('body') ? `<div class="field"><label for="ws-body">Text</label>
          <textarea id="ws-body" data-k="body" rows="6" placeholder="Write here. **Bold** and links work.">${esc(cfg.body || '')}</textarea></div>` : ''}
        ${has('desc') ? `<div class="field"><label for="ws-desc">Short description</label>
          <input id="ws-desc" data-k="desc" value="${esc(cfg.desc || '')}" placeholder="Sign up for Saturday's tournament" maxlength="90"></div>` : ''}
        ${has('url') || has('button') || has('link') ? `<div class="field"><label for="ws-url">Link${has('link') ? ' (optional)' : ''}</label>
          <input id="ws-url" data-k="url" value="${esc(cfg.url || '')}" placeholder="https://forms.gle/…" inputmode="url"></div>` : ''}
        ${has('button') ? `<div class="field"><label for="ws-btn">Button text</label>
          <input id="ws-btn" data-k="button" value="${esc(cfg.button || '')}" placeholder="Sign up" maxlength="30"></div>` : ''}
        ${has('date') ? `<div class="field"><label for="ws-date">Count down to</label>
          <input id="ws-date" type="datetime-local" data-k="date" value="${esc(cfg.date || '')}">
          <small class="field-hint">Leave it empty to count down to the next event on the calendar.</small></div>` : ''}
        ${has('video') ? `<div class="field"><label for="ws-video">YouTube link</label>
          <input id="ws-video" data-k="url" value="${esc(cfg.url || '')}" placeholder="https://youtu.be/…" inputmode="url"></div>` : ''}
        ${has('color') ? `<div class="field"><label>Colour</label>
          <div class="tone-pick" data-tones>${Object.entries(TONES).map(([k, label]) =>
            `<button type="button" class="tone-dot tone-${k}${(cfg.color || defaultTone(w.type)) === k ? ' on' : ''}" data-tone="${k}" title="${label}" aria-label="${label}"></button>`).join('')}</div></div>` : ''}
      </div>
      <div class="dash-drawer-foot">
        <button class="btn ghost sm" data-remove>${svg('trash')}Remove</button>
        <div class="spacer"></div>
        <button class="btn primary" data-close>Done</button>
      </div>`;
    document.body.appendChild(drawer);
    requestAnimationFrame(() => drawer && drawer.classList.add('open'));

    const update = () => { repaintOne(w); persist(); };

    drawer.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSettings));
    drawer.querySelector('[data-remove]').onclick = () => removeWidget(w.i);
    drawer.querySelectorAll('[data-k]').forEach((inp) => {
      inp.oninput = () => {
        if (inp.value.trim()) cfg[inp.dataset.k] = inp.value;
        else delete cfg[inp.dataset.k];
        update();
      };
    });
    const tones = drawer.querySelector('[data-tones]');
    if (tones) tones.onclick = (e) => {
      const b = e.target.closest('[data-tone]');
      if (!b) return;
      cfg.color = b.dataset.tone;
      tones.querySelectorAll('.tone-dot').forEach((d) => d.classList.toggle('on', d === b));
      update();
    };
    const fit = drawer.querySelector('[data-fit]');
    if (fit) fit.onclick = (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      cfg.fit = b.dataset.v;
      update();
      openSettings(w.i);     // the focus picker comes or goes with the mode
    };
    const focal = drawer.querySelector('[data-focal]');
    if (focal) {
      const setFocal = (ev) => {
        const r = focal.getBoundingClientRect();
        cfg.px = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 100);
        cfg.py = Math.round(Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) * 100);
        const dot = focal.querySelector('i');
        dot.style.left = cfg.px + '%';
        dot.style.top = cfg.py + '%';
        const img = canvas.querySelector(`[data-i="${w.i}"] .w-banner-img`);
        if (img) img.style.objectPosition = `${cfg.px}% ${cfg.py}%`;
      };
      focal.onpointerdown = (ev) => {
        focal.setPointerCapture(ev.pointerId);
        setFocal(ev);
        focal.onpointermove = setFocal;
        focal.onpointerup = () => { focal.onpointermove = null; persist(); };
      };
    }
    const fileInput = drawer.querySelector('[data-file]');
    if (fileInput) {
      const drop = drawer.querySelector('[data-drop]');
      const pick = () => fileInput.click();
      drop.onclick = pick;
      drawer.querySelector('[data-pick]')?.addEventListener('click', pick);
      drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (ev) => {
        ev.preventDefault();
        drop.classList.remove('over');
        if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]);
      };
      fileInput.onchange = () => { if (fileInput.files[0]) upload(fileInput.files[0]); };
    }

    async function upload(file) {
      const drop = drawer && drawer.querySelector('[data-drop]');
      if (drop) drop.classList.add('loading');
      try {
        const shrunk = await shrinkImage(file);
        const mid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const rec = { data: shrunk.data, w: shrunk.w, h: shrunk.h, createdAt: Date.now(), by: ctx.user.uid };
        await setDoc(clubDoc(ctx.clubId, 'media', mid), rec);
        mediaCache.set(mid, rec);
        data.media[mid] = rec;
        cfg.media = mid;
        if (!cfg.fit) cfg.fit = 'contain';
        update();
        openSettings(w.i);
        toast('Picture added', 'ok');
      } catch (e) {
        console.error(e);
        toast(e.code === 'permission-denied'
          ? 'Pictures need the latest database rules. Ask whoever deploys the site to publish them.'
          : (e.message || 'Could not upload that picture'), 'error');
        if (drop) drop.classList.remove('loading');
      }
    }
  }

  /* ── the gallery ── */

  function openGallery() {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card dash-gallery">
        <button class="icon-btn modal-close" data-x aria-label="Close">✕</button>
        <h3>Add a widget</h3>
        <p class="modal-meta" style="margin:0">It goes in the first open spot. Drag it anywhere afterwards.</p>
        ${GROUPS.map((g) => `
          <div class="gallery-group">
            <h4>${esc(g)}</h4>
            <div class="gallery-grid">
              ${Object.entries(WIDGETS).filter(([, m]) => m.group === g).map(([type, m]) => `
                <button class="gallery-item" data-w="${type}">
                  <span class="gallery-ico">${svg(m.icon)}</span>
                  <span><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span>
                </button>`).join('')}
            </div>
          </div>`).join('')}
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('[data-x]').onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    wrap.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { close(); addWidget(b.dataset.w); }));
  }

  if (editing) host.querySelector('#dash-add').onclick = openGallery;

  const onKey = (e) => { if (e.key === 'Escape' && drawer) closeSettings(); };
  document.addEventListener('keydown', onKey);

  paint();

  let raf = 0;
  const onResize = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => place());
  };
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(canvas);

  return () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    ro.disconnect();
    clearInterval(tick);
    closeSettings();
    host.classList.remove('is-dash');
  };
}

const defaultTitle = (type) => ({
  welcome: 'Good afternoon, Alex', announcement: 'Tournament this Saturday', text: 'Club rules',
  link: 'Join the group chat', countdown: 'Countdown', video: 'This week\'s lesson',
  'events-next': 'Coming up', 'news-latest': 'Latest news', leaderboard: 'Leaderboard',
  tournaments: 'Tournaments', 'quick-duel': 'Play a game', 'puzzle-daily': 'Puzzle of the day',
  tip: 'Tip of the day', 'store-preview': 'Store', 'stat-members': 'Members', 'club-stats': 'Club stats'
}[type] || '');

const defaultTone = (type) => ({ announcement: 'green', link: 'blue', countdown: 'felt' }[type] || 'green');

/* ── a toast with an undo button ───────────────────────────────────── */

function undoToast(message, onUndo) {
  let hostEl = document.querySelector('.toast-host');
  if (!hostEl) {
    hostEl = document.createElement('div');
    hostEl.className = 'toast-host';
    document.body.appendChild(hostEl);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span><button class="toast-undo">Undo</button>`;
  hostEl.appendChild(el);
  const done = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  el.querySelector('.toast-undo').onclick = () => { onUndo(); done(); };
  setTimeout(done, 5000);
}

/* ── pictures: shrunk before they are stored ───────────────────────── */

/* Firestore caps a document at a megabyte, and a phone photo is several.
   The picture is scaled to at most 1600px on its long side and re-encoded,
   stepping size and quality down until it fits comfortably. */
async function shrinkImage(file) {
  if (!/^image\//.test(file.type)) throw new Error('That file isn\'t a picture.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That picture could not be opened.'));
      i.src = url;
    });
    const LIMIT = 700 * 1024;
    for (const max of [1600, 1280, 1000, 800]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      for (const q of [0.86, 0.76, 0.66]) {
        const out = c.toDataURL('image/jpeg', q);
        if (out.length < LIMIT) return { data: out, w, h };
      }
    }
    throw new Error('That picture is too detailed to store. Try a smaller one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── pages the widgets point at ────────────────────────────────────
   The quick-game and tournament widgets have to land somewhere, so a club
   that shows one and has no page for it gets the page. Only an admin may
   write the club document, so for everyone else the page still answers on
   its standalone route.
   ─────────────────────────────────────────────────────────────────── */

let addingPage = false;

const WIDGET_NEEDS = {
  'quick-duel': { id: 'duels', type: 'duels', name: 'Play' },
  tournaments: { id: 'tournaments', type: 'tournaments', name: 'Tournaments' }
};

async function ensureDuelsPage(ctx, layout) {
  if (addingPage || !ctx.isAdmin) return;
  const blocks = (ctx.club.blocks || []).slice();
  const wanted = Object.entries(WIDGET_NEEDS)
    .filter(([widget]) => layout.some((w) => w.type === widget))
    .map(([, block]) => block)
    .filter((block) => !blocks.some((b) => b.type === block.type));
  if (!wanted.length) return;

  addingPage = true;
  try {
    wanted.forEach((b) => blocks.push(b));
    await updateDoc(clubRef(ctx.clubId), { blocks });
    ctx.club.blocks = blocks;
  } catch (e) {
    console.warn('Could not add a page the home page needs', e);
  } finally {
    addingPage = false;
  }
}

/* ── an unfinished move finishes itself ────────────────────────────
   If an admin lands here before a copy from the old single-club site
   completed (a closed tab, a dropped connection), it resumes silently.
   Merge-only, so re-running costs nothing. Never surfaced as a choice.
   ─────────────────────────────────────────────────────────────────── */

let moveRunning = false;

async function runPendingMove(ctx) {
  if (moveRunning || !ctx.isAdmin) return;
  if (!ctx.club.legacySource || ctx.club.legacyImported) return;
  moveRunning = true;
  try {
    const { importLegacy } = await import('./club-import.js');
    const result = await importLegacy(ctx.clubId, () => {});
    ctx.club.legacyImported = true;
    if (result.skipped) return;
    toast(`Finished moving ${result.total} records across`, 'ok');
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    console.error('Resume of the club move failed:', e);
  } finally {
    moveRunning = false;
  }
}
