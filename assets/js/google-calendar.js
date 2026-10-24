/* ═══════════════════════════════════════════════════════════════════════
   google-calendar.js — the club calendar, mirrored into somebody's Google
   Calendar and back.

   ─── why the connection is "saved" but the token is not ────────────────
   A saved connection normally means a refresh token, and Google only hands
   those to a client that can keep a secret. JagChess is static hosting and
   a database: there is no server, so there is no secret, so there is no
   refresh token — the same wall lichess-auth.js and gmail-send.js both
   describe.

   What is saved instead is everything EXCEPT the token: which account was
   connected, which calendar, and whether syncing is on. The token itself
   is re-acquired on load with `prompt: ''`, which Google answers without
   showing anything at all to somebody who has already consented and still
   has a Google session. So nobody is asked to reconnect in the ordinary
   case, and the rare visible prompt is a session that genuinely expired
   rather than a connection we forgot.

   What this cannot do, and no amount of browser code can: sync while
   nobody has JagChess open. Every pull and push below happens because an
   admin is looking at the page. Moving this to a Cloud Function is the
   only thing that changes that, which is why everything here is kept free
   of the DOM — it would move unchanged.

   ─── what is authoritative ─────────────────────────────────────────────
   The database is. An event created in JagChess is written to Firestore
   first and pushed to Google second, and it stays in Firestore whether or
   not the push lands and whether or not syncing is ever turned on again.
   Google events are the other way round: they are shown while syncing is
   on and are NOT written into the club, because they are somebody's own
   calendar and the club has no claim on them. Turn syncing off and they
   simply stop being drawn — nothing of the club's is lost, and nothing of
   theirs is kept.
   ═══════════════════════════════════════════════════════════════════════ */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/calendar/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/* calendar.events is a SENSITIVE scope: until the app passes Google
   verification this shows an "unverified app" screen and allows at most
   100 connected accounts. userinfo.email is what lets the panel say which
   account is connected, and is not sensitive. */
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

/* One calendar, the account's own. Letting a club choose among a person's
   calendars would mean asking for calendar.readonly as well — a second
   sensitive scope to be verified — to show a list most clubs would scroll
   past. Switching Google account is how you switch calendar. */
export const CALENDAR_ID = 'primary';
export const CALENDAR_LINK = 'https://calendar.google.com/calendar/r';

const clientId = () => String((window.MAIL_CONFIG || {}).googleClientId || '').trim();
export const isConfigured = () => !!clientId();

let gisPromise = null;
let tokenClient = null;
let token = null;        // { value, expiresAt } — memory only, never stored
let account = null;      // { email }
let granted = '';        // the scopes Google actually gave us, not the ones we asked for

export const connectedAccount = () => account;

/* Asking for a scope and being given it are different things. If
   calendar.events is not on the consent screen for this client, Google
   still completes the sign-in and still hands back a token — just without
   that scope on it — and every calendar call then fails with 403. Checked
   here so the failure lands at connect time, with something to act on,
   instead of silently as an empty calendar. */
export const hasCalendarAccess = () =>
  granted.split(/\s+/).includes('https://www.googleapis.com/auth/calendar.events');

export class ScopeError extends Error {
  constructor() {
    super('Google did not grant calendar access');
    this.name = 'ScopeError';
    this.code = 'no-calendar-scope';
  }
}
const live = () => !!(token && Date.now() < token.expiresAt - 60_000);

/* ── Google Identity Services ─────────────────────────────────────────── */

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not reach Google'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

async function client() {
  if (tokenClient) return tokenClient;
  if (!isConfigured()) throw new Error('No Google client ID is configured');
  await loadGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId(),
    scope: SCOPE,
    callback: () => {}          // replaced per request
  });
  return tokenClient;
}

/**
 * Asks Google for an access token.
 *
 * @param {boolean} silent  true uses `prompt: ''`, which returns a token
 *   with nothing shown to somebody who has already consented — and fails
 *   rather than interrupting if they have not. False asks out loud.
 */
function ask(silent) {
  return new Promise((resolve, reject) => {
    client().then((tc) => {
      tc.callback = (resp) => {
        if (!resp || resp.error) return reject(new Error((resp && resp.error) || 'no token'));
        token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        granted = String(resp.scope || '');
        resolve(token);
      };
      /* error_callback is the only way a silent request reports that it
         could not be answered without a prompt; without it the promise
         would hang forever on a lapsed session. */
      tc.error_callback = (err) => reject(err || new Error('no token'));
      try {
        tc.requestAccessToken({ prompt: silent ? '' : 'consent' });
      } catch (e) { reject(e); }
    }, reject);
  });
}

async function bearer(silent) {
  if (live()) return token.value;
  const t = await ask(!!silent);
  return t.value;
}

async function whoAmI(access) {
  try {
    const r = await fetch(USERINFO, { headers: { Authorization: 'Bearer ' + access } });
    if (!r.ok) return null;
    const j = await r.json();
    account = { email: String(j.email || '') };
    return account;
  } catch (_) { return null; }
}

/**
 * Reconnects without showing anything, for a club that already had syncing
 * on. Resolves false rather than throwing when Google will not answer
 * quietly — that is an ordinary outcome, not an error worth a toast.
 */
export async function resume() {
  if (!isConfigured()) return false;
  try {
    const access = await bearer(true);
    if (!hasCalendarAccess()) return false;
    await whoAmI(access);
    return true;
  } catch (_) { return false; }
}

/** Asks out loud. Used only behind the confirmation modal. */
export async function connect() {
  const access = await bearer(false);
  if (!hasCalendarAccess()) throw new ScopeError();
  const who = await whoAmI(access);
  return who || { email: '' };
}

export function forget() {
  token = null;
  account = null;
  granted = '';
}

/* ── the REST calls ───────────────────────────────────────────────────── */

async function call(path, opts = {}) {
  const access = await bearer(true).catch(() => null);
  if (!access) throw new Error('not connected');
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + access,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (r.status === 204) return null;
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 403 && !hasCalendarAccess()) throw new ScopeError();
    const msg = (body && body.error && body.error.message) || r.statusText;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return body;
}

/* ── translating between the two shapes ───────────────────────────────── */

const iso = (ms) => new Date(ms).toISOString();

/** A JagChess event as Google wants it. */
export function toGoogle(ev) {
  const start = Number(ev.date) || Date.now();
  const mins = Math.max(5, Number(ev.durationMin) || 30);
  return {
    summary: String(ev.title || 'Untitled'),
    description: String(ev.desc || ''),
    start: { dateTime: iso(start) },
    end: { dateTime: iso(start + mins * 60000) },
    /* So a pull can tell the club's own events apart from the person's and
       never draw one twice, without keeping a second index anywhere. */
    extendedProperties: { private: { jagchessClubId: String(ev.clubId || ''), jagchessEventId: String(ev.id || '') } }
  };
}

/** A Google event as the calendar draws it. Read-only: never written to the club. */
export function fromGoogle(g) {
  const startISO = (g.start && (g.start.dateTime || g.start.date)) || null;
  const endISO = (g.end && (g.end.dateTime || g.end.date)) || null;
  if (!startISO) return null;
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : start + 30 * 60000;
  const priv = (g.extendedProperties && g.extendedProperties.private) || {};
  return {
    id: 'g:' + g.id,
    googleEventId: g.id,
    /* The club's own event, come back around. The caller drops these: the
       database copy is the real one and is already on screen. */
    jagchessEventId: priv.jagchessEventId || '',
    title: String(g.summary || '(no title)'),
    desc: String(g.description || ''),
    date: start,
    durationMin: Math.max(5, Math.round((end - start) / 60000)),
    tag: 'classic',
    source: 'google',
    allDay: !!(g.start && g.start.date && !g.start.dateTime),
    htmlLink: String(g.htmlLink || '')
  };
}

/* ── pull ─────────────────────────────────────────────────────────────── */

/**
 * The account's events in a window, as calendar rows.
 *
 * Events that came from JagChess are dropped: the database copy is already
 * on screen, and it is the one that is allowed to be edited.
 */
export async function pull(fromMs, toMs) {
  const qs = new URLSearchParams({
    timeMin: iso(fromMs),
    timeMax: iso(toMs),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  });
  const body = await call(`/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${qs}`);
  return ((body && body.items) || [])
    .map(fromGoogle)
    .filter((e) => e && !e.jagchessEventId);
}

/* ── push ─────────────────────────────────────────────────────────────── */

/**
 * Puts one club event into Google, creating or updating as needed.
 * @returns {Promise<string>} the Google event id to store on the club event
 */
export async function push(ev) {
  const payload = toGoogle(ev);
  if (ev.googleEventId) {
    try {
      const up = await call(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(ev.googleEventId)}`,
        { method: 'PUT', body: JSON.stringify(payload) }
      );
      return (up && up.id) || ev.googleEventId;
    } catch (e) {
      /* Deleted at the far end, or the account was switched and this id
         means nothing on the new calendar. Either way the right repair is
         to make a fresh one rather than to keep failing. */
      if (!/404|not found|deleted/i.test(String(e.message))) throw e;
    }
  }
  const made = await call(
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
  return (made && made.id) || '';
}

export async function remove(googleEventId) {
  if (!googleEventId) return;
  try {
    await call(`/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(googleEventId)}`,
      { method: 'DELETE' });
  } catch (e) {
    if (!/404|not found|deleted/i.test(String(e.message))) throw e;
  }
}
