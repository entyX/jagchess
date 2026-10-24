/* ═══════════════════════════════════════════════════════════════════════
   whats-new.js — the release note club staff see once per version.

   Only admins and founders get it: they are the people who have to decide
   whether a new module belongs in their club, and a student has nothing to
   act on. It is dismissible, it never comes back for the same version, and
   the first run on a device is not treated as an update — there is nothing
   to catch up on yet.

   Whether it has been seen lives in localStorage (see version.js), so it is
   per-device rather than per-account. That is deliberate: someone who opens
   the club on a new laptop deserves to be told what changed there too.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc } from './club-core.js';
import { VERSION, LATEST, CHANGE_KINDS, shouldAnnounce, markVersionSeen } from './version.js';

const md = (s) => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

const MAX_SHOWN = 7;

/**
 * @param {object} ctx  the club ctx — used only to check the role
 */
export function maybeShowWhatsNew(ctx) {
  if (!ctx || !ctx.isAdmin) return;
  if (!shouldAnnounce()) return;
  // whatever happens next, this version has now been put in front of them
  markVersionSeen();
  showWhatsNew();
}

export function showWhatsNew() {
  const e = LATEST;
  const shown = e.changes.slice(0, MAX_SHOWN);
  const rest = e.changes.length - shown.length;

  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal-card whats-new-card">
      <button class="icon-btn modal-close" data-x title="Close">✕</button>
      <div class="whats-new-head">
        <span class="whats-new-badge">${esc(VERSION)}</span>
        <span class="tn-status finished">What's new</span>
      </div>
      <h3 class="whats-new-title">${esc(e.title)}</h3>
      <p class="whats-new-sum">${esc(e.summary)}</p>
      <ul class="whats-new-list">
        ${shown.map((c) => {
          const k = CHANGE_KINDS[c.kind] || CHANGE_KINDS.new;
          return `<li><span class="cl-kind ${k.tint}">${k.label}</span><span>${md(c.text)}</span></li>`;
        }).join('')}
      </ul>
      ${rest > 0 ? `<p class="whats-new-more">…and ${rest} more change${rest === 1 ? '' : 's'}.</p>` : ''}
      <div class="whats-new-foot">
        <a href="/guide#changelog" target="_blank" rel="noopener">Read the full changelog →</a>
        <button class="btn primary" data-x>Got it</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (ev) => { if (ev.target === wrap) close(); };
  document.addEventListener('keydown', function esc2(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
}
