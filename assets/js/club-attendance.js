/* ═══════════════════════════════════════════════════════════════════════
   club-attendance.js — checking in.

   The rule the whole file is built around: nobody is turned away. A QR code
   on a table gets scanned by whoever is in the room — members, the person
   who joined the club last week and never made an account, and the person
   who wandered in today. All three can check in, and all three end up
   somewhere sensible.

   What each of them is asked:

     signed in   — the club's own questions, and nothing else. The club
                   already knows their name and their address; asking again
                   is the longest part of a ten-second form.
     signed out  — first name, last name, email first, then the club's
                   questions. Those three are forced and cannot be removed,
                   because without them a check-in is an anonymous tally.

   And where the points go, which is decided later rather than on the spot:

     the address is a member's       — their points, once
     the address already registered  — the pending registration holds them
     the address is new              — a registration is filled in for them
                                       from what they just typed, and holds
                                       the points until they join

   "Later" is deliberate. Somebody signed out cannot write to a member's row
   and cannot read the pending list — the rules see to that, and should. So a
   guest check-in writes exactly one document, its own, and the awarding runs
   the next time a member of staff has the club open. See reconcile() at the
   bottom; it is the only thing here that needs privileges.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, clubCol, clubDoc, memberRef, applicationCol, applicationRef,
  publicAttendanceRef, attendanceResponseRef,
  collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, increment, emailKey, memberEmailRef, esc, clubAvatar
} from './club-core.js';

import {
  CORE_QUESTIONS, normalizeForm, renderQuestions, wireForm, readQuestions
} from './registration-form.js';

/* ── when a form is open ───────────────────────────────────────────── */

/* Same window the Events page uses: from five minutes before the start
   until the event is over. */
export const opensAt = (e) => e.date - 5 * 60000;
export const closesAt = (e) => e.date + (e.durationMin || 30) * 60000;

export const isLive = (e) => {
  const now = Date.now();
  return now >= opensAt(e) && now <= closesAt(e);
};

export const hasPassed = (e) => Date.now() > closesAt(e);

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

/* ── the stored form ───────────────────────────────────────────────── */

export const DEFAULT_POINTS = 10;

/**
 * One attendance form, cleaned up enough to draw.
 *
 * The questions go through the registration form's normalizer, which is what
 * makes the two editors interchangeable — and which quietly carries the old
 * shape forward, since a question saved by the previous editor was `{id,
 * text}` and normalizeQuestion reads `text` as a label.
 */
export function normalizeAttendanceForm(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const points = Number(f.points);
  return {
    points: Number.isFinite(points) ? points : DEFAULT_POINTS,
    questions: normalizeForm(f.questions)
  };
}

/** What a signed-out visitor is asked, in order: the forced three, then the club's. */
export const guestQuestions = (form) => CORE_QUESTIONS.concat(form.questions);

/** What a member is asked: the club's questions, and only those. */
export const memberQuestions = (form) => form.questions;

/* The questions ride along with the answers, exactly as they do on a
   registration. A club that edits its form next week must still be able to
   read what this person was actually asked. */
const questionRecord = (questions) => questions.map((q) => ({
  id: q.id,
  label: q.label,
  type: q.type,
  required: !!q.required,
  ...(q.type === 'slider' ? { min: q.min, max: q.max, step: q.step } : {})
}));

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE PUBLIC MIRROR                                                      */
/* ═══════════════════════════════════════════════════════════════════════ */

const mirrorPayload = (club, event, form) => ({
  clubId: club.id,
  clubSlug: club.slug || club.id,
  clubName: club.name || '',
  clubIcon: club.icon || '♞',
  clubColor: club.color || '#1faf5a',
  /* The card a guest sees is drawn from this copy and nothing else, so the
     club's picture has to travel with it or the check-in looks like a
     different club's. */
  clubPhoto: club.photo || '',
  eventId: event.id,
  title: event.title || 'This event',
  desc: event.desc || '',
  date: event.date,
  durationMin: event.durationMin || 30,
  points: form.points,
  questions: form.questions,
  opensAt: opensAt(event),
  closesAt: closesAt(event),
  updatedAt: Date.now()
});

const sameMirror = (a, b) => {
  const strip = ({ updatedAt, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
};

/**
 * Publishes one event's check-in so that somebody with no account can reach
 * it. Cheap by design — it reads first and writes only when something really
 * changed — because it is called from anywhere an admin so much as looks at
 * the attendance panel. Never throws: no club operation should fail over a
 * mirror.
 */
export async function syncPublicAttendance(club, event, form) {
  if (!club || !club.id || !event || !event.id) return false;
  try {
    const ref = publicAttendanceRef(club.id, event.id);
    const next = mirrorPayload(club, event, form);
    const current = await getDoc(ref);
    if (current.exists() && sameMirror(current.data(), next)) return false;
    await setDoc(ref, next);
    return true;
  } catch (e) {
    console.warn('Could not publish the check-in for this event', e);
    return false;
  }
}

export async function dropPublicAttendance(clubId, eventId) {
  try {
    await deleteDoc(publicAttendanceRef(clubId, eventId));
  } catch (e) { console.warn('Could not withdraw that check-in', e); }
}

/**
 * Keeps the mirrors for a club's soon-and-now events up to date.
 *
 * Only events inside the window anybody could actually scan into — open now,
 * or opening within a day — so a club with three years of history publishes
 * two documents, not a thousand. Staff only; everyone else no-ops.
 */
export async function publishOpenAttendance(ctx, events) {
  if (!ctx.isAdmin) return;
  const now = Date.now();
  const soon = events.filter((e) => closesAt(e) > now && opensAt(e) < now + 24 * 3600e3);
  await Promise.all(soon.map(async (event) => {
    const snap = await getDoc(clubDoc(ctx.clubId, 'attendanceForms', event.id)).catch(() => null);
    const form = normalizeAttendanceForm(snap && snap.exists() ? snap.data() : null);
    await syncPublicAttendance({ id: ctx.clubId, ...ctx.club }, event, form);
  }));
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE MODAL                                                              */
/* ═══════════════════════════════════════════════════════════════════════ */

const SIGN_IN_PITCH = `
  <div class="att-pitch">
    <span class="att-pitch-mark" aria-hidden="true">⚡</span>
    <div>
      <b>Signing in is worth it</b>
      <p>With an account your points land on your profile the moment you check in, and they keep
         adding up across every event. Already have one and would rather not log in right now?
         Fill this in with the same email address and we'll find your account and award the
         points anyway.</p>
    </div>
  </div>`;

/**
 * The check-in, for whoever opened it.
 *
 * @param {object} o
 *   clubId, club      — the club, however much of it the caller could read
 *   event             — id, title, date, durationMin
 *   form              — normalized: { points, questions }
 *   user              — the signed-in user, or null
 *   member            — their membership row, when there is one
 *   onDone            — called once the check-in is recorded
 */
export function openAttendanceModal(o) {
  const signedIn = !!o.user;
  const questions = signedIn ? memberQuestions(o.form) : guestQuestions(o.form);
  const points = o.form.points;

  const modal = el(`
    <div class="modal att-modal">
      <div class="modal-card att-card" role="dialog" aria-modal="true" aria-labelledby="att-title">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>

        <div class="att-card-head">
          ${clubAvatar(o.club, 'att-card-avatar')}
          <div>
            <span class="att-card-club">${esc(o.club.name || 'Check in')}</span>
            <h3 id="att-title">${esc(o.event.title || 'This event')}</h3>
          </div>
        </div>

        <div class="att-card-reward">
          <span class="att-live-dot" aria-hidden="true"></span>
          Checking in is worth <b>${esc(String(points))} point${points === 1 ? '' : 's'}</b>
        </div>

        <div class="att-stage" data-stage>
          <form class="rf-form att-qs" data-form novalidate${questions.length ? '' : ' hidden'}>
            ${signedIn ? '' : SIGN_IN_PITCH}
            ${renderQuestions(questions)}
            <p class="rf-form-error" data-err hidden></p>
            <button class="btn primary lg block" type="submit" data-submit>Check in</button>
            ${signedIn ? '' : `<p class="att-foot-note">Your answers go to
              ${esc(o.club.name || 'the club')}'s admins only.</p>`}
          </form>

          <div class="att-busy" data-busy${questions.length ? ' hidden' : ''}>
            <div class="att-spinner" aria-hidden="true"></div>
            <p data-busy-text>Checking you in…</p>
          </div>

          <div class="att-done" data-done hidden>
            <svg class="att-tick" viewBox="0 0 64 64" aria-hidden="true">
              <circle class="att-tick-ring" cx="32" cy="32" r="27" />
              <path class="att-tick-path" d="M19 33.5 28 42.5 45.5 24" />
            </svg>
            <h4 data-done-title>Complete</h4>
            <p class="att-done-sub" data-done-sub></p>
            <div class="att-done-actions" data-done-actions></div>
          </div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  const form = modal.querySelector('[data-form]');
  const errBox = modal.querySelector('[data-err]');
  const stage = modal.querySelector('[data-stage]');
  const busy = modal.querySelector('[data-busy]');
  const done = modal.querySelector('[data-done]');
  const submitBtn = modal.querySelector('[data-submit]');

  wireForm(form);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modal.remove();
    document.body.style.overflow = '';
    if (o.onClose) o.onClose();
  };
  modal.querySelector('[data-x]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  /* The two screens the form turns into. A check-in that asked nothing still
     goes through both — a modal that blinks open and shut tells you nothing
     about whether it worked. */
  const showBusy = (text) => {
    form.hidden = true;
    done.hidden = true;
    busy.hidden = false;
    busy.querySelector('[data-busy-text]').textContent = text || 'Checking you in…';
    stage.classList.add('is-busy');
  };

  const showDone = (title, sub, actions) => {
    busy.hidden = true;
    form.hidden = true;
    stage.classList.remove('is-busy');
    done.querySelector('[data-done-title]').textContent = title;
    done.querySelector('[data-done-sub]').innerHTML = sub || '';
    const box = done.querySelector('[data-done-actions]');
    box.innerHTML = (actions || []).map((a) => a.href
      ? `<a class="btn ${esc(a.kind || 'subtle')}" href="${esc(a.href)}">${esc(a.label)}</a>`
      : `<button class="btn ${esc(a.kind || 'subtle')}" data-act="${esc(a.label)}">${esc(a.label)}</button>`).join('');
    box.querySelectorAll('[data-act]').forEach((b) => (b.onclick = close));
    done.hidden = false;
    stage.classList.add('is-done');
    if (o.onDone) o.onDone();
  };

  const fail = (message) => {
    busy.hidden = true;
    form.hidden = false;
    stage.classList.remove('is-busy');
    errBox.innerHTML = message;
    errBox.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Check in';
  };

  /* A little air before the tick: the write is usually faster than the eye,
     and a confirmation nobody saw appear reads as a page that did nothing. */
  const settle = (ms = 620) => new Promise((r) => setTimeout(r, ms));

  async function send(values) {
    showBusy();
    try {
      const result = signedIn
        ? await submitAsMember(o, questions, values)
        : await submitAsGuest(o, questions, values);
      await settle();
      showDone(result.title, result.sub, result.actions);
    } catch (e) {
      console.error(e);
      if (e && e.code === 'already') {
        await settle(240);
        showDone('Already checked in', e.message, [{ label: 'Close' }]);
        return;
      }
      fail(e && e.code === 'permission-denied'
        ? 'This check-in has closed. Ask the club to reopen it.'
        : 'Could not send that — check your connection and try again.');
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const { ok, values, firstBad } = readQuestions(form, questions);
    if (!ok) {
      errBox.textContent = 'Some answers still need filling in.';
      errBox.hidden = false;
      const field = form.querySelector('[data-field="' + CSS.escape(firstBad) + '"]');
      if (field) field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    errBox.hidden = true;
    submitBtn.disabled = true;
    send(values);
  };

  /* Nothing to ask: no form, no button, straight to the spinner and the tick.
     This is the member-with-no-bonus-questions case, and it is the common one. */
  if (!questions.length) {
    Promise.resolve().then(() => send({}));
  }

  return { close };
}

/* ── the two ways a check-in is written ────────────────────────────── */

async function submitAsMember(o, questions, values) {
  const key = `${o.event.id}_${o.user.uid}`;
  const ref = attendanceResponseRef(o.clubId, key);

  /* Deterministic ids are what make one-check-in-per-person a fact rather
     than a hope: `setDoc` here is the only write, and the guard below is the
     read that keeps the message friendly. Rows written by the old random-id
     version are still found by the caller's query before we get here. */
  if ((await getDoc(ref)).exists()) {
    const err = new Error('You have already checked in for this event.');
    err.code = 'already';
    throw err;
  }

  const points = o.form.points;
  await setDoc(ref, {
    clubId: o.clubId,
    eventId: o.event.id,
    eventTitle: o.event.title || '',
    userId: o.user.uid,
    userEmail: (o.user.email || '').toLowerCase(),
    username: (o.member && o.member.username) || '',
    firstName: '',
    lastName: '',
    email: (o.user.email || '').toLowerCase(),
    guest: false,
    newUser: false,
    answers: values,
    questions: questionRecord(questions),
    points,
    awarded: true,
    submittedAt: Date.now()
  });

  await updateDoc(memberRef(o.clubId, o.user.uid), { points: increment(points) })
    .catch((e) => console.warn('Checked in, but the points did not land', e));
  if (o.member) o.member.points = (o.member.points || 0) + points;

  window.jagTrack?.('attendance_checkin', { club: o.clubId, mode: 'member' });

  return {
    title: 'Complete',
    sub: `You're checked in for <b>${esc(o.event.title || 'this event')}</b> — ` +
         `<b>+${esc(String(points))} points</b> added to your total.`,
    actions: [{ label: 'Done', kind: 'primary' }]
  };
}

async function submitAsGuest(o, questions, values) {
  const email = String(values.email || '').trim().toLowerCase();
  const key = await emailKey(email);
  if (!key) {
    const err = new Error('That does not look like an email address.');
    err.code = 'bad-email';
    throw err;
  }

  /* Asked of the club, not of the person: memberEmails answers "is this
     address in the club?" without handing over a single address. It changes
     nothing about what is written — it changes what we can promise. */
  let known = false;
  try {
    known = (await getDoc(memberEmailRef(o.clubId, key))).exists();
  } catch (e) {
    console.warn('Could not check that address against the club', e);
  }

  const ref = attendanceResponseRef(o.clubId, `${o.event.id}_${key}`);
  const points = o.form.points;

  const payload = {
    clubId: o.clubId,
    eventId: o.event.id,
    eventTitle: o.event.title || '',
    userId: '',
    userEmail: email,
    username: '',
    firstName: String(values.firstName || '').slice(0, 60),
    lastName: String(values.lastName || '').slice(0, 60),
    email: email.slice(0, 140),
    guest: true,
    newUser: !known,
    answers: values,
    questions: questionRecord(questions),
    points,
    awarded: false,
    submittedAt: Date.now()
  };

  /* One write, and the rules decide. A signed-out visitor cannot read a
     check-in back — those rows are names and addresses, and they stay
     members-only — so there is no asking first whether this one exists.

     Which leaves reading the refusal. `setDoc` over a document that is
     already there is an update, and a guest may only create, so a second
     check-in on the same address comes back permission-denied. So does a
     check-in after the form has closed. Those are the only two ways a
     payload we built ourselves can be refused, and the clock tells them
     apart: still inside the window means the row was already there. */
  try {
    await setDoc(ref, payload);
  } catch (e) {
    if (e && e.code === 'permission-denied' && Date.now() <= closesAt(o.event)) {
      const err = new Error(`${esc(payload.firstName || 'You')} already checked in for this one — ` +
        `one check-in per person per event.`);
      err.code = 'already';
      throw err;
    }
    throw e;
  }
  window.jagTrack?.('attendance_checkin', { club: o.clubId, mode: known ? 'matched' : 'new' });

  const club = esc(o.club.name || 'the club');
  const next = encodeURIComponent('/clubs/' + (o.club.slug || o.clubId));

  return {
    title: 'Complete',
    sub: known
      ? `You're marked down for <b>${esc(o.event.title || 'this event')}</b>. We found an account ` +
        `at <b>${esc(email)}</b>, so the <b>${esc(String(points))} points</b> are going there — ` +
        `log in any time to see them.`
      : `You're marked down for <b>${esc(o.event.title || 'this event')}</b>. You're new to ` +
        `${club}, so your <b>${esc(String(points))} points</b> are being held for you — ` +
        `create an account with <b>${esc(email)}</b> and they come with you.`,
    actions: known
      ? [{ label: 'Log in', kind: 'primary', href: '/login?next=' + next }, { label: 'Close' }]
      : [{ label: 'Create an account', kind: 'primary', href: '/login?mode=signup&next=' + next },
         { label: 'Close' }]
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  OPENING IT — MEMBERS                                                   */
/* ═══════════════════════════════════════════════════════════════════════ */

/* Only nag once per event per tab — reopening the club later is fine, but
   flicking between pages should not re-trigger it. */
const nagged = new Set();

async function loadEvent(ctx, id) {
  const s = await getDoc(clubDoc(ctx.clubId, 'events', id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

async function loadLiveEvent(ctx) {
  const s = await getDocs(query(clubCol(ctx.clubId, 'events'), orderBy('date', 'asc')));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).find(isLive) || null;
}

export async function loadAttendanceForm(ctx, eventId) {
  const snap = await getDoc(clubDoc(ctx.clubId, 'attendanceForms', eventId)).catch(() => null);
  return normalizeAttendanceForm(snap && snap.exists() ? snap.data() : null);
}

/** Has this member already checked in for this event? Old rows included. */
export async function alreadyCheckedIn(ctx, eventId) {
  const mine = await getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'),
    where('eventId', '==', eventId), where('userId', '==', ctx.user.uid)));
  return !mine.empty;
}

/** Opens the check-in for a signed-in member. */
export async function openMemberAttendance(ctx, event, opts = {}) {
  const form = opts.form || await loadAttendanceForm(ctx, event.id);
  return openAttendanceModal({
    clubId: ctx.clubId,
    club: { id: ctx.clubId, ...ctx.club },
    event,
    form,
    user: ctx.user,
    member: ctx.member,
    onDone: opts.onDone,
    onClose: opts.onClose
  });
}

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
    if (!isLive(event)) return;
    if (nagged.has(event.id)) return;
    if (await alreadyCheckedIn(ctx, event.id)) return;

    nagged.add(event.id);
    const form = await loadAttendanceForm(ctx, event.id);

    /* A scan is somebody standing at the table with their phone out. They
       have already said yes; putting a "would you like to check in?" card in
       front of them is one tap for nothing, so the form opens directly. */
    if (eventId) {
      openMemberAttendance(ctx, event, { form });
      return;
    }
    openPrompt(ctx, api, event, form);
  } catch (e) {
    console.warn('Could not check attendance', e);
  }
}

function openPrompt(ctx, api, event, form) {
  const points = form.points;
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
    openMemberAttendance(ctx, event, { form });
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

/* ═══════════════════════════════════════════════════════════════════════ */
/*  OPENING IT — NOBODY                                                    */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * The signed-out path: `/clubs/<slug>?att=<eventId>` with no session.
 *
 * Everything it needs is in the one public document — the club's name and
 * color as much as the questions — because there is nothing else on the
 * whole database this visitor may read.
 *
 * @returns {Promise<boolean>} whether a check-in was found and opened
 */
export async function openGuestAttendance(slug, eventId) {
  let snap = await getDoc(publicAttendanceRef(slug, eventId)).catch(() => null);

  /* Club ids are slugs, so the direct address is right virtually always. The
     fallback is for a club that renamed its slug after the QR went out. */
  if (!snap || !snap.exists()) {
    try {
      const rows = await getDocs(query(collection(db, 'publicAttendance'),
        where('eventId', '==', eventId), limit(5)));
      const hit = rows.docs.find((d) => d.data().clubSlug === slug || d.data().clubId === slug);
      snap = hit || null;
    } catch (e) { console.warn('Could not look up that check-in', e); }
  }

  if (!snap || !snap.exists || !snap.exists()) return false;
  const f = snap.data();

  const now = Date.now();
  if (now < f.opensAt || now > f.closesAt) {
    openClosedNotice(f, now > f.closesAt);
    return true;
  }

  openAttendanceModal({
    clubId: f.clubId,
    club: {
      id: f.clubId, slug: f.clubSlug, name: f.clubName,
      icon: f.clubIcon, color: f.clubColor, photo: f.clubPhoto
    },
    event: { id: f.eventId, title: f.title, date: f.date, durationMin: f.durationMin },
    form: normalizeAttendanceForm(f),
    user: null,
    member: null
  });
  return true;
}

function openClosedNotice(f, over) {
  const next = encodeURIComponent('/clubs/' + (f.clubSlug || f.clubId));
  const modal = el(`
    <div class="modal att-modal">
      <div class="modal-card att-card att-closed">
        <div class="att-card-head">
          <span class="att-card-avatar" style="background:${esc(f.clubColor || '#1faf5a')}">${esc(f.clubIcon || '♞')}</span>
          <div>
            <span class="att-card-club">${esc(f.clubName || '')}</span>
            <h3>${esc(f.title || 'This event')}</h3>
          </div>
        </div>
        <div class="att-prompt-ico warn">⏰</div>
        <p class="modal-meta" style="margin:0;text-align:center">
          ${over
            ? 'Check-in for this event has closed.'
            : 'Check-in for this event has not opened yet — it opens five minutes before the start.'}
        </p>
        <div class="att-done-actions">
          <a class="btn primary" href="/login?next=${next}">Log in</a>
          <a class="btn subtle" href="/network">Browse clubs</a>
        </div>
      </div>
    </div>`);
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  AWARDING — THE PART THAT NEEDS PRIVILEGES                              */
/* ═══════════════════════════════════════════════════════════════════════ */

const lowerEmail = (v) => String(v || '').trim().toLowerCase();

/* Once per tab is plenty. The reconciler runs off the back of an admin
   opening a page, and an admin clicking between pages should not re-run it. */
let reconciling = null;

/**
 * Sends every guest check-in's points where they belong.
 *
 * Somebody signed out can write their own check-in and nothing else — not a
 * member's points, not the pending list, neither of which they may even read.
 * So the row lands unawarded and this settles it the next time a member of
 * staff has the club open:
 *
 *   · the address is a member's       → their points, and the row is stamped
 *   · already on the pending list     → that registration holds the points
 *   · neither                         → a registration is created from the
 *                                       name and address they just typed,
 *                                       and holds them
 *   · a second row for the same
 *     address and event               → marked a duplicate, awarded nothing
 *
 * And the last piece, which closes the loop: a pending registration whose
 * person has since joined hands its points over to the membership row. That
 * is what "not on the leaderboard until they join" means in practice — the
 * points were never nowhere, they were just not on the board yet.
 *
 * Staff only, and silent: it is a repair pass, not a feature anybody asked
 * for, and it must never take a page down with it.
 *
 * @returns {Promise<number>} how many rows it settled
 */
export async function reconcileAttendance(ctx) {
  if (!ctx || !ctx.isAdmin) return 0;
  if (reconciling) return reconciling;
  reconciling = run(ctx).finally(() => { reconciling = null; });
  return reconciling;
}

async function run(ctx) {
  let settled = 0;
  try {
    /* The cheap question first, and usually the only one asked: is there
       anything at all to settle? Two small queries, both of which come back
       empty on a club where everybody signs in — and then nothing else is
       read. This runs off the back of an admin opening a page, so it has to
       cost nothing on the days it has nothing to do. */
    const [pendingSnap, holderSnap] = await Promise.all([
      getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'),
        where('awarded', '==', false), limit(300))),
      getDocs(query(applicationCol(ctx.clubId),
        where('attendancePoints', '>', 0), limit(300))).catch(() => ({ docs: [] }))
    ]);

    const holders = holderSnap.docs.filter((d) => !d.data().pointsHandedOver);
    if (pendingSnap.empty && !holders.length) return 0;

    const [memberSnap, appSnap] = await Promise.all([
      getDocs(clubCol(ctx.clubId, 'members')),
      pendingSnap.empty ? Promise.resolve({ docs: [] }) : getDocs(applicationCol(ctx.clubId))
    ]);

    const members = new Map();
    memberSnap.docs.forEach((d) => {
      const m = d.data();
      const e = lowerEmail(m.email);
      if (e) members.set(e, { id: d.id, ...m });
    });

    const apps = new Map();
    appSnap.docs.forEach((d) => {
      const a = d.data();
      const e = lowerEmail(a.email);
      if (e && !apps.has(e)) apps.set(e, { id: d.id, ...a });
    });

    /* Who has already been paid for which event. Read per event rather than
       for the club, because a check-in waiting to be settled belongs to one
       event and a club's whole history of them is not worth reading. */
    const paid = new Set();
    const eventIds = [...new Set(pendingSnap.docs.map((d) => d.data().eventId).filter(Boolean))];
    await Promise.all(eventIds.map(async (eventId) => {
      const snap = await getDocs(query(clubCol(ctx.clubId, 'attendanceResponses'),
        where('eventId', '==', eventId), where('awarded', '==', true), limit(400)))
        .catch(() => ({ docs: [] }));
      snap.docs.forEach((d) => {
        const r = d.data();
        const e = lowerEmail(r.email || r.userEmail);
        if (e) paid.add(`${eventId}::${e}`);
      });
    }));

    for (const d of pendingSnap.docs) {
      const r = d.data();
      const email = lowerEmail(r.email || r.userEmail);
      const points = Number(r.points) || 0;
      if (!email) continue;

      const stamp = { awarded: true, awardedAt: Date.now() };
      const mark = `${r.eventId}::${email}`;

      /* A second row for the same person and the same event. It is kept and
         labelled rather than deleted: an admin looking at the register should
         see that somebody filled it in twice, not silently have one vanish. */
      if (paid.has(mark)) {
        await updateDoc(d.ref, { ...stamp, duplicate: true, awardedTo: 'duplicate' }).catch(() => {});
        settled++;
        continue;
      }

      const member = members.get(email);
      if (member) {
        await updateDoc(memberRef(ctx.clubId, member.id), { points: increment(points) }).catch(() => {});
        await updateDoc(d.ref, {
          ...stamp,
          userId: member.uid || member.id,
          username: member.username || '',
          newUser: false,
          awardedTo: 'member'
        }).catch(() => {});
        paid.add(mark);
        settled++;
        continue;
      }

      const app = apps.get(email);
      if (app) {
        await updateDoc(applicationRef(ctx.clubId, app.id), {
          attendancePoints: increment(points),
          lastAttendanceAt: Date.now()
        }).catch(() => {});
        await updateDoc(d.ref, { ...stamp, awardedTo: 'applicant', applicationId: app.id }).catch(() => {});
        paid.add(mark);
        settled++;
        continue;
      }

      /* Nobody at all: fill the registration in for them out of what they
         typed on the check-in, so what an admin sees waiting is a person with
         a name, an address and the points they have already earned — rather
         than a check-in row with nowhere to go. */
      const created = await addDoc(applicationCol(ctx.clubId), {
        clubId: ctx.clubId,
        status: 'pending',
        firstName: String(r.firstName || '').slice(0, 60) || 'Guest',
        lastName: String(r.lastName || '').slice(0, 60) || '—',
        email: email.slice(0, 140),
        answers: { firstName: r.firstName || '', lastName: r.lastName || '', email },
        questions: [],
        source: 'attendance',
        attendancePoints: points,
        lastAttendanceAt: Date.now(),
        submittedAt: Date.now()
      }).catch((e) => { console.warn('Could not open a pending place for that check-in', e); return null; });

      if (!created) continue;
      apps.set(email, { id: created.id, email, attendancePoints: points });
      await updateDoc(d.ref, { ...stamp, awardedTo: 'applicant', applicationId: created.id }).catch(() => {});
      paid.add(mark);
      settled++;
    }

    settled += await handOverJoined(ctx, members, holders);
  } catch (e) {
    console.warn('Could not settle the guest check-ins', e);
  }
  return settled;
}

/**
 * A pending registration holding attendance points, whose person has since
 * made an account and joined: the points move onto the membership row, and
 * the registration is stamped so it never happens twice.
 */
async function handOverJoined(ctx, members, holders) {
  let moved = 0;
  for (const d of holders) {
    const a = d.data();
    const points = Number(a.attendancePoints) || 0;
    if (!points || a.pointsHandedOver) continue;
    const member = members.get(lowerEmail(a.email));
    if (!member) continue;
    await updateDoc(memberRef(ctx.clubId, member.id), { points: increment(points) }).catch(() => {});
    await updateDoc(d.ref, { pointsHandedOver: true, handedOverAt: Date.now() }).catch(() => {});
    moved++;
  }
  return moved;
}
