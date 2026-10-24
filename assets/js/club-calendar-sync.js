/* ═══════════════════════════════════════════════════════════════════════
   club-calendar-sync.js — the switch, and everything it turns on.

   google-calendar.js knows how to talk to Google and nothing about this
   club. This file is the other half: where the connection is remembered,
   who is allowed to change it, and what the calendar draws once it is on.

   ─── the switch ────────────────────────────────────────────────────────
   Syncing is a club setting, not a personal one: it is stored on the club
   and every member sees the result. But it can only be turned on by
   somebody who signed into JagChess WITH Google, because turning it on
   immediately needs a Google token and asking an email/password user for
   one would mean sending them through a second, unrelated sign-in.

   ─── what turning it off does, and does not do ─────────────────────────
   Off is not a disconnection and not a deletion. The club's own events are
   in Firestore and stay exactly as they are — they were written there
   first and were never Google's. What stops is the drawing of the
   account's own events, and the pushing of new club events out. Whatever
   was already pushed stays in the person's calendar, because deleting
   things out of somebody's Google Calendar is not a thing a toggle should
   do quietly.
   ═══════════════════════════════════════════════════════════════════════ */

import { db, doc, getDoc, setDoc, onSnapshot, esc, toast, confirmDialog } from './club-core.js';
import * as G from './google-calendar.js';

const ref = (clubId) => doc(db, 'clubs', clubId, 'integrations', 'calendar');

/* How much of the account's calendar is drawn. A club calendar is a month
   at a time and nobody scrolls two years back, so the window is generous
   rather than unbounded — an unbounded pull on a busy account is hundreds
   of events nobody asked to see. */
const WINDOW_BACK = 120 * 864e5;
const WINDOW_FWD = 365 * 864e5;

/** True when this person signed in to JagChess with Google. */
export function signedInWithGoogle(user) {
  const list = (user && user.providerData) || [];
  return list.some((p) => p && p.providerId === 'google.com');
}

/**
 * Attaches the Google half of the calendar.
 *
 * @returns an object the events block uses: the extra rows to draw, and
 *   the two writes to make when a club event changes.
 */
export function attachCalendarSync(ctx, host, opts) {
  const onChange = opts.onChange;
  const clubEvents = opts.events;
  const isStaff = !!ctx.isAdmin;
  let state = { enabled: false, accountEmail: '', calendarId: G.CALENDAR_ID };
  let googleEvents = [];
  let connected = false;
  let busy = false;
  let resumed = false;
  /* The last thing that went wrong, kept so the tile can say it. Copying a
     term's events out can fail one at a time and for a reason the person
     can actually fix — a missing scope, most often — and a count in the
     console helps nobody. */
  let problem = '';

  const tile = host.querySelector('#cal-sync');

  /* ── reading and writing the setting ──────────────────────────────── */

  const save = (patch) => setDoc(ref(ctx.clubId), {
    ...state, ...patch, updatedAt: Date.now(), updatedBy: ctx.user.uid
  }, { merge: true });

  /* ── the events themselves ────────────────────────────────────────── */

  async function refresh() {
    if (!state.enabled) { googleEvents = []; onChange(); return; }
    if (!connected) {
      /* Nothing is shown and nothing is complained about: the club setting
         says on, this particular browser simply has no token yet. */
      googleEvents = [];
      onChange();
      return;
    }
    try {
      const now = Date.now();
      googleEvents = await G.pull(now - WINDOW_BACK, now + WINDOW_FWD);
    } catch (e) {
      console.warn('Could not read the Google calendar', e);
      googleEvents = [];
    }
    onChange();
  }

  /* ── bringing the connection back without asking ──────────────────── */

  async function resume() {
    if (!state.enabled || !G.isConfigured()) { paint(); return; }
    connected = await G.resume();
    paint();
    refresh();
  }

  /* ── the switch ───────────────────────────────────────────────────── */

  async function turnOn() {
    const ok = await confirmDialog({
      title: 'Sync with Google Calendar?',
      body: 'Your club’s events will be copied into your Google Calendar, and that '
        + 'account’s own events will show on the club calendar. Everything the club has '
        + 'stays in JagChess either way.',
      confirmText: 'Connect Google'
    });
    if (!ok) return;

    busy = true; paint();
    try {
      const who = await G.connect();
      connected = true;
      state = { ...state, enabled: true, accountEmail: who.email || '' };
      await save({ enabled: true, accountEmail: state.accountEmail, connectedBy: ctx.user.uid });
      toast('Google Calendar connected', 'ok');
      const r = await pushAll();
      if (r.failed) {
        toast(r.sent
          ? `Copied ${r.sent} of ${r.total} events — the rest did not go`
          : 'Connected, but no events could be copied', 'error');
      } else if (r.sent) {
        toast(`Copied ${r.sent} event${r.sent === 1 ? '' : 's'} to Google`, 'ok');
      }
      await refresh();
    } catch (e) {
      console.warn(e);
      problem = describe(e);
      /* The connection itself failed, so nothing is on. Leaving `enabled`
         true would show a switch that claims to be working. */
      if (e && e.code === 'no-calendar-scope') {
        state = { ...state, enabled: false };
        await save({ enabled: false }).catch(() => {});
      }
      toast(e && e.code === 'no-calendar-scope'
        ? 'Google did not grant calendar access'
        : 'Google did not complete the connection', 'error');
    } finally { busy = false; paint(); }
  }

  async function turnOff() {
    const ok = await confirmDialog({
      title: 'Stop syncing?',
      body: 'The club calendar will go back to showing only JagChess events, and new ones '
        + 'will stop being copied out. Nothing already in your Google Calendar is removed.',
      confirmText: 'Stop syncing'
    });
    if (!ok) return;

    busy = true; problem = ''; paint();
    try {
      state = { ...state, enabled: false };
      await save({ enabled: false });
      G.forget();
      connected = false;
      googleEvents = [];
      toast('Syncing stopped');
      onChange();
    } catch (e) {
      console.warn(e);
      toast('Could not save that', 'error');
    } finally { busy = false; paint(); }
  }

  /* ── pushing the club's own events out ────────────────────────────── */

  /* Called once when syncing is switched on, so a calendar that has been
     running for a term does not start half empty. Failures are per event
     and never collective: one malformed event must not stop the rest. */
  async function pushAll() {
    if (!state.enabled || !connected) return { sent: 0, failed: 0 };
    const rows = clubEvents() || [];
    let sent = 0, failed = 0, first = null;
    for (const ev of rows) {
      try { await pushOne(ev); sent++; }
      catch (e) {
        failed++;
        if (!first) first = e;
        console.warn('could not copy event', ev.id, e);
        /* A missing scope fails identically for every remaining event, so
           stopping is kinder than making a hundred doomed requests. */
        if (e && e.code === 'no-calendar-scope') break;
      }
    }
    if (first) problem = describe(first);
    else if (rows.length) problem = '';
    return { sent, failed, total: rows.length, first };
  }

  /* Said in terms of what to do about it, not what the API returned. */
  function describe(e) {
    if (e && e.code === 'no-calendar-scope') {
      return 'Google connected, but without permission to use the calendar. The '
        + 'calendar.events scope has to be added to this site’s Google sign-in screen '
        + 'before this can work.';
    }
    const msg = String((e && e.message) || 'Something went wrong');
    if (/insufficient|permission|403/i.test(msg)) {
      return 'Google refused the calendar request: ' + msg;
    }
    return msg;
  }

  async function pushOne(ev) {
    if (!state.enabled || !connected || !ev || !ev.id) return;
    const gid = await G.push({ ...ev, clubId: ctx.clubId });
    /* Stored so the next edit updates that event instead of making a
       second one. Written straight to the club document rather than kept
       in memory, because the next edit may well be from another admin on
       another machine. */
    if (gid && gid !== ev.googleEventId) {
      await setDoc(doc(db, 'clubs', ctx.clubId, 'events', ev.id),
        { googleEventId: gid }, { merge: true }).catch(() => {});
    }
  }

  async function removeOne(ev) {
    if (!state.enabled || !connected || !ev || !ev.googleEventId) return;
    try { await G.remove(ev.googleEventId); } catch (e) { console.warn('could not remove', e); }
  }

  /* ── the tile ─────────────────────────────────────────────────────── */

  function paint() {
    if (!tile) return;
    if (!isStaff) { tile.innerHTML = ''; return; }

    if (!G.isConfigured()) {
      tile.innerHTML = `<div class="tile cal-sync">
        <h3>Google Calendar</h3>
        <p class="field-hint">Not set up for this site yet — no Google client ID is
          configured, so there is nothing to connect to.</p>
      </div>`;
      return;
    }

    const canSwitch = signedInWithGoogle(ctx.user);
    const on = !!state.enabled;

    tile.innerHTML = `<div class="tile cal-sync">
      <div class="cal-sync-head">
        <h3>Google Calendar</h3>
        <button class="cal-switch${on ? ' on' : ''}" id="cal-sync-toggle" type="button"
          role="switch" aria-checked="${on ? 'true' : 'false'}"
          ${canSwitch && !busy ? '' : 'disabled'}
          title="${canSwitch ? 'Sync this club’s calendar with Google' : 'Sign in to JagChess with Google to use this'}">
          <span class="cal-switch-knob"></span>
        </button>
      </div>
      ${!canSwitch ? `
        <p class="field-hint">You are signed in to JagChess without Google, so there is no
          account to sync with. Sign in with Google to turn this on.</p>`
      : on ? `
        <p class="field-hint">
          ${state.accountEmail ? `Syncing with <b>${esc(state.accountEmail)}</b>.` : 'Syncing.'}
          ${connected
            ? 'This club’s events are copied there, and that calendar’s events show here.'
            : 'Waiting on Google — the account’s own events are not shown until it answers.'}
        </p>
        <div class="cal-sync-tools">
          <a class="btn subtle sm" href="${esc(G.CALENDAR_LINK)}" target="_blank" rel="noopener noreferrer">
            Open Google Calendar</a>
          ${connected ? `<button class="btn subtle sm" id="cal-sync-push" type="button"
            ${busy ? 'disabled' : ''}>Copy existing events now</button>` : ''}
        </div>`
      : `
        <p class="field-hint">Off. The calendar shows only what JagChess has. Turn this on to
          copy the club’s events into your Google Calendar and see that account’s
          events here.</p>`}
      ${busy ? '<p class="field-hint">Talking to Google…</p>' : ''}
      ${problem ? `<p class="cal-sync-problem">${esc(problem)}</p>` : ''}
    </div>`;

    const btn = tile.querySelector('#cal-sync-toggle');
    if (btn) btn.onclick = () => (state.enabled ? turnOff() : turnOn());

    /* Retrying is its own button rather than "turn it off and on again":
       the events that failed are the ones that matter and the connection
       is usually fine. */
    const again = tile.querySelector('#cal-sync-push');
    if (again) again.onclick = async () => {
      busy = true; problem = ''; paint();
      try {
        const r = await pushAll();
        toast(r.failed
          ? (r.sent ? `Copied ${r.sent} of ${r.total} — the rest did not go` : 'None of them could be copied')
          : `Copied ${r.sent} event${r.sent === 1 ? '' : 's'} to Google`,
        r.failed ? 'error' : 'ok');
      } catch (e) {
        problem = describe(e);
      } finally { busy = false; paint(); }
    };
  }

  /* ── start ────────────────────────────────────────────────────────── */

  /* Only staff may read the setting — it carries somebody's personal
     address — and only a connected browser could draw Google rows anyway,
     so for everybody else this is inert and the calendar is the database's
     alone. */
  if (!isStaff) return { rows: () => [], enabled: () => false, pushOne: async () => {}, removeOne: async () => {}, stop: () => {} };

  const stop = onSnapshot(ref(ctx.clubId), (snap) => {
    const was = state.enabled;
    const d = (snap.exists() && snap.data()) || {};
    state = {
      enabled: d.enabled === true,
      accountEmail: String(d.accountEmail || ''),
      calendarId: String(d.calendarId || G.CALENDAR_ID)
    };
    paint();
    if (state.enabled && !resumed) { resumed = true; resume(); }
    else if (!state.enabled) { resumed = false; googleEvents = []; if (was) onChange(); }
  }, (e) => console.warn('Could not read the calendar setting', e));

  paint();

  return {
    rows: () => (state.enabled && connected ? googleEvents : []),
    enabled: () => !!state.enabled,
    pushOne,
    removeOne,
    stop
  };
}
