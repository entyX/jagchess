/* ═══════════════════════════════════════════════════════════════════════
   profile-card.js — the card that opens when you press anybody's name, and
   the Account settings where you dress your own.

     installProfileCards(ctx)   once per page: any [data-profile="<uid>"]
                                anywhere opens that person's card
     openProfileCard(ctx, uid)  the card itself
     openAccountSettings(ctx)   lichess link, outside ratings, card style

   What a card says, and where each number comes from:

     ranked        trophies and place on the ranked board   (ranked.js)
     club points   the member row, ranked within the club
     club rating   the member row's Glicko, ranked within the club
     global        the user profile's Glicko, ranked site-wide
     outside       chess.com, lichess, USCF, FIDE, NWSRS — typed in by the
                   player, except lichess, which is read live from lichess
                   when they have connected their account

   A rating box the player has left empty is simply not drawn. A card is
   theirs to style; the ranked flair is not — it is earned on the board, and
   the best place anyone has ever reached unlocks the rarer styles for good.

     users/{uid}.card         { theme, pattern, emblem, tagline }
     users/{uid}.extRatings   { chesscom, uscf, fide, nwchess, lichess }
     users/{uid}.rankedBest   the best ranked place ever reached
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDoc, getDocs, setDoc, query, limit, clubCol,
  esc, initials, toast, fmtDate, ROLE_LABEL
} from './club-core.js';

import { readRating, displayRating } from './glicko2.js';
import { readRecord, setDuelIntent, duelsHash } from './club-duels.js';
import { loadRanked, lastRanked, tierOf, TIER_NAME, trophyText, TROPHY_SVG, CROWN_SVG, LINK_SVG } from './ranked.js';
import { session, connect, disconnect, onAuthChange } from './lichess-auth.js';
import { linkAccount, unlinkAccount, readAccount } from './lichess-store.js';
import { publicUser } from './lichess-api.js';

/* ── the wardrobe ──────────────────────────────────────────────────── */

export const THEMES = [
  { id: 'classic', name: 'Classic' },
  { id: 'midnight', name: 'Midnight' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'ember', name: 'Ember' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'forest', name: 'Forest' },
  { id: 'laurel', name: 'Laurel', need: 10, why: 'Reach the ranked top ten' },
  { id: 'gilded', name: 'Gilded', need: 3, why: 'Reach a ranked podium' },
  { id: 'sovereign', name: 'Sovereign', need: 1, why: 'Finish #1 on a ranked board' }
];

export const PATTERNS = [
  { id: 'none', name: 'Plain' },
  { id: 'checker', name: 'Board' },
  { id: 'diagonal', name: 'Stripes' },
  { id: 'dots', name: 'Dots' },
  { id: 'rays', name: 'Rays' }
];

export const EMBLEMS = ['♚', '♛', '♜', '♝', '♞', '♟'];

const EXTERNAL = [
  { id: 'chesscom', name: 'Chess.com', tint: '#7fa650' },
  { id: 'lichess', name: 'Lichess', tint: '#8a8f99' },
  { id: 'uscf', name: 'USCF', tint: '#2a5caa' },
  { id: 'fide', name: 'FIDE', tint: '#1c76c4' },
  { id: 'nwchess', name: 'NW Chess', tint: '#0f8a6c' }
];

const unlocked = (theme, best) => !theme.need || (best && best <= theme.need);

const cardOf = (u) => {
  const c = (u && u.card) || {};
  const theme = THEMES.find((t) => t.id === c.theme) || THEMES[0];
  return {
    theme: unlocked(theme, u && u.rankedBest) ? theme.id : 'classic',
    pattern: PATTERNS.some((p) => p.id === c.pattern) ? c.pattern : 'none',
    emblem: EMBLEMS.includes(c.emblem) ? c.emblem : '♞',
    tagline: String(c.tagline || '').slice(0, 70)
  };
};

/* ── shared reads, kept for a minute ───────────────────────────────── */

const memo = new Map();
const cached = (key, ms, load) => {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = load().catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: Date.now(), p });
  return p;
};

const allUsers = () => cached('users', 60000, async () => {
  const s = await getDocs(query(collection(db, 'users'), limit(500)));
  return s.docs.map((d) => ({ uid: d.id, ...d.data() }));
});

const clubMembers = (clubId) => cached('members:' + clubId, 30000, async () => {
  const s = await getDocs(clubCol(clubId, 'members'));
  return s.docs.map((d) => ({ uid: d.id, ...d.data() }));
});

const lichessPerfs = (name) => cached('li:' + name.toLowerCase(), 300000, async () => {
  const u = await publicUser(name);
  return (u && u.perfs) || {};
});

/** The rating a lichess profile is best summed up by: the busiest of the usual four. */
function mainLichess(perfs) {
  const keys = ['rapid', 'blitz', 'classical', 'bullet'];
  const have = keys.map((k) => ({ k, ...(perfs[k] || {}) })).filter((p) => p.games > 0 && p.rating);
  if (!have.length) return null;
  have.sort((a, b) => b.games - a.games);
  return { rating: have[0].rating, label: have[0].k, prov: !!have[0].prov };
}

const rankBy = (rows, uid, score, eligible = () => true) => {
  const list = rows.filter(eligible).sort((a, b) => score(b) - score(a));
  const i = list.findIndex((r) => r.uid === uid);
  return i < 0 ? null : i + 1;
};

/* ── remembering the best place reached ────────────────────────────── */

let myBest;
/** Called wherever the board is drawn: a better place than ever is kept. */
export async function noteMyRank(ctx, board) {
  if (!board || !ctx.user) return;
  const row = board.rows.find((r) => r.uid === ctx.user.uid);
  if (!row) return;
  if (myBest === undefined) {
    const s = await getDoc(doc(db, 'users', ctx.user.uid)).catch(() => null);
    myBest = (s && s.exists() && s.data().rankedBest) || null;
  }
  if (myBest && myBest <= row.rank) return;
  myBest = row.rank;
  setDoc(doc(db, 'users', ctx.user.uid), { rankedBest: row.rank }, { merge: true }).catch(() => {});
}

/* ── installing ────────────────────────────────────────────────────── */

let installed = false;

export function installProfileCards(ctx) {
  if (installed) return;
  installed = true;
  /* Capture, so a row that does something else on click — open a game,
     open a tournament — still lets the name on it open the card. */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-profile]');
    if (!t || !t.dataset.profile || e.target.closest('[data-confirm],[data-no-profile]')) return;
    e.preventDefault();
    e.stopPropagation();
    openProfileCard(ctx, t.dataset.profile);
  }, true);

  syncLichessLink(ctx);
  onAuthChange(() => syncLichessLink(ctx));

  /* Back from the lichess login that Account settings started. */
  try {
    if (sessionStorage.getItem('jag-open-account')) {
      sessionStorage.removeItem('jag-open-account');
      setTimeout(() => openAccountSettings(ctx), 400);
    }
  } catch (_) {}
}

/* The token stays in this browser; what is shared is the fact of the link,
   which is what lets ranked trophies find their owner on their own. */
async function syncLichessLink(ctx) {
  const s = session();
  if (!s || !ctx.user) return;
  const have = await readAccount(ctx.user.uid);
  if (have && have.username === s.username) return;
  linkAccount(ctx.user.uid, s).catch((e) => console.warn('Could not record the lichess link', e));
}

/* ── the card ──────────────────────────────────────────────────────── */

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

/**
 * Everything the card shows, gathered in one go.
 */
async function gather(ctx, uid) {
  const [userSnap, account, users, members, board] = await Promise.all([
    getDoc(doc(db, 'users', uid)).catch(() => null),
    readAccount(uid).catch(() => null),
    allUsers().catch(() => []),
    ctx.clubId ? clubMembers(ctx.clubId).catch(() => []) : Promise.resolve([]),
    (lastRanked(ctx) ? Promise.resolve(lastRanked(ctx)) : loadRanked(ctx)).catch(() => null)
  ]);
  const user = (userSnap && userSnap.exists() && userSnap.data()) || {};
  const member = members.find((m) => m.uid === uid) || null;

  const rated = (src) => readRating(src).games > 0;
  const stats = {
    globalRating: readRating(user),
    globalRank: rated(user) ? rankBy(users, uid, (u) => readRating(u).r, rated) : null,
    globalRecord: readRecord(user)
  };
  if (member) {
    stats.points = member.points || 0;
    stats.pointsRank = rankBy(members.filter((m) => !m.deleted), uid, (m) => m.points || 0);
    stats.clubRating = readRating(member);
    stats.clubRank = rated(member) ? rankBy(members, uid, (m) => readRating(m).r, rated) : null;
    stats.clubRecord = readRecord(member);
  }
  const rk = board && board.rows.find((r) => r.uid === uid);
  stats.ranked = rk || null;
  stats.rankedOf = board ? board.rows.length : 0;

  return { user, member, account, stats };
}

function cardHTML(ctx, uid, data, opts = {}) {
  const { user, member, account, stats } = data;
  const name = (member && member.username) || user.username || 'Player';
  const color = (member && member.avatarColor) || user.avatarColor || '#7b8394';
  const look = opts.look || cardOf(user);
  const tier = stats.ranked ? tierOf(stats.ranked.rank) : '';
  const me = uid === ctx.user.uid;
  const ext = user.extRatings || {};

  const stat = (label, big, sub, cls = '') => `
    <div class="pc-stat ${cls}"><small>${label}</small><b>${big}</b><i>${sub || '&nbsp;'}</i></div>`;
  const ord = (n) => (n ? `#${n}` : '—');

  const tiles = [];
  tiles.push(stat(`${TROPHY_SVG}Ranked`,
    stats.ranked ? trophyText(stats.ranked.trophies) : '—',
    stats.ranked ? `${ord(stats.ranked.rank)} of ${stats.rankedOf}` : 'no trophies yet', 'ranked ' + tier));
  if (member) {
    tiles.push(stat('Club points', String(stats.points), `${ord(stats.pointsRank)} in club`));
    tiles.push(stat('Club rating', displayRating(member.rating),
      stats.clubRank ? `${ord(stats.clubRank)} in club` : 'unrated'));
  }
  tiles.push(stat('Global rating', displayRating(user.rating),
    stats.globalRank ? `${ord(stats.globalRank)} worldwide` : 'unrated'));

  const rec = member ? stats.clubRecord : stats.globalRecord;

  /* Outside ratings: lichess from lichess when it is connected, otherwise
     whatever the player typed. Empty boxes are not drawn at all. */
  const boxes = EXTERNAL.map((x) => {
    if (x.id === 'lichess' && account) {
      return `<div class="pc-ext-box synced" style="--x:${x.tint}" data-li-box>
        <small>${x.name}<span class="pc-sync" title="Synced from lichess">live</span></small>
        <b data-li-num>…</b><i data-li-sub>@${esc(account.username)}</i></div>`;
    }
    const v = ext[x.id];
    if (!v) return '';
    return `<div class="pc-ext-box" style="--x:${x.tint}"><small>${x.name}</small><b>${esc(String(v))}</b></div>`;
  }).join('');

  const medals = stats.ranked && (stats.ranked.gold + stats.ranked.silver + stats.ranked.bronze)
    ? `<div class="pc-medals">
        ${stats.ranked.gold ? `<span class="pc-medal gold" title="Tournament wins"><i>1st</i>×${stats.ranked.gold}</span>` : ''}
        ${stats.ranked.silver ? `<span class="pc-medal silver" title="Second places"><i>2nd</i>×${stats.ranked.silver}</span>` : ''}
        ${stats.ranked.bronze ? `<span class="pc-medal bronze" title="Third places"><i>3rd</i>×${stats.ranked.bronze}</span>` : ''}
      </div>` : '';

  return `
    <div class="pc-card t-${look.theme} pat-${look.pattern} ${tier ? 'flair-' + tier : ''} ${opts.mini ? 'mini' : ''}">
      <div class="pc-shine"></div>
      <div class="pc-banner">
        <span class="pc-emblem">${esc(look.emblem)}</span>
        ${tier ? `<span class="pc-flair">${tier === 'gold' ? CROWN_SVG : TROPHY_SVG}${TIER_NAME[tier]}</span>` : ''}
      </div>
      <div class="pc-head">
        <span class="pc-av ${tier}" style="--av:${esc(color)}">${esc(initials(name))}</span>
        ${medals}
      </div>
      <div class="pc-id">
          <h3>${esc(name)}</h3>
          ${look.tagline ? `<p class="pc-tag">${esc(look.tagline)}</p>` : ''}
          <div class="pc-chips">
            ${member ? `<span class="pc-chip">${esc(ROLE_LABEL[member.role] || 'Member')}</span>` : ''}
            ${member && member.joinedAt ? `<span class="pc-chip">Since ${fmtDate(member.joinedAt, { month: 'short', year: 'numeric' })}</span>` : ''}
            ${account ? `<a class="pc-chip li" href="https://lichess.org/@/${esc(account.username)}" target="_blank" rel="noopener">${LINK_SVG}${esc(account.username)}</a>` : ''}
          </div>
      </div>
      <div class="pc-stats">${tiles.join('')}</div>
      ${boxes ? `<div class="pc-ext"><div class="pc-sec">Outside ratings</div><div class="pc-ext-row">${boxes}</div></div>` : ''}
      <div class="pc-foot">
        <span class="pc-rec"><b>${rec.w}</b>W <b>${rec.d}</b>D <b>${rec.l}</b>L <em>${member ? 'in club' : 'global'}</em></span>
        ${opts.mini ? '' : me
          ? '<button class="btn subtle sm" data-edit>Edit my card</button>'
          : '<button class="btn primary sm" data-duel>Challenge</button>'}
      </div>
    </div>`;
}

async function fillLichess(root, account) {
  if (!account) return;
  try {
    const perfs = await lichessPerfs(account.username);
    const main = mainLichess(perfs);
    const num = root.querySelector('[data-li-num]');
    const sub = root.querySelector('[data-li-sub]');
    if (!num) return;
    if (!main) { num.textContent = '—'; return; }
    num.textContent = main.rating + (main.prov ? '?' : '');
    sub.textContent = main.label;
  } catch (_) {
    const num = root.querySelector('[data-li-num]');
    if (num) num.textContent = '—';
  }
}

export async function openProfileCard(ctx, uid) {
  const wrap = el(`<div class="modal pc-modal"><div class="pc-holder">
    <div class="pc-card loading"><div class="pc-banner"></div><div class="pc-skel"></div><div class="pc-skel short"></div></div>
  </div></div>`);
  document.body.appendChild(wrap);
  const close = () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 180); };
  wrap.onclick = (e) => { if (e.target === wrap || e.target.classList.contains('pc-holder')) close(); };
  const esc_ = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); } };
  document.addEventListener('keydown', esc_);

  const data = await gather(ctx, uid);
  const holder = wrap.querySelector('.pc-holder');
  holder.innerHTML = cardHTML(ctx, uid, data) + '<button class="pc-close" aria-label="Close">✕</button>';
  holder.querySelector('.pc-close').onclick = close;
  fillLichess(holder, data.account);
  tilt(holder.querySelector('.pc-card'));

  const edit = holder.querySelector('[data-edit]');
  if (edit) edit.onclick = () => { close(); openAccountSettings(ctx); };
  const duel = holder.querySelector('[data-duel]');
  if (duel) duel.onclick = () => {
    close();
    setDuelIntent({ scope: ctx.clubId ? 'club' : 'global', opponent: uid });
    if (ctx.clubId) location.hash = duelsHash(ctx);
    else location.href = '/play';
  };
}

/* A card you can tilt a little with the pointer. Small, and only where a
   pointer can hover; it is the difference between a modal and an object. */
function tilt(card) {
  if (!card || !matchMedia('(hover: hover)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
  });
  card.addEventListener('pointerleave', () => {
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  ACCOUNT SETTINGS                                                   */
/* ═══════════════════════════════════════════════════════════════════ */

export async function openAccountSettings(ctx) {
  const uid = ctx.user.uid;
  const wrap = el(`<div class="modal"><div class="modal-card as-modal">
    <button class="icon-btn modal-close" data-x title="Close">✕</button>
    <h3>Account settings</h3>
    <div class="empty-state">Loading…</div>
  </div></div>`);
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-x]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };

  const data = await gather(ctx, uid);
  const user = data.user;
  const look = cardOf(user);
  const ext = { ...(user.extRatings || {}) };
  const best = user.rankedBest || null;
  let account = data.account;

  const card = wrap.querySelector('.as-modal');
  card.innerHTML = `
    <button class="icon-btn modal-close" data-x title="Close">✕</button>
    <div class="as-grid">
      <div class="as-preview">
        <div class="as-preview-label">Your card, as others see it</div>
        <div class="as-preview-card" data-preview></div>
        ${best ? `<p class="field-hint">Best ranked place: <b>#${best}</b></p>` : ''}
      </div>
      <div class="as-controls">
        <h3>Account settings</h3>

        <section class="as-sec">
          <div class="as-sec-head"><b>Lichess account</b><small>Connect it and your ranked trophies count automatically, and your lichess rating stays in sync.</small></div>
          <div data-li></div>
        </section>

        <section class="as-sec">
          <div class="as-sec-head"><b>Ratings</b><small>Leave a box empty and it will not appear on your card.</small></div>
          <div class="as-ratings">${EXTERNAL.map((x) => `
            <label class="as-rating" style="--x:${x.tint}">
              <span>${x.name}</span>
              <input type="number" min="0" max="3500" inputmode="numeric" data-ext="${x.id}" value="${esc(ext[x.id] || '')}" placeholder="—" />
            </label>`).join('')}</div>
        </section>

        <section class="as-sec">
          <div class="as-sec-head"><b>Card style</b><small>Rarer styles unlock as you climb the ranked board.</small></div>
          <div class="as-themes">${THEMES.map((t) => {
            const open = unlocked(t, best);
            return `<button type="button" class="as-theme t-${t.id} ${t.id === look.theme ? 'on' : ''} ${open ? '' : 'locked'}"
              data-theme="${t.id}" ${open ? '' : 'disabled'} title="${esc(open ? t.name : t.why)}">
              <span class="as-theme-sw"></span><small>${esc(t.name)}</small>
              ${open ? '' : '<i class="as-lock">🔒</i>'}
            </button>`;
          }).join('')}</div>
          <div class="as-row">
            <span class="as-label">Pattern</span>
            <div class="duel-seg as-seg" data-seg="pattern">${PATTERNS.map((p) =>
              `<button type="button" class="duel-seg-opt ${p.id === look.pattern ? 'on' : ''}" data-v="${p.id}">${p.name}</button>`).join('')}</div>
          </div>
          <div class="as-row">
            <span class="as-label">Emblem</span>
            <div class="as-emblems" data-seg="emblem">${EMBLEMS.map((m) =>
              `<button type="button" class="as-emblem ${m === look.emblem ? 'on' : ''}" data-v="${m}">${m}</button>`).join('')}</div>
          </div>
          <label class="as-row as-tagline">
            <span class="as-label">Tagline</span>
            <input data-tagline maxlength="70" value="${esc(look.tagline)}" placeholder="Sicilian or nothing." />
          </label>
        </section>

        <div class="as-foot">
          <button class="btn subtle" data-x>Cancel</button>
          <button class="btn primary" data-save>Save</button>
        </div>
      </div>
    </div>`;
  card.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));

  const preview = () => {
    const box = card.querySelector('[data-preview]');
    const d = { ...data, account, user: { ...user, extRatings: ext } };
    box.innerHTML = cardHTML(ctx, uid, d, { look, mini: true });
    fillLichess(box, account);
  };

  const paintLichess = () => {
    const box = card.querySelector('[data-li]');
    const s = session();
    if (account) {
      box.innerHTML = `<div class="as-li on">
        <span class="rk-li-dot"></span>
        <div><b>${esc(account.username)}</b><small>Connected${account.linkedAt ? ' ' + fmtDate(account.linkedAt) : ''}</small></div>
        <button class="btn subtle sm" data-li-off>Disconnect</button>
      </div>`;
      box.querySelector('[data-li-off]').onclick = async () => {
        try {
          if (s) await disconnect();
          await unlinkAccount(uid);
          account = null;
          paintLichess(); preview();
          toast('Lichess account disconnected');
        } catch (e) { toast('Could not disconnect', 'error'); }
      };
    } else {
      box.innerHTML = `<div class="as-li">
        <span class="as-li-logo">♞</span>
        <div><b>Not connected</b><small>${s ? `Signed in here as ${esc(s.username)}` : 'Takes you to lichess.org and straight back.'}</small></div>
        <button class="btn primary sm" data-li-on>${s ? 'Link ' + esc(s.username) : 'Connect lichess'}</button>
      </div>`;
      box.querySelector('[data-li-on]').onclick = async () => {
        if (s) {
          await linkAccount(uid, s).catch(() => {});
          account = await readAccount(uid);
          paintLichess(); preview();
          toast('Lichess account linked', 'ok');
          return;
        }
        try { sessionStorage.setItem('jag-open-account', '1'); } catch (_) {}
        connect([]);
      };
    }
    const liInput = card.querySelector('[data-ext="lichess"]');
    if (liInput) {
      liInput.disabled = !!account;
      liInput.placeholder = account ? 'synced' : '—';
      if (account) liInput.value = '';
    }
  };

  card.querySelectorAll('[data-theme]').forEach((b) => {
    b.onclick = () => {
      look.theme = b.dataset.theme;
      card.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x === b));
      preview();
    };
  });
  card.querySelectorAll('[data-seg]').forEach((seg) => {
    seg.onclick = (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      look[seg.dataset.seg] = b.dataset.v;
      seg.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b));
      preview();
    };
  });
  card.querySelector('[data-tagline]').oninput = (e) => { look.tagline = e.target.value.slice(0, 70); preview(); };
  card.querySelectorAll('[data-ext]').forEach((i) => {
    i.oninput = () => {
      const n = parseInt(i.value, 10);
      if (n > 0) ext[i.dataset.ext] = Math.min(3500, n); else delete ext[i.dataset.ext];
      preview();
    };
  });

  card.querySelector('[data-save]').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    const clean = {};
    EXTERNAL.forEach((x) => {
      if (x.id === 'lichess' && account) return;
      if (ext[x.id]) clean[x.id] = ext[x.id];
    });
    try {
      /* Replaced whole rather than merged, so a box emptied stays empty. */
      await setDoc(doc(db, 'users', uid), { card: { ...look }, extRatings: clean },
        { mergeFields: ['card', 'extRatings'] });
      memo.delete('users');
      toast('Saved', 'ok');
      close();
    } catch (err) {
      console.error(err);
      toast('Could not save your settings', 'error');
      e.target.disabled = false;
      e.target.textContent = 'Save';
    }
  };

  paintLichess();
  preview();
}
