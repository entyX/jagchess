/* ═══════════════════════════════════════════════════════════════════════
   club-share.js — invite links and QR codes, for clubs and for individual
   attendance forms.

   Who may see a club's invite:
     public club   — any member, since anyone could join anyway
     private club  — admins only, because the link carries the join code
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, toast } from './club-core.js';
import { toSVG, toPNG } from './qr.js';

const origin = () => location.origin;

/* A link that works for whoever opens it: signed out goes to login and comes
   back here, a non-member lands on the join gate with the code already in
   hand, a member just opens the club. */
export function clubInviteURL(ctx) {
  const slug = ctx.club.slug || ctx.clubId;
  const code = ctx.club.code ? '?code=' + encodeURIComponent(ctx.club.code) : '';
  return `${origin()}/clubs/${encodeURIComponent(slug)}${code}`;
}

export function attendanceURL(ctx, eventId) {
  const slug = ctx.club.slug || ctx.clubId;
  return `${origin()}/clubs/${encodeURIComponent(slug)}?att=${encodeURIComponent(eventId)}`;
}

/* Private clubs keep their code — and so the QR — behind an admin check. */
export const canShareClub = (ctx) =>
  ctx.club.visibility === 'private' ? ctx.isAdmin : true;

/* ── the sheet ─────────────────────────────────────────────────────── */

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

/**
 * @param {object} o
 * @param {string} o.title      heading
 * @param {string} o.subtitle   one line under it
 * @param {string} o.url        what the QR encodes and the field shows
 * @param {string} [o.filename] for the PNG download
 * @param {string} [o.extraHTML] anything to slot above the link (a join code)
 */
export function openShareSheet(o) {
  let qr;
  try {
    qr = toSVG(o.url, { margin: 2, dark: '#101c24', light: '#ffffff' });
  } catch (e) {
    console.error(e);
    toast('Could not build a QR code for that link', 'error');
    return;
  }

  const sheet = el(`
    <div class="modal share-modal">
      <div class="modal-card share-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <h3>${esc(o.title)}</h3>
        <p class="modal-meta" style="margin:0">${esc(o.subtitle || '')}</p>
        ${o.extraHTML || ''}
        <div class="share-qr" id="share-qr">${qr}</div>
        <div class="share-link">
          <input id="share-url" readonly value="${esc(o.url)}" />
          <button class="btn primary sm" id="share-copy">Copy</button>
        </div>
        <div class="share-actions">
          <button class="btn subtle sm" id="share-png">Download QR</button>
          <button class="btn subtle sm" id="share-print">Print</button>
          ${navigator.share ? '<button class="btn subtle sm" id="share-native">Share…</button>' : ''}
        </div>
      </div>
    </div>`);

  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.querySelector('[data-x]').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };

  const field = sheet.querySelector('#share-url');
  field.onclick = () => field.select();

  sheet.querySelector('#share-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(o.url);
      toast('Link copied', 'ok');
    } catch {
      // clipboard access is refused in some browsers unless the field is focused
      field.select();
      toast('Press Ctrl+C to copy the link');
    }
  };

  sheet.querySelector('#share-png').onclick = () => {
    try {
      const a = document.createElement('a');
      a.href = toPNG(o.url, { margin: 3, scale: 12 });
      a.download = (o.filename || 'jagchess-qr') + '.png';
      a.click();
    } catch (e) {
      console.error(e);
      toast('Could not save the QR code', 'error');
    }
  };

  /* Printing opens just the code and the link — what you would pin to a wall. */
  sheet.querySelector('#share-print').onclick = () => {
    const w = window.open('', '_blank', 'width=640,height=800');
    if (!w) { toast('Your browser blocked the print window'); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(o.title)}</title>
      <style>
        body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;
             padding:48px 32px;color:#14262f}
        h1{font-size:26px;margin:0 0 6px}
        p{color:#5b7182;margin:0 0 28px;font-size:15px}
        .qr{width:min(420px,80vw);margin:0 auto}
        code{display:block;margin-top:26px;font-size:14px;color:#5b7182;word-break:break-all}
      </style>
      <h1>${esc(o.title)}</h1><p>${esc(o.subtitle || '')}</p>
      <div class="qr">${toSVG(o.url, { margin: 2 })}</div>
      <code>${esc(o.url)}</code>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  const native = sheet.querySelector('#share-native');
  if (native) native.onclick = () => {
    navigator.share({ title: o.title, text: o.subtitle, url: o.url }).catch(() => {});
  };

  return close;
}

/* ── the two things we share ───────────────────────────────────────── */

export function openClubShare(ctx) {
  if (!canShareClub(ctx)) {
    toast('Only admins can share a private club', 'error');
    return;
  }
  const isPrivate = ctx.club.visibility === 'private';
  openShareSheet({
    title: 'Invite people to ' + (ctx.club.name || 'this club'),
    subtitle: isPrivate
      ? 'This club is private, so keep this link to people you want in it — it carries the join code.'
      : 'Anyone who opens this link can join the club.',
    url: clubInviteURL(ctx),
    filename: 'jagchess-' + (ctx.club.slug || ctx.clubId),
    extraHTML: ctx.club.code
      ? `<div class="share-code"><span>Join code</span><b>${esc(ctx.club.code)}</b></div>`
      : ''
  });
}

export function openAttendanceShare(ctx, event, points) {
  openShareSheet({
    title: 'Attendance for ' + (event.title || 'this event'),
    subtitle: `Members who scan this go straight to the check-in${points ? ` and earn ${points} points` : ''}.`,
    url: attendanceURL(ctx, event.id),
    filename: 'jagchess-attendance-' + event.id
  });
}
