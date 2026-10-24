/* ═══════════════════════════════════════════════════════════════════════
   global-leaderboard.js — /leaderboard, the whole-site rating table.

   Outside a club there is only one board to show: the global rating and the
   global win / draw / loss record, both read off the user profile. Club
   ratings deliberately stay inside their club — a club number only means
   something next to the other members of that club.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, collection, getDocs, query, limit, esc, initials, toast
} from './club-core.js';

import { readRating, displayRating } from './glicko2.js';
import { readRecord, watchActiveDuels, gameOf, setDuelIntent } from './club-duels.js';
import { bootHub } from './hub-shell.js';

const $ = (id) => document.getElementById(id);

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 12S6 5.4 12 5.4 21.6 12 21.6 12 18 18.6 12 18.6 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="2.9"/></svg>';
const SWORD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/></svg>';

(async function init() {
  const ctx = await bootHub('leaderboard');

  $('hub-boot').hidden = true;
  $('hub-body').hidden = false;

  let players = [];
  let games = [];
  let sortBy = 'rating';

  const host = $('hub-main');
  host.innerHTML = `
    <div class="lb-tabs">
      <button class="lb-tab on" data-s="rating">Global rating</button>
      <button class="lb-tab" data-s="wins">Most wins</button>
      <button class="lb-tab" data-s="games">Most games</button>
    </div>
    <div class="tile lb-tile">
      <div class="lb-row lb-row-head has-duel">
        <span class="lb-col-rank">Rank</span>
        <span class="lb-col-player">Player</span>
        <span class="lb-col-pts" id="lb-metric">Rating</span>
        <span class="lb-col-wdl">W / D / L</span>
        <span></span>
      </div>
      <div id="lb-list"><div class="empty-state">Loading players…</div></div>
      <div class="empty-state" id="lb-empty" hidden>Nobody has played a rated global game yet.</div>
    </div>`;

  host.querySelector('.lb-tabs').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    sortBy = b.dataset.s;
    host.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('on', t.dataset.s === sortBy));
    host.querySelector('#lb-metric').textContent =
      sortBy === 'rating' ? 'Rating' : sortBy === 'wins' ? 'Wins' : 'Games';
    paint();
  };

  function ordered() {
    const rows = players.slice();
    if (sortBy === 'wins') {
      return rows.sort((a, b) => readRecord(b).w - readRecord(a).w ||
        readRating(b).r - readRating(a).r);
    }
    if (sortBy === 'games') {
      const n = (p) => { const r = readRecord(p); return r.w + r.d + r.l; };
      return rows.sort((a, b) => n(b) - n(a) || readRating(b).r - readRating(a).r);
    }
    // an unplayed 1000 says nothing, so provisional players sit below the ranked
    return rows.sort((a, b) => {
      const ra = readRating(a), rb = readRating(b);
      if ((ra.games < 1) !== (rb.games < 1)) return ra.games < 1 ? 1 : -1;
      return rb.r - ra.r;
    });
  }

  function paint() {
    const rows = ordered();
    $('lb-empty').hidden = rows.length > 0;
    host.querySelector('#lb-list').innerHTML = rows.map((p, i) => {
      const me = p.uid === ctx.user.uid;
      const medal = i === 0 ? 'lb-rank-gold' : i === 1 ? 'lb-rank-silver' : i === 2 ? 'lb-rank-bronze' : '';
      const rating = readRating(p);
      const rec = readRecord(p);
      const total = rec.w + rec.d + rec.l;
      const metric = sortBy === 'wins' ? String(rec.w)
        : sortBy === 'games' ? String(total)
        : `<span class="${rating.games < 1 ? 'lb-provisional' : ''}">${displayRating(p.rating)}</span>
           <span class="lb-rating-games">${rating.games} rated</span>`;

      const live = gameOf(games, p.uid);
      const actions = [
        live ? `<button class="lb-mini watch" data-watch="${esc(live.id)}">${EYE}Watch</button>` : '',
        !me && !live ? `<button class="lb-mini" data-duel="${esc(p.uid)}">${SWORD}Duel</button>` : ''
      ].filter(Boolean).join('');

      return `<div class="lb-row has-duel${me ? ' lb-row-me' : ''}">
        <span class="lb-col-rank ${medal}">${i + 1}</span>
        <span class="lb-col-player">
          <span class="lb-avatar" style="background:${esc(p.avatarColor || '#1cb0f6')}">${esc(initials(p.username || p.email))}</span>
          <span class="lb-player-info">
            <span class="lb-player-name">${esc(p.username || 'Player')}${me ? '<span class="lb-me-badge">You</span>' : ''}</span>
            <span class="lb-player-email">${total ? `${total} rated game${total === 1 ? '' : 's'}` : 'No rated games yet'}</span>
          </span>
        </span>
        <span class="lb-col-pts">${metric}</span>
        <span class="lb-col-wdl">${rec.w} / ${rec.d} / ${rec.l}</span>
        <span class="lb-row-actions">${actions}</span>
      </div>`;
    }).join('');

    host.querySelectorAll('[data-watch]').forEach((b) => {
      b.onclick = () => { location.href = '/play#duel/' + b.dataset.watch; };
    });
    host.querySelectorAll('[data-duel]').forEach((b) => {
      b.onclick = () => {
        setDuelIntent({ scope: 'global', opponent: b.dataset.duel });
        location.href = '/play';
      };
    });
  }

  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(300)));
    players = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.username);
  } catch (e) {
    console.error(e);
    host.querySelector('#lb-list').innerHTML =
      '<div class="empty-state">Could not load the leaderboard right now.</div>';
    toast('Could not load the leaderboard', 'error');
    return;
  }

  watchActiveDuels((rows) => { games = rows; paint(); });
  paint();
})();
