/* ═══════════════════════════════════════════════════════════════════════
   club-dash.js — the club dashboard: a 12-column widget grid that admins
   can rearrange in editor mode.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, clubRef, clubCol, updateDoc, getDocs, query, orderBy, limit,
  esc, fmtDate, fmtTime, toast
} from './club-core.js';

import { displayRating } from './glicko2.js';
import { loadMyRatings, setDuelIntent, duelsHash } from './club-duels.js';

const COLS = 12;
const ROW = 84;
const GAP = 16;
const MIN_ROW = 46;

/* ── layout maths ──────────────────────────────────────────────────── */

const hit = (a, b) =>
  a.i !== b.i && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/* The dragged widget always wins its cell; everything it lands on is pushed
   down, and cascading overlaps are settled the same way. */
function resolve(layout, moved) {
  let guard = 0;
  let changed = true;
  while (changed && guard++ < 80) {
    changed = false;
    const others = layout.filter((w) => w.i !== moved.i).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const o of others) {
      if (hit(moved, o)) { o.y = moved.y + moved.h; changed = true; }
    }
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        if (hit(others[i], others[j])) {
          others[j].y = others[i].y + others[i].h;
          changed = true;
        }
      }
    }
  }
}

/* Pull everything as far up as it will go so the grid never grows gaps. */
function compact(layout) {
  const order = layout.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = [];
  for (const it of order) {
    while (it.y > 0) {
      const test = { ...it, y: it.y - 1 };
      if (placed.some((p) => hit(test, p))) break;
      it.y--;
    }
    placed.push(it);
  }
}

/* Eight rows deep on purpose: the whole thing has to land on one screen. */
const DEFAULT_LAYOUT = [
  { i: 'w1', type: 'welcome',      x: 0, y: 0, w: 8, h: 3 },
  { i: 'w2', type: 'quick-duel',   x: 8, y: 0, w: 4, h: 3 },
  { i: 'w3', type: 'events-next',  x: 0, y: 3, w: 5, h: 5 },
  { i: 'w4', type: 'leaderboard',  x: 5, y: 3, w: 4, h: 5 },
  { i: 'w5', type: 'puzzle-daily', x: 9, y: 3, w: 3, h: 2 },
  { i: 'w6', type: 'news-latest',  x: 9, y: 5, w: 3, h: 3 }
];

const TIPS = [
  'Control the centre — pieces and pawns in the centre dominate the board.',
  'Develop every piece once before moving any piece twice.',
  'Castle early to protect your king and connect your rooks.',
  'A knight on the rim is dim. Centralise your knights.',
  'When ahead in material, trade pieces to simplify.',
  'Always ask: what is my opponent threatening?',
  'Rooks belong on open files — connect and double them.'
];

/* ── widget catalogue ──────────────────────────────────────────────── */

export const WIDGETS = {
  welcome:      { name: 'Welcome banner', desc: 'Greeting and a call to action', w: 8, h: 3, minW: 4, minH: 2 },
  'quick-duel': { name: 'Quick duel',     desc: 'Your ratings and a way straight into a 1v1', w: 4, h: 3, minW: 3, minH: 3 },
  'stat-members':{name: 'Member count',   desc: 'How many people are in the club', w: 3, h: 2, minW: 2, minH: 2 },
  'events-next':{ name: 'Upcoming events',desc: 'The next few things on the calendar', w: 7, h: 5, minW: 4, minH: 3 },
  leaderboard:  { name: 'Leaderboard',    desc: 'Top players by points', w: 5, h: 5, minW: 3, minH: 3 },
  'news-latest':{ name: 'Latest news',    desc: 'Most recent announcements', w: 4, h: 3, minW: 3, minH: 2 },
  'puzzle-daily':{name: 'Daily puzzle',   desc: 'Shortcut into the newest puzzle', w: 4, h: 3, minW: 3, minH: 2 },
  tip:          { name: 'Tip of the day', desc: 'A rotating chess tip', w: 4, h: 3, minW: 3, minH: 2 },
  'store-preview':{name: 'Store preview', desc: 'A few items members can spend points on', w: 4, h: 4, minW: 3, minH: 3 }
};

/* ── data ──────────────────────────────────────────────────────────── */

async function loadData(ctx) {
  const id = ctx.clubId;
  const safe = async (p, fallback) => { try { return await p; } catch (e) { console.warn(e); return fallback; } };

  const [events, members, news, puzzles, items] = await Promise.all([
    safe(getDocs(query(clubCol(id, 'events'), orderBy('date', 'asc'))), { docs: [] }),
    safe(getDocs(query(clubCol(id, 'members'), orderBy('points', 'desc'), limit(20))), { docs: [] }),
    safe(getDocs(query(clubCol(id, 'announcements'), orderBy('createdAt', 'desc'), limit(4))), { docs: [] }),
    safe(getDocs(query(clubCol(id, 'puzzles'), orderBy('createdAt', 'desc'), limit(1))), { docs: [] }),
    safe(getDocs(query(clubCol(id, 'shopItems'), limit(4))), { docs: [] })
  ]);

  const map = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const now = Date.now();
  const staffHidden = ctx.club.hideStaffFromLeaderboard === true;
  const isStaffRole = (r) => r === 'admin' || r === 'founder';
  return {
    events: map(events).filter((e) => e.date >= now - 3 * 3600e3).slice(0, 6),
    members: map(members).filter((m) => !(staffHidden && isStaffRole(m.role))).slice(0, 8),
    news: map(news),
    puzzle: map(puzzles)[0] || null,
    items: map(items),
    ratings: await loadMyRatings(ctx)
  };
}

/* ── widget bodies ─────────────────────────────────────────────────── */

function widgetHTML(type, ctx, data) {
  const me = ctx.member;

  switch (type) {
    case 'welcome': {
      const h = new Date().getHours();
      const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
      return `<div class="w-welcome">
        <div class="w-welcome-eyebrow">${esc(ctx.club.name || 'Your club')}</div>
        <div class="w-welcome-title">${greet}, ${esc((me.username || '').split(' ')[0] || 'player')}.</div>
        <div class="w-welcome-sub">${esc(ctx.club.description || 'Everything your club is doing, in one place.')}</div>
        <div class="w-welcome-cta">
          ${data.puzzle ? '<button class="btn" data-go="puzzles">Solve the puzzle</button>' : ''}
          <button class="btn on-hero-ghost" data-go="events">View calendar</button>
        </div>
        <div class="w-welcome-art" aria-hidden="true"></div>
      </div>`;
    }

    case 'quick-duel': {
      const club = data.ratings.club;
      const glob = data.ratings.global;
      const num = (r) =>
        `<span class="w-duel-num${r.games < 1 ? ' prov' : ''}">${displayRating(r)}</span>`;
      return `<div class="w-duel">
        <div class="w-duel-head">
          <span class="w-duel-title">Quick duel</span>
          <span class="duel-pill">JagChess rating</span>
        </div>
        <div class="w-duel-ratings">
          <div class="w-duel-rating">${num(club)}<span class="w-duel-tag">Club</span></div>
          <div class="w-duel-rating">${num(glob)}<span class="w-duel-tag">Global</span></div>
        </div>
        <div class="w-duel-btns">
          <button class="btn primary sm" data-duel="club">Play in the club</button>
          <button class="btn blue sm" data-duel="global">Play globally</button>
        </div>
      </div>`;
    }

    case 'stat-members':
      return `<div class="w-single">
        <div class="w-single-num">${ctx.club.memberCount || data.members.length || 1}</div>
        <div class="w-single-label">Members</div>
      </div>`;

    case 'events-next':
      return `<div class="w-head"><span class="dash-heading">Upcoming events</span>
          <button class="dash-link" data-go="events">View all →</button></div>
        <div class="w-scroll">${data.events.length ? data.events.map((e) => `
          <div class="dash-ev-row">
            <div class="dash-ev-date">
              <div class="dash-ev-day">${new Date(e.date).getDate()}</div>
              <div class="dash-ev-mon">${new Date(e.date).toLocaleString(undefined, { month: 'short' })}</div>
            </div>
            <div class="dash-ev-info">
              <div class="dash-ev-title">${esc(e.title)}</div>
              <div class="dash-ev-sub">
                <span class="dash-ev-time">${fmtTime(e.date)}</span>
                <span class="tag-badge tag-${esc(e.tag || 'classic')}">${esc(e.tag || 'classic')}</span>
              </div>
            </div>
          </div>`).join('') : '<div class="empty-state">Nothing scheduled yet.</div>'}</div>`;

    case 'leaderboard':
      return `<div class="w-head"><span class="dash-heading">Leaderboard</span>
          <button class="dash-link" data-go="leaderboard">Full board →</button></div>
        <div class="w-scroll">${data.members.length ? data.members.slice(0, 6).map((m, i) => `
          <div class="dash-leader-row">
            <div class="dash-leader-rank${i === 0 ? ' top' : ''}">${i + 1}</div>
            <span class="lb-avatar" style="background:${esc(m.avatarColor || '#1cb0f6')};width:30px;height:30px;font-size:11px">${esc((m.username || '?').slice(0, 2).toUpperCase())}</span>
            <div class="dash-leader-name">${esc(m.username || 'Player')}${m.uid === ctx.user.uid ? ' <span class="lb-me-badge">You</span>' : ''}</div>
            <div class="dash-leader-pts">${m.points || 0}</div>
          </div>`).join('') : '<div class="empty-state">No points scored yet.</div>'}</div>`;

    case 'news-latest':
      return `<div class="w-head"><span class="dash-heading">Latest news</span>
          <button class="dash-link" data-go="newsletters">See all →</button></div>
        <div class="w-scroll">${data.news.length ? data.news.map((n) => `
          <div class="dash-news-row">
            <div class="dash-news-title">${esc(n.title)}</div>
            <div class="dash-news-date">${fmtDate(n.createdAt, { month: 'short', day: 'numeric' })}</div>
          </div>`).join('') : '<div class="empty-state">No announcements yet.</div>'}</div>`;

    case 'puzzle-daily':
      return `<div class="w-cta">
        <span class="w-cta-ico">♟</span>
        <div class="w-cta-body">
          <div class="w-cta-title">${data.puzzle ? esc(data.puzzle.title || 'Daily puzzle') : 'No puzzle yet'}</div>
          <div class="w-cta-sub">${data.puzzle ? (data.puzzle.points || 10) + ' points on the line' : 'Admins can publish one from the Puzzles block.'}</div>
        </div>
        ${data.puzzle ? '<button class="btn primary sm" data-go="puzzles">Solve</button>' : ''}
      </div>`;

    case 'tip':
      return `<div class="w-head"><span class="dash-heading">Tip of the day</span></div>
        <div class="w-tip">${esc(TIPS[new Date().getDay() % TIPS.length])}</div>`;

    case 'store-preview':
      return `<div class="w-head"><span class="dash-heading">Store</span>
          <button class="dash-link" data-go="store">Browse →</button></div>
        <div class="w-scroll">${data.items.length ? data.items.map((it) => `
          <div class="w-store-row">
            <span class="w-store-thumb">${it.imageBase64 ? `<img src="${esc(it.imageBase64)}" alt="">` : '🎁'}</span>
            <span class="w-store-name">${esc(it.name)}</span>
            <b class="w-store-cost">${it.pointCost} pts</b>
          </div>`).join('') : '<div class="empty-state">No items in the store.</div>'}</div>`;

    default:
      return '<div class="empty-state">Unknown widget</div>';
  }
}

/* ── render ────────────────────────────────────────────────────────── */

export async function renderDashboard(ctx, host, api) {
  const editing = ctx.mode === 'editor' && ctx.isAdmin;
  let layout = (ctx.club.layout && ctx.club.layout.length ? ctx.club.layout : DEFAULT_LAYOUT)
    // points and streak moved to the header, so the tile they used to occupy
    // becomes the quick-duel panel on layouts saved before that change
    .map((w) => ({ ...w, type: w.type === 'stat-points' ? 'quick-duel' : w.type }));

  ensureDuelsPage(ctx, layout);

  host.classList.add('is-dash');   // trims the page padding so the grid can fill the screen
  host.innerHTML = `
    <div class="grid-wrap${editing ? ' editing' : ''}">
      <div class="dash-grid" id="dash-grid"></div>
      ${editing ? '<button class="grid-add" id="grid-add">＋ Add widget</button>' : ''}
    </div>`;

  runPendingMove(ctx);

  const grid = host.querySelector('#dash-grid');
  const data = await loadData(ctx);
  let rowH = ROW;

  const rowCount = () => layout.reduce((m, w) => Math.max(m, w.y + w.h), 0) || 1;

  /* The whole dashboard is sized to the viewport: rows shrink or grow so the
     layout fits without scrolling, whatever the screen height. */
  const fit = () => {
    if (window.innerWidth <= 900) { grid.style.gridAutoRows = ''; return; }
    const r = rowCount();
    const top = grid.getBoundingClientRect().top;
    const reserve = editing ? 88 : 0;      // room for the add-widget button
    const avail = window.innerHeight - top - 22 - reserve;
    rowH = Math.max(MIN_ROW, (avail - GAP * (r - 1)) / r);
    grid.style.gridAutoRows = rowH.toFixed(2) + 'px';
  };

  /* Move existing nodes instead of re-rendering, so a drag is never interrupted. */
  const place = () => {
    layout.forEach((w) => {
      const n = grid.querySelector('[data-i="' + w.i + '"]');
      if (!n) return;
      n.style.gridColumn = `${w.x + 1}/span ${w.w}`;
      n.style.gridRow = `${w.y + 1}/span ${w.h}`;
    });
    fit();
  };

  const paint = () => {
    grid.style.gridTemplateColumns = `repeat(${COLS}, minmax(0, 1fr))`;
    grid.style.gap = GAP + 'px';
    grid.innerHTML = layout.map((w) => {
      const meta = WIDGETS[w.type] || { name: w.type };
      return `<section class="tile widget" data-i="${esc(w.i)}"
          style="grid-column:${w.x + 1}/span ${w.w};grid-row:${w.y + 1}/span ${w.h}">
          ${editing ? `<div class="widget-chrome">
              <span class="widget-tag">${esc(meta.name)}</span>
              <button class="widget-del" data-del="${esc(w.i)}" title="Remove widget">✕</button>
            </div>` : ''}
          <div class="widget-body">${widgetHTML(w.type, ctx, data)}</div>
          ${editing ? '<span class="widget-resize" data-resize></span>' : ''}
        </section>`;
    }).join('');

    grid.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => {
        const target = (ctx.club.blocks || []).find((x) => x.type === b.dataset.go);
        if (target) location.hash = target.id;
        else toast('That block hasn\'t been added to this club yet.');
      };
    });

    grid.querySelectorAll('[data-duel]').forEach((b) => {
      b.onclick = () => {
        setDuelIntent({ scope: b.dataset.duel });
        location.hash = duelsHash(ctx);
      };
    });

    if (editing) {
      grid.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => removeWidget(b.dataset.del)));
      grid.querySelectorAll('.widget').forEach(wireDrag);
    }
    fit();
  };

  const persist = async () => {
    ctx.club.layout = layout;
    try { await updateDoc(clubRef(ctx.clubId), { layout }); }
    catch (e) { console.error(e); toast('Could not save the layout', 'error'); }
  };

  function wireDrag(el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const item = layout.find((w) => w.i === el.dataset.i);
      if (!item) return;

      const resizing = !!e.target.closest('[data-resize]');
      if (!resizing && e.target.closest('button, a, input, textarea, select')) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...item };
      const cellW = (grid.clientWidth - GAP * (COLS - 1)) / COLS;
      const cellH = rowH;
      el.setPointerCapture(e.pointerId);
      el.classList.add(resizing ? 'resizing' : 'dragging');

      const move = (ev) => {
        const dx = Math.round((ev.clientX - startX) / (cellW + GAP));
        const dy = Math.round((ev.clientY - startY) / (cellH + GAP));
        const meta = WIDGETS[item.type] || {};

        if (resizing) {
          item.w = Math.max(meta.minW || 2, Math.min(COLS - item.x, start.w + dx));
          item.h = Math.max(meta.minH || 2, start.h + dy);
        } else {
          item.x = Math.max(0, Math.min(COLS - item.w, start.x + dx));
          item.y = Math.max(0, start.y + dy);
        }

        resolve(layout, item);
        place();
      };

      const up = () => {
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        el.classList.remove('dragging', 'resizing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        compact(layout);
        place();
        persist();
      };

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  async function removeWidget(i) {
    layout = layout.filter((w) => w.i !== i);
    compact(layout);
    paint();
    await persist();
  }

  if (editing) {
    host.querySelector('#grid-add').onclick = () => openWidgetPicker(async (type) => {
      const meta = WIDGETS[type];
      const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0);
      layout.push({ i: 'w' + Date.now().toString(36), type, x: 0, y: maxY, w: meta.w, h: meta.h });
      compact(layout);
      paint();
      await persist();
      toast(meta.name + ' added');
    });
  }

  paint();

  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
    host.classList.remove('is-dash');
  };
}

/* ── the duels page follows the quick-duel widget ──────────────────
   The widget's buttons have to land somewhere, so a club that shows it and
   has no Duels page gets one. Only an admin may write the club document, so
   for everyone else the page still answers on its standalone route — the
   sidebar entry just appears the next time an admin opens the dashboard.
   ─────────────────────────────────────────────────────────────────── */

let addingDuels = false;

async function ensureDuelsPage(ctx, layout) {
  if (addingDuels || !ctx.isAdmin) return;
  if (!layout.some((w) => w.type === 'quick-duel')) return;
  const blocks = (ctx.club.blocks || []).slice();
  if (blocks.some((b) => b.type === 'duels')) return;

  addingDuels = true;
  try {
    blocks.push({ id: 'duels', type: 'duels', name: 'Duels' });
    await updateDoc(clubRef(ctx.clubId), { blocks });
    ctx.club.blocks = blocks;
  } catch (e) {
    console.warn('Could not add the Duels page', e);
  } finally {
    addingDuels = false;
  }
}

/* ── widget picker ─────────────────────────────────────────────────── */

function openWidgetPicker(onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal-card block-picker">
      <button class="icon-btn modal-close" data-x title="Close">✕</button>
      <h3>Add a widget</h3>
      <p class="modal-meta" style="margin:0">Widgets only live on the dashboard. Drag them around once they're placed.</p>
      <div class="block-list">
        ${Object.entries(WIDGETS).map(([type, m]) => `
          <button class="block-opt" data-w="${type}">
            <span class="block-opt-icon" style="background:var(--surface-2)">▦</span>
            <span class="block-opt-body"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span>
            <span class="block-opt-add">+</span>
          </button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-x]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { close(); onPick(b.dataset.w); }));
}

/* ── unfinished move finishes itself ───────────────────────────────
   If an admin lands here before the copy completed (a closed tab, a
   dropped connection), it resumes silently. Merge-only, so re-running
   costs nothing. Never surfaced as a choice.
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
    toast(`Finished moving ${result.total} records across`, 'ok');
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    console.error('Resume of the club move failed:', e);
  } finally {
    moveRunning = false;
  }
}
