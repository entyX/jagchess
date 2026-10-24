/* ═══════════════════════════════════════════════════════════════════════
   club-welcome.js — the moment right after a club is created.

   The club exists, so the job now is the next thirty seconds: get the link
   into a group chat, and know where things are. Two buttons for those, and
   a way to just look around.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, clubAvatar } from './club-core.js';
import { openClubShare, clubInviteURL } from './club-share.js';

export function showClubWelcome(ctx) {
  const club = ctx.club;
  const wrap = document.createElement('div');
  wrap.className = 'modal welcome-modal';
  wrap.innerHTML = `
    <div class="modal-card welcome-card">
      <div class="welcome-burst" aria-hidden="true">${burst()}</div>
      <div class="welcome-avatar">${clubAvatar(club, 'club-avatar')}</div>
      <h3>${esc(club.name || 'Your club')} is ready</h3>
      <p class="modal-meta">You're the founder. Here's the address people will use:</p>
      <div class="welcome-url">${esc(clubInviteURL(ctx).replace(/^https?:\/\//, '').replace(/\?.*$/, ''))}</div>
      <div class="welcome-actions">
        <button class="btn primary lg" data-invite>Invite members</button>
        <button class="btn subtle lg" data-tour>Show me around</button>
      </div>
      <button class="welcome-skip" data-skip>I'll explore on my own</button>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('[data-skip]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.querySelector('[data-invite]').onclick = () => { close(); openClubShare(ctx); };
  wrap.querySelector('[data-tour]').onclick = async () => {
    close();
    const { runClubTour } = await import('./tour.js');
    runClubTour(ctx);
  };
}

/* A one-off scatter of chess pieces behind the heading. */
function burst() {
  const pieces = ['♞', '♛', '♜', '♝', '♟', '♚'];
  return Array.from({ length: 14 }, (_, n) => {
    const a = (n / 14) * Math.PI * 2;
    const d = 90 + (n % 3) * 40;
    return `<i style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d * .7)}px;--r:${(n * 47) % 360}deg;--d:${(n % 5) * 40}ms">${pieces[n % pieces.length]}</i>`;
  }).join('');
}
