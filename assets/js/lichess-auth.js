/* ═══════════════════════════════════════════════════════════════════════
   lichess-auth.js — "Log in with Lichess", the official way.

   Lichess supports unregistered PUBLIC OAuth2 clients using the authorization
   code flow with PKCE (S256 only). That is the flow a site with no server can
   use honestly, and it is the one used here: no client secret exists, because
   a public client is not supposed to have one.

   ─── about where the token lives ───────────────────────────────────────
   JagChess is static hosting and a database. There is no backend to hold an
   access token on the user's behalf, so the token lives in this browser, in
   localStorage, and nowhere else. It is never written to Firestore, never
   sent to any JagChess service, and never shared between accounts.

   That is a real difference from a server-side integration and it is written
   down in LICHESS.md rather than glossed over. What follows from it:

     • nothing at all is asked for until somebody presses Join — watching a
       tournament, or the whole site, grants no permission whatsoever — and
       the team scope is only asked for by a tournament that needs one;
     • "Disconnect" revokes the token at lichess (DELETE /api/token) before
       forgetting it, so signing out actually ends the grant;
     • what we DO keep in Firestore is the link — lichess username, granted
       scopes, when it was linked — so a tournament page can say who is who
       without the token going anywhere.

   Refresh tokens do not exist on lichess; access tokens last about a year.
   ═══════════════════════════════════════════════════════════════════════ */

import { AUTHORIZE_URL, exchangeToken, revokeToken, account, testToken } from './lichess-api.js';

/* ── what we ask for, and when ─────────────────────────────────────── */

export const SCOPES = {
  /* Create and join tournaments. Needed by a player pressing Join, and by a
     host creating a lichess tournament from the JagChess form. */
  tournament: 'tournament:write',
  /* Join a team, for the tournaments that require membership. */
  team: 'team:write',
  /* Play from this site through the Board API. */
  board: 'board:play'
};

/* What the "Join & play" button asks for: everything a person who intends to
   take part will need, in ONE consent screen.
 *
 * Splitting these was worse, not better. Each extra scope means another full
 * redirect to lichess and back, and the moments they were needed — pressing
 * Join, and then being told to join a team — are exactly the moments a round
 * trip is most disruptive. Somebody who only ever watches still grants
 * nothing at all, because they never press the button. */
export const PLAYER_SCOPES = [SCOPES.tournament, SCOPES.board, SCOPES.team];

const KEY = 'jag-lichess';
const PENDING = 'jag-lichess-pending';

export const CLIENT_ID = 'jagchess.web.app';
export const redirectUri = () => location.origin + '/lichess-callback';

/* ── the stored session ────────────────────────────────────────────── */

/** @returns {{token:string, username:string, userId:string, scopes:string[], linkedAt:number}|null} */
export function session() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.token ? s : null;
  } catch (_) { return null; }
}

const save = (s) => {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
  notify();
};

const forget = () => {
  try { localStorage.removeItem(KEY); } catch (_) {}
  notify();
};

export const isConnected = () => !!session();
export const myUsername = () => (session() || {}).username || null;
export const myToken = () => (session() || {}).token || null;

export const hasScopes = (needed) => {
  const s = session();
  if (!s) return false;
  return (needed || []).every((n) => (s.scopes || []).includes(n));
};

/* Anything on the page that shows the lichess identity listens here rather
   than polling, and a login finished in another tab reaches this one too. */
const listeners = new Set();
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((f) => { try { f(session()); } catch (e) { console.error(e); } });
}
window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

/* ── PKCE ──────────────────────────────────────────────────────────── */

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = (bytes = 32) =>
  b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const challengeFor = async (verifier) =>
  b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

/* ── starting the flow ─────────────────────────────────────────────── */

/**
 * Sends the browser to lichess to authorize. Does not return.
 *
 * @param {string[]} scopes   the scopes to ask for, on top of any already held
 * @param {string}  [returnTo] where to come back to; defaults to right here
 */
export async function connect(scopes = PLAYER_SCOPES, returnTo) {
  const held = (session() || {}).scopes || [];
  /* Re-authorizing replaces the grant rather than adding to it, so the new
     request has to carry everything we already had as well as the new bit. */
  const want = [...new Set([...held, ...scopes])];

  const verifier = randomString(48);
  const state = randomString(16);
  try {
    sessionStorage.setItem(PENDING, JSON.stringify({
      verifier, state, scopes: want,
      returnTo: returnTo || location.href,
      at: Date.now()
    }));
  } catch (_) {
    throw new Error('This browser is blocking session storage, which the login needs.');
  }

  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state
  });
  if (want.length) p.set('scope', want.join(' '));
  location.href = AUTHORIZE_URL + '?' + p.toString();
}

/**
 * Makes sure the stored token carries every scope in `needed`, sending the
 * user through lichess again if it does not.
 *
 * @returns {Promise<boolean>} true when the token is already good. When it is
 *   not, the browser is on its way to lichess and nothing after this runs.
 */
export async function ensureScopes(needed, returnTo) {
  if (hasScopes(needed)) return true;
  await connect(needed, returnTo);
  return false;
}

/* ── finishing the flow ────────────────────────────────────────────── */

/**
 * Run by /lichess-callback with the query string lichess sent back.
 *
 * @returns {Promise<{returnTo: string}>}
 */
export async function finish(search) {
  const q = new URLSearchParams(search || location.search);
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch (_) {}
  try { sessionStorage.removeItem(PENDING); } catch (_) {}

  const returnTo = (pending && pending.returnTo) || '/tournaments';

  if (q.get('error')) {
    const e = new Error(q.get('error') === 'access_denied'
      ? 'You cancelled the lichess login.'
      : (q.get('error_description') || 'Lichess refused the login.'));
    e.returnTo = returnTo;
    throw e;
  }

  const code = q.get('code');
  if (!code || !pending) {
    const e = new Error('That login link is stale. Start the login again.');
    e.returnTo = returnTo;
    throw e;
  }
  /* The state check is the whole defense against a forged callback, so it is
     an outright refusal rather than a warning. */
  if (q.get('state') !== pending.state) {
    const e = new Error('The login could not be verified. Start it again.');
    e.returnTo = returnTo;
    throw e;
  }

  const res = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: pending.verifier,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID
  });

  const token = res.access_token;
  if (!token) {
    const e = new Error('Lichess did not return an access token.');
    e.returnTo = returnTo;
    throw e;
  }

  /* Trust lichess about what the token can do, not our own request: a user
     can untick a scope on the authorization screen. */
  let scopes = pending.scopes || [];
  let userId = null;
  let username = null;
  try {
    const t = await testToken(token);
    if (t) { scopes = t.scopes; userId = t.userId; }
  } catch (e) { console.warn('Could not verify the new token’s scopes', e); }

  try {
    const me = await account(token);
    username = me.username;
    userId = me.id || userId;
  } catch (e) {
    console.warn('Could not read the lichess account', e);
  }

  save({
    token,
    username: username || userId || 'lichess user',
    userId: userId || (username || '').toLowerCase(),
    scopes,
    linkedAt: Date.now(),
    expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : null
  });

  return { returnTo };
}

/* ── ending it ─────────────────────────────────────────────────────── */

/**
 * Disconnects the lichess account. Revokes at lichess first, because a token
 * we merely forgot is a token that still works.
 */
export async function disconnect() {
  const s = session();
  if (!s) return;
  try { await revokeToken(s.token); }
  catch (e) { console.warn('Could not revoke the token at lichess', e); }
  forget();
}

/**
 * Checks the stored token is still live, and clears it if lichess says no.
 * Called once when a page that uses the integration boots.
 */
export async function verify() {
  const s = session();
  if (!s) return null;
  if (s.expiresAt && s.expiresAt < Date.now()) { forget(); return null; }
  try {
    const me = await account(s.token);
    if (me && me.username && me.username !== s.username) {
      save({ ...s, username: me.username, userId: me.id || s.userId });
    }
    return session();
  } catch (e) {
    // 401 means revoked or expired; anything else is lichess being unreachable
    if (e && e.status === 401) { forget(); return null; }
    return s;
  }
}
