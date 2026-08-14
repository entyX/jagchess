/* ═══════════════════════════════════════════════════════════════════════
   club-attendance.js — the check-in nudge.

   Opening the club while an event is running puts the attendance form in
   front of you rather than waiting for you to find the Events page. Close it
   without checking in and a short reminder follows, so nobody loses points
   by clicking past a modal.

   A scanned attendance QR lands here too, via ?att=<eventId>.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  clubCol, clubDoc, getDoc, getDocs, query, where, orderBy,
  esc, toast
} from './club-core.js';

/* Same window the Events page uses: from five minutes before the start
   until the event is over. */
export const isLive = (e) => {
  const start = e.date;
  const end = start + (e.durationMin || 30) * 60000;
  const now = Date.now();
  return now >= start - 5 * 60000 && now <= end;
};

export const hasPassed = (e) => Date.now() > e.date + (e.durationMin || 30) * 60000;

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

/* Only nag once per event per tab — reopening the club later is fine, but
   flicking between pages should not re-trigger it. */
const nagged = new Set();

/**
 * Decide whether to prompt, and prompt.
 * @param {object} ctx        the club shell context
 * @param {object} api        { goToEvents }
 * @param {string} [eventId]  from a scanned QR; otherwise whatever is live
 */
export async function maybePromptAttendance(ctx, api, eventId) {
  try {
    const event = eventId ? await loadEvent(ctx, eventId) : await loadLiveEvent(ctx);

    // A scanned link always lands on Events. A stale one says nothing more.
    if (eventId) api.goToEvents();
    if (!event) return;
    if (!isLive(event) || hasPassed(event)) return;
    if (nagged.has(event.id)) return;

    const [formSnap, mine] = await Promise.all([
      getDoc(clubDoc(ctx.clubId, 'attendanceForms', event.id)),
      getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'),
        where('eventId', '==', event.id), where('userId', '==', ctx.user.uid)))
    ]);
    if (!mine.empty) return;                       // already checked in

    const points = (formSnap.exists() && formSnap.data().points) || 10;
    nagged.add(event.id);
    openPrompt(ctx, api, event, points);
  } catch (e) {
    console.warn('Could not check attendance', e);
  }
}

async function loadEvent(ctx, id) {
  const s = await getDoc(clubDoc(ctx.clubId, 'events', id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

async function loadLiveEvent(ctx) {
  const s = await getDocs(query(clubCol(ctx.clubId, 'events'), orderBy('date', 'asc')));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).find(isLive) || null;
}

/* ── the two modals ────────────────────────────────────────────────── */

function openPrompt(ctx, api, event, points) {
  const modal = el(`
    <div class="modal att-prompt">
      <div class="modal-card att-prompt-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <div class="att-prompt-ico">📋</div>
        <h3>Attendance is open</h3>
        <div class="att-prompt-event">${esc(event.title || 'This event')}</div>
        <p class="modal-meta" style="margin:0">
          Check in now and you'll be awarded <b>${points} points</b>.
        </p>
        <div class="att-prompt-actions">
          <button class="btn subtle" data-later>Not now</button>
          <button class="btn primary" data-go>Check in →</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(modal);

  let done = false;
  const dismiss = (took) => {
    if (done) return;
    done = true;
    modal.remove();
    if (!took) setTimeout(() => openReminder(event), 260);   // after the first has gone
  };

  modal.querySelector('[data-x]').onclick = () => dismiss(false);
  modal.querySelector('[data-later]').onclick = () => dismiss(false);
  modal.onclick = (e) => { if (e.target === modal) dismiss(false); };
  modal.querySelector('[data-go]').onclick = () => {
    dismiss(true);
    api.goToEvents();
  };
}

function openReminder(event) {
  const modal = el(`
    <div class="modal att-reminder">
      <div class="modal-card att-prompt-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <div class="att-prompt-ico warn">⏰</div>
        <h3>Make sure to complete it!</h3>
        <p class="modal-meta" style="margin:0">
          You can always fill out attendance for ${esc(event.title || 'this event')}
          by clicking the <b>Events</b> tab.
        </p>
        <button class="btn primary block" data-ok>Got it</button>
      </div>
    </div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-x]').onclick = close;
  modal.querySelector('[data-ok]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}
