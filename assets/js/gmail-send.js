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

/* How big the masthead picture is allowed to be. Tall enough to be the
   club's badge rather than a bullet point beside its name, and wide enough
   for a wordmark, which is what a good half of them are. */
const LOGO_BOX = 64;
const LOGO_WIDE = 260;

/* RFC 2045 wants base64 in lines of at most 76 characters. Gmail forgives
   one long one; Outlook and a couple of gateways do not. */
const wrap76 = (s) => String(s).replace(/.{1,76}/g, '$&\r\n').trim();

const boundary = () =>
  `jagchess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * A picture the message carries with it.
 *
 * A club badge is stored as a data URL in its own document — there is no
 * bucket here to put one in — and a data URL in an `img` is stripped by
 * every mail client worth naming. Sent as a related part with a
 * Content-ID, the same bytes arrive and `src="cid:…"` finds them.
 *
 * Two things happen on the way:
 *   · WebP, which is what the badge usually is, is redrawn as a PNG.
 *     Outlook has never rendered WebP and never says so — it just shows
 *     nothing where the logo was.
 *   · it is measured, so the masthead can give the image real width and
 *     height attributes. Word's layout engine ignores CSS on an image and
 *     will happily print a 256px badge at full size without them.
 *
 * @param {string} dataUrl  a data: image URL, or anything (null comes back)
 * @param {object} [opts]   { cid, height } — height is the box to fit into
 * @returns {Promise<null|{cid,contentType,base64,filename,width,height}>}
 */
export async function inlineImage(dataUrl, opts = {}) {
  const cid = opts.cid || 'clublogo';
  const box = Number(opts.height) || LOGO_BOX;
  const src = String(dataUrl || '');
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return null;

  let measured;
  try {
    measured = await measure(src);
  } catch {
    return null;   // a badge that will not decode is not worth a failed send
  }

  const mailable = /^data:image\/(png|jpeg);base64,/.test(src) ? src : measured.png;
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(mailable || '');
  if (!m) return null;

  /* Fit rather than fill: a club's badge is a circle for some and a
     wordmark for others, and cropping one to look like the other is not
     this module's call to make. */
  const scale = Math.min(1, box / measured.height, LOGO_WIDE / measured.width);
  return {
    cid,
    contentType: m[1],
    base64: m[2],
    filename: m[1] === 'image/png' ? 'logo.png' : 'logo.jpg',
    width: Math.max(1, Math.round(measured.width * scale)),
    height: Math.max(1, Math.round(measured.height * scale)),
  };
}

const measure = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth || 44;
    const h = img.naturalHeight || 44;
    let png = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);
      png = canvas.toDataURL('image/png');
    } catch { /* tainted or unavailable — only matters for WebP */ }
    resolve({ width: w, height: h, png });
  };
  img.onerror = () => reject(new Error('the logo could not be read'));
  img.src = src;
});

/**
 * The masthead picture, whichever kind the caller has.
 *
 * A club keeps its badge as a data URL in its own document, so that one
 * travels with the message. The site-wide console has an ordinary address
 * on the site instead, and an address is simply used — mail clients fetch
 * remote images happily, and there is nothing to attach.
 *
 * Either way the answer is the same shape, and either way a logo that will
 * not load comes back as nothing rather than as a broken picture in
 * somebody's inbox.
 *
 * @returns {Promise<{logo:null|{src,width,height}, inline:null|object}>}
 */
export async function emailLogo(source, opts = {}) {
  const src = String(source || '').trim();
  const none = { logo: null, inline: null };
  if (!src) return none;

  if (/^https?:\/\//i.test(src)) {
    const box = Number(opts.height) || LOGO_BOX;
    const size = await measure(src).catch(() => null);
    if (!size) return none;
    const scale = Math.min(1, box / size.height, LOGO_WIDE / size.width);
    return {
      logo: {
        src,
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      },
      inline: null,
    };
  }

  const inline = await inlineImage(src, opts);
  if (!inline) return none;
  return {
    logo: { src: `cid:${inline.cid}`, width: inline.width, height: inline.height },
    inline,
  };
}

export function buildMime({ fromEmail, fromName, to, bcc, replyTo, replyToName, subject, html, inline }) {
  const headers = [
    `From: ${addressHeader(fromEmail, fromName)}`,
    `To: ${to}`,
    bcc.length ? `Bcc: ${bcc.join(', ')}` : null,
    replyTo && replyTo !== fromEmail ? `Reply-To: ${addressHeader(replyTo, replyToName)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (!inline) {
    headers.push(
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
    );
    return `${headers.join('\r\n')}\r\n\r\n${html}`;
  }

  /* multipart/related, not mixed: the picture is part of the document
     rather than something attached to it, and clients that know the
     difference keep it out of the paperclip menu. */
  const mark = boundary();
  headers.push(`Content-Type: multipart/related; type="text/html"; boundary="${mark}"`);

  return [
    headers.join('\r\n'),
    '',
    `--${mark}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${mark}`,
    `Content-Type: ${inline.contentType}; name="${inline.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${inline.cid}>`,
    `Content-Disposition: inline; filename="${inline.filename}"`,
    '',
    wrap76(inline.base64),
    `--${mark}--`,
    '',
  ].join('\r\n');
}

/* ── what a JagChess email looks like ──────────────────────────────────
   An email is not a web page: no stylesheet is guaranteed to arrive, no
   webfont is guaranteed to load, and Outlook still lays the whole thing
   out with Word. So everything here is inline, the widths are on tables,
   and every font is a stack that ends somewhere every machine already has.

   PT Serif is the face; Palatino and Georgia stand in where it cannot be
   fetched, which on Gmail is always. Navy is the colour, and it is a
   constant rather than the club's own — a club picks its colour for a
   badge on a bright page, and a header bar in it is a different question.
   ─────────────────────────────────────────────────────────────────── */

/** The bar, the headings and the links. */
export const BRAND_NAVY = '#16264d';
export const BRAND_NAVY_SOFT = '#2c4780';

export const SERIF = `'PT Serif', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', Times, serif`;
export const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

/* How wide the card is allowed to get, and how far in from its edge the
   writing starts.

   600 is the old email convention and it leaves a message from a club
   stranded in the middle of a modern inbox with most of the pane empty
   each side. 1240 leaves a margin rather than a moat.

   The cost is the measure. Typography would put a line of text somewhere
   near seventy-five characters and this is well past that; the body size
   below is set as large as it is to claw some of that back, because bigger
   type at the same width is fewer characters per line. If it ever wants
   reining in, this number and GUTTER are the only two to touch — every
   padding in the card is written from them. Under 1240 the table is fluid
   and the gutters collapse on a phone. */
const CARD = 1240;
const GUTTER = 64;

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The line the inbox shows beside the subject. Without one, every client
   fills it with whatever text comes first — which here is the club's name
   again, already on the line above it. */
const preheader = (text) => `<div style="display:none;max-height:0;max-width:0;overflow:hidden;` +
  `mso-hide:all;opacity:0;color:transparent;height:0;width:0">${escHtml(text)}</div>`;

/**
 * The masthead's picture.
 *
 * A club that has uploaded a badge gets the badge itself, sitting straight
 * on the navy — a plate behind it is a frame nobody asked for, and a logo
 * with its own shape reads better without one. A club that has not gets the
 * square it wears everywhere else on the site: its own colour, its own
 * glyph, which is the thing people already recognise it by.
 *
 * `logo.src` is something the recipient's client can actually fetch — a
 * `cid:` part travelling with the message, or an https address.
 */
const masthead = (clubName, logo, icon, color) => {
  const mark = logo && logo.src
    ? `<td valign="middle" style="line-height:0;font-size:0">
         <img src="${escHtml(logo.src)}" width="${logo.width}" height="${logo.height}" alt=""
              style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;outline:none;text-decoration:none" />
       </td>`
    : `<td width="60" height="60" align="center" valign="middle"
           style="width:60px;height:60px;background:${escHtml(color || BRAND_NAVY_SOFT)};
                  border-radius:14px;font:700 30px/60px ${SERIF};color:#ffffff;text-align:center">${escHtml(icon || '♞')}</td>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    ${mark}
    <td style="padding-left:18px" valign="middle">
      <span class="jc-name" style="font:700 24px/1.25 ${SERIF};color:#ffffff;letter-spacing:.2px">${escHtml(clubName || 'JagChess')}</span>
    </td>
  </tr></table>`;
};

/**
 * Wraps a written message in the club's stationery.
 *
 * @param {string} subject     also the headline on the card
 * @param {string} bodyHtml    the message itself, already mail-safe HTML
 * @param {string} senderName  who the footer says it came from
 * @param {string} clubName    the name on the masthead
 * @param {object} [opts]      { logo: {src,width,height}, icon, color, note }
 */
export const wrapEmail = (subject, bodyHtml, senderName, clubName, opts = {}) => {
  const { logo = null, icon = '', color = '', note = '' } = opts;
  const title = escHtml(subject);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<!--[if mso]><style>body,table,td,div,p,h1,h2,h3,a,span{font-family:Georgia,'Times New Roman',serif !important}</style><![endif]-->
<style>
  a { color: ${BRAND_NAVY_SOFT}; }
  @media only screen and (max-width:700px) {
    .jc-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .jc-title { font-size: 24px !important; }
    .jc-body { font-size: 16px !important; }
    .jc-name { font-size: 19px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef1f6;-webkit-font-smoothing:antialiased">
${preheader(`${clubName ? clubName + ' — ' : ''}${subject}`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f6">
<tr><td align="center" style="padding:26px 14px">

  <!--[if mso]><table role="presentation" width="${CARD}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="width:100%;max-width:${CARD}px;background:#ffffff;border-radius:14px;
                border:1px solid #dde3ec;border-collapse:separate;overflow:hidden">

    <tr><td class="jc-pad" style="background:${BRAND_NAVY};padding:24px ${GUTTER}px">${masthead(clubName, logo, icon, color)}</td></tr>
    <tr><td style="height:4px;line-height:4px;font-size:0;background:${BRAND_NAVY_SOFT}">&nbsp;</td></tr>

    <tr><td class="jc-pad" style="padding:38px ${GUTTER}px 0">
      <h1 class="jc-title" style="margin:0;font:700 32px/1.25 ${SERIF};color:${BRAND_NAVY};letter-spacing:-.2px">${title}</h1>
    </td></tr>

    <tr><td class="jc-pad jc-body" style="padding:22px ${GUTTER}px 40px;font:400 19px/1.7 ${SERIF};color:#2a3442">
      ${bodyHtml}
    </td></tr>

    <tr><td class="jc-pad" style="padding:20px ${GUTTER}px 24px;border-top:1px solid #e7ebf2;background:#f8fafc">
      <p style="margin:0;font:400 13.5px/1.6 ${SERIF};color:#76829a">
        Sent by ${escHtml(senderName)}${clubName ? ` &middot; ${escHtml(clubName)}` : ''}<br>
        Just reply to this email to reach the sender.${note ? `<br>${escHtml(note)}` : ''}
      </p>
    </td></tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->

  <p style="margin:16px 0 0;font:400 12px/1.5 ${SANS};color:#9aa5b8">Sent with JagChess</p>
</td></tr></table>
</body></html>`;
};

/* ── sending ──────────────────────────────────────────────────────────── */

/**
 * Send one message to one person, addressed to them in the open.
 *
 * The newsletter path below hides every recipient in Bcc, which is right for
 * a mailing and wrong for an invitation: an invite that arrives blind-copied
 * from a stranger reads like spam, and the reply has nowhere obvious to go.
 * @returns {Promise<{sent:number}>}
 */
export async function sendDirectEmail({ subject, html, to, replyTo, replyToName, inline }) {
  if (!connected || !hasLiveToken()) {
    await connectGmail({ interactive: !connected });
  }
  if (!connected) throw new Error('no Gmail account is connected');

  const address = String(to || '').trim().toLowerCase();
  if (!address) throw new Error('there is nobody to send this to');

  const raw = toBase64Url(buildMime({
    fromEmail: connected.email,
    fromName: connected.name,
    to: address,
    bcc: [],
    replyTo,
    replyToName,
    subject,
    html,
    inline,
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
    throw new Error(msg);
  }

  return { sent: 1 };
}

/**
 * Send one newsletter to everybody, in Gmail-sized batches.
 * Recipients ride in Bcc so nobody sees anyone else's address.
 * @returns {Promise<{sent:number, batches:number}>}
 */
export async function sendViaGmail({ subject, html, recipients, replyTo, replyToName, onProgress, inline }) {
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
      inline,
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
