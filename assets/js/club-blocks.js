/* ═══════════════════════════════════════════════════════════════════════
   club-blocks.js — every block (page) a club can contain.
   Each renderer returns a cleanup function.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, auth, clubRef, clubCol, clubDoc, memberRef, applicationCol,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, increment, limit,
  esc, fmtDate, fmtTime, toast, confirmDialog, promptDialog, initials,
  CLUB_COLORS, CLUB_ICONS, makeCode, banRef, isStaff, canModerate, canSetRoles, ROLE_LABEL,
  deleteClubDeep, syncPublicClub, unindexMemberEmail,
  clubAvatar, clubPhoto, clubPhotoFrom
} from './club-core.js';

import { readRating, displayRating } from './glicko2.js';
import { attachCalendarSync } from './club-calendar-sync.js';
import {
  renderDuels, watchActiveDuels, gameOf, loadMyRatings, setDuelIntent, duelsHash,
  readRecord
} from './club-duels.js';
import { renderTournaments } from './tournaments-ui.js';
import { openAttendanceShare, openClubShare } from './club-share.js';
import { mountNewsletterMail } from './newsletter-mail.js';
import { fontSelectHTML, wireFontSelect } from './mail-fonts.js';
import { mountEmojiButton } from './emoji-picker.js';
import {
  mountRegistrationEditor, applicantRowHTML, openResponse, openInviteMail,
  openBulkInvite, deleteApplication, mountMarkupEditor, markupFromApplicants,
  saveMarkup
} from './club-registration.js';
import {
  isLive, hasPassed, normalizeAttendanceForm, loadAttendanceForm, alreadyCheckedIn,
  openMemberAttendance, guestQuestions, syncPublicAttendance, dropPublicAttendance,
  publishOpenAttendance, reconcileAttendance
} from './club-attendance.js';
import { mountQuestionEditor } from './question-editor.js';
import { renderPuzzles } from './club-puzzles.js';
import {
  MAX_QUESTIONS, renderQuestions, wireForm, answerText
} from './registration-form.js';

export const BLOCK_TYPES = {
  events: {
    name: 'Events', icon: 'calendar', tint: 'var(--blue-soft)',
    desc: 'A shared calendar for practices, tournaments and meetings — with attendance and streaks.',
    sub: 'Practices, tournaments and meetings'
  },
  puzzles: {
    name: 'Puzzles', icon: 'puzzle', tint: 'var(--green-soft)',
    desc: 'Publish tactical positions from a board or a FEN, file them into collections, and share a collection with the whole of JagChess. Members solve them for points, and can build their own.',
    sub: 'Tactics training worth points'
  },
  newsletters: {
    name: 'Newsletters', icon: 'mail', tint: 'var(--purple-soft)',
    desc: 'Write rich announcements for the club and keep them in one readable archive.',
    sub: 'Announcements and updates'
  },
  leaderboard: {
    name: 'Leaderboard', icon: 'trophy', tint: 'var(--gold-soft)',
    desc: 'Rank every member by the points they have earned across the whole club.',
    sub: 'Who is ahead this season'
  },
  duels: {
    name: 'Play', icon: 'swords', tint: 'var(--blue-soft)',
    desc: 'Live 1v1 chess with clocks and ratings. Play clubmates or anyone on JagChess, and watch games as they happen.',
    sub: 'Games against clubmates and anyone on JagChess'
  },
  tournaments: {
    name: 'Tournaments', icon: 'tournament', tint: 'var(--purple-soft)',
    desc: 'Run timed arenas, rated or casual, or a real Lichess tournament — with live standings and a full history.',
    sub: 'Arenas, Lichess events and past winners'
  },
  store: {
    name: 'Store', icon: 'bag', tint: 'var(--orange-soft)',
    desc: 'Let members spend their points on merch, entry fees or privileges, with order approval.',
    sub: 'Spend points on real rewards'
  },
  donate: {
    name: 'Donate', icon: 'heart', tint: 'var(--red-soft)',
    desc: 'A simple page asking supporters to help fund equipment, coaching and travel.',
    sub: 'Support the club'
  }
};

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

const noop = () => {};

/* ═══ router ═════════════════════════════════════════════════════════ */

export async function renderBlock(type, ctx, host, api) {
  switch (type) {
    case 'events':      return renderEvents(ctx, host, api);
    case 'puzzles':     return renderPuzzles(ctx, host, api);
    case 'newsletters': return renderNews(ctx, host, api);
    case 'leaderboard': return renderLeaderboard(ctx, host, api);
    case 'duels':       return renderDuels(ctx, host, api);
    case 'tournaments': return renderTournaments(ctx, host, api);
    case 'store':       return renderStore(ctx, host, api);
    case 'donate':      return renderDonate(ctx, host, api);
    case 'profile':     return renderProfile(ctx, host, api);
    case 'members':     return renderMembers(ctx, host, api);
    case 'settings':    return renderSettings(ctx, host, api);
    default:
      host.innerHTML = '<div class="empty-state">This block type isn\'t available.</div>';
      return noop;
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  EVENTS                                                             */
/* ═══════════════════════════════════════════════════════════════════ */

const TAGS = ['classic', 'tournament', 'practice', 'meeting', 'lesson', 'match'];

async function renderEvents(ctx, host, api) {
  const isAdmin = ctx.isAdmin;
  let events = [];
  let month = new Date();

  host.innerHTML = `
    <div id="att-live"></div>
    <div class="calendar-layout">
      <div class="tile calendar-card">
        <div class="calendar-head">
          <button class="icon-btn" id="cal-prev" title="Previous month">←</button>
          <div class="calendar-title" id="cal-title">—</div>
          <button class="icon-btn" id="cal-next" title="Next month">→</button>
        </div>
        <div class="calendar-weekdays"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
        <div class="calendar-grid" id="cal-grid"></div>
      </div>
      <div class="events-side-col">
        <div id="cal-sync"></div>
        <div class="tile events-side">
          <div class="events-side-header"><h3>Upcoming</h3><span class="muted" id="ev-range"></span></div>
          <div class="list" id="ev-upcoming"></div>
          <div class="empty-state" id="ev-empty" hidden>No upcoming events yet.</div>
        </div>
      </div>
    </div>
    ${isAdmin ? `
    <div class="tile" style="margin-top:16px">
      <h3>Attendance</h3>
      <p class="muted" style="font-size:13.5px;margin:-6px 0 14px">Pick an event to set its reward, add questions, and read who checked in.</p>
      <select id="att-event"><option value="">Choose an event</option></select>
      <div id="att-panel" hidden style="margin-top:20px"></div>
    </div>` : ''}`;

  const grid = host.querySelector('#cal-grid');
  const title = host.querySelector('#cal-title');

  /* The club's own events, plus the connected account's while syncing is
     on. Only the club's are in `events`, and only those can be opened,
     edited or deleted — a Google row is somebody else's and is drawn to be
     looked at. Everything that paints goes through this, so turning the
     switch off takes them off every surface at once. */
  let sync = null;
  const shown = () => events.concat(sync ? sync.rows() : []);
  const isClubEvent = (id) => events.some((e) => e.id === id);

  const paintCalendar = () => {
    title.textContent = month.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = new Date().toDateString();
    let html = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const outside = d.getMonth() !== month.getMonth();
      const dayEvents = shown().filter((e) => new Date(e.date).toDateString() === d.toDateString());
      if (i >= 35 && !dayEvents.length && outside) continue;
      html += `<div class="day-cell${outside ? ' is-outside' : ''}${d.toDateString() === today ? ' is-today' : ''}" data-day="${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}">
        <div class="day-num">${d.getDate()}</div>
        <div class="day-events">${dayEvents.map((e) =>
          `<button class="event-pill tag-${esc(e.tag || 'classic')}${e.source === 'google' ? ' from-google' : ''}" data-ev="${esc(e.id)}"
            ${e.source === 'google' ? 'title="From the connected Google Calendar"' : ''}>${esc(e.title)}</button>`).join('')}</div>
      </div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('[data-ev]').forEach((b) => (b.onclick = () => openEvent(b.dataset.ev)));
  };

  const paintUpcoming = () => {
    const now = Date.now();
    const up = shown().filter((e) => e.date >= now - 3 * 3600e3)
      .sort((a, b) => a.date - b.date).slice(0, 8);
    host.querySelector('#ev-empty').hidden = up.length > 0;
    host.querySelector('#ev-range').textContent = up.length ? `${up.length} scheduled` : '';
    host.querySelector('#ev-upcoming').innerHTML = up.map((e) => `
      <button class="ev-row" data-ev="${esc(e.id)}">
        <span class="dash-ev-date">
          <span class="dash-ev-day">${new Date(e.date).getDate()}</span>
          <span class="dash-ev-mon">${new Date(e.date).toLocaleString(undefined, { month: 'short' })}</span>
        </span>
        <span class="ev-row-info">
          <span class="dash-ev-title">${esc(e.title)}</span>
          <span class="dash-ev-sub"><span class="dash-ev-time">${fmtTime(e.date)}</span>
          <span class="tag-badge tag-${esc(e.tag || 'classic')}">${esc(e.tag || 'classic')}</span></span>
        </span>
      </button>`).join('');
    host.querySelectorAll('#ev-upcoming [data-ev]').forEach((b) => (b.onclick = () => openEvent(b.dataset.ev)));
  };

  const paintAttSelect = () => {
    const sel = host.querySelector('#att-event');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Choose an event</option>' +
      events.slice().reverse().map((e) =>
        `<option value="${esc(e.id)}">${esc(e.title)}, ${fmtDate(e.date)}</option>`).join('');
    sel.value = cur;
  };

  function openEvent(id) {
    const e = shown().find((x) => x.id === id);
    if (!e) return;
    /* A Google row can be read and nothing else: editing it would mean
       writing into somebody's personal calendar from a club page, and
       deleting it would be worse. */
    const own = isClubEvent(id);
    const live = isLive(e);
    const modal = el(`<div class="modal">
      <div class="modal-card">
        <button class="icon-btn modal-close" data-x>✕</button>
        <div class="modal-tag"><span class="tag-badge tag-${esc(e.tag || 'classic')}">${esc(e.tag || 'classic')}</span></div>
        <h3>${esc(e.title)}</h3>
        <div class="modal-meta">${fmtDate(e.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${fmtTime(e.date)}, ${e.durationMin || 30} minutes</div>
        <p>${esc(e.desc || 'No description.')}</p>
        ${live ? '<div class="live-chip">● Happening now</div>' : ''}
        ${e.source === 'google' ? `<p class="field-hint">From the connected Google Calendar.
          ${e.htmlLink ? `<a href="${esc(e.htmlLink)}" target="_blank" rel="noopener noreferrer">Open it there</a> to change it.`
            : 'Change it in Google Calendar.'}</p>` : ''}
        ${isAdmin && own ? `<div class="modal-actions">
          <button class="btn subtle" data-edit>Edit</button>
          <button class="btn danger" data-del>Delete</button></div>` : ''}
      </div></div>`);
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-x]').onclick = close;
    modal.onclick = (ev) => { if (ev.target === modal) close(); };
    const editBtn = modal.querySelector('[data-edit]');
    if (editBtn) editBtn.onclick = () => { close(); startEdit(e); };
    const delBtn = modal.querySelector('[data-del]');
    if (delBtn) delBtn.onclick = async () => {
      close();
      if (!await confirmDialog({ title: 'Delete event?', body: `"${e.title}" will be removed for everyone.`, confirmText: 'Delete', danger: true })) return;
      if (sync) await sync.removeOne(e);
      await deleteDoc(clubDoc(ctx.clubId, 'events', e.id));
      // the public copy of its check-in is a root document, so it does not go
      // with the event and has to be withdrawn by name
      await dropPublicAttendance(ctx.clubId, e.id);
      toast('Event deleted');
    };
  }

  /* ── the event editor ────────────────────────────────────────────────
     A sheet that opens when it's wanted, rather than a form that sits on
     the page all the time. Creating one can repeat it weekly, because most
     clubs meet on the same day every week and typing that in eight times is
     how a calendar ends up empty.
     ─────────────────────────────────────────────────────────────────── */

  const LENGTHS = [30, 45, 60, 90, 120, 180];
  const pad = (n) => String(n).padStart(2, '0');
  const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function startEdit(e) { openEditor(e); }

  function openEditor(e, onDay) {
    const editing = !!e;
    const d = e ? new Date(e.date) : null;
    const date = d ? dayStr(d) : onDay || dayStr(new Date());
    const time = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : (e && e.time) || '15:30';
    const len = (e && e.durationMin) || 60;
    let tag = (e && e.tag) || 'meeting';

    const sheet = el(`<div class="modal">
      <div class="modal-card ev-editor">
        <button class="icon-btn modal-close" data-x aria-label="Close">✕</button>
        <h3>${editing ? 'Edit event' : 'New event'}</h3>
        <input id="ed-title" class="ev-title-input" placeholder="Club meeting" maxlength="80" value="${esc((e && e.title) || '')}" />
        <div class="ev-when">
          <label>Day<input id="ed-date" type="date" value="${date}" /></label>
          <label>Starts<input id="ed-time" type="time" value="${time}" /></label>
          <label>Length<select id="ed-len">${LENGTHS.map((m) => `<option value="${m}"${m === len ? ' selected' : ''}>${m < 60 ? m + ' min' : (m / 60) + (m === 60 ? ' hour' : ' hours')}</option>`).join('')}${LENGTHS.includes(len) ? '' : `<option value="${len}" selected>${len} min</option>`}</select></label>
        </div>
        <div class="ev-kind">
          <span>What kind</span>
          <div class="ev-tags">${TAGS.map((t) => `<button type="button" class="ev-tag tag-${t}${t === tag ? ' on' : ''}" data-tag="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
        </div>
        <textarea id="ed-desc" rows="3" placeholder="What to bring, which room, anything people should know">${esc((e && e.desc) || '')}</textarea>
        ${editing ? '' : `
        <div class="ev-repeat-box">
          <button type="button" class="ev-repeat" id="ed-repeat" aria-pressed="false">
            <span><b>Repeat every week</b><small id="ed-repeat-hint">Off. Just this one date.</small></span>
            <i class="switch" aria-hidden="true"></i>
          </button>
          <div class="ev-weeks" id="ed-weeks" hidden>
            <span>For</span>${[4, 8, 12, 16].map((n) => `<button type="button" class="ev-tag${n === 8 ? ' on' : ''}" data-weeks="${n}">${n} weeks</button>`).join('')}
          </div>
        </div>`}
        <div class="modal-actions ev-actions">
          ${editing ? '<button class="btn ghost" data-delete>Delete</button>' : ''}
          <div class="spacer"></div>
          <button class="btn subtle" data-x>Cancel</button>
          <button class="btn primary" data-save>${editing ? 'Save changes' : 'Add to calendar'}</button>
        </div>
      </div></div>`);
    document.body.appendChild(sheet);
    const q = (sel) => sheet.querySelector(sel);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
    sheet.onclick = (ev) => { if (ev.target === sheet) close(); };
    setTimeout(() => q('#ed-title').focus(), 60);

    q('.ev-tags').onclick = (ev) => {
      const b = ev.target.closest('[data-tag]');
      if (!b) return;
      tag = b.dataset.tag;
      sheet.querySelectorAll('.ev-tag').forEach((x) => x.classList.toggle('on', x === b));
    };

    let repeat = false;
    let weeks = 8;
    const rep = q('#ed-repeat');
    if (rep) {
      q('#ed-weeks').onclick = (ev) => {
        const b = ev.target.closest('[data-weeks]');
        if (!b) return;
        weeks = +b.dataset.weeks;
        sheet.querySelectorAll('[data-weeks]').forEach((x) => x.classList.toggle('on', x === b));
      };
      const paintRepeat = () => {
        rep.classList.toggle('on', repeat);
        rep.parentElement.classList.toggle('on', repeat);
        rep.setAttribute('aria-pressed', repeat);
        q('#ed-weeks').hidden = !repeat;
        const wd = new Date(q('#ed-date').value + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' });
        q('#ed-repeat-hint').textContent = repeat ? `Every ${wd}, starting on the day above.` : 'Off. Just this one date.';
      };
      rep.onclick = () => { repeat = !repeat; paintRepeat(); };
      q('#ed-date').onchange = paintRepeat;
    }

    const del = q('[data-delete]');
    if (del) del.onclick = async () => {
      close();
      if (!await confirmDialog({ title: 'Delete this event?', body: `"${e.title}" will be removed for everyone.`, confirmText: 'Delete', danger: true })) return;
      if (sync) await sync.removeOne(e);
      await deleteDoc(clubDoc(ctx.clubId, 'events', e.id));
      await dropPublicAttendance(ctx.clubId, e.id);
      toast('Event deleted');
    };

    q('[data-save]').onclick = async () => {
      const title = q('#ed-title').value.trim();
      const day = q('#ed-date').value;
      const at = q('#ed-time').value || '00:00';
      if (!title) { toast('Give the event a name', 'error'); q('#ed-title').focus(); return; }
      if (!day) { toast('Pick a day', 'error'); return; }
      const base = {
        title,
        desc: q('#ed-desc').value.trim(),
        time: at,
        tag,
        durationMin: Math.max(5, parseInt(q('#ed-len').value, 10) || 60),
        updatedAt: Date.now()
      };
      const btn = q('[data-save]');
      btn.disabled = true;
      try {
        if (editing) {
          const payload = { ...base, date: new Date(`${day}T${at}`).getTime() };
          await updateDoc(clubDoc(ctx.clubId, 'events', e.id), payload);
          if (sync) sync.pushOne({ ...e, ...payload }).catch((err) => console.warn('calendar push', err));
          toast('Event updated', 'ok');
        } else {
          const count = repeat ? weeks : 1;
          const first = new Date(`${day}T${at}`);
          for (let i = 0; i < count; i++) {
            const when = new Date(first);
            when.setDate(first.getDate() + i * 7);
            const payload = { ...base, date: when.getTime(), createdAt: Date.now() };
            if (repeat) payload.series = `${first.getTime()}`;
            const id = (await addDoc(clubCol(ctx.clubId, 'events'), payload)).id;
            if (sync) sync.pushOne({ ...payload, id }).catch((err) => console.warn('calendar push', err));
          }
          toast(count > 1 ? `Added ${count} weekly events` : 'Event added', 'ok');
        }
        close();
      } catch (err) {
        console.error(err);
        toast('Could not save the event', 'error');
        btn.disabled = false;
      }
    };
  }

  if (isAdmin) {
    if (api && api.topbar) {
      api.topbar.innerHTML = '<button class="btn primary sm" id="ev-new">New event</button>';
      api.topbar.querySelector('#ev-new').onclick = () => openEditor();
    }
    // clicking an empty part of a day starts an event on that day
    grid.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-ev]')) return;
      const cell = ev.target.closest('[data-day]');
      if (cell) openEditor(null, cell.dataset.day);
    });
    wireAttendanceAdmin(ctx, host, () => events);
  }

  host.querySelector('#cal-prev').onclick = () => { month.setMonth(month.getMonth() - 1); paintCalendar(); };
  host.querySelector('#cal-next').onclick = () => { month.setMonth(month.getMonth() + 1); paintCalendar(); };

  /* Attached before the events listener so the first snapshot already has
     somewhere to put the Google rows, rather than painting twice. */
  sync = attachCalendarSync(ctx, host, {
    events: () => events,
    onChange: () => { paintCalendar(); paintUpcoming(); }
  });

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'events'), orderBy('date', 'asc')), (snap) => {
    events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    paintCalendar();
    paintUpcoming();
    paintAttSelect();
    if (!isAdmin) paintLiveAttendance(ctx, host, events);
    else {
      /* Two repairs an admin performs simply by having this page open: the
         public copy of every check-in that is open or about to be, and the
         points owed to everybody who checked in without an account. Neither
         is something anybody should have to remember to press. */
      publishOpenAttendance(ctx, events).catch(() => {});
      reconcileAttendance(ctx).catch(() => {});
    }
  }, (err) => {
    console.error(err);
    grid.innerHTML = '<div class="empty-state">Could not load events.</div>';
  });

  return () => { stop(); if (sync) sync.stop(); };
}

/* ── the member's own check-in ─────────────────────────────────────── */

/* The banner is a door, not a form. Whoever opens it — a member here, or
   somebody with no account at all on the same event's QR link — gets the
   same modal, drawn by the same code, so the two can never drift apart. */
async function paintLiveAttendance(ctx, host, events) {
  const slot = host.querySelector('#att-live');
  if (!slot) return;
  const live = events.find(isLive);
  if (!live) { slot.innerHTML = ''; return; }

  const [form, done] = await Promise.all([
    loadAttendanceForm(ctx, live.id),
    alreadyCheckedIn(ctx, live.id)
  ]);

  if (done) {
    slot.innerHTML = `<div class="att-banner done">
      <span class="att-ico">✓</span>
      <div><b>You're checked in for ${esc(live.title)}</b><small>Points have been added to your total.</small></div>
    </div>`;
    return;
  }

  const extra = form.questions.length;
  slot.innerHTML = `<div class="att-banner">
    <div class="att-banner-head">
      <span class="att-ico live">●</span>
      <div><b>${esc(live.title)} is happening now</b><small>Check in to earn ${form.points} points.</small></div>
    </div>
    <div class="att-banner-foot">
      <span class="att-banner-note">${extra
        ? `${extra} quick question${extra === 1 ? '' : 's'} to answer.`
        : 'Nothing to fill in — one tap and you are done.'}</span>
      <button class="btn primary" id="att-open">Check in</button>
    </div>
  </div>`;

  slot.querySelector('#att-open').onclick = () => openMemberAttendance(ctx, live, {
    form,
    onDone: () => paintLiveAttendance(ctx, host, events)
  });
}

/* ── admin attendance panel ────────────────────────────────────────── */

/* The three that are forced, and the one thing worth saying about them: a
   member is never asked, because the club already knows all three. */
const ATT_CORE_ROWS = [
  ['What is your first name?', 'Short answer'],
  ['What is your last name?', 'Short answer'],
  ['What is your email address?', 'Email address']
];

const attCoreHTML = ATT_CORE_ROWS.map(([label, type], i) => `
  <div class="reg-q is-core">
    <span class="reg-q-num">${i + 1}</span>
    <div class="reg-q-core">
      <b>${esc(label)}</b>
      <span class="reg-q-meta">${esc(type)} · Required · Only asked when signed out</span>
    </div>
    <span class="reg-built-in">Built in</span>
  </div>`).join('');

const respTag = (r) => {
  if (!r.guest) return '';
  if (r.duplicate) return '<span class="att-tag dup">Duplicate</span>';
  if (r.newUser) return '<span class="att-tag new">New user</span>';
  return '<span class="att-tag guest">Signed out</span>';
};

const respWhere = (r) => {
  if (!r.guest) return 'Member · points added';
  if (r.duplicate) return 'Already counted for this event';
  if (!r.awarded) return 'Points are queued — they land next time an admin opens the club';
  if (r.awardedTo === 'member') return 'Matched to a member · points added';
  return 'Held on their pending registration until they join';
};

function wireAttendanceAdmin(ctx, host, getEvents) {
  const sel = host.querySelector('#att-event');
  const panel = host.querySelector('#att-panel');
  if (!sel || !panel) return;

  sel.addEventListener('change', async () => {
    const id = sel.value;
    panel.hidden = !id;
    if (!id) return;
    panel.innerHTML = '<div class="empty-state">Loading…</div>';

    /* Anything a signed-out visitor checked into is settled before the list
       is drawn, so the numbers an admin is looking at are the real ones. */
    await reconcileAttendance(ctx).catch(() => {});

    const [formSnap, resSnap] = await Promise.all([
      getDoc(clubDoc(ctx.clubId, 'attendanceForms', id)),
      getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'), where('eventId', '==', id)))
    ]);
    const form = normalizeAttendanceForm(formSnap.exists() ? formSnap.data() : null);
    const responses = resSnap.docs.map((d) => d.data())
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    const counted = responses.filter((r) => !r.duplicate).length;

    panel.innerHTML = `
      <div class="att-admin">
        <section class="att-build">
          <div class="reg-head">
            <div>
              <h4>The check-in form</h4>
              <p class="muted reg-sub">Built exactly like your registration form. The three below are
                asked of anybody who is not signed in — a member never sees them, because the club
                already has their name and address.</p>
            </div>
            <div class="reg-head-actions">
              <button class="btn subtle sm" id="att-preview" type="button">Preview</button>
            </div>
          </div>

          <div class="att-pts-row">
            <div>
              <span class="adm-field-label">Points reward</span>
              <div class="att-pts-input">
                <input id="att-pts" type="number" min="0" value="${form.points}" />
                <span>per check-in</span>
              </div>
            </div>
            <p class="field-hint">Everyone who checks in gets this — members straight away, everybody
              else onto whichever account we can match them to.</p>
          </div>

          <div class="reg-stage">
            <div class="reg-list" id="att-qs"></div>
            <div class="reg-foot">
              <button class="btn subtle" id="att-add-q" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                Add a question
              </button>
              <span class="reg-dirty" id="att-dirty" hidden>Unsaved changes</span>
              <button class="btn primary" id="att-save" type="button">Save form</button>
            </div>
          </div>

          <button class="btn subtle block" id="att-share" style="margin-top:12px">Share link &amp; QR code</button>
          <p class="field-hint" style="margin-top:8px">Anybody can scan it — no account, no login.
            Members go straight to their check-in; everybody else fills in the three built-in
            questions and we match them to an account by email.</p>
        </section>

        <section class="att-resp">
          <div class="att-resp-head">
            <span class="adm-field-label">Check-ins</span>
            <span class="adm-att-badge">${counted}</span>
          </div>
          <div class="att-resp-list">${responses.length ? responses.map((r) => `
            <div class="adm-att-resp-row${r.duplicate ? ' is-dup' : ''}">
              <div class="adm-att-resp-user">
                <span class="adm-att-resp-name">${esc(
                  r.username || [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || r.userEmail || 'Member')}
                  ${respTag(r)}</span>
                <span class="adm-att-resp-time">${fmtTime(r.submittedAt || Date.now())}</span>
              </div>
              <div class="adm-att-resp-where">${esc(r.email || r.userEmail || '')}${
                (r.email || r.userEmail) ? ' · ' : ''}${esc(respWhere(r))}</div>
              ${(r.questions || []).map((q) => {
                const a = (r.answers || {})[q.id];
                if (a == null || a === '') return '';
                return `<div class="adm-att-answer"><span class="adm-att-q-label">${esc(q.label || 'Answer')}</span><span class="adm-att-a-text">${esc(answerText(q, a))}</span></div>`;
              }).join('')}
            </div>`).join('') : '<div class="empty-state">No check-ins yet.</div>'}</div>
        </section>
      </div>`;

    const dirtyFlag = panel.querySelector('#att-dirty');
    const addBtn = panel.querySelector('#att-add-q');
    const markDirty = (on = true) => { dirtyFlag.hidden = !on; };

    const editor = mountQuestionEditor(panel.querySelector('#att-qs'), {
      questions: form.questions,
      coreHTML: attCoreHTML,
      coreCount: ATT_CORE_ROWS.length,
      max: MAX_QUESTIONS,
      emptyHTML: `<div class="reg-none">No extra questions, which is the fastest a check-in can be:
        a member taps once and it is done. Add your own below if you want to ask something.</div>`,
      onDirty: () => markDirty(),
      onCount: (n) => { addBtn.disabled = n >= MAX_QUESTIONS; }
    });

    addBtn.onclick = () => editor.add();

    const currentForm = () => normalizeAttendanceForm({
      points: parseFloat(panel.querySelector('#att-pts').value) || 0,
      questions: editor.read()
    });

    panel.querySelector('#att-pts').oninput = () => markDirty();

    panel.querySelector('#att-preview').onclick = () => openAttendancePreview(ctx,
      getEvents().find((e) => e.id === id) || { id, title: 'This event' }, currentForm());

    panel.querySelector('#att-share').onclick = async () => {
      const event = getEvents().find((e) => e.id === id);
      if (!event) { toast('That event is no longer available.', 'error'); return; }
      /* The QR is only worth handing out if the public copy is there to meet
         it, so publishing happens here rather than on a button of its own. */
      const next = currentForm();
      await syncPublicAttendance({ id: ctx.clubId, ...ctx.club }, event, next);
      openAttendanceShare(ctx, event, next.points);
    };

    panel.querySelector('#att-save').onclick = async () => {
      const btn = panel.querySelector('#att-save');
      const next = currentForm();

      const blank = next.questions.find((q) => !q.label.trim());
      if (blank) { toast('Every question needs something to ask', 'error'); editor.paint(); return; }

      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await setDoc(clubDoc(ctx.clubId, 'attendanceForms', id), {
          eventId: id,
          points: next.points,
          questions: next.questions,
          updatedAt: Date.now()
        });
        const event = getEvents().find((e) => e.id === id);
        if (event && !hasPassed(event)) {
          await syncPublicAttendance({ id: ctx.clubId, ...ctx.club }, event, next);
        }
        markDirty(false);
        toast('Attendance form saved', 'ok');
      } catch (e) {
        console.error(e);
        toast('Could not save the form', 'error');
      }
      btn.disabled = false; btn.textContent = 'Save form';
    };
  });
}

/* The preview is the check-in, not a diagram of it: one form, drawn the way
   the real modal draws it — by looking at who is opening it and asking for
   what is missing. An admin is signed in, so that is what opens.

   The switch is there because the other answer is the one an admin cannot
   get to any other way: they cannot sign out to check their own form, and
   the three built-in questions only ever appear on that side. */
function openAttendancePreview(ctx, event, form) {
  let asGuest = !(ctx && ctx.user);

  const modal = el(`<div class="modal"><div class="modal-card reg-preview-card att-preview-card">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>What people see</h3>
    <p class="modal-meta" style="margin:0">The check-in for ${esc(event.title || 'this event')},
      worth ${esc(String(form.points))} point${form.points === 1 ? '' : 's'}. Nothing typed here is sent anywhere.</p>
    <div class="lb-tabs att-preview-switch">
      <button class="lb-tab" type="button" data-as="member">Signed in</button>
      <button class="lb-tab" type="button" data-as="guest">Signed out</button>
    </div>
    <p class="att-preview-note" data-note></p>
    <div class="reg-preview rf-form" data-form></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" data-x>Close preview</button></div>
  </div></div>`);

  document.body.appendChild(modal);

  const box = modal.querySelector('[data-form]');
  const note = modal.querySelector('[data-note]');

  const paint = () => {
    const questions = asGuest ? guestQuestions(form) : form.questions;
    modal.querySelectorAll('[data-as]').forEach((b) =>
      b.classList.toggle('on', (b.dataset.as === 'guest') === asGuest));

    note.textContent = asGuest
      ? 'First name, last name and email are asked first and cannot be removed. Their points go to whichever account that address belongs to.'
      : form.questions.length
        ? 'A member is asked your questions and nothing else — the club already has their name and address.'
        : 'A member is asked nothing at all, so the check-in completes on its own.';

    box.innerHTML = questions.length
      ? renderQuestions(questions)
      : '<div class="att-nothing">Nothing to fill in — the check-in completes on its own.</div>';
    wireForm(box);
  };

  modal.querySelectorAll('[data-as]').forEach((b) => (b.onclick = () => {
    asGuest = b.dataset.as === 'guest';
    paint();
  }));
  paint();

  const close = () => modal.remove();
  modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  modal.onclick = (e) => { if (e.target === modal) close(); };
}



/* ═══════════════════════════════════════════════════════════════════ */
/*  NEWSLETTERS                                                        */
/* ═══════════════════════════════════════════════════════════════════ */

async function renderNews(ctx, host) {
  const isAdmin = ctx.isAdmin;
  host.innerHTML = `
    ${isAdmin ? `
    <div class="tile" style="margin-bottom:16px">
      <h3 id="nw-form-title">Post an announcement</h3>
      <div class="form-inline">
        <input id="nw-title" placeholder="Subject" />
        <div class="rte-wrap">
          <div class="rte-toolbar">
            ${fontSelectHTML('nw-font')}
            <div class="rte-sep"></div>
            <button class="rte-btn" data-cmd="bold" title="Bold"><strong>B</strong></button>
            <button class="rte-btn" data-cmd="italic" title="Italic"><em>I</em></button>
            <button class="rte-btn" data-cmd="underline" title="Underline"><u>U</u></button>
            <div class="rte-sep"></div>
            <button class="rte-btn" data-cmd="insertUnorderedList" title="Bullets">•—</button>
            <button class="rte-btn" data-cmd="insertOrderedList" title="Numbers">1—</button>
            <div class="rte-sep"></div>
            <button class="rte-btn" data-link title="Link">🔗</button>
            <button class="rte-btn" data-emoji-btn title="Emoji" aria-label="Insert an emoji">🙂</button>
            <button class="rte-btn" data-cmd="removeFormat" title="Clear formatting">✕</button>
          </div>
          <div class="rte-editor" id="nw-body" contenteditable="true" data-placeholder="Write your announcement…"></div>
        </div>
        <div id="nw-mail"></div>
        <div class="row">
          <button class="btn primary" id="nw-post">Publish</button>
          <button class="btn subtle" id="nw-cancel" hidden>Cancel</button>
        </div>
      </div>
    </div>` : ''}
    <div class="stu-news-wrap" id="nw-list"></div>
    <div class="empty-state" id="nw-empty" hidden>No announcements yet.</div>`;

  let editingId = null;
  let mailField = null;
  let stopMembers = null;
  let stopApplicants = null;
  let stopEmoji = null;
  let stopFont = null;

  if (isAdmin) {
    host.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = (e) => {
      e.preventDefault();
      document.execCommand(b.dataset.cmd, false, null);
      host.querySelector('#nw-body').focus();
    }));
    /* It listens for the selection moving, on the document, so leaving the
       page has to take the listener with it. */
    stopFont = wireFontSelect(host.querySelector('#nw-font'), host.querySelector('#nw-body'));

    host.querySelector('[data-link]').onclick = async (e) => {
      e.preventDefault();
      const url = await promptDialog({ title: 'Insert link', label: 'URL', placeholder: 'https://', confirmText: 'Insert' });
      if (url) document.execCommand('createLink', false, url);
    };

    /* insertText rather than innerHTML, so the emoji lands at the caret and
       one undo takes it back out again */
    stopEmoji = mountEmojiButton(host.querySelector('[data-emoji-btn]'), (emoji) => {
      const editor = host.querySelector('#nw-body');
      editor.focus();
      if (!document.execCommand('insertText', false, emoji)) editor.append(emoji);
    });
    /* The optional "email this out" field. Two rosters feed it: the club's
       members, and the people waiting on an invite — who are not members
       and have no account, but are exactly who an announcement about the
       club is often for. @pending is how you reach them. */
    let members = [];
    let applicants = [];
    mailField = mountNewsletterMail(host.querySelector('#nw-mail'), {
      getPeople: () => members.map((m) => ({
        email: m.email,
        name: m.username,
        role: m.role || 'student',
        avatarColor: m.avatarColor,
      })),
      getPending: () => applicants.map((a) => ({
        email: a.email,
        name: [a.firstName, a.lastName].filter(Boolean).join(' ').trim(),
      })),
      getMe: () => ctx.user.email || '',
      getClubName: () => ctx.club?.name || '',
      /* clubPhoto, not club.photo: the stored string is writable by staff
         and mirrored where the whole internet reads it, so it is checked
         for the shape of an image before it is put in front of anybody. */
      getClubLogo: () => clubPhoto(ctx.club) || '',
      getClubIcon: () => ctx.club?.icon || '',
      getClubColor: () => ctx.club?.color || '',
      addAllLabel: `Add all ${ctx.club?.name || 'club'} students`,
    });

    stopMembers = onSnapshot(clubCol(ctx.clubId, 'members'), (s) => {
      members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      mailField.refresh();
    });

    /* Anybody here who has since joined is filtered out by the field
       itself, so both halves can be handed over raw. */
    stopApplicants = onSnapshot(applicationCol(ctx.clubId), (s) => {
      applicants = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      mailField.refresh();
    }, (e) => console.warn('newsletter applications listener', e));

    const resetForm = () => {
      editingId = null;
      host.querySelector('#nw-title').value = '';
      host.querySelector('#nw-body').innerHTML = '';
      host.querySelector('#nw-form-title').textContent = 'Post an announcement';
      host.querySelector('#nw-post').textContent = 'Publish';
      host.querySelector('#nw-cancel').hidden = true;
      mailField.reset();
    };

    host.querySelector('#nw-post').onclick = async () => {
      const postBtn = host.querySelector('#nw-post');
      const title = host.querySelector('#nw-title').value.trim();
      const body = host.querySelector('#nw-body').innerHTML.trim();
      if (!title) { toast('Give it a subject', 'error'); return; }

      const emailing = mailField.enabled;
      if (emailing) mailField.flush();
      if (emailing && !mailField.recipients.length) {
        mailField.status('Add at least one recipient, or switch off "Email this to students".', 'warn');
        return;
      }

      postBtn.disabled = true;
      postBtn.textContent = emailing ? 'Sending…' : 'Publishing…';

      try {
        if (editingId) await updateDoc(clubDoc(ctx.clubId, 'announcements', editingId), { title, body, updatedAt: Date.now() });
        else await addDoc(clubCol(ctx.clubId, 'announcements'), { title, body, createdAt: Date.now(), authorName: ctx.member.username || '' });

        if (emailing) {
          // The post is already saved, so a mail failure leaves the form up
          // with the recipient list intact rather than losing the announcement.
          const sent = await mailField.send(title, body);
          resetForm();
          mailField.status(`Posted and emailed to ${sent.sent} recipient${sent.sent === 1 ? '' : 's'}.`, 'ok');
          toast(`Published and emailed to ${sent.sent}`, 'ok');
        } else {
          resetForm();
          toast('Published', 'ok');
        }
      } catch (e) {
        console.error(e);
        if (emailing) {
          mailField.status(`Posted, but the email did not go out — ${e.message}`, 'error');
          toast('Posted, but the email failed', 'error');
        } else {
          toast('Could not publish', 'error');
        }
      } finally {
        postBtn.disabled = false;
        postBtn.textContent = editingId ? 'Save changes' : 'Publish';
      }
    };
    host.querySelector('#nw-cancel').onclick = resetForm;
  }

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'announcements'), orderBy('createdAt', 'desc')), (s) => {
    const rows = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    host.querySelector('#nw-empty').hidden = rows.length > 0;
    host.querySelector('#nw-list').innerHTML = rows.map((n) => `
      <article class="news-card">
        <div class="news-card-header">
          <span class="news-card-date">${fmtDate(n.createdAt)}</span>
          ${isAdmin ? `<span class="news-card-actions">
            <button class="btn subtle sm" data-edit="${esc(n.id)}">Edit</button>
            <button class="btn danger sm" data-del="${esc(n.id)}">Delete</button></span>` : ''}
        </div>
        <h3 class="news-card-title">${esc(n.title)}</h3>
        <div class="news-card-body">${n.body || ''}</div>
      </article>`).join('');

    if (!isAdmin) return;
    host.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
      const n = rows.find((x) => x.id === b.dataset.edit);
      editingId = n.id;
      host.querySelector('#nw-title').value = n.title || '';
      host.querySelector('#nw-body').innerHTML = n.body || '';
      host.querySelector('#nw-form-title').textContent = 'Edit announcement';
      host.querySelector('#nw-post').textContent = 'Save changes';
      host.querySelector('#nw-cancel').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      host.querySelector('#nw-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!await confirmDialog({ title: 'Delete announcement?', body: 'It disappears for everyone.', confirmText: 'Delete', danger: true })) return;
      await deleteDoc(clubDoc(ctx.clubId, 'announcements', b.dataset.del));
      toast('Deleted');
    }));
  });

  return () => {
    stop();
    if (stopMembers) stopMembers();
    if (stopApplicants) stopApplicants();
    if (mailField) mailField.destroy();
    if (stopEmoji) stopEmoji();
    if (stopFont) stopFont();
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  LEADERBOARD                                                        */
/* ═══════════════════════════════════════════════════════════════════ */

const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 12S6 5.4 12 5.4 21.6 12 21.6 12 18 18.6 12 18.6 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="2.9"/></svg>';
const SWORD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 14.6 20 9.2V4h-5.2l-5.4 5.4"/><path d="m9.4 14.6-5.4-5.4V4h5.2l5.4 5.4"/><path d="m13 16.4 3.4 3.4M11 16.4l-3.4 3.4"/></svg>';

async function renderLeaderboard(ctx, host) {
  const staffHidden = ctx.club.hideStaffFromLeaderboard === true;
  let tab = 'points';
  let members = [];
  let games = [];
  /* uid → the user profile, which is where a global rating and a global
     record live. Loaded lazily, because the points tab never needs them. */
  let profiles = null;

  host.innerHTML = `
    <div class="lb-tabs">
      <button class="lb-tab on" data-t="points">Points</button>
      <button class="lb-tab" data-t="club">Club rating</button>
      <button class="lb-tab" data-t="global">Global rating</button>
    </div>
    ${ctx.isAdmin ? `
    <div class="tile lb-setting">
      <div>
        <b>Hide staff from the leaderboard</b>
        <small>Admins and the founder are left out of the ranking, so the board is a student contest.</small>
      </div>
      <label class="switch">
        <input type="checkbox" id="lb-hide" ${staffHidden ? 'checked' : ''} />
        <span class="switch-track"><span class="switch-knob"></span></span>
      </label>
    </div>` : ''}
    <div class="tile lb-tile">
      <div class="lb-row lb-row-head has-duel">
        <span class="lb-col-rank">Rank</span>
        <span class="lb-col-player">Player</span>
        <span class="lb-col-pts" id="lb-metric">Points</span>
        <span class="lb-col-wdl">W / D / L</span>
        <span></span>
      </div>
      <div id="lb-list"></div>
      <div class="empty-state" id="lb-empty" hidden>No members yet.</div>
    </div>`;

  const toggle = host.querySelector('#lb-hide');
  if (toggle) toggle.onchange = async () => {
    try {
      await updateDoc(clubRef(ctx.clubId), { hideStaffFromLeaderboard: toggle.checked });
      ctx.club.hideStaffFromLeaderboard = toggle.checked;
      paint();
      toast(toggle.checked ? 'Staff hidden from the leaderboard' : 'Staff shown on the leaderboard', 'ok');
    } catch (e) {
      console.error(e);
      toggle.checked = !toggle.checked;
      toast('Could not save that setting', 'error');
    }
  };

  host.querySelector('.lb-tabs').onclick = async (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    tab = b.dataset.t;
    host.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('on', t.dataset.t === tab));
    host.querySelector('#lb-metric').textContent = tab === 'points' ? 'Points' : 'Rating';
    if (tab === 'global') await loadProfiles();
    paint();
  };

  /* Global numbers are not on the member row, so they come from the user
     profiles — one read for the whole club, and only when asked for. */
  async function loadProfiles() {
    if (profiles) return;
    profiles = {};
    try {
      const snap = await getDocs(query(collection(db, 'users'), limit(300)));
      snap.docs.forEach((d) => { profiles[d.id] = d.data(); });
    } catch (e) {
      console.warn('Could not load global ratings', e);
    }
  }

  /* Which document a row's rating and record should be read from. */
  const sourceOf = (m) =>
    tab === 'global' ? ((profiles && profiles[m.uid]) || {}) : m;

  function ordered() {
    const rows = members
      .filter((m) => !m.deleted)
      .filter((m) => !(ctx.club.hideStaffFromLeaderboard && isStaff(m.role)));
    if (tab === 'points') return rows.sort((a, b) => (b.points || 0) - (a.points || 0));
    // an unplayed 1000 says nothing, so provisional players sit below the ranked ones
    return rows.sort((a, b) => {
      const ra = readRating(sourceOf(a));
      const rb = readRating(sourceOf(b));
      if ((ra.games < 1) !== (rb.games < 1)) return ra.games < 1 ? 1 : -1;
      return rb.r - ra.r;
    });
  }

  function paint() {
    const rows = ordered();
    host.querySelector('#lb-empty').hidden = rows.length > 0;
    host.querySelector('#lb-list').innerHTML = rows.map((m, i) => {
      const me = m.uid === ctx.user.uid;
      const medal = i === 0 ? 'lb-rank-gold' : i === 1 ? 'lb-rank-silver' : i === 2 ? 'lb-rank-bronze' : '';
      const src = sourceOf(m);
      const rating = readRating(src);
      const rec = readRecord(src);
      const metric = tab === 'points'
        ? `${m.points || 0}`
        : `<span class="${rating.games < 1 ? 'lb-provisional' : ''}">${displayRating(src.rating)}</span>
           <span class="lb-rating-games">${rating.games} game${rating.games === 1 ? '' : 's'}</span>`;

      // both buttons are conditional: watch needs a game in progress, duel
      // needs somebody other than you who is free to play
      const live = gameOf(games, m.uid);
      const actions = [
        live ? `<button class="lb-mini watch" data-watch="${esc(live.id)}">${EYE_SVG}Watch</button>` : '',
        !me && !live ? `<button class="lb-mini" data-duel="${esc(m.uid)}">${SWORD_SVG}Duel</button>` : ''
      ].filter(Boolean).join('');

      return `<div class="lb-row has-duel${me ? ' lb-row-me' : ''}">
        <span class="lb-col-rank ${medal}">${i + 1}</span>
        <span class="lb-col-player">
          <span class="lb-avatar" style="background:${esc(m.avatarColor || '#2e90fa')}">${esc(initials(m.username || m.email))}</span>
          <span class="lb-player-info">
            <span class="lb-player-name">${esc(m.username || 'Player')}${me ? '<span class="lb-me-badge">You</span>' : ''}${isStaff(m.role) ? `<span class="role-pill ${esc(m.role)}" style="margin-left:8px">${esc(ROLE_LABEL[m.role])}</span>` : ''}</span>
            <span class="lb-player-email">${esc(m.email || '')}</span>
          </span>
        </span>
        <span class="lb-col-pts">${metric}</span>
        <span class="lb-col-wdl">${rec.w} / ${rec.d} / ${rec.l}</span>
        <span class="lb-row-actions">${actions}</span>
      </div>`;
    }).join('');

    host.querySelectorAll('[data-watch]').forEach((b) => {
      b.onclick = () => { location.hash = 'duel/' + b.dataset.watch; };
    });
    host.querySelectorAll('[data-duel]').forEach((b) => {
      b.onclick = () => {
        setDuelIntent({ scope: 'club', opponent: b.dataset.duel });
        location.hash = duelsHash(ctx);
      };
    });
  }

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'members'), orderBy('points', 'desc')), (s) => {
    members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    paint();
  });

  const stopGames = watchActiveDuels((rows) => { games = rows; paint(); });

  return () => { stop(); stopGames(); };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  STORE                                                              */
/* ═══════════════════════════════════════════════════════════════════ */

const cartKey = (clubId) => `jag-cart-${clubId}`;
const getCart = (clubId) => { try { return JSON.parse(localStorage.getItem(cartKey(clubId))) || []; } catch { return []; } };
const setCart = (clubId, c) => localStorage.setItem(cartKey(clubId), JSON.stringify(c));

async function renderStore(ctx, host, api) {
  return ctx.isAdmin && ctx.mode !== 'member' ? storeAdmin(ctx, host) : storeMember(ctx, host);
}

async function storeMember(ctx, host) {
  host.innerHTML = `
    <div class="st">
      <header class="st-head">
        <div>
          <h2>Rewards store</h2>
          <p>Spend the points you have earned in ${esc(ctx.club.name || 'this club')}.</p>
        </div>
        <div class="st-head-right">
          <span class="st-balance"><b id="st-pts">0</b> points available</span>
          <button class="btn blue st-cart-btn" id="st-cart">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.4 8h13.2l-1.1 12.2H6.5Z"/><path d="M9 8V5.9a3 3 0 0 1 6 0V8"/></svg>
            Cart<span class="st-badge" id="st-badge" hidden>0</span>
          </button>
        </div>
      </header>

      <div class="st-grid" id="st-grid"></div>
      <div class="st-empty" id="st-empty" hidden>
        <span>🎁</span>
        <b>The store is empty</b>
        <small>Once an admin adds rewards, they show up here.</small>
      </div>

      <section class="tile st-orders">
        <h3>Your orders</h3>
        <div id="st-orders"></div>
        <div class="empty-state" id="st-orders-empty">Nothing ordered yet.</div>
      </section>
    </div>`;

  let items = [];
  const balance = () => ctx.member.points || 0;

  const paintBalance = () => {
    host.querySelector('#st-pts').textContent = balance().toLocaleString();
    const n = getCart(ctx.clubId).reduce((s, i) => s + (i.qty || 1), 0);
    const badge = host.querySelector('#st-badge');
    badge.hidden = n === 0;
    badge.textContent = n;
  };

  const paintGrid = () => {
    host.querySelector('#st-empty').hidden = items.length > 0;
    const cart = getCart(ctx.clubId);
    host.querySelector('#st-grid').innerHTML = items.map((it) => {
      const out = it.stock !== null && it.stock !== undefined && it.stock <= 0;
      const inCart = !!cart.find((c) => c.id === it.id);
      const afford = balance() >= it.pointCost;
      return `<article class="st-card${out ? ' is-out' : ''}">
        <div class="st-media">
          ${it.imageBase64 ? `<img src="${esc(it.imageBase64)}" alt="">` : '<span>🎁</span>'}
          ${out ? '<div class="st-out">Out of stock</div>' : ''}
        </div>
        <div class="st-body">
          <h4>${esc(it.name)}</h4>
          ${it.description ? `<p>${esc(it.description)}</p>` : '<p class="st-nodesc">&nbsp;</p>'}
          <div class="st-meta">
            <span class="st-cost${afford ? '' : ' short'}">${it.pointCost.toLocaleString()} pts</span>
            <span class="st-stock">${it.stock == null ? 'Unlimited' : it.stock + ' left'}</span>
          </div>
          ${out
            ? '<button class="btn subtle block" disabled>Unavailable</button>'
            : inCart
              ? `<button class="btn block st-in-cart" data-rm="${esc(it.id)}">In cart — remove</button>`
              : afford
                ? `<button class="btn primary block" data-add="${esc(it.id)}">Add to cart</button>`
                : `<button class="btn subtle block" disabled>Need ${(it.pointCost - balance()).toLocaleString()} more points</button>`}
        </div>
      </article>`;
    }).join('');

    host.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
      const it = items.find((x) => x.id === b.dataset.add);
      const cart = getCart(ctx.clubId);
      cart.push({ id: it.id, name: it.name, pointCost: it.pointCost, qty: 1 });
      setCart(ctx.clubId, cart);
      paintBalance(); paintGrid();
      toast('Added to cart');
    }));
    host.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
      setCart(ctx.clubId, getCart(ctx.clubId).filter((c) => c.id !== b.dataset.rm));
      paintBalance(); paintGrid();
    }));
  };

  host.querySelector('#st-cart').onclick = () => openCart(ctx, items, () => { paintBalance(); paintGrid(); });

  const stopItems = onSnapshot(clubCol(ctx.clubId, 'shopItems'), (s) => {
    items = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.available !== false);
    paintBalance(); paintGrid();
  });

  const stopOrders = onSnapshot(query(clubCol(ctx.clubId, 'shopOrders'), where('userId', '==', ctx.user.uid)), (s) => {
    const rows = s.docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt);
    host.querySelector('#st-orders-empty').hidden = rows.length > 0;
    host.querySelector('#st-orders').innerHTML = rows.map((o) => `
      <div class="st-order">
        <span class="st-order-ico">🎁</span>
        <div class="st-order-info">
          <div class="st-order-name">${esc((o.items || []).map((i) => i.name).join(', '))}</div>
          <div class="st-order-meta">${fmtDate(o.createdAt)} · ${o.totalCost} pts</div>
        </div>
        <span class="order-pill ${esc(o.status || 'pending')}">${esc(o.status || 'pending')}</span>
      </div>`).join('');
  });

  return () => { stopItems(); stopOrders(); };
}

const balanceOf = (ctx) => (ctx.member.points || 0).toLocaleString();

function openCart(ctx, items, refresh) {
  const cart = getCart(ctx.clubId);
  const total = cart.reduce((s, i) => s + i.pointCost * (i.qty || 1), 0);
  const afford = (ctx.member.points || 0) >= total;

  const m = el(`<div class="modal"><div class="modal-card" style="max-width:480px">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>Your cart</h3>
    <div>${cart.length ? cart.map((c, i) => `
      <div class="st-cart-row">
        <span class="st-cart-thumb">🎁</span>
        <span class="st-cart-name">${esc(c.name)}</span>
        <span class="st-cart-cost">${c.pointCost} pts</span>
        <button class="st-cart-x" data-ri="${i}" aria-label="Remove">×</button>
      </div>`).join('') : '<div class="empty-state">Your cart is empty.</div>'}</div>
    <div class="st-cart-total"><span>Total</span><span>${total} pts</span></div>
    ${!afford && cart.length ? '<p style="font-size:13px;color:var(--red-dark);margin:0">That is more than your ' + balanceOf(ctx) + ' points.</p>' : ''}
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn subtle" data-x>Close</button>
      <button class="btn primary" data-confirm ${!cart.length || !afford ? 'disabled' : ''}>Place order</button>
    </div></div></div>`);

  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelectorAll('[data-ri]').forEach((b) => (b.onclick = () => {
    const c = getCart(ctx.clubId);
    c.splice(+b.dataset.ri, 1);
    setCart(ctx.clubId, c);
    close(); refresh(); openCart(ctx, items, refresh);
  }));

  const confirmBtn = m.querySelector('[data-confirm]');
  if (confirmBtn) confirmBtn.onclick = async () => {
    confirmBtn.disabled = true; confirmBtn.textContent = 'Placing…';
    try {
      await addDoc(clubCol(ctx.clubId, 'shopOrders'), {
        userId: ctx.user.uid,
        userEmail: ctx.user.email || '',
        username: ctx.member.username || '',
        items: cart.map((i) => ({ id: i.id, name: i.name, pointCost: i.pointCost, qty: i.qty || 1 })),
        totalCost: total,
        status: 'pending',
        createdAt: Date.now()
      });
      setCart(ctx.clubId, []);
      close(); refresh();
      toast('Order placed — an admin will verify it', 'ok');
    } catch (e) {
      console.error(e);
      toast('Could not place the order', 'error');
      confirmBtn.disabled = false; confirmBtn.textContent = 'Place order';
    }
  };
}

async function storeAdmin(ctx, host) {
  host.innerHTML = `
    <div class="tile">
      <div class="shop-orders-head"><h3 style="margin:0">Store items</h3>
        <button class="btn primary sm" id="st-new">+ New item</button></div>
      <div class="shop-items-grid" id="st-items"></div>
      <div class="empty-state" id="st-items-empty" hidden>No items yet.</div>
    </div>
    <div class="tile" style="margin-top:16px">
      <div class="shop-orders-head">
        <div><h3 style="margin:0">Orders</h3>
          <p class="muted" style="font-size:13px;margin:3px 0 0">Verify a purchase to deduct the member's points.</p></div>
        <div style="display:flex;gap:7px">
          <button class="btn subtle sm shop-orders-filter active" data-f="pending">Pending</button>
          <button class="btn subtle sm shop-orders-filter" data-f="verified">Verified</button>
          <button class="btn subtle sm shop-orders-filter" data-f="all">All</button>
        </div>
      </div>
      <div id="st-orders"></div>
      <div class="empty-state" id="st-orders-empty" hidden>Nothing here.</div>
    </div>`;

  let filter = 'pending';
  let orders = [];

  const paintOrders = () => {
    const rows = orders.filter((o) => filter === 'all' || (o.status || 'pending') === filter);
    host.querySelector('#st-orders-empty').hidden = rows.length > 0;
    host.querySelector('#st-orders').innerHTML = rows.map((o) => `
      <div class="order-row">
        <div>
          <div class="order-user-name">${esc(o.username || o.userEmail || 'Member')}</div>
          <div class="order-items-list">${esc((o.items || []).map((i) => `${i.name} ×${i.qty || 1}`).join(', '))}</div>
        </div>
        <div class="order-meta-row">
          <span class="order-cost-pill">${o.totalCost} pts</span>
          <span class="order-status-pill ${esc(o.status || 'pending')}">${esc(o.status || 'pending')}</span>
        </div>
        <div class="order-actions">
          ${(o.status || 'pending') === 'pending' ? `
            <button class="btn primary sm" data-v="${esc(o.id)}">Verify</button>
            <button class="btn danger sm" data-r="${esc(o.id)}">Reject</button>` : ''}
        </div>
      </div>`).join('');

    host.querySelectorAll('[data-v]').forEach((b) => (b.onclick = async () => {
      const o = orders.find((x) => x.id === b.dataset.v);
      b.disabled = true;
      try {
        await updateDoc(memberRef(ctx.clubId, o.userId), { points: increment(-o.totalCost) });
        await updateDoc(clubDoc(ctx.clubId, 'shopOrders', o.id), { status: 'verified', verifiedAt: Date.now() });
        toast('Order verified', 'ok');
      } catch (e) { console.error(e); toast('Could not verify', 'error'); b.disabled = false; }
    }));
    host.querySelectorAll('[data-r]').forEach((b) => (b.onclick = async () => {
      await updateDoc(clubDoc(ctx.clubId, 'shopOrders', b.dataset.r), { status: 'rejected', rejectedAt: Date.now() });
      toast('Order rejected');
    }));
  };

  host.querySelectorAll('.shop-orders-filter').forEach((b) => (b.onclick = () => {
    filter = b.dataset.f;
    host.querySelectorAll('.shop-orders-filter').forEach((o) => o.classList.toggle('active', o === b));
    paintOrders();
  }));

  host.querySelector('#st-new').onclick = () => openItemEditor(ctx, null);

  const stopItems = onSnapshot(clubCol(ctx.clubId, 'shopItems'), (s) => {
    const items = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    host.querySelector('#st-items-empty').hidden = items.length > 0;
    host.querySelector('#st-items').innerHTML = items.map((it) => `
      <div class="shop-item-card">
        ${it.imageBase64 ? `<img class="shop-item-thumb" src="${esc(it.imageBase64)}" alt="">`
          : '<div class="shop-item-thumb-placeholder">🎁</div>'}
        <div class="shop-item-meta">
          <div class="shop-item-meta-name">${esc(it.name)}</div>
          <div class="shop-item-meta-cost">${it.pointCost} pts · ${it.stock == null ? '∞' : it.stock} left</div>
          <div style="display:flex;gap:6px;margin-top:9px">
            <button class="btn subtle sm" data-e="${esc(it.id)}">Edit</button>
            <button class="btn danger sm" data-d="${esc(it.id)}">✕</button>
          </div>
        </div>
      </div>`).join('');

    host.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => openItemEditor(ctx, items.find((x) => x.id === b.dataset.e))));
    host.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => {
      if (!await confirmDialog({ title: 'Delete item?', body: 'It is removed from the store.', confirmText: 'Delete', danger: true })) return;
      await deleteDoc(clubDoc(ctx.clubId, 'shopItems', b.dataset.d));
      toast('Item deleted');
    }));
  });

  const stopOrders = onSnapshot(clubCol(ctx.clubId, 'shopOrders'), (s) => {
    orders = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
    paintOrders();
  });

  return () => { stopItems(); stopOrders(); };
}

function openItemEditor(ctx, item) {
  let img = item ? item.imageBase64 || null : null;
  const m = el(`<div class="modal"><div class="modal-card" style="max-width:460px">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>${item ? 'Edit item' : 'New store item'}</h3>
    <div class="shop-img-picker" data-pick>${img ? `<img src="${esc(img)}" alt="">` : '<div style="color:var(--muted);font-size:13px">Click to add an image</div>'}</div>
    <input type="file" accept="image/*" data-file hidden />
    <div class="form-inline">
      <input data-name placeholder="Item name" value="${item ? esc(item.name) : ''}" />
      <textarea data-desc rows="2" placeholder="Description (optional)">${item ? esc(item.description || '') : ''}</textarea>
      <input data-stock type="number" min="0" placeholder="Stock (blank = unlimited)" value="${item && item.stock != null ? item.stock : ''}" />
      <input data-cost type="number" min="1" placeholder="Point cost" value="${item ? item.pointCost : ''}" />
      <button class="btn primary block" data-save>${item ? 'Save changes' : 'Add item'}</button>
    </div></div></div>`);

  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('[data-x]').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };

  const file = m.querySelector('[data-file]');
  m.querySelector('[data-pick]').onclick = () => file.click();
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 700000) { toast('Pick an image under 700 KB', 'error'); return; }
    const r = new FileReader();
    r.onload = () => {
      img = r.result;
      m.querySelector('[data-pick]').innerHTML = `<img src="${img}" alt="">`;
    };
    r.readAsDataURL(f);
  };

  m.querySelector('[data-save]').onclick = async () => {
    const name = m.querySelector('[data-name]').value.trim();
    const cost = parseInt(m.querySelector('[data-cost]').value, 10);
    if (!name || !cost || cost < 1) { toast('A name and point cost are required', 'error'); return; }
    const stockRaw = m.querySelector('[data-stock]').value.trim();
    const payload = {
      name,
      description: m.querySelector('[data-desc]').value.trim(),
      pointCost: cost,
      stock: stockRaw === '' ? null : parseInt(stockRaw, 10),
      imageBase64: img || null
    };
    try {
      if (item) await updateDoc(clubDoc(ctx.clubId, 'shopItems', item.id), payload);
      else await addDoc(clubCol(ctx.clubId, 'shopItems'), { ...payload, available: true, createdAt: Date.now() });
      close();
      toast(item ? 'Item updated' : 'Item added', 'ok');
    } catch (e) { console.error(e); toast('Could not save the item', 'error'); }
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  DONATE                                                             */
/* ═══════════════════════════════════════════════════════════════════ */

async function renderDonate(ctx, host) {
  host.innerHTML = `
    <div class="tile donate-card">
      <span class="donate-ico">💛</span>
      <h3>Support ${esc(ctx.club.name || 'the club')}</h3>
      <p>Donations help fund equipment, coaching and tournament travel for every member of the team.
         Every contribution goes straight back into the club.</p>
      <button class="btn primary lg" disabled>Donate (coming soon)</button>
      ${ctx.isAdmin ? '<p class="muted" style="font-size:13px;margin-top:14px">Payment processing isn\'t connected yet — this page is a placeholder your members can already see.</p>' : ''}
    </div>`;
  return noop;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  PROFILE                                                            */
/* ═══════════════════════════════════════════════════════════════════ */

async function renderProfile(ctx, host) {
  const m = ctx.member;

  // rank and solved count give the page something to actually say
  let rank = 0, solved = 0;
  try {
    const [mem, att] = await Promise.all([
      getDocs(query(clubCol(ctx.clubId, 'members'), orderBy('points', 'desc'))),
      getDocs(query(clubCol(ctx.clubId, 'puzzleAttempts'), where('userId', '==', ctx.user.uid)))
    ]);
    rank = mem.docs.findIndex((d) => d.id === ctx.user.uid) + 1;
    solved = att.size;
  } catch (e) { console.warn(e); }

  // there is no global leaderboard page yet, so the global standing lives here
  const ratings = await loadMyRatings(ctx);
  let globalRank = 0;
  if (ratings.global.games > 0) {
    try {
      const all = await getDocs(query(collection(db, 'users'), limit(500)));
      const ranked = all.docs
        .map((d) => ({ uid: d.id, ...readRating(d.data()) }))
        .filter((u) => u.games > 0)
        .sort((a, b) => b.r - a.r);
      globalRank = ranked.findIndex((u) => u.uid === ctx.user.uid) + 1;
    } catch (e) { console.warn('Could not work out the global rank', e); }
  }

  host.innerHTML = `
    <div class="pf">
      <section class="tile pf-hero">
        <div class="pf-avatar" id="pf-avatar" style="background:${esc(m.avatarColor || '#2e90fa')}">${esc(initials(m.username))}</div>
        <div class="pf-id">
          <h2 id="pf-name">${esc(m.username || 'Player')}</h2>
          <div class="pf-mail">${esc(m.email || ctx.user.email || '')}</div>
          <div class="pf-pills">
            <span class="role-pill ${m.role === 'admin' ? 'admin' : ''}">${m.role === 'admin' ? 'Admin' : 'Student'}</span>
            <span class="role-pill">Member since ${fmtDate(m.joinedAt || Date.now(), { month: 'short', year: 'numeric' })}</span>
          </div>
        </div>
      </section>

      <div class="pf-stats">
        <div class="tile pf-stat"><span class="pf-stat-ico gold">★</span>
          <div><b id="pf-pts">${m.points || 0}</b><small>Points</small></div></div>
        <div class="tile pf-stat"><span class="pf-stat-ico orange">🔥</span>
          <div><b>${m.currentStreak || 0}</b><small>Week streak</small></div></div>
        <div class="tile pf-stat"><span class="pf-stat-ico blue">#</span>
          <div><b>${rank || '—'}</b><small>Club rank</small></div></div>
        <div class="tile pf-stat"><span class="pf-stat-ico green">♟</span>
          <div><b>${solved}</b><small>Puzzles solved</small></div></div>
      </div>

      <section class="tile">
        <h3>Chess ratings</h3>
        <p class="pf-hint" style="margin:2px 0 14px">Glicko-2, the same system lichess runs. Everyone starts at 1000, shown as “?” until your first rated game.</p>
        <div class="profile-ratings">
          <div class="profile-rating">
            <span class="profile-rating-num">${displayRating(m.rating)}</span>
            <span class="profile-rating-label">${esc(ctx.club.name || 'Club')} rating</span>
            <span class="profile-rating-sub">${ratings.club.games} rated game${ratings.club.games === 1 ? '' : 's'} in this club</span>
          </div>
          <div class="profile-rating">
            <span class="profile-rating-num">${displayRating(ratings.global)}</span>
            <span class="profile-rating-label">Global rating</span>
            <span class="profile-rating-sub">${ratings.global.games} rated game${ratings.global.games === 1 ? '' : 's'}${globalRank ? ` · ranked #${globalRank} worldwide` : ''}</span>
          </div>
        </div>
      </section>

      <section class="tile pf-edit">
        <h3>Appearance</h3>
        <div class="pf-field">
          <label>Avatar color</label>
          <div class="pf-palette" id="pf-palette"></div>
        </div>
        <div class="pf-field">
          <label for="pf-input">Display name</label>
          <div class="pf-name-row">
            <input id="pf-input" value="${esc(m.username || '')}" placeholder="Your name in this club" />
            <button class="btn primary" id="pf-save">Save changes</button>
          </div>
          <p class="pf-hint">This is the name other members see on the leaderboard.</p>
        </div>
      </section>

      <section class="tile pf-danger">
        <h3>Membership</h3>
        <p>Your points, streak and puzzle history belong to
           ${esc(ctx.club.name || 'this club')} alone — joining another club starts you fresh there.</p>
        <button class="btn danger" id="pf-leave">Leave this club</button>
      </section>
    </div>`;

  let color = m.avatarColor || '#2e90fa';
  const palette = host.querySelector('#pf-palette');
  palette.innerHTML = CLUB_COLORS.map((c) =>
    `<button class="pf-swatch${c === color ? ' on' : ''}" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('');
  palette.onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    color = b.dataset.c;
    palette.querySelectorAll('.pf-swatch').forEach((s) => s.classList.toggle('on', s === b));
    host.querySelector('#pf-avatar').style.background = color;
  };

  host.querySelector('#pf-save').onclick = async () => {
    const btn = host.querySelector('#pf-save');
    const username = host.querySelector('#pf-input').value.trim();
    if (!username) { toast('Pick a display name', 'error'); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await updateDoc(memberRef(ctx.clubId, ctx.user.uid), { username, avatarColor: color });
      ctx.member.username = username;
      ctx.member.avatarColor = color;
      host.querySelector('#pf-name').textContent = username;
      host.querySelector('#pf-avatar').textContent = initials(username);
      document.getElementById('me-name').textContent = username;
      const av = document.getElementById('me-avatar');
      av.textContent = initials(username);
      av.style.background = color;
      toast('Profile updated', 'ok');
    } catch (e) { console.error(e); toast('Could not save', 'error'); }
    btn.disabled = false; btn.textContent = 'Save changes';
  };

  host.querySelector('#pf-leave').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Leave this club?',
      body: 'You will lose access to its pages. Your points stay saved if you rejoin later.',
      confirmText: 'Leave club', danger: true
    });
    if (!ok) return;
    try {
      await deleteDoc(memberRef(ctx.clubId, ctx.user.uid));
      await setDoc(doc(db, 'users', ctx.user.uid), { clubs: { [ctx.clubId]: null } }, { merge: true });
      location.href = '/clubs';
    } catch (e) { console.error(e); toast('Could not leave the club', 'error'); }
  };

  return noop;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  MEMBERS (admin)                                                    */
/* ═══════════════════════════════════════════════════════════════════ */

async function renderMembers(ctx, host) {
  const myRole = ctx.member.role;

  host.innerHTML = `
    <div class="users-toolbar">
      <span class="users-meta" id="mb-meta"></span>
      <div class="users-filters">
        <button class="filter-btn active" data-f="all">All</button>
        <button class="filter-btn" data-f="student">Students</button>
        <button class="filter-btn" data-f="staff">Staff</button>
        <button class="filter-btn" data-f="pending">Pending <span class="filter-count" id="mb-pending-badge" hidden>0</span></button>
      </div>
    </div>
    <div class="tile users-tile" id="mb-real">
      <div class="users-table-head"><span>#</span><span></span><span>Member</span><span style="text-align:right">Points</span><span></span></div>
      <div id="mb-list"></div>
    </div>

    <section class="tile users-tile mb-pending" id="mb-pending" hidden>
      <div class="pending-head">
        <div>
          <h3>Pending members</h3>
          <p>People who signed up through the JagChess Network, and anyone you have typed in
            yourself. They have no account yet, so they are not in the club — send an invite and
            they can let themselves in.</p>
        </div>
        <div class="pending-head-side">
          <span class="pending-count" id="mb-pending-count"></span>
          <div class="pending-tools">
            <button class="btn subtle sm" id="mb-send-all" type="button">Send all</button>
            <button class="btn subtle sm" id="mb-markup" type="button">Edit markup</button>
          </div>
        </div>
      </div>
      <div id="mb-pending-list"></div>
    </section>
    <section class="tile mb-bans" id="mb-bans" hidden style="margin-top:16px">
      <div class="mb-bans-head">
        <h3>Removed members &amp; appeals</h3>
        <span class="mb-appeal-count" id="mb-appeals" hidden></span>
      </div>
      <div id="mb-ban-list"></div>
    </section>`;

  let members = [];
  let applicants = [];
  let banRows = [];
  let filter = 'all';
  let markupMode = false;
  let markupEditor = null;

  /* Somebody who applied and has since made an account and joined is simply a
     member — the row they left behind is history, not a person waiting. */
  const pending = () => {
    const emails = new Set(members.map((m) => String(m.email || '').toLowerCase()));
    return applicants.filter((a) => !emails.has(String(a.email || '').toLowerCase()));
  };

  const paintPending = () => {
    const rows = pending();
    const wrap = host.querySelector('#mb-pending');
    const badge = host.querySelector('#mb-pending-badge');

    badge.hidden = rows.length === 0;
    badge.textContent = rows.length;

    /* The section is the whole page under the Pending filter, and it stays
       under All even with nobody in it: an admin who has never had a sign-up
       needs to be told that, not shown a gap where the box used to be. The
       role filters are about members, so it steps out of their way. */
    wrap.hidden = !(filter === 'all' || filter === 'pending');

    /* Two different things, counted separately. Who came in through the
       Network is not who an admin typed into the markup, and "3 signed up"
       next to "0 not invited yet" reads as a contradiction unless the line
       also says how many have been invited. */
    const markups = rows.filter((a) => a.source === 'markup').length;
    const regs = rows.length - markups;
    const invited = rows.filter((a) => a.status === 'invited').length;
    const waiting = rows.length - invited;
    const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;

    host.querySelector('#mb-pending-count').innerHTML = rows.length
      ? `<span>${n(regs, 'registration', 'registrations')} · ${n(markups, 'markup entry', 'markup entries')}</span>
         <span>${invited} invited · ${waiting} not invited yet</span>`
      : '<span>Nobody waiting</span>';

    const sendAll = host.querySelector('#mb-send-all');
    const markupBtn = host.querySelector('#mb-markup');
    sendAll.disabled = markupMode || !rows.length;
    sendAll.onclick = () => openBulkInvite(ctx, pending());
    markupBtn.textContent = markupMode ? 'Cancel' : 'Edit markup';
    markupBtn.onclick = () => {
      markupMode = !markupMode;
      markupEditor = null;
      paintPending();
    };

    const list = host.querySelector('#mb-pending-list');

    /* Once the editor is up it owns that space. A repaint fired by somebody
       else's sign-up landing must not take the caret out of it, so the
       counts above refresh and the text below is left alone. */
    if (markupMode) {
      if (!markupEditor) {
        const opened = rows;
        markupEditor = mountMarkupEditor(list, {
          text: markupFromApplicants(opened),
          memberEmails: members.map((m) => m.email),
          onCancel: () => { markupMode = false; markupEditor = null; paintPending(); },
          onSave: async (people) => {
            const ok = await saveMarkup(ctx, people, opened);
            if (ok) { markupMode = false; markupEditor = null; paintPending(); }
            return ok;
          }
        });
      }
      return;
    }
    markupEditor = null;

    list.innerHTML = rows.length
      ? rows.map(applicantRowHTML).join('')
      : `<div class="empty-state">Nobody is waiting to join. People who sign up through the
           JagChess Network land here — your club's registration form and its QR code live in
           Club settings — and you can type addresses in yourself with <b>Edit markup</b>.</div>`;

    const find = (id) => rows.find((a) => a.id === id);
    host.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => openResponse(ctx, find(b.dataset.view))));
    host.querySelectorAll('[data-invite]').forEach((b) => (b.onclick = () => openInviteMail(ctx, find(b.dataset.invite))));
    host.querySelectorAll('[data-drop]').forEach((b) => (b.onclick = () => deleteApplication(ctx, find(b.dataset.drop))));
  };

  const paint = () => {
    const rows = filter === 'pending' ? [] : members.filter((m) => {
      const r = m.role || 'student';
      return filter === 'all' || (filter === 'staff' ? isStaff(r) : r === 'student');
    });
    const staffCount = members.filter((m) => isStaff(m.role)).length;
    const waiting = pending().length;
    host.querySelector('#mb-meta').textContent =
      `${members.length} member${members.length === 1 ? '' : 's'} · ${staffCount} staff` +
      (waiting ? ` · ${waiting} pending` : '');

    host.querySelector('#mb-real').hidden = filter === 'pending';
    paintPending();
    paintBans(banRows);

    host.querySelector('#mb-list').innerHTML = rows.map((m, i) => {
      const role = m.role || 'student';
      const manageable = m.uid !== ctx.user.uid && canModerate(myRole, role);
      return `<div class="user-row">
        <div class="user-rank${i === 0 ? ' top' : ''}">${i + 1}</div>
        <div class="user-avatar-circle" style="background:${esc(m.avatarColor || '#2e90fa')}">${esc(initials(m.username || m.email))}</div>
        <div class="user-info">
          <div class="user-uid">${esc(m.username || 'Player')}
            <span class="role-pill ${esc(role)}">${esc(ROLE_LABEL[role] || 'Student')}</span></div>
          <div class="user-role">${esc(m.email || '')}</div>
        </div>
        <div class="user-pts-col"><span class="user-pts-num">${m.points || 0}</span><span class="user-pts-label">pts</span></div>
        <button class="user-edit-btn" data-m="${esc(m.id)}">${manageable || m.uid === ctx.user.uid ? 'Manage' : 'View'}</button>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => manage(members.find((x) => x.id === b.dataset.m))));
  };

  host.querySelectorAll('.filter-btn').forEach((b) => (b.onclick = () => {
    filter = b.dataset.f;
    host.querySelectorAll('.filter-btn').forEach((o) => o.classList.toggle('active', o === b));
    paint();
  }));

  /* ── manage one member ── */
  function manage(m) {
    const isMe = m.uid === ctx.user.uid;
    const role = m.role || 'student';
    const canAct = !isMe && canModerate(myRole, role);
    const canRole = !isMe && canSetRoles(myRole) && role !== 'founder';

    const modal = el(`<div class="modal"><div class="modal-card" style="max-width:480px">
      <button class="icon-btn modal-close" data-x>✕</button>
      <h3>${isMe ? 'Your membership' : 'Manage member'}</h3>
      <div class="manage-user-head">
        <div class="user-avatar-circle" style="width:52px;height:52px;font-size:17px;background:${esc(m.avatarColor || '#2e90fa')}">${esc(initials(m.username || m.email))}</div>
        <div><div style="font-family:var(--font);font-size:16px;font-weight:800">${esc(m.username || 'Player')}
            <span class="role-pill ${esc(role)}">${esc(ROLE_LABEL[role])}</span></div>
          <div style="font-size:12.5px;color:var(--muted)">${esc(m.email || '')}</div></div>
      </div>

      <div class="mb-section">
        <label>Points</label>
        <div style="display:flex;gap:10px">
          <input data-pts type="number" min="0" value="${m.points || 0}" style="max-width:150px" />
          <button class="btn primary" data-savepts>Save points</button>
        </div>
      </div>

      <div class="mb-section">
        <label>Role</label>
        ${role === 'founder'
          ? '<p class="mb-note">The founder\'s role can only change by transferring ownership, in club settings.</p>'
          : canRole
            ? `<div style="display:flex;gap:10px">
                 <button class="btn ${role === 'student' ? 'primary' : 'subtle'}" data-role="student">Student</button>
                 <button class="btn ${role === 'admin' ? 'primary' : 'subtle'}" data-role="admin">Admin</button>
               </div>`
            : `<p class="mb-note">${isMe ? 'You cannot change your own role.' : 'Only the founder can change roles.'}</p>`}
      </div>

      ${canAct ? `
      <div class="mb-section mb-danger">
        <label>Remove from club</label>
        <p class="mb-note">A kick can be undone by rejoining. A ban blocks the join code and hides the club from them.</p>
        <div style="display:flex;gap:10px">
          <button class="btn subtle danger" data-kick>Kick…</button>
          <button class="btn danger" data-ban>Ban…</button>
        </div>
      </div>` : ''}
      </div></div>`);

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-x]').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };

    modal.querySelector('[data-savepts]').onclick = async () => {
      const pts = parseInt(modal.querySelector('[data-pts]').value, 10) || 0;
      try {
        await updateDoc(memberRef(ctx.clubId, m.id), { points: pts });
        close(); toast('Points updated', 'ok');
      } catch (e) { console.error(e); toast('Could not update points', 'error'); }
    };

    modal.querySelectorAll('[data-role]').forEach((b) => (b.onclick = async () => {
      try {
        await updateDoc(memberRef(ctx.clubId, m.id), { role: b.dataset.role });
        await setDoc(doc(db, 'users', m.id), { clubs: { [ctx.clubId]: b.dataset.role } }, { merge: true }).catch(() => {});
        close(); toast(`${m.username || 'Member'} is now ${b.dataset.role === 'admin' ? 'an admin' : 'a student'}`, 'ok');
      } catch (e) {
        console.error(e);
        toast(e.code === 'permission-denied' ? 'Only the founder can change roles.' : 'Could not change the role', 'error');
      }
    }));

    const kickBtn = modal.querySelector('[data-kick]');
    if (kickBtn) kickBtn.onclick = () => { close(); removeMember(m, 'kick'); };
    const banBtn = modal.querySelector('[data-ban]');
    if (banBtn) banBtn.onclick = () => { close(); removeMember(m, 'ban'); };
  }

  /* ── kick / ban, both requiring a reason ── */
  function removeMember(m, type) {
    const isBan = type === 'ban';
    const modal = el(`<div class="modal"><div class="modal-card" style="max-width:460px">
      <button class="icon-btn modal-close" data-x>✕</button>
      <h3>${isBan ? 'Ban' : 'Kick'} ${esc(m.username || 'this member')}?</h3>
      <p class="modal-meta" style="margin:0">${isBan
        ? 'They lose access, the club disappears from their list, and the join code stops working for them. They can send you an appeal.'
        : 'They lose access immediately, but may rejoin with the club code later.'}</p>
      <div>
        <label for="rm-reason">Reason${isBan ? '' : ' (kept for your records)'}</label>
        <textarea id="rm-reason" rows="3" placeholder="${isBan ? 'Shown to them with the ban notice…' : 'Why are they being removed?'}"></textarea>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn subtle" data-x>Cancel</button>
        <button class="btn danger" data-go>${isBan ? 'Ban member' : 'Kick member'}</button>
      </div></div></div>`);

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
    modal.onclick = (e) => { if (e.target === modal) close(); };

    modal.querySelector('[data-go]').onclick = async () => {
      const reason = modal.querySelector('#rm-reason').value.trim();
      if (!reason) { toast('Give a reason first', 'error'); return; }
      const go = modal.querySelector('[data-go]');
      go.disabled = true; go.textContent = 'Working…';
      try {
        await setDoc(banRef(ctx.clubId, m.id), {
          uid: m.id,
          type,
          reason,
          email: m.email || '',
          username: m.username || '',
          at: Date.now(),
          byUid: ctx.user.uid,
          byName: ctx.member.username || ''
        });
        await deleteDoc(memberRef(ctx.clubId, m.id));
        await unindexMemberEmail(ctx.clubId, m.email);
        await setDoc(doc(db, 'users', m.id), {
          clubs: { [ctx.clubId]: null },
          ...(isBan ? { bannedFrom: { [ctx.clubId]: true } } : {})
        }, { merge: true }).catch((e) => console.warn('index update failed', e));

        close();
        toast(isBan ? 'Member banned' : 'Member kicked');
      } catch (e) {
        console.error(e);
        toast(e.code === 'permission-denied' ? 'You cannot moderate that member.' : 'Could not complete that', 'error');
        go.disabled = false; go.textContent = isBan ? 'Ban member' : 'Kick member';
      }
    };
  }

  /* ── bans + appeals ── */
  function paintBans(rows) {
    const wrap = host.querySelector('#mb-bans');
    // under the Pending filter this section is somebody else's business
    wrap.hidden = rows.length === 0 || filter === 'pending';
    const appeals = rows.filter((r) => r.appeal && r.appeal.status === 'open').length;
    const badge = host.querySelector('#mb-appeals');
    badge.hidden = appeals === 0;
    badge.textContent = `${appeals} open appeal${appeals === 1 ? '' : 's'}`;

    host.querySelector('#mb-ban-list').innerHTML = rows.map((r) => `
      <div class="mb-ban-row${r.appeal && r.appeal.status === 'open' ? ' has-appeal' : ''}">
        <div class="mb-ban-top">
          <div>
            <div class="mb-ban-name">${esc(r.username || r.email || 'Member')}
              <span class="role-pill ${r.type === 'ban' ? 'banned' : ''}">${r.type === 'ban' ? 'Banned' : 'Kicked'}</span></div>
            <div class="mb-ban-meta">${esc(r.email || '')} · ${fmtDate(r.at)}${r.byName ? ' · by ' + esc(r.byName) : ''}</div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0">
            ${r.type === 'ban' ? `<button class="btn primary sm" data-unban="${esc(r.uid)}">Lift ban</button>` : ''}
            <button class="btn subtle sm" data-clear="${esc(r.uid)}">Dismiss</button>
          </div>
        </div>
        ${r.reason ? `<div class="mb-ban-reason"><b>Reason</b> ${esc(r.reason)}</div>` : ''}
        ${r.appeal ? `<div class="mb-appeal">
            <b>Appeal · ${fmtDate(r.appeal.submittedAt)}</b>
            <p>${esc(r.appeal.text)}</p>
          </div>` : ''}
      </div>`).join('');

    host.querySelectorAll('[data-unban]').forEach((b) => (b.onclick = async () => {
      const uid = b.dataset.unban;
      try {
        await deleteDoc(banRef(ctx.clubId, uid));
        await setDoc(doc(db, 'users', uid), { bannedFrom: { [ctx.clubId]: null } }, { merge: true }).catch(() => {});
        toast('Ban lifted — they can rejoin with the code', 'ok');
      } catch (e) { console.error(e); toast('Could not lift the ban', 'error'); }
    }));

    host.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = async () => {
      const uid = b.dataset.clear;
      try {
        await deleteDoc(banRef(ctx.clubId, uid));
        await setDoc(doc(db, 'users', uid), { bannedFrom: { [ctx.clubId]: null } }, { merge: true }).catch(() => {});
        toast('Record dismissed');
      } catch (e) { console.error(e); toast('Could not dismiss', 'error'); }
    }));
  }

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'members'), orderBy('points', 'desc')), (s) => {
    members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    paint();
  });

  const stopBans = onSnapshot(clubCol(ctx.clubId, 'bans'), (s) => {
    banRows = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at || 0) - (a.at || 0));
    paintBans(banRows);
  }, (e) => console.warn('bans listener', e));

  const stopApps = onSnapshot(applicationCol(ctx.clubId), (s) => {
    applicants = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    paint();
  }, (e) => console.warn('applications listener', e));

  return () => { stop(); stopBans(); stopApps(); };
}

/* ── transfer ownership (founder only) ─────────────────────────────── */

async function openTransfer(ctx) {
  const snap = await getDocs(clubCol(ctx.clubId, 'members'));
  const people = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => m.uid !== ctx.user.uid && m.role !== 'founder')
    // admins first, then students, each alphabetical
    .sort((a, b) => {
      const rank = (r) => (r === 'admin' ? 0 : 1);
      return rank(a.role) - rank(b.role) || (a.username || '').localeCompare(b.username || '');
    });

  const modal = el(`<div class="modal"><div class="modal-card" style="max-width:520px">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>Transfer ownership</h3>
    <p class="modal-meta" style="margin:0">The person you pick becomes the founder of
      ${esc(ctx.club.name || 'this club')}. You stay on as an admin.</p>
    <div class="tr-list">${people.length ? people.map((m) => `
      <button class="tr-row" data-uid="${esc(m.id)}" data-role="${esc(m.role || 'student')}" data-name="${esc(m.username || m.email || 'Member')}">
        <span class="user-avatar-circle" style="background:${esc(m.avatarColor || '#2e90fa')}">${esc(initials(m.username || m.email))}</span>
        <span class="tr-info">
          <span class="tr-name">${esc(m.username || 'Player')}</span>
          <span class="tr-mail">${esc(m.email || '')}</span>
        </span>
        <span class="role-pill ${esc(m.role || 'student')}">${esc(ROLE_LABEL[m.role] || 'Student')}</span>
      </button>`).join('')
      : '<div class="empty-state">There is nobody else in the club yet.</div>'}</div>
    </div></div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-x]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  modal.querySelectorAll('[data-uid]').forEach((b) => (b.onclick = async () => {
    const { uid, role, name } = b.dataset;

    // handing the club to a student deserves a second look
    if (role === 'student') {
      const ok = await confirmDialog({
        title: `Make ${name} the founder?`,
        body: `${name} is currently a student, not an admin. As founder they will control every setting, every role, and could remove you. Are you sure?`,
        confirmText: 'Yes, transfer to ' + name,
        danger: true
      });
      if (!ok) return;
    } else {
      const ok = await confirmDialog({
        title: `Make ${name} the founder?`,
        body: 'They take full ownership of the club and you become an admin. Only the new founder can hand it back.',
        confirmText: 'Transfer ownership'
      });
      if (!ok) return;
    }

    close();
    try {
      // order matters: every write below must happen while you are still founder
      await updateDoc(memberRef(ctx.clubId, uid), { role: 'founder' });
      await updateDoc(clubRef(ctx.clubId), { ownerUid: uid });
      await updateDoc(memberRef(ctx.clubId, ctx.user.uid), { role: 'admin' });

      await setDoc(doc(db, 'users', uid), { clubs: { [ctx.clubId]: 'founder' } }, { merge: true }).catch(() => {});
      await setDoc(doc(db, 'users', ctx.user.uid), { clubs: { [ctx.clubId]: 'admin' } }, { merge: true }).catch(() => {});

      ctx.member.role = 'admin';
      toast(`${name} is now the founder`, 'ok');
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      console.error(e);
      toast('Could not transfer ownership — nothing was changed', 'error');
    }
  }));
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  SETTINGS (admin)                                                   */
/* ═══════════════════════════════════════════════════════════════════ */

/* ── the club's picture ─────────────────────────────────────────
   The founder's, and only the founder's: it is the club's face everywhere
   on the site, including to people who are not in it, and an admin who can
   be replaced tomorrow should not be able to change what the club looks
   like on the Network.

   Shrinking happens here, in the browser, before anything is written — see
   clubPhotoFrom. What lands on the club document is a small square, and the
   listing is refreshed straight afterwards so the Network agrees.
   ──────────────────────────────────────────────────────────── */

/**
 * The coloured badge, which the picture sits on top of rather than replaces.
 *
 * It was only choosable while a club was being created, which meant a
 * founder who picked the green knight by accident was stuck with it
 * forever. Both lists live in club-core and are only ever appended to, so
 * what a club already stores keeps meaning what it meant.
 *
 * Saved with the rest of the details rather than on click: it sits in the
 * same form, and a badge that saved itself while the name beside it had
 * not would be a confusing thing to explain.
 */
function wireClubBadge(ctx, host) {
  const icons = host.querySelector('[data-icons]');
  const colors = host.querySelector('[data-colors]');
  if (!icons || !colors) return { value: () => ({}) };

  const c = ctx.club;
  let icon = c.icon || CLUB_ICONS[0];
  let color = c.color || CLUB_COLORS[0];

  /* A club whose badge predates a list is still shown its own choice, so
     saving the form cannot quietly change it to something it never was. */
  const iconList = CLUB_ICONS.indexOf(icon) === -1 ? [icon].concat(CLUB_ICONS) : CLUB_ICONS;
  const colorList = CLUB_COLORS.indexOf(color) === -1 ? [color].concat(CLUB_COLORS) : CLUB_COLORS;

  const preview = host.querySelector('[data-preview]');
  const repaint = () => {
    if (preview) preview.innerHTML = clubAvatar({ ...c, icon, color }, 'club-avatar lg');
  };

  icons.innerHTML = iconList.map((i) =>
    `<button type="button" class="icon-opt${i === icon ? ' on' : ''}" data-icon="${esc(i)}"
       aria-label="${esc(i)}">${esc(i)}</button>`).join('');
  icons.onclick = (e) => {
    const b = e.target.closest('[data-icon]');
    if (!b) return;
    icon = b.dataset.icon;
    icons.querySelectorAll('.icon-opt').forEach((o) => o.classList.toggle('on', o === b));
    repaint();
  };

  colors.innerHTML = colorList.map((v) =>
    `<button type="button" class="color-opt${v === color ? ' on' : ''}"
       style="background:${esc(v)}" data-color="${esc(v)}" aria-label="${esc(v)}"></button>`).join('');
  colors.onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    color = b.dataset.color;
    colors.querySelectorAll('.color-opt').forEach((o) => o.classList.toggle('on', o === b));
    repaint();
  };

  return { value: () => ({ icon, color }) };
}

function wireClubPhoto(ctx, host) {
  const pick = host.querySelector('[data-pick]');
  if (!pick) return;                          // not the founder

  const file = host.querySelector('[data-file]');
  const drop = host.querySelector('[data-drop]');
  const note = host.querySelector('[data-photo-note]');

  const save = async (photo) => {
    pick.disabled = true;
    if (drop) drop.disabled = true;
    const said = note.textContent;
    note.textContent = photo ? 'Saving the picture…' : 'Removing the picture…';
    try {
      await updateDoc(clubRef(ctx.clubId), { photo: photo || '' });
      ctx.club.photo = photo || '';
      /* The Network reads a copy, not the club, so it has to be told. */
      await syncPublicClub(ctx.club);
      toast(photo ? 'Club picture saved' : 'Club picture removed', 'ok');
      renderSettings(ctx, host);
    } catch (e) {
      console.error(e);
      toast('Could not save the picture', 'error');
      note.textContent = said;
      pick.disabled = false;
      if (drop) drop.disabled = false;
    }
  };

  pick.onclick = () => file.click();

  file.onchange = async () => {
    const chosen = file.files && file.files[0];
    file.value = '';                          // so the same file can be picked twice
    if (!chosen) return;
    try {
      note.textContent = 'Preparing the picture…';
      await save(await clubPhotoFrom(chosen));
    } catch (e) {
      toast(e.message || 'That picture could not be used', 'error');
      note.textContent = 'Square works best — anything else is cropped from the middle.';
    }
  };

  if (drop) {
    drop.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Remove the club picture?',
        body: 'The club goes back to its coloured badge everywhere it appears.',
        confirmText: 'Remove',
        danger: true
      });
      if (ok) save('');
    };
  }
}

async function renderSettings(ctx, host, api, startTab) {
  const c = ctx.club;
  const founder = ctx.member.role === 'founder';
  const isPrivate = c.visibility === 'private';
  host.innerHTML = `
    <div class="se">
      <div class="seg se-tabs" id="se-tabs" role="tablist">
        <button class="seg-btn on" data-tab="club" role="tab">Club</button>
        <button class="seg-btn" data-tab="join" role="tab">Joining</button>
        <button class="seg-btn" data-tab="form" role="tab">Sign-up form</button>
        <button class="seg-btn" data-tab="owner" role="tab">Ownership</button>
      </div>

      <section class="se-pane on" data-pane="club">
        <div class="tile se-group">
          ${founder ? `
          <div class="se-row se-row-photo">
            <div class="se-label"><b>Picture</b><small>A logo or team photo. Any shape works.</small></div>
            <div class="se-photo">
              <span class="se-photo-now" data-preview>${clubAvatar(c, 'club-avatar lg')}</span>
              <div class="se-photo-tools">
                <button class="btn subtle sm" type="button" data-pick>${clubPhoto(c) ? 'Change picture' : 'Upload a picture'}</button>
                ${clubPhoto(c) ? '<button class="btn subtle sm" type="button" data-drop>Remove</button>' : ''}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-file />
                <p class="field-hint" data-photo-note></p>
              </div>
            </div>
          </div>
          <div class="se-row">
            <div class="se-label"><b>Badge and colour</b><small>${clubPhoto(c) ? 'Shown if the picture is ever removed.' : 'Shown everywhere until you add a picture.'}</small></div>
            <div><div class="icon-picker" data-icons></div><div class="color-picker" style="margin-top:12px" data-colors></div></div>
          </div>` : ''}
          <div class="se-row">
            <label class="se-label" for="se-name"><b>Name</b></label>
            <input id="se-name" value="${esc(c.name || '')}" maxlength="60" />
          </div>
          <div class="se-row">
            <label class="se-label" for="se-desc"><b>Description</b><small>One or two lines. Shown on the home page and in search.</small></label>
            <textarea id="se-desc" rows="3" maxlength="240">${esc(c.description || '')}</textarea>
          </div>
          <div class="se-row">
            <div class="se-label"><b>Web address</b><small>Fixed, so links people have saved keep working.</small></div>
            <div class="domain-preview"><span class="domain-fixed">${esc(location.host)}/clubs/</span><span class="domain-slug">${esc(c.slug || c.id)}</span></div>
          </div>
          <div class="se-foot"><button class="btn primary" id="se-save">Save changes</button></div>
        </div>
      </section>

      <section class="se-pane" data-pane="join">
        <div class="tile se-group">
          <button class="se-toggle${isPrivate ? '' : ' on'}" id="se-vis" aria-pressed="${!isPrivate}">
            <span><b>Anyone with the link can join</b>
            <small>${isPrivate ? 'Off. People need the join code, and the club is hidden from search.' : 'On. The club is listed so students can find it and join in one tap.'}</small></span>
            <i class="switch${isPrivate ? '' : ' on'}" aria-hidden="true"></i>
          </button>
          <div class="se-row">
            <div class="se-label"><b>Join code</b><small>Students type this at ${esc(location.host)}/clubs to join.</small></div>
            <div class="code-row">
              <div class="code-display" id="se-code">${esc(c.code || '------')}</div>
              <button class="btn subtle sm" id="se-copy">Copy</button>
              <button class="btn subtle sm" id="se-regen">New code</button>
            </div>
          </div>
          <div class="se-foot"><button class="btn primary" id="se-share">Invite link, QR code and message</button></div>
        </div>
      </section>

      <section class="se-pane" data-pane="form">
        <div id="se-registration"></div>
      </section>

      <section class="se-pane" data-pane="owner">
        <div class="tile se-group">
          ${founder ? `
          <div class="se-row">
            <div class="se-label"><b>Hand the club over</b><small>Someone else becomes founder, and you become an admin.</small></div>
            <div><button class="btn subtle" id="se-transfer">Transfer ownership</button></div>
          </div>` : ''}
          <div class="se-row">
            <div class="se-label"><b>Delete this club</b><small>Removes it for every member, with its events, puzzles and news. This can't be undone.</small></div>
            <div><button class="btn danger" id="se-delete">Delete club</button></div>
          </div>
        </div>
      </section>
    </div>`;

  const showTab = (t) => {
    host.querySelectorAll('#se-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    host.querySelectorAll('.se-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === t));
  };
  host.querySelector('#se-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  };
  if (startTab) showTab(startTab);

  /* The registration form is its own box under the two above: it is the one
     part of club settings aimed at people who are not members yet. */
  mountRegistrationEditor(ctx, host.querySelector('#se-registration'));

  const transferBtn = host.querySelector('#se-transfer');
  if (transferBtn) transferBtn.onclick = () => openTransfer(ctx);

  wireClubPhoto(ctx, host);
  const badge = wireClubBadge(ctx, host);

  let visibility = c.visibility || 'public';
  /* The switch saves itself: it is one decision, not part of a form. */
  host.querySelector('#se-vis').onclick = async () => {
    const next = visibility === 'private' ? 'public' : 'private';
    try {
      await updateDoc(clubRef(ctx.clubId), { visibility: next });
      ctx.club.visibility = next;
      visibility = next;
      await syncPublicClub(ctx.club);
      toast(next === 'public' ? 'Anyone with the link can join now' : 'The club now needs a join code', 'ok');
      renderSettings(ctx, host, api, 'join');
    } catch (e) { console.error(e); toast('Could not change that', 'error'); }
  };

  host.querySelector('#se-save').onclick = async () => {
    const btn = host.querySelector('#se-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const patch = {
        name: host.querySelector('#se-name').value.trim() || c.name,
        description: host.querySelector('#se-desc').value.trim(),
        ...badge.value()
      };
      await updateDoc(clubRef(ctx.clubId), patch);
      Object.assign(ctx.club, patch);

      /* Going public puts the club on the JagChess Network; going private
         takes it straight back off, registration form and all. */
      await syncPublicClub(ctx.club);

      toast('Club updated', 'ok');

    } catch (e) { console.error(e); toast('Could not save', 'error'); }
    btn.disabled = false; btn.textContent = 'Save changes';
  };

  host.querySelector('#se-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(c.code || ''); toast('Join code copied'); }
    catch { toast('Copy failed', 'error'); }
  };

  host.querySelector('#se-share').onclick = () => openClubShare(ctx);

  host.querySelector('#se-regen').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Regenerate the join code?',
      body: 'The old code stops working immediately.', confirmText: 'Regenerate', danger: true
    });
    if (!ok) return;
    const code = makeCode();
    await setDoc(doc(db, 'clubCodes', code), { clubId: ctx.clubId, createdAt: Date.now() });
    if (c.code) await deleteDoc(doc(db, 'clubCodes', c.code)).catch(() => {});
    await updateDoc(clubRef(ctx.clubId), { code });
    ctx.club.code = code;
    host.querySelector('#se-code').textContent = code;
    toast('New join code created', 'ok');
  };

  host.querySelector('#se-delete').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Delete this club?',
      body: 'Every member loses access, and the events, puzzles, newsletters, orders and '
        + 'tournaments belonging to this club are removed with it. This cannot be undone.',
      confirmText: 'Delete club', danger: true
    });
    if (!ok) return;
    const btn = host.querySelector('#se-delete');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await deleteClubDeep(ctx.user, { id: ctx.clubId, code: ctx.club.code });
      location.href = '/clubs';
    } catch (e) {
      console.error(e);
      toast('Could not delete the club', 'error');
      btn.disabled = false;
      btn.textContent = 'Delete club';
    }
  };

  return noop;
}
