/* ═══════════════════════════════════════════════════════════════════════
   club-blocks.js — every block (page) a club can contain.
   Each renderer returns a cleanup function.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, auth, clubRef, clubCol, clubDoc, memberRef,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, increment, limit,
  esc, fmtDate, fmtTime, toast, confirmDialog, promptDialog, initials,
  CLUB_COLORS, makeCode, banRef, isStaff, canModerate, canSetRoles, ROLE_LABEL
} from './club-core.js';

import { readRating, displayRating } from './glicko2.js';
import {
  renderDuels, watchActiveDuels, gameOf, loadMyRatings, setDuelIntent, duelsHash
} from './club-duels.js';
import { openAttendanceShare, openClubShare } from './club-share.js';
import { mountNewsletterMail } from './newsletter-mail.js';

export const BLOCK_TYPES = {
  events: {
    name: 'Events', icon: 'calendar', tint: 'var(--blue-soft)',
    desc: 'A shared calendar for practices, tournaments and meetings — with attendance and streaks.',
    sub: 'Practices, tournaments and meetings'
  },
  puzzles: {
    name: 'Puzzles', icon: 'puzzle', tint: 'var(--green-soft)',
    desc: 'Publish tactical positions from a board or a FEN. Members solve them for points.',
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
    name: 'Duels', icon: 'swords', tint: 'var(--blue-soft)',
    desc: 'One-on-one chess with clocks and Glicko-2 ratings — play the club or the world, and watch live games.',
    sub: 'Play 1v1 and watch live games'
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
  let editingId = null;
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
        ${isAdmin ? `
        <div class="tile">
          <h3 id="ev-form-title">Add event</h3>
          <div class="form-inline">
            <input id="ev-title" placeholder="Title" />
            <div class="row"><input id="ev-date" type="date" /><input id="ev-time" type="time" /></div>
            <select id="ev-tag">${TAGS.map((t) => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>
            <textarea id="ev-desc" rows="2" placeholder="Short description"></textarea>
            <div style="display:flex;align-items:center;gap:10px">
              <input id="ev-dur" type="number" min="5" value="30" style="flex:1" />
              <span style="font-size:13px;color:var(--muted)">minutes</span>
            </div>
            <div class="row">
              <button class="btn primary" id="ev-save">Add event</button>
              <button class="btn subtle" id="ev-cancel" hidden>Cancel</button>
            </div>
          </div>
        </div>` : ''}
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
      <select id="att-event"><option value="">— Select an event —</option></select>
      <div id="att-panel" hidden style="margin-top:20px"></div>
    </div>` : ''}`;

  const grid = host.querySelector('#cal-grid');
  const title = host.querySelector('#cal-title');

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
      const dayEvents = events.filter((e) => new Date(e.date).toDateString() === d.toDateString());
      if (i >= 35 && !dayEvents.length && outside) continue;
      html += `<div class="day-cell${outside ? ' is-outside' : ''}${d.toDateString() === today ? ' is-today' : ''}">
        <div class="day-num">${d.getDate()}</div>
        <div class="day-events">${dayEvents.map((e) =>
          `<button class="event-pill tag-${esc(e.tag || 'classic')}" data-ev="${esc(e.id)}">${esc(e.title)}</button>`).join('')}</div>
      </div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('[data-ev]').forEach((b) => (b.onclick = () => openEvent(b.dataset.ev)));
  };

  const paintUpcoming = () => {
    const now = Date.now();
    const up = events.filter((e) => e.date >= now - 3 * 3600e3).slice(0, 8);
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
    sel.innerHTML = '<option value="">— Select an event —</option>' +
      events.slice().reverse().map((e) =>
        `<option value="${esc(e.id)}">${esc(e.title)} · ${fmtDate(e.date)}</option>`).join('');
    sel.value = cur;
  };

  function openEvent(id) {
    const e = events.find((x) => x.id === id);
    if (!e) return;
    const live = isLive(e);
    const modal = el(`<div class="modal">
      <div class="modal-card">
        <button class="icon-btn modal-close" data-x>✕</button>
        <div class="modal-tag"><span class="tag-badge tag-${esc(e.tag || 'classic')}">${esc(e.tag || 'classic')}</span></div>
        <h3>${esc(e.title)}</h3>
        <div class="modal-meta">${fmtDate(e.date, { weekday: 'long', month: 'long', day: 'numeric' })} · ${fmtTime(e.date)} · ${e.durationMin || 30} min</div>
        <p>${esc(e.desc || 'No description.')}</p>
        ${live ? '<div class="live-chip">● Happening now</div>' : ''}
        ${isAdmin ? `<div class="modal-actions">
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
      await deleteDoc(clubDoc(ctx.clubId, 'events', e.id));
      toast('Event deleted');
    };
  }

  function startEdit(e) {
    editingId = e.id;
    host.querySelector('#ev-form-title').textContent = 'Edit event';
    host.querySelector('#ev-title').value = e.title || '';
    const d = new Date(e.date);
    host.querySelector('#ev-date').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    host.querySelector('#ev-time').value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tagSel = host.querySelector('#ev-tag');
    tagSel.value = e.tag || 'classic';
    tagSel.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector('#ev-desc').value = e.desc || '';
    host.querySelector('#ev-dur').value = e.durationMin || 30;
    host.querySelector('#ev-save').textContent = 'Save changes';
    host.querySelector('#ev-cancel').hidden = false;
    host.querySelector('#ev-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearForm() {
    editingId = null;
    ['#ev-title', '#ev-desc'].forEach((s) => (host.querySelector(s).value = ''));
    host.querySelector('#ev-date').value = '';
    host.querySelector('#ev-time').value = '';
    host.querySelector('#ev-dur').value = 30;
    host.querySelector('#ev-form-title').textContent = 'Add event';
    host.querySelector('#ev-save').textContent = 'Add event';
    host.querySelector('#ev-cancel').hidden = true;
  }

  if (isAdmin) {
    host.querySelector('#ev-save').onclick = async () => {
      const title = host.querySelector('#ev-title').value.trim();
      const date = host.querySelector('#ev-date').value;
      const time = host.querySelector('#ev-time').value || '00:00';
      if (!title || !date) { toast('A title and date are required', 'error'); return; }
      const payload = {
        title,
        desc: host.querySelector('#ev-desc').value.trim(),
        date: new Date(`${date}T${time}`).getTime(),
        time,
        tag: host.querySelector('#ev-tag').value,
        durationMin: Math.max(5, parseInt(host.querySelector('#ev-dur').value, 10) || 30),
        updatedAt: Date.now()
      };
      try {
        if (editingId) await updateDoc(clubDoc(ctx.clubId, 'events', editingId), payload);
        else await addDoc(clubCol(ctx.clubId, 'events'), { ...payload, createdAt: Date.now() });
        clearForm();
        toast(editingId ? 'Event updated' : 'Event added', 'ok');
      } catch (e) { console.error(e); toast('Could not save the event', 'error'); }
    };
    host.querySelector('#ev-cancel').onclick = clearForm;
    wireAttendanceAdmin(ctx, host, () => events);
  }

  host.querySelector('#cal-prev').onclick = () => { month.setMonth(month.getMonth() - 1); paintCalendar(); };
  host.querySelector('#cal-next').onclick = () => { month.setMonth(month.getMonth() + 1); paintCalendar(); };

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'events'), orderBy('date', 'asc')), (snap) => {
    events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    paintCalendar();
    paintUpcoming();
    paintAttSelect();
    if (!isAdmin) paintLiveAttendance(ctx, host, events);
  }, (err) => {
    console.error(err);
    grid.innerHTML = '<div class="empty-state">Could not load events.</div>';
  });

  return stop;
}

const isLive = (e) => {
  const start = e.date;
  const end = start + (e.durationMin || 30) * 60000;
  const now = Date.now();
  return now >= start - 5 * 60000 && now <= end;
};

/* ── student-facing attendance ─────────────────────────────────────── */

async function paintLiveAttendance(ctx, host, events) {
  const slot = host.querySelector('#att-live');
  if (!slot) return;
  const live = events.find(isLive);
  if (!live) { slot.innerHTML = ''; return; }

  const [formSnap, mine] = await Promise.all([
    getDoc(clubDoc(ctx.clubId, 'attendanceForms', live.id)),
    getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'),
      where('eventId', '==', live.id), where('userId', '==', ctx.user.uid)))
  ]);

  if (!mine.empty) {
    slot.innerHTML = `<div class="att-banner done">
      <span class="att-ico">✓</span>
      <div><b>You're checked in for ${esc(live.title)}</b><small>Points have been added to your total.</small></div>
    </div>`;
    return;
  }

  const form = formSnap.exists() ? formSnap.data() : { points: 10, questions: [] };
  slot.innerHTML = `<div class="att-banner">
    <div class="att-banner-head">
      <span class="att-ico live">●</span>
      <div><b>${esc(live.title)} is happening now</b><small>Check in to earn ${form.points || 10} points.</small></div>
    </div>
    <div class="att-form">
      <label class="att-confirm"><input type="checkbox" id="att-check" /> <span>I confirm I attended this event</span></label>
      ${(form.questions || []).map((q, i) => `
        <div class="att-q"><label>${esc(q.text)}</label>
          <input data-q="${esc(q.id || String(i))}" placeholder="Your answer" /></div>`).join('')}
      <button class="btn primary" id="att-submit" disabled>Submit attendance</button>
    </div>
  </div>`;

  const check = slot.querySelector('#att-check');
  const submit = slot.querySelector('#att-submit');
  check.onchange = () => (submit.disabled = !check.checked);
  submit.onclick = async () => {
    submit.disabled = true; submit.textContent = 'Submitting…';
    try {
      const answers = Array.from(slot.querySelectorAll('[data-q]'))
        .map((i) => ({ questionId: i.dataset.q, text: i.value.trim() }));
      await addDoc(clubCol(ctx.clubId, 'attendanceResponses'), {
        eventId: live.id,
        userId: ctx.user.uid,
        userEmail: ctx.user.email || '',
        username: ctx.member.username || '',
        answers,
        submittedAt: Date.now()
      });
      const pts = form.points || 10;
      await updateDoc(memberRef(ctx.clubId, ctx.user.uid), { points: increment(pts) });
      ctx.member.points = (ctx.member.points || 0) + pts;
      toast(`Checked in — +${pts} points`, 'ok');
      paintLiveAttendance(ctx, host, events);
    } catch (e) {
      console.error(e);
      toast('Could not submit attendance', 'error');
      submit.disabled = false; submit.textContent = 'Submit attendance';
    }
  };
}

/* ── admin attendance panel ────────────────────────────────────────── */

function wireAttendanceAdmin(ctx, host, getEvents) {
  const sel = host.querySelector('#att-event');
  const panel = host.querySelector('#att-panel');
  if (!sel || !panel) return;
  let questions = [];

  sel.addEventListener('change', async () => {
    const id = sel.value;
    panel.hidden = !id;
    if (!id) return;
    panel.innerHTML = '<div class="empty-state">Loading…</div>';

    const [formSnap, resSnap] = await Promise.all([
      getDoc(clubDoc(ctx.clubId, 'attendanceForms', id)),
      getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'), where('eventId', '==', id)))
    ]);
    const form = formSnap.exists() ? formSnap.data() : { points: 10, questions: [] };
    questions = (form.questions || []).slice();
    const responses = resSnap.docs.map((d) => d.data()).sort((a, b) => b.submittedAt - a.submittedAt);

    panel.innerHTML = `
      <div class="att-admin">
        <div>
          <span class="adm-field-label">Points reward</span>
          <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
            <input id="att-pts" type="number" min="0" value="${form.points ?? 10}" style="width:110px" />
            <span style="font-size:13px;color:var(--muted)">per check-in</span>
          </div>
          <div class="att-qs-head"><span class="adm-field-label">Extra questions</span>
            <button class="btn subtle sm" id="att-add-q">+ Add</button></div>
          <div id="att-qs"></div>
          <button class="btn primary block" id="att-save" style="margin-top:16px">Save form</button>
          <button class="btn subtle block" id="att-share" style="margin-top:8px">Share link & QR code</button>
          <p class="field-hint" style="margin-top:8px">Members who scan it land on the check-in. Anyone else is asked to sign in or join first.</p>
        </div>
        <div>
          <div class="att-resp-head">
            <span class="adm-field-label">Check-ins</span>
            <span class="adm-att-badge">${responses.length}</span>
          </div>
          <div class="att-resp-list">${responses.length ? responses.map((r) => `
            <div class="adm-att-resp-row">
              <div class="adm-att-resp-user">
                <span class="adm-att-resp-name">${esc(r.username || r.userEmail || 'Member')}</span>
                <span class="adm-att-resp-time">${fmtTime(r.submittedAt)}</span>
              </div>
              ${(r.answers || []).filter((a) => a.text).map((a) => {
                const q = questions.find((x) => x.id === a.questionId);
                return `<div class="adm-att-answer"><span class="adm-att-q-label">${esc(q ? q.text : 'Answer')}</span><span class="adm-att-a-text">${esc(a.text)}</span></div>`;
              }).join('')}
            </div>`).join('') : '<div class="empty-state">No check-ins yet.</div>'}</div>
        </div>
      </div>`;

    const paintQs = () => {
      panel.querySelector('#att-qs').innerHTML = questions.map((q, i) => `
        <div class="adm-att-q-row">
          <input class="adm-att-q-input" data-qi="${i}" value="${esc(q.text)}" placeholder="Question" />
          <button class="adm-att-q-del" data-qd="${i}">×</button>
        </div>`).join('');
      panel.querySelectorAll('[data-qi]').forEach((i) => (i.oninput = () => (questions[+i.dataset.qi].text = i.value)));
      panel.querySelectorAll('[data-qd]').forEach((b) => (b.onclick = () => { questions.splice(+b.dataset.qd, 1); paintQs(); }));
    };
    paintQs();

    panel.querySelector('#att-add-q').onclick = () => {
      questions.push({ id: 'q' + Date.now().toString(36), text: '' });
      paintQs();
    };

    panel.querySelector('#att-share').onclick = () => {
      const event = getEvents().find((e) => e.id === id);
      if (!event) { toast('That event is no longer available.', 'error'); return; }
      openAttendanceShare(ctx, event, parseFloat(panel.querySelector('#att-pts').value) || 10);
    };
    panel.querySelector('#att-save').onclick = async () => {
      const btn = panel.querySelector('#att-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      await setDoc(clubDoc(ctx.clubId, 'attendanceForms', id), {
        eventId: id,
        points: parseFloat(panel.querySelector('#att-pts').value) || 10,
        questions: questions.filter((q) => q.text.trim()),
        updatedAt: Date.now()
      });
      btn.disabled = false; btn.textContent = 'Save form';
      toast('Attendance form saved', 'ok');
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  PUZZLES                                                            */
/* ═══════════════════════════════════════════════════════════════════ */

const PIECE_THEME = (p) => `/assets/vendor/chessboard/img/chesspieces/wikipedia/${p}.png`;

async function renderPuzzles(ctx, host, api) {
  return ctx.isAdmin && ctx.mode !== 'member'
    ? puzzlesAdmin(ctx, host)
    : puzzlesMember(ctx, host);
}

function normalizeFen(fen, color) {
  if (!fen) return 'start';
  const parts = fen.trim().split(/\s+/);
  if (parts.length >= 4) return fen;
  return `${parts[0]} ${color || 'w'} - - 0 1`;
}

async function puzzlesMember(ctx, host) {
  host.innerHTML = `
    <div class="puzzle-layout">
      <div class="tile puzzle-board">
        <div class="puzzle-header"><h3 id="pz-title">Daily puzzle</h3>
          <div class="puzzle-status" id="pz-status">Pick a puzzle to start.</div></div>
        <div id="pz-board" class="chessboard"></div>
        <div class="puzzle-controls"><button class="btn subtle" id="pz-reset">Reset board</button></div>
        <div class="puzzle-sequence"><h4>Progress</h4><div class="list" id="pz-progress"></div></div>
      </div>
      <div class="tile puzzle-side">
        <div class="puzzle-side-header"><h3>All puzzles</h3><span class="muted" id="pz-meta"></span></div>
        <div class="list" id="pz-list"></div>
        <div class="empty-state" id="pz-empty" hidden>No puzzles published yet.</div>
      </div>
    </div>`;

  let puzzles = [];
  let attempts = new Map();
  let current = null, game = null, board = null;
  let index = 0, tries = 0, locked = false;

  const status = (msg, kind) => {
    const s = host.querySelector('#pz-status');
    s.textContent = msg;
    if (kind) s.dataset.status = kind; else delete s.dataset.status;
  };

  const paintProgress = () => {
    const list = host.querySelector('#pz-progress');
    if (!current) { list.innerHTML = '<div class="empty-state">No puzzle selected.</div>'; return; }
    const sol = current.solution || [];
    list.innerHTML = sol.map((mv, i) =>
      `<div class="list-item${i < index ? ' done' : ''}">
        <span class="pz-step">${i + 1}</span>
        <span>${i < index ? esc(mv) : '•••'}</span>
      </div>`).join('') +
      `<div class="pz-tries">${tries} / ${current.maxMoves || sol.length} attempts used</div>`;
  };

  const paintList = () => {
    host.querySelector('#pz-empty').hidden = puzzles.length > 0;
    host.querySelector('#pz-meta').textContent = puzzles.length ? `${puzzles.length} published` : '';
    host.querySelector('#pz-list').innerHTML = puzzles.map((p, i) => {
      const a = attempts.get(p.id);
      return `<button class="pz-row${current && current.id === p.id ? ' on' : ''}" data-p="${esc(p.id)}">
        <span class="pz-row-info">
          <span class="pz-row-title">${esc(p.title || 'Puzzle ' + (i + 1))}</span>
          <span class="pz-row-meta">${p.points || 10} pts · ${(p.solution || []).length} moves</span>
        </span>
        ${a ? `<span class="pz-done">+${a.scoreAwarded || 0}</span>` : (i === 0 ? '<span class="pz-new">New</span>' : '')}
      </button>`;
    }).join('');
    host.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => select(puzzles.find((x) => x.id === b.dataset.p), b.dataset.p !== puzzles[0]?.id)));
  };

  const build = (fen, orientation) => {
    if (board && board.destroy) board.destroy();
    board = window.Chessboard(host.querySelector('#pz-board'), {
      draggable: true,
      position: fen,
      orientation,
      pieceTheme: PIECE_THEME,
      onDrop: (from, to) => {
        if (!game || !current || locked) return 'snapback';
        const color = current.playerColor || 'w';
        const max = Number(current.maxMoves || (current.solution || []).length || 0);
        const piece = game.get(from);
        if (piece && piece.color !== color) { status(`You're playing ${color === 'w' ? 'White' : 'Black'}.`, 'error'); return 'snapback'; }
        if (game.turn() !== color) {
          const t = game.fen().split(' ');
          t[1] = color;
          game = new window.Chess(t.join(' '));
        }
        const move = game.move({ from, to, promotion: 'q' });
        if (!move) return 'snapback';
        tries++;
        if (move.san !== (current.solution || [])[index]) {
          game.undo();
          tries--;
          if (tries >= max) { locked = true; status('Out of attempts.', 'error'); }
          else status('Not the move. Try again.', 'error');
          paintProgress();
          return 'snapback';
        }
        index++;
        if (index < current.solution.length) {
          const reply = game.move(current.solution[index], { sloppy: true });
          if (reply) index++;
        }
        if (index >= current.solution.length) {
          locked = true;
          status('Solved!', 'success');
          paintProgress();
          award();
          return undefined;
        }
        status('Correct.', 'success');
        paintProgress();
        return undefined;
      },
      onSnapEnd: () => board.position(game.fen())
    });
  };

  const select = (p, late) => {
    current = p; index = 0; tries = 0; locked = false;
    if (!p) { status('Pick a puzzle to start.'); paintProgress(); return; }
    if (attempts.has(p.id)) locked = true;
    const color = p.playerColor || 'w';
    const fen = normalizeFen(p.fen, color);
    game = new window.Chess(fen);
    build(fen, color === 'b' ? 'black' : 'white');
    host.querySelector('#pz-title').textContent = p.title || 'Puzzle';
    status(locked ? 'Already solved — replay for practice.' : `Playing as ${color === 'b' ? 'Black' : 'White'}.`, 'info');
    paintProgress();
    paintList();
  };

  const award = async () => {
    if (attempts.has(current.id)) return;
    const pts = Number(current.points || 10);
    try {
      await setDoc(clubDoc(ctx.clubId, 'puzzleAttempts', `${ctx.user.uid}_${current.id}`), {
        puzzleId: current.id, userId: ctx.user.uid, completedAt: Date.now(),
        movesUsed: tries, scoreAwarded: pts
      }, { merge: true });
      await updateDoc(memberRef(ctx.clubId, ctx.user.uid), { points: increment(pts) });
      ctx.member.points = (ctx.member.points || 0) + pts;
      attempts.set(current.id, { scoreAwarded: pts });
      paintList();
      celebrate(pts);
    } catch (e) { console.error(e); toast('Could not save your score', 'error'); }
  };

  host.querySelector('#pz-reset').onclick = () => current && select(current, false);

  const stopP = onSnapshot(query(clubCol(ctx.clubId, 'puzzles'), orderBy('createdAt', 'desc')), (s) => {
    puzzles = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    paintList();
    if (!current && puzzles.length) select(puzzles[0], false);
    if (!puzzles.length) paintProgress();
  });

  const stopA = onSnapshot(query(clubCol(ctx.clubId, 'puzzleAttempts'), where('userId', '==', ctx.user.uid)), (s) => {
    attempts = new Map(s.docs.map((d) => [d.data().puzzleId, d.data()]));
    paintList();
  });

  return () => { stopP(); stopA(); if (board && board.destroy) board.destroy(); };
}

function celebrate(points) {
  const m = el(`<div class="modal"><div class="modal-card" style="max-width:380px;text-align:center">
    <div class="pz-celebrate">♟</div>
    <h3>Puzzle solved!</h3>
    <div class="modal-meta">Points earned</div>
    <div class="puzzle-points-count">+${points}</div>
    <button class="btn primary block" data-x>Nice!</button>
  </div></div>`);
  document.body.appendChild(m);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };
}

async function puzzlesAdmin(ctx, host) {
  host.innerHTML = `
    <div class="puzzle-layout">
      <div class="tile puzzle-board">
        <div class="puzzle-header"><h3>Create puzzle</h3>
          <div class="puzzle-status" id="pz-status">Set the starting position.</div></div>
        <div id="pz-board" class="chessboard"></div>
        <div class="puzzle-controls">
          <button class="btn primary" id="pz-add">Record move</button>
          <button class="btn subtle" id="pz-start">Set as start</button>
          <button class="btn subtle" id="pz-reset">Reset to start</button>
          <button class="btn subtle" id="pz-undo">Undo</button>
          <button class="btn subtle" id="pz-clear">Clear board</button>
          <button class="btn subtle" id="pz-fen">FEN…</button>
        </div>
        <div class="puzzle-sequence"><h4>Solution line</h4><div class="list" id="pz-seq"></div></div>
      </div>
      <div class="tile puzzle-side">
        <h3 id="pz-form-title">Puzzle details</h3>
        <div class="form-inline">
          <input id="pz-title" placeholder="Title" />
          <textarea id="pz-desc" rows="2" placeholder="Short description"></textarea>
          <div class="row">
            <input id="pz-max" type="number" min="1" placeholder="Max attempts" value="3" />
            <input id="pz-pts" type="number" min="1" placeholder="Points" value="10" />
          </div>
          <select id="pz-color"><option value="w">Play as White</option><option value="b">Play as Black</option></select>
          <div class="row">
            <button class="btn primary" id="pz-publish">Publish puzzle</button>
            <button class="btn subtle" id="pz-cancel" hidden>Cancel</button>
          </div>
        </div>
        <h4 style="margin-top:22px">Published</h4>
        <div class="list" id="pz-list"></div>
        <div class="empty-state" id="pz-empty" hidden>Nothing published yet.</div>
      </div>
    </div>`;

  let board = null, game = null;
  let startFen = 'start';
  let solution = [];
  let editingId = null;
  let puzzles = [];

  const status = (m, k) => {
    const s = host.querySelector('#pz-status');
    s.textContent = m;
    if (k) s.dataset.status = k; else delete s.dataset.status;
  };

  const paintSeq = () => {
    host.querySelector('#pz-seq').innerHTML = solution.length
      ? solution.map((m, i) => `<div class="list-item"><span class="pz-step">${i + 1}</span><span>${esc(m)}</span></div>`).join('')
      : '<div class="empty-state">Play the winning line on the board, recording each move.</div>';
  };

  const build = (opts) => {
    if (board && board.destroy) board.destroy();
    board = window.Chessboard(host.querySelector('#pz-board'), {
      draggable: true,
      dropOffBoard: 'trash',
      sparePieces: !!opts.spare,
      position: opts.position,
      orientation: opts.orientation || 'white',
      pieceTheme: PIECE_THEME,
      onDrop: opts.spare ? undefined : (from, to) => {
        if (!game) return 'snapback';
        const mv = game.move({ from, to, promotion: 'q' });
        if (!mv) return 'snapback';
        pendingMove = mv.san;
        status(`${mv.san} played — press “Record move” to add it.`, 'info');
        return undefined;
      },
      onSnapEnd: () => { if (game) board.position(game.fen()); }
    });
  };

  let pendingMove = null;

  build({ spare: true, position: 'start' });
  paintSeq();

  host.querySelector('#pz-start').onclick = () => {
    startFen = board.fen();
    const color = host.querySelector('#pz-color').value;
    const full = `${startFen} ${color} - - 0 1`;
    try { game = new window.Chess(full); }
    catch { toast('That position isn\'t legal', 'error'); return; }
    solution = [];
    pendingMove = null;
    build({ spare: false, position: game.fen(), orientation: color === 'b' ? 'black' : 'white' });
    paintSeq();
    status('Start position locked. Now play the solution.', 'success');
  };

  host.querySelector('#pz-add').onclick = () => {
    if (!pendingMove) { toast('Play a move on the board first'); return; }
    solution.push(pendingMove);
    pendingMove = null;
    paintSeq();
    status(`${solution.length} move${solution.length === 1 ? '' : 's'} recorded.`, 'success');
  };

  host.querySelector('#pz-undo').onclick = () => {
    if (!game) return;
    game.undo();
    solution.pop();
    pendingMove = null;
    board.position(game.fen());
    paintSeq();
  };

  host.querySelector('#pz-reset').onclick = () => {
    if (!startFen || startFen === 'start') { build({ spare: true, position: 'start' }); return; }
    const color = host.querySelector('#pz-color').value;
    game = new window.Chess(`${startFen} ${color} - - 0 1`);
    solution = [];
    pendingMove = null;
    build({ spare: false, position: game.fen(), orientation: color === 'b' ? 'black' : 'white' });
    paintSeq();
  };

  host.querySelector('#pz-clear').onclick = () => {
    game = null; solution = []; startFen = 'start'; pendingMove = null;
    build({ spare: true, position: 'empty' });
    paintSeq();
    status('Board cleared. Drag pieces in, then set the start.');
  };

  host.querySelector('#pz-fen').onclick = async () => {
    const fen = await promptDialog({
      title: 'Load from FEN', label: 'FEN string', placeholder: 'r1bqkb1r/pppp1ppp/… w KQkq - 0 1', confirmText: 'Load'
    });
    if (!fen) return;
    try {
      const test = new window.Chess(fen);
      startFen = fen.split(' ')[0];
      game = test;
      solution = [];
      build({ spare: false, position: test.fen(), orientation: test.turn() === 'b' ? 'black' : 'white' });
      host.querySelector('#pz-color').value = test.turn();
      host.querySelector('#pz-color').dispatchEvent(new Event('change', { bubbles: true }));
      paintSeq();
      status('Position loaded from FEN.', 'success');
    } catch { toast('That FEN isn\'t valid', 'error'); }
  };

  host.querySelector('#pz-publish').onclick = async () => {
    const title = host.querySelector('#pz-title').value.trim();
    if (!title) { toast('Give the puzzle a title', 'error'); return; }
    if (!solution.length) { toast('Record at least one move', 'error'); return; }
    const payload = {
      title,
      description: host.querySelector('#pz-desc').value.trim(),
      fen: startFen,
      solution,
      maxMoves: parseInt(host.querySelector('#pz-max').value, 10) || solution.length,
      points: parseInt(host.querySelector('#pz-pts').value, 10) || 10,
      playerColor: host.querySelector('#pz-color').value,
      updatedAt: Date.now()
    };
    try {
      if (editingId) await updateDoc(clubDoc(ctx.clubId, 'puzzles', editingId), payload);
      else await addDoc(clubCol(ctx.clubId, 'puzzles'), { ...payload, createdAt: Date.now() });
      toast(editingId ? 'Puzzle updated' : 'Puzzle published', 'ok');
      resetForm();
    } catch (e) { console.error(e); toast('Could not publish', 'error'); }
  };

  function resetForm() {
    editingId = null;
    host.querySelector('#pz-title').value = '';
    host.querySelector('#pz-desc').value = '';
    host.querySelector('#pz-form-title').textContent = 'Puzzle details';
    host.querySelector('#pz-publish').textContent = 'Publish puzzle';
    host.querySelector('#pz-cancel').hidden = true;
    solution = []; startFen = 'start'; game = null; pendingMove = null;
    build({ spare: true, position: 'start' });
    paintSeq();
  }
  host.querySelector('#pz-cancel').onclick = resetForm;

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'puzzles'), orderBy('createdAt', 'desc')), (s) => {
    puzzles = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    host.querySelector('#pz-empty').hidden = puzzles.length > 0;
    host.querySelector('#pz-list').innerHTML = puzzles.map((p) => `
      <div class="pz-row static">
        <span class="pz-row-info">
          <span class="pz-row-title">${esc(p.title || 'Puzzle')}</span>
          <span class="pz-row-meta">${p.points || 10} pts · ${(p.solution || []).length} moves</span>
        </span>
        <span class="pz-row-tools">
          <button class="btn subtle sm" data-edit="${esc(p.id)}">Edit</button>
          <button class="btn danger sm" data-del="${esc(p.id)}">✕</button>
        </span>
      </div>`).join('');

    host.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
      const p = puzzles.find((x) => x.id === b.dataset.edit);
      editingId = p.id;
      host.querySelector('#pz-title').value = p.title || '';
      host.querySelector('#pz-desc').value = p.description || '';
      host.querySelector('#pz-max').value = p.maxMoves || 3;
      host.querySelector('#pz-pts').value = p.points || 10;
      const cs = host.querySelector('#pz-color');
      cs.value = p.playerColor || 'w';
      cs.dispatchEvent(new Event('change', { bubbles: true }));
      startFen = p.fen;
      solution = (p.solution || []).slice();
      try {
        game = new window.Chess(normalizeFen(p.fen, p.playerColor || 'w'));
        build({ spare: false, position: game.fen(), orientation: (p.playerColor || 'w') === 'b' ? 'black' : 'white' });
      } catch { build({ spare: true, position: 'start' }); }
      paintSeq();
      host.querySelector('#pz-form-title').textContent = 'Edit puzzle';
      host.querySelector('#pz-publish').textContent = 'Save changes';
      host.querySelector('#pz-cancel').hidden = false;
      status('Editing an existing puzzle.', 'info');
    }));

    host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!await confirmDialog({ title: 'Delete puzzle?', body: 'Members will no longer see it.', confirmText: 'Delete', danger: true })) return;
      await deleteDoc(clubDoc(ctx.clubId, 'puzzles', b.dataset.del));
      toast('Puzzle deleted');
    }));
  });

  return () => { stop(); if (board && board.destroy) board.destroy(); };
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
            <button class="rte-btn" data-cmd="bold" title="Bold"><strong>B</strong></button>
            <button class="rte-btn" data-cmd="italic" title="Italic"><em>I</em></button>
            <button class="rte-btn" data-cmd="underline" title="Underline"><u>U</u></button>
            <div class="rte-sep"></div>
            <button class="rte-btn" data-cmd="insertUnorderedList" title="Bullets">•—</button>
            <button class="rte-btn" data-cmd="insertOrderedList" title="Numbers">1—</button>
            <div class="rte-sep"></div>
            <button class="rte-btn" data-link title="Link">🔗</button>
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

  if (isAdmin) {
    host.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = (e) => {
      e.preventDefault();
      document.execCommand(b.dataset.cmd, false, null);
      host.querySelector('#nw-body').focus();
    }));
    host.querySelector('[data-link]').onclick = async (e) => {
      e.preventDefault();
      const url = await promptDialog({ title: 'Insert link', label: 'URL', placeholder: 'https://', confirmText: 'Insert' });
      if (url) document.execCommand('createLink', false, url);
    };
    /* the optional "email this out" field — roster comes from club members */
    let members = [];
    mailField = mountNewsletterMail(host.querySelector('#nw-mail'), {
      getPeople: () => members.map((m) => ({
        email: m.email,
        name: m.username,
        role: m.role || 'student',
        avatarColor: m.avatarColor,
      })),
      getMe: () => ctx.user.email || '',
      getClubName: () => ctx.club?.name || '',
      addAllLabel: `Add all ${ctx.club?.name || 'club'} students`,
    });

    stopMembers = onSnapshot(clubCol(ctx.clubId, 'members'), (s) => {
      members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      mailField.refresh();
    });

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
    if (mailField) mailField.destroy();
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

  host.innerHTML = `
    <div class="lb-tabs">
      <button class="lb-tab on" data-t="points">Points</button>
      <button class="lb-tab" data-t="rated">Rated</button>
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

  host.querySelector('.lb-tabs').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    tab = b.dataset.t;
    host.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('on', t.dataset.t === tab));
    host.querySelector('#lb-metric').textContent = tab === 'points' ? 'Points' : 'Rating';
    paint();
  };

  function ordered() {
    const rows = members
      .filter((m) => !m.deleted)
      .filter((m) => !(ctx.club.hideStaffFromLeaderboard && isStaff(m.role)));
    if (tab === 'points') return rows.sort((a, b) => (b.points || 0) - (a.points || 0));
    // an unplayed 1000 says nothing, so provisional players sit below the ranked ones
    return rows.sort((a, b) => {
      const ra = readRating(a);
      const rb = readRating(b);
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
      const rating = readRating(m);
      const metric = tab === 'points'
        ? `${m.points || 0}`
        : `<span class="${rating.games < 1 ? 'lb-provisional' : ''}">${displayRating(m.rating)}</span>
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
          <span class="lb-avatar" style="background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username || m.email))}</span>
          <span class="lb-player-info">
            <span class="lb-player-name">${esc(m.username || 'Player')}${me ? '<span class="lb-me-badge">You</span>' : ''}${isStaff(m.role) ? `<span class="role-pill ${esc(m.role)}" style="margin-left:8px">${esc(ROLE_LABEL[m.role])}</span>` : ''}</span>
            <span class="lb-player-email">${esc(m.email || '')}</span>
          </span>
        </span>
        <span class="lb-col-pts">${metric}</span>
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
        <div class="pf-avatar" id="pf-avatar" style="background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username))}</div>
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
          <label>Avatar colour</label>
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

  let color = m.avatarColor || '#1cb0f6';
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
      </div>
    </div>
    <div class="tile users-tile">
      <div class="users-table-head"><span>#</span><span></span><span>Member</span><span style="text-align:right">Points</span><span></span></div>
      <div id="mb-list"></div>
    </div>
    <section class="tile mb-bans" id="mb-bans" hidden style="margin-top:16px">
      <div class="mb-bans-head">
        <h3>Removed members &amp; appeals</h3>
        <span class="mb-appeal-count" id="mb-appeals" hidden></span>
      </div>
      <div id="mb-ban-list"></div>
    </section>`;

  let members = [];
  let filter = 'all';

  const paint = () => {
    const rows = members.filter((m) => {
      const r = m.role || 'student';
      return filter === 'all' || (filter === 'staff' ? isStaff(r) : r === 'student');
    });
    const staffCount = members.filter((m) => isStaff(m.role)).length;
    host.querySelector('#mb-meta').textContent =
      `${members.length} member${members.length === 1 ? '' : 's'} · ${staffCount} staff`;

    host.querySelector('#mb-list').innerHTML = rows.map((m, i) => {
      const role = m.role || 'student';
      const manageable = m.uid !== ctx.user.uid && canModerate(myRole, role);
      return `<div class="user-row">
        <div class="user-rank${i === 0 ? ' top' : ''}">${i + 1}</div>
        <div class="user-avatar-circle" style="background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username || m.email))}</div>
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
        <div class="user-avatar-circle" style="width:52px;height:52px;font-size:17px;background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username || m.email))}</div>
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
  const paintBans = (rows) => {
    const wrap = host.querySelector('#mb-bans');
    wrap.hidden = rows.length === 0;
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
  };

  const stop = onSnapshot(query(clubCol(ctx.clubId, 'members'), orderBy('points', 'desc')), (s) => {
    members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    paint();
  });

  const stopBans = onSnapshot(clubCol(ctx.clubId, 'bans'), (s) => {
    paintBans(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at || 0) - (a.at || 0)));
  }, (e) => console.warn('bans listener', e));

  return () => { stop(); stopBans(); };
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
        <span class="user-avatar-circle" style="background:${esc(m.avatarColor || '#1cb0f6')}">${esc(initials(m.username || m.email))}</span>
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

async function renderSettings(ctx, host) {
  const c = ctx.club;
  host.innerHTML = `
    <div class="settings-grid">
      <div class="tile">
        <h3>Club details</h3>
        <div class="form-inline">
          <div><label>Name</label><input id="se-name" value="${esc(c.name || '')}" /></div>
          <div><label>Description</label><textarea id="se-desc" rows="3">${esc(c.description || '')}</textarea></div>
          <div><label>Web address</label>
            <div class="domain-preview"><span class="domain-fixed">${esc(location.host)}/clubs/</span><span class="domain-slug">${esc(c.slug || c.id)}</span></div>
            <p class="field-hint">The address is fixed once the club is created, so member links never break.</p>
          </div>
          <div><label>Who can join?</label>
            <div class="seg-choice" id="se-vis">
              <button class="seg-opt${c.visibility !== 'private' ? ' on' : ''}" data-v="public"><span><b>Public</b><small>Listed and open to anyone</small></span></button>
              <button class="seg-opt${c.visibility === 'private' ? ' on' : ''}" data-v="private"><span><b>Private</b><small>Join code required</small></span></button>
            </div>
          </div>
          <div><button class="btn primary" id="se-save">Save changes</button></div>
        </div>
      </div>

      <div class="tile">
        <h3>Join code</h3>
        <p class="muted" style="font-size:13.5px;margin:-6px 0 14px">Share this with people you want in the club.</p>
        <div class="code-row">
          <div class="code-display" id="se-code">${esc(c.code || '——————')}</div>
          <button class="btn subtle sm" id="se-copy">Copy</button>
          <button class="btn subtle sm" id="se-regen">Regenerate</button>
        </div>
        <button class="btn primary block" id="se-share" style="margin-top:12px">Invite link & QR code</button>
        <p class="field-hint" style="margin-top:8px">
          ${c.visibility === 'private'
            ? 'This club is private, so only admins can see the invite link and QR code.'
            : 'This club is public, so any member can share its invite link and QR code.'}
        </p>

        ${ctx.member.role === 'founder' ? `
        <h3 style="margin-top:26px">Ownership</h3>
        <p class="muted" style="font-size:13.5px;margin:-6px 0 14px">
          You are the founder of ${esc(c.name || 'this club')}. Handing it over makes someone else
          founder and drops you to admin.</p>
        <button class="btn subtle" id="se-transfer">Transfer ownership…</button>` : ''}

        <h3 style="margin-top:26px">Danger zone</h3>
        <p class="muted" style="font-size:13.5px;margin:-6px 0 14px">Deleting a club removes it for every member. This can't be undone.</p>
        <button class="btn danger" id="se-delete">Delete this club</button>
      </div>
    </div>`;

  const transferBtn = host.querySelector('#se-transfer');
  if (transferBtn) transferBtn.onclick = () => openTransfer(ctx);

  let visibility = c.visibility || 'public';
  host.querySelector('#se-vis').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    visibility = b.dataset.v;
    host.querySelectorAll('#se-vis .seg-opt').forEach((o) => o.classList.toggle('on', o === b));
  };

  host.querySelector('#se-save').onclick = async () => {
    const btn = host.querySelector('#se-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await updateDoc(clubRef(ctx.clubId), {
        name: host.querySelector('#se-name').value.trim() || c.name,
        description: host.querySelector('#se-desc').value.trim(),
        visibility
      });
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
      body: 'Every member loses access. Content stays in the database but the club disappears.',
      confirmText: 'Delete club', danger: true
    });
    if (!ok) return;
    await deleteDoc(clubRef(ctx.clubId));
    location.href = '/clubs';
  };

  return noop;
}
