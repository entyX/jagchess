/* ═══════════════════════════════════════════════════════════════════════
   gmail-send.js — send a newsletter from the club owner's own Gmail.

   Each club sends on its own credentials rather than through a shared
   platform mailbox: the address on the message is really theirs, the send
   counts against their Gmail quota, and if anyone abuses it the damage is
   contained to their account.

   This deliberately does NOT go through Firebase Auth. Requesting extra
   scopes via signInWithPopup would re-authenticate the user and could
   switch who they are signed in as — fatal for anyone using email/password.
   Google Identity Services hands back a bare access token instead, so the
   mailbox you send from is decoupled from the account you signed in with.

   The token lives in memory for about an hour and is never persisted.
   ═══════════════════════════════════════════════════════════════════════ */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/* gmail.send alone cannot tell us WHICH mailbox was picked — reading that
   back needs the two userinfo scopes. Both are non-sensitive, so they add
   nothing to what Google has to verify. */
const SCOPE = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

/* Gmail refuses more than ~100 addressees on one message. */
export const GMAIL_BATCH = 90;

let gisPromise = null;
let tokenClient = null;

/* in-memory only — a reload asks again, which is the intended tradeoff */
let token = null;          // { value, expiresAt }
let connected = null;      // { email, name, picture }

const clientId = () => String(window.MAIL_CONFIG?.googleClientId || '').trim();

export const isConfigured = () => !!clientId();
export const connectedAccount = () => connected;
export const hasLiveToken = () => !!(token && Date.now() < token.expiresAt - 60_000);

/* ── loading Google Identity Services ─────────────────────────────────── */

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('could not reach Google to start the sign-in'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

/**
 * Ask Google for permission to send as the user. Opens a popup the first
 * time; afterwards it usually returns silently until the token expires.
 * @param {boolean} interactive false re-uses an existing grant without a prompt
 */
export async function connectGmail({ interactive = true } = {}) {
  const id = clientId();
  if (!id) throw new Error('Gmail sending is not set up on this site yet');

  await loadGis();

  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: () => {},        // replaced per request below
    });
  }

  const grant = await new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(
          resp.error === 'access_denied'
            ? 'permission was declined'
            : resp.error_description || resp.error
        ));
        return;
      }
      resolve(resp);
    };
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (e) {
      reject(e);
    }
  });

  token = {
    value: grant.access_token,
    expiresAt: Date.now() + (Number(grant.expires_in || 3600) * 1000),
  };

  connected = await readAccount(token.value);
  return connected;
}

/* Which mailbox did they actually pick? It need not be the address they
   signed into JagChess with. Two ways to find out, because a consent screen
   that is missing the userinfo scopes would otherwise dead-end the whole
   connect flow. */
async function readAccount(accessToken) {
  const auth = { Authorization: `Bearer ${accessToken}` };

  const info = await fetch(USERINFO, { headers: auth })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (info?.email) {
    return {
      email: String(info.email).toLowerCase(),
      name: info.name || '',
      picture: info.picture || '',
    };
  }

  // Fall back to Gmail itself, which at least knows its own address.
  const prof = await fetch(GMAIL_PROFILE, { headers: auth })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (prof?.emailAddress) {
    return { email: String(prof.emailAddress).toLowerCase(), name: '', picture: '' };
  }

  throw new Error(
    'Google would not say which account was connected. Add the userinfo.email ' +
    'and userinfo.profile scopes on the Data Access page of the Google Auth Platform'
  );
}

export function disconnectGmail() {
  if (token?.value && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(token.value, () => {}); } catch { /* best effort */ }
  }
  token = null;
  connected = null;
}

/* ── building the message ─────────────────────────────────────────────── */

/* RFC 2047 — headers must be ASCII, so anything else is encoded. */
const encodeHeader = (s) => {
  const str = String(s || '');
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  const utf8 = new TextEncoder().encode(str);
  let bin = '';
  utf8.forEach((b) => { bin += String.fromCharCode(b); });
  return `=?UTF-8?B?${btoa(bin)}?=`;
};

const addressHeader = (email, name) =>
  name ? `${encodeHeader(name)} <${email}>` : email;

/* Gmail wants the whole RFC 822 message base64url-encoded. */
const toBase64Url = (str) => {
  const utf8 = new TextEncoder().encode(str);
  let bin = '';
  utf8.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function buildMime({ fromEmail, fromName, to, bcc, replyTo, replyToName, subject, html }) {
  const headers = [
    `From: ${addressHeader(fromEmail, fromName)}`,
    `To: ${to}`,
    bcc.length ? `Bcc: ${bcc.join(', ')}` : null,
    replyTo && replyTo !== fromEmail ? `Reply-To: ${addressHeader(replyTo, replyToName)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);

  return `${headers.join('\r\n')}\r\n\r\n${html}`;
}

/* The editor produces a bare fragment; mail clients want a whole document,
   with inline styles only — no <style> block survives Gmail reliably. */
export const wrapEmail = (subject, bodyHtml, senderName, clubName) => {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9ee;">
    <tr><td style="background:#58cc02;padding:20px 28px;">
      <span style="font:700 19px/1.2 ${font};color:#ffffff;">&#9822; ${esc(clubName || 'JagChess')}</span>
    </td></tr>
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 18px;font:700 22px/1.3 ${font};color:#14262f;">${esc(subject)}</h1>
      <div style="font:400 15px/1.65 ${font};color:#14262f;">${bodyHtml}</div>
    </td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid #e4e9ee;background:#fbfcfd;">
      <p style="margin:0;font:400 12.5px/1.5 ${font};color:#8296a4;">
        Sent by ${esc(senderName)}${clubName ? ` &middot; ${esc(clubName)}` : ''}<br>
        Just reply to this email to reach the sender.
      </p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
};

/* ── sending ──────────────────────────────────────────────────────────── */

/**
 * Send one newsletter to everybody, in Gmail-sized batches.
 * Recipients ride in Bcc so nobody sees anyone else's address.
 * @returns {Promise<{sent:number, batches:number}>}
 */
export async function sendViaGmail({ subject, html, recipients, replyTo, replyToName, onProgress }) {
  if (!connected || !hasLiveToken()) {
    await connectGmail({ interactive: !connected });
  }
  if (!connected) throw new Error('no Gmail account is connected');

  const list = [...new Set(
    recipients.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
  )];
  if (!list.length) throw new Error('there are no recipients');

  const batches = [];
  for (let i = 0; i < list.length; i += GMAIL_BATCH) batches.push(list.slice(i, i + GMAIL_BATCH));

  let sent = 0;
  for (const [i, bcc] of batches.entries()) {
    const raw = toBase64Url(buildMime({
      fromEmail: connected.email,
      fromName: connected.name,
      to: connected.email,          // the sender keeps a visible copy
      bcc,
      replyTo,
      replyToName,
      subject,
      html,
    }));

    const res = await fetch(GMAIL_SEND, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.value}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = `Gmail rejected the message (${res.status})`;
      if (res.status === 401) msg = 'the Gmail connection expired — connect again and resend';
      else if (res.status === 403 && /quota|limit/i.test(detail)) {
        msg = 'this Gmail account hit its daily sending limit — try again tomorrow';
      } else if (detail) {
        try { msg = JSON.parse(detail)?.error?.message || msg; } catch { /* keep msg */ }
      }
      // Report what did land, so a partial send is never silently lost.
      const err = new Error(msg);
      err.sent = sent;
      err.total = list.length;
      throw err;
    }

    sent += bcc.length;
    if (onProgress) onProgress(sent, list.length, i + 1, batches.length);
  }

  return { sent, batches: batches.length };
}
