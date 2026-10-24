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

/* Where somebody with no account signs up for this club: the club's card on
   the public Network, opened straight onto its registration form. */
export function registrationURL(ctx) {
  const slug = ctx.club.slug || ctx.clubId;
  return `${origin()}/network?club=${encodeURIComponent(slug)}`;
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

/* The one place an admin goes to bring people in. Three ways, side by side,
   because they are for three different people: a member with an account
   (the invite link), somebody without one (the sign-up form), and a
   classroom (the QR on a projector). Each comes with a message already
   written, since what people actually do with a link is paste it into a
   group chat. */
export function openClubShare(ctx) {
  if (!canShareClub(ctx)) {
    toast('Only admins can share a private club', 'error');
    return;
  }
  const club = ctx.club;
  const isPrivate = club.visibility === 'private';
  const name = club.name || 'our chess club';
  const ways = [
    {
      id: 'invite', label: 'Invite link',
      hint: isPrivate
        ? 'For people with a JagChess account, or happy to make one. The link carries the join code, so share it only with people you want in.'
        : 'For anyone. Opening it takes them to a Join button, and signing up takes about ten seconds.',
      url: clubInviteURL(ctx),
      message: `Join ${name} on JagChess! Puzzles, games and our meeting calendar are all in one place.\n\n${clubInviteURL(ctx)}${club.code ? `\n\nOr go to ${location.host}/clubs and enter the code ${club.code}.` : ''}`
    }
  ];
  if (!isPrivate) {
    ways.push({
      id: 'form', label: 'Sign-up form',
      hint: 'A form for people without an account, like parents or new students. You approve each one on the Members page.',
      url: registrationURL(ctx),
      message: `Want to join ${name}? Sign up here and we will add you:\n\n${registrationURL(ctx)}`
    });
  }

  let current = ways[0];
  const sheet = el(`
    <div class="modal share-modal">
      <div class="modal-card share-hub">
        <button class="icon-btn modal-close" data-x title="Close" aria-label="Close">✕</button>
        <h3>Invite people to ${esc(name)}</h3>
        ${ways.length > 1 ? `<div class="seg" data-ways>${ways.map((w, i) =>
          `<button class="seg-btn${i === 0 ? ' on' : ''}" data-way="${w.id}">${esc(w.label)}</button>`).join('')}</div>` : ''}
        <p class="share-hint" data-hint></p>
        <div class="share-hub-body">
          <div class="share-qr" data-qr></div>
          <div class="share-hub-side">
            ${club.code ? `<div class="share-code"><span>Join code</span><b>${esc(club.code)}</b></div>` : ''}
            <label class="share-label" for="share-url">Link</label>
            <div class="share-link">
              <input id="share-url" readonly />
              <button class="btn primary sm" data-copy="url">Copy</button>
            </div>
            <label class="share-label" for="share-msg">Message to paste in a group chat or email</label>
            <textarea id="share-msg" rows="5"></textarea>
            <div class="share-actions">
              <button class="btn subtle sm" data-copy="msg">Copy message</button>
              <button class="btn subtle sm" data-png>Download QR</button>
              <button class="btn subtle sm" data-print>Print a poster</button>
              ${navigator.share ? '<button class="btn subtle sm" data-native>Share…</button>' : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`);
  document.body.appendChild(sheet);

  const paint = () => {
    sheet.querySelector('[data-hint]').textContent = current.hint;
    sheet.querySelector('#share-url').value = current.url;
    sheet.querySelector('#share-msg').value = current.message;
    try { sheet.querySelector('[data-qr]').innerHTML = toSVG(current.url, { margin: 2, dark: '#1a1d24', light: '#ffffff' }); }
    catch (e) { console.error(e); }
  };
  paint();

  const close = () => sheet.remove();
  sheet.querySelector('[data-x]').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  const seg = sheet.querySelector('[data-ways]');
  if (seg) seg.onclick = (e) => {
    const b = e.target.closest('[data-way]');
    if (!b) return;
    current = ways.find((w) => w.id === b.dataset.way);
    seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    paint();
  };

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast(what + ' copied', 'ok'); }
    catch { toast('Select the text and press Ctrl+C to copy'); }
  };
  sheet.querySelector('[data-copy="url"]').onclick = () => copy(current.url, 'Link');
  sheet.querySelector('[data-copy="msg"]').onclick = () => copy(sheet.querySelector('#share-msg').value, 'Message');
  sheet.querySelector('#share-url').onclick = (e) => e.target.select();

  sheet.querySelector('[data-png]').onclick = () => {
    try {
      const a = document.createElement('a');
      a.href = toPNG(current.url, { margin: 3, scale: 12 });
      a.download = 'jagchess-' + (club.slug || ctx.clubId) + '-' + current.id + '.png';
      a.click();
    } catch (e) { console.error(e); toast('Could not save the QR code', 'error'); }
  };

  /* A poster: the club's name, one sentence, the code, a big QR. What gets
     taped to a classroom door. */
  sheet.querySelector('[data-print]').onclick = () => {
    const w = window.open('', '_blank', 'width=700,height=900');
    if (!w) { toast('Your browser blocked the print window'); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(name)}</title>
      <style>
        body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;padding:56px 32px;color:#12221a}
        h1{font-size:44px;margin:0 0 10px;letter-spacing:-.03em}
        p{color:#4f6157;margin:0 0 30px;font-size:19px}
        .qr{width:min(440px,78vw);margin:0 auto}
        .code{margin-top:28px;font-size:18px;color:#4f6157}
        .code b{display:block;font-size:40px;letter-spacing:.2em;color:#12221a;margin-top:4px}
        small{display:block;margin-top:26px;color:#7a8a81;font-size:13px;word-break:break-all}
      </style>
      <h1>${esc(name)}</h1>
      <p>${current.id === 'form' ? 'Scan to sign up' : 'Scan to join us on JagChess'}</p>
      <div class="qr">${toSVG(current.url, { margin: 2, dark: '#1a1d24' })}</div>
      ${club.code && current.id === 'invite' ? `<div class="code">or enter this code at ${esc(location.host)}/clubs<b>${esc(club.code)}</b></div>` : ''}
      <small>${esc(current.url)}</small>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  const native = sheet.querySelector('[data-native]');
  if (native) native.onclick = () => {
    navigator.share({ title: name, text: sheet.querySelector('#share-msg').value }).catch(() => {});
  };
  return close;
}

/* The registration form is a public thing by definition, so this sheet is
   offered whenever the club is public — and only then. A private club has no
   listing on the Network for the link to land on. */
export function openRegistrationShare(ctx) {
  if (ctx.club.visibility === 'private') {
    toast('Make the club public to share its registration form', 'error');
    return;
  }
  openShareSheet({
    title: 'Registration for ' + (ctx.club.name || 'this club'),
    subtitle: 'Anyone who scans this — account or not — lands on your registration form.',
    url: registrationURL(ctx),
    filename: 'jagchess-registration-' + (ctx.club.slug || ctx.clubId),
    extraHTML: '<div class="share-note">People who already have a JagChess account can skip '
      + 'the form entirely and join from the same page.</div>'
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
