/* ═══════════════════════════════════════════════════════════════════════
   club-core.js — shared plumbing for the clubs layer.
   Firebase handles, club-scoped collection helpers, and small UI utilities.
   ═══════════════════════════════════════════════════════════════════════ */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut as authSignOut, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, orderBy, increment, writeBatch, limit,
  runTransaction, connectFirestoreEmulator
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

import { rememberSignedIn, forgetSignedIn } from './session-hint.js';

export {
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, increment, writeBatch, limit,
  runTransaction, onAuthStateChanged
};

/* Signing out is the one moment the signed-out pages need to hear about, and
   every screen already calls this. Wrapping it is what keeps the hint honest
   without asking each caller to remember. */
export const signOut = (a) => {
  forgetSignedIn();
  return authSignOut(a);
};

const cfg = window.FIREBASE_CONFIG;
export const app = getApps().length ? getApps()[0] : initializeApp(cfg);
export const auth = getAuth(app);
export const db = getFirestore(app);

/* local development against the emulators — see firebase-config.js */
if (window.JAG_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

/* ── club-scoped paths ─────────────────────────────────────────────── */

export const clubRef = (clubId) => doc(db, 'clubs', clubId);
export const clubCol = (clubId, name) => collection(db, 'clubs', clubId, name);
export const clubDoc = (clubId, name, id) => doc(db, 'clubs', clubId, name, id);
export const memberRef = (clubId, uid) => doc(db, 'clubs', clubId, 'members', uid);

/* people who applied through the JagChess Network but have no account yet */
export const applicationCol = (clubId) => collection(db, 'clubs', clubId, 'applications');
export const applicationRef = (clubId, id) => doc(db, 'clubs', clubId, 'applications', id);

/* ── the open attendance form ──────────────────────────────────────────
   Attendance is the one thing in a club that has to work for somebody who
   is not signed in — a QR code on a table gets scanned by whoever is in the
   room, and making them make an account first is how a club ends up with no
   attendance record at all.

   `clubs/{id}/events` and `clubs/{id}/attendanceForms` are both member-only,
   and they have to stay that way: between them they are the club's whole
   calendar. So a check-in that is currently open is mirrored out to a root
   document anybody may read — one event, one form, and the window it is open
   for. It is the same bargain publicClubs makes, narrowed to one event, and
   unlike publicClubs it survives a club going private: a closed club still
   meets on Tuesdays.
   ─────────────────────────────────────────────────────────────────── */

export const attendanceFormId = (clubId, eventId) => `${clubId}__${eventId}`;
export const publicAttendanceRef = (clubId, eventId) =>
  doc(db, 'publicAttendance', attendanceFormId(clubId, eventId));
export const publicAttendanceCol = () => collection(db, 'publicAttendance');

/* Check-ins are keyed, not auto-numbered: one row per person per event, so a
   second submission is refused by Firestore itself rather than by a check
   somebody has to remember to write. A member is keyed by uid; somebody
   signed out is keyed by the hash of their address. */
export const attendanceResponseRef = (clubId, key) =>
  doc(db, 'clubs', clubId, 'attendanceResponses', key);

/* ── "is this address already in the club?" ────────────────────────────
   Someone filling in a registration form has no account and no read access
   to anything, so the only way to tell them they are already a member is to
   publish something they can check. Publishing the roster is out of the
   question, so what is published is a set of one-way hashes, one document
   per member, keyed by the hash itself.

   The rules allow `get` and refuse `list`: you can ask about an address you
   already know, and you cannot walk the collection to learn any. That is the
   same bargain clubCodes makes, and it is the strongest privacy available
   without a server to ask on the visitor's behalf. The documents hold a
   timestamp and nothing else — no address, no name, no uid.
   ─────────────────────────────────────────────────────────────────── */

export const memberEmailCol = (clubId) => collection(db, 'clubs', clubId, 'memberEmails');
export const memberEmailRef = (clubId, key) => doc(db, 'clubs', clubId, 'memberEmails', key);

/** SHA-256 of the normalized address, shortened to 80 bits of document id. */
export async function emailKey(email) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return Array.from(new Uint8Array(digest).slice(0, 10))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Adds one address to the index. Best effort: it is a convenience, not a gate. */
export async function indexMemberEmail(clubId, email) {
  try {
    const key = await emailKey(email);
    if (key) await setDoc(memberEmailRef(clubId, key), { at: Date.now() });
  } catch (e) { console.warn('Could not index that member address', e); }
}

export async function unindexMemberEmail(clubId, email) {
  try {
    const key = await emailKey(email);
    if (key) await deleteDoc(memberEmailRef(clubId, key));
  } catch (e) { console.warn('Could not clear that member address', e); }
}

/**
 * Makes the index agree with the membership list — adding what joined before
 * the index existed, removing what has left. Runs off a roster the caller has
 * already read, so it costs one list read and, usually, no writes at all.
 */
export async function syncMemberEmails(clubId, members) {
  try {
    const want = new Map();
    for (const m of members) {
      const key = await emailKey(m.email);
      if (key) want.set(key, true);
    }
    const have = new Set((await getDocs(memberEmailCol(clubId))).docs.map((d) => d.id));

    const adds = [...want.keys()].filter((k) => !have.has(k));
    const drops = [...have].filter((k) => !want.has(k));
    if (!adds.length && !drops.length) return 0;

    await Promise.all([
      ...adds.map((k) => setDoc(memberEmailRef(clubId, k), { at: Date.now() }).catch(() => {})),
      ...drops.map((k) => deleteDoc(memberEmailRef(clubId, k)).catch(() => {}))
    ]);
    return adds.length + drops.length;
  } catch (e) {
    console.warn('Could not refresh the member address index', e);
    return 0;
  }
}

/* ── the public mirror ─────────────────────────────────────────────────
   A club document can never be world-readable: it carries the join code,
   and a code the whole internet can read is not a code. So the handful of
   fields the JagChess Network page needs are copied into publicClubs/{id},
   which anybody may read — signed in or not — and which exists only while
   the club is public. Turning a club private deletes the mirror, and with
   it the listing, the registration form and the ability to apply.
   ──────────────────────────────────────────────────────────────────── */

export const publicClubRef = (clubId) => doc(db, 'publicClubs', clubId);

/* A field that is missing on the club, defaulted the way the security rules
   default it. The two have to agree exactly: the rules accept a listing only
   if it matches the club document field for field, which is what lets ANY
   signed-in user publish one. A listing is a copy, never an opinion, so
   nobody can rewrite somebody else's club card. */
const mirrored = (v, fallback) => (v === undefined || v === null ? fallback : v);

export const publicClubPayload = (club) => ({
  clubId: club.id,
  name: mirrored(club.name, ''),
  slug: mirrored(club.slug, club.id),
  icon: mirrored(club.icon, ''),
  color: mirrored(club.color, ''),
  photo: mirrored(club.photo, ''),
  description: mirrored(club.description, ''),
  memberCount: mirrored(club.memberCount, 0),
  blocks: mirrored(club.blocks, []),
  registrationForm: mirrored(club.registrationForm, []),
  createdAt: mirrored(club.createdAt, 0),
  visibility: 'public',
  updatedAt: Date.now()
});

/* Key order out of Firestore is not the key order we wrote, so the two have
   to be compared on sorted keys or every listing looks changed. */
const stable = (v) => JSON.stringify(v, (_k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, k) => { o[k] = val[k]; return o; }, {})
    : val);

const sameListing = (a, b) => {
  const strip = ({ updatedAt, ...rest }) => stable(rest);   // always differs
  return strip(a) === strip(b);
};

/**
 * Makes the public listing agree with the club.
 *
 * Called from everywhere a club is opened — the hub, the club page, settings
 * — so that a club lands on the Network without anybody configuring anything.
 * That means it has to be cheap: it reads the listing first and writes only
 * when something actually changed, so the common case is one read and no
 * write at all. It never throws; no club operation should fail over its card.
 */
export async function syncPublicClub(club, opts = {}) {
  if (!club || !club.id) return;
  const isPrivate = (club.visibility || 'public') === 'private';

  try {
    /* `known` lets a caller that has already read the listing skip the read.
       undefined means "not looked yet"; null means "looked, and it is gone". */
    const current = opts.known !== undefined
      ? opts.known
      : await getDoc(publicClubRef(club.id)).then((s) => (s.exists() ? s.data() : null));

    // a private club has no listing, and deleting one that isn't there is a
    // write nobody needs
    if (isPrivate) {
      if (!current) return false;
      await deleteDoc(publicClubRef(club.id));
      return true;
    }

    const next = publicClubPayload(club);
    if (current && sameListing(current, next)) return false;
    await setDoc(publicClubRef(club.id), next, { merge: true });
    return true;
  } catch (e) {
    console.warn('Could not refresh the public listing for this club', e);
  }
  return false;
}

/**
 * Reconciles the whole directory in one pass: every public club gains a
 * listing, every club that has gone private loses one.
 *
 * The Network is a directory, and a club missing from it because nobody in it
 * has signed in lately is a club nobody can find. So this deliberately does
 * not stop at the clubs you belong to — any signed-in person looking at the
 * hub, or at the Network itself, repairs the listing for everybody. Two
 * collection reads, and a write only where something actually differs.
 *
 * @returns {Promise<number>} how many listings changed
 */
export async function syncAllPublicClubs() {
  try {
    const [clubs, listings] = await Promise.all([
      getDocs(query(collection(db, 'clubs'), limit(300))),
      getDocs(collection(db, 'publicClubs'))
    ]);
    const known = new Map(listings.docs.map((d) => [d.id, d.data()]));
    const done = await Promise.all(clubs.docs.map((d) =>
      syncPublicClub({ id: d.id, ...d.data() }, { known: known.get(d.id) || null })));
    return done.filter(Boolean).length;
  } catch (e) {
    console.warn('Could not refresh the public club directory', e);
    return 0;
  }
}

/* ── auth gate ─────────────────────────────────────────────────────── */

/**
 * Who is signed in, or null — the question requireUser refuses to answer,
 * because it bounces you to a login screen instead.
 *
 * A page that has something to offer a signed-out visitor has to be able to
 * ask without being redirected out from under itself. Only attendance needs
 * that so far, and only on the club page.
 */
export function currentUser() {
  return new Promise((resolve) => {
    let stop = null;
    let settled = false;
    const seen = (user) => {
      if (settled) return;
      settled = true;
      // the listener can answer before onAuthStateChanged has handed back the
      // unsubscribe, so unhooking waits a tick rather than calling null
      if (stop) stop(); else queueMicrotask(() => stop && stop());
      if (user) {
        window.jagIdentify?.(user.uid);
        rememberSignedIn();
      } else {
        forgetSignedIn();
      }
      resolve(user || null);
    };
    stop = onAuthStateChanged(auth, seen);
  });
}

export function requireUser() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        /* Being turned away here settles it: whatever the hint said, there is
           no session. Clearing it now is what stops a stale one bouncing the
           public pages to a login screen over and over. */
        forgetSignedIn();
        const next = encodeURIComponent(location.pathname + location.search);
        /* Somebody following an invite link almost certainly has no account
           yet — needing one is the whole reason the invite was sent — so the
           sign-up tab opens rather than making them hunt for it. Logging in
           instead is one click away on the same screen. */
        const invited = new URLSearchParams(location.search).get('invite') === '1';
        location.href = '/login?next=' + next + (invited ? '&mode=signup' : '');
        return;
      }
      /* let Analytics know who this is, so returning visits register */
      window.jagIdentify?.(user.uid);
      rememberSignedIn();
      resolve(user);
    });
  });
}

/* ── slugs, codes, initials ────────────────────────────────────────── */

export const slugify = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/[\s_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const makeCode = (len = 6) => {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
};

export const initials = (name) => {
  if (!name) return '?';
  const p = String(name).trim().split(/\s+/);
  return (p.length > 1 ? p[0][0] + p[p.length - 1][0] : name.slice(0, 2)).toUpperCase();
};

/* ── a club's face ────────────────────────────────────────────
   A club used to be a coloured square with a chess glyph on it, which is a
   fine default and a poor identity: two clubs that both picked the green
   knight were indistinguishable on the Network.

   There is no file storage here — no server, and no bucket configured — so
   the picture lives on the club document as a data URL. That is only
   reasonable because it is made small first: centre-cropped square, 256px,
   WebP, and refused outright if it will not come under the cap. A Firestore
   document holds a megabyte; this takes a sixth of that at the very worst
   and usually a twentieth.

   Everything read back is checked before it reaches the page. A club
   document is writable by its staff and mirrored somewhere the whole
   internet reads, so `photo` is attacker-controlled text by the time it
   gets here: it is matched against the shape of a base64 image URL and
   dropped if it is anything else. It is then put in an `img` rather than a
   CSS background, so there is no style attribute for it to escape from.
   ──────────────────────────────────────────────────────────── */

/** The most a stored picture may weigh, as data-URL characters. */
export const CLUB_PHOTO_MAX = 180 * 1024;

const PHOTO_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The club's picture if it has a usable one, or null. Never trusts it blindly. */
export function clubPhoto(club) {
  const raw = String((club || {}).photo || '');
  if (!raw || raw.length > CLUB_PHOTO_MAX) return null;
  return PHOTO_URL.test(raw) ? raw : null;
}

/**
 * The avatar markup every club surface shares: the picture if there is one,
 * and the coloured glyph if there is not.
 *
 * @param {object} club
 * @param {string} [className]  the class that sizes it on this particular screen
 */
export function clubAvatar(club, className) {
  const cls = esc(className || 'club-avatar');
  const photo = clubPhoto(club);
  if (photo) {
    return `<span class="${cls} has-photo"><img src="${photo}" alt="" /></span>`;
  }
  const c = club || {};
  return `<span class="${cls}" style="background:${esc(c.color || '#1faf5a')}">${esc(c.icon || '♞')}</span>`;
}

/* WebP where it is understood, PNG where it is not — and never JPEG, which
   has no alpha channel and would fill every transparent pixel with black.
   A club badge is very often a logo on nothing at all. */
const encode = (canvas, quality) => {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.indexOf('data:image/webp') === 0) return webp;
  return canvas.toDataURL('image/png');
};

/**
 * Turns a picked file into a data URL small enough to store.
 *
 * The whole picture is kept. It used to be centre-cropped to a square,
 * which is the right thing for a photograph of people and the wrong thing
 * for the far more common case — a club logo, which came back with its
 * edges cut off. So it is scaled to fit inside the square instead, at its
 * own proportions, and the avatar box lets the rest show through.
 *
 * Nothing is painted underneath either: a logo on transparency stays on
 * transparency rather than gaining a white card it never had.
 *
 * Tried at falling sizes and qualities rather than at one setting, because
 * "too big" depends entirely on the picture: a flat logo makes it at 256px
 * and a photograph of a crowd may not. Refusing is the last resort, and it
 * says so rather than silently storing something blurry.
 */
export async function clubPhotoFrom(file) {
  if (!file || !/^image\//.test(file.type || '')) {
    throw new Error('That file is not a picture.');
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That picture could not be opened.'));
      i.src = url;
    });

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('That picture could not be opened.');

    for (const [box, quality] of [[256, 0.86], [256, 0.7], [208, 0.7], [160, 0.64], [128, 0.6]]) {
      /* Fit, not fill: the longer side becomes `box` and the shorter one
         keeps its proportion. No padding is baked in — the square it sits
         in does the centring, and letterboxing it here would only make the
         file bigger and the transparency harder to hold on to. */
      const scale = Math.min(1, box / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h, 0, 0, cw, ch);

      const out = encode(canvas, quality);
      if (out && out.length <= CLUB_PHOTO_MAX && PHOTO_URL.test(out)) return out;
    }
    throw new Error('That picture is too detailed to store — try a simpler one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Twelve, not twenty-two: enough that two clubs at one school rarely share
   one, few enough that picking is a glance rather than a decision. */
export const CLUB_COLORS = [
  '#1faf5a', '#2e90fa', '#8b5cf6', '#ff8a1f', '#f2484b', '#14b8a6',
  '#f5a700', '#ec4899', '#4f46e5', '#0f3b2d', '#b45309', '#475569'
];

export const CLUB_ICONS = [
  '♞', '♜', '♛', '♚', '♝', '♟',
  '♘', '♖', '♕', '♔', '♗', '♙',
  '🏆', '🥇', '🎖️', '👑', '⚔️', '🛡️',
  '🎓', '📚', '🧠', '🧩', '💡', '🎯',
  '⚡', '🔥', '⭐', '🌟', '🚀', '⏱️',
  '🦁', '🐺', '🦅', '🐉', '🐝', '🎲'
];

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const fmtDate = (ms, opts) => new Date(ms).toLocaleDateString(undefined,
  opts || { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined,
  { hour: 'numeric', minute: '2-digit' });

/* ── toast ─────────────────────────────────────────────────────────── */

let toastHost = null;
export function toast(message, kind) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

/* ── confirm dialog (replaces window.confirm) ──────────────────────── */

export function confirmDialog({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card" style="max-width:420px">
        <h3>${esc(title)}</h3>
        <p class="modal-meta" style="margin:0">${esc(body)}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
          <button class="btn subtle" data-no>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-no]').onclick = () => done(false);
    wrap.querySelector('[data-yes]').onclick = () => done(true);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
  });
}

/* ── prompt dialog ─────────────────────────────────────────────────── */

export function promptDialog({ title, label, value = '', confirmText = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card" style="max-width:420px">
        <h3>${esc(title)}</h3>
        <div>
          <label>${esc(label)}</label>
          <input data-input value="${esc(value)}" placeholder="${esc(placeholder)}" />
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
          <button class="btn subtle" data-no>Cancel</button>
          <button class="btn primary" data-yes>${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('[data-input]');
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-no]').onclick = () => done(null);
    wrap.querySelector('[data-yes]').onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); };
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/* ── roles ─────────────────────────────────────────────────────────── */

/* ── pop-over menus ──────────────────────────────────────────────────
   One small menu at a time, anchored under (or above) whatever opened it.
   Closes on a click elsewhere, Escape, or choosing an item; `onPick` gets
   the data-act of the item chosen.
   ─────────────────────────────────────────────────────────────────── */

let openPop = null;

export function closeMenu() {
  if (!openPop) return;
  const { el, anchor, off } = openPop;
  openPop = null;
  off();
  el.remove();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
}

export function openMenu(anchor, html, { onPick, place = 'below', width } = {}) {
  const same = openPop && openPop.anchor === anchor;
  closeMenu();
  if (same) return null;           // a second click on the opener closes it

  const el = document.createElement('div');
  el.className = 'pop-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = html;
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const w = width || Math.max(r.width, 240);
  el.style.width = w + 'px';
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  if (place === 'above') el.style.bottom = (innerHeight - r.top + 6) + 'px';
  else el.style.top = (r.bottom + 6) + 'px';
  anchor.setAttribute('aria-expanded', 'true');

  const onDoc = (e) => {
    if (el.contains(e.target)) {
      const item = e.target.closest('[data-act]');
      if (!item) return;
      const act = item.dataset.act;
      closeMenu();
      if (onPick) onPick(act, item);
      return;
    }
    if (!anchor.contains(e.target)) closeMenu();
  };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  // wait a tick so the click that opened the menu doesn't also close it
  setTimeout(() => document.addEventListener('click', onDoc), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', closeMenu, { once: true });
  openPop = {
    el, anchor,
    off: () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    }
  };
  const first = el.querySelector('[data-act]');
  if (first) first.focus({ preventScroll: true });
  return el;
}

export const ROLE_LABEL = { founder: 'Founder', admin: 'Admin', student: 'Student' };

export const isStaff = (role) => role === 'admin' || role === 'founder';

/* Who may act on whom. Founders are untouchable; admins may only moderate
   students; nobody may act on themselves. */
export function canModerate(myRole, targetRole) {
  if (targetRole === 'founder') return false;
  if (myRole === 'founder') return true;
  if (myRole === 'admin') return targetRole === 'student';
  return false;
}

export const canSetRoles = (myRole) => myRole === 'founder';

export const banRef = (clubId, uid) => doc(db, 'clubs', clubId, 'bans', uid);

/* ── membership helpers ────────────────────────────────────────────── */

export class BannedError extends Error {
  constructor(record) {
    super('You are banned from this club.');
    this.name = 'BannedError';
    this.record = record;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.role]  set only when provisioning — creating a club, or
 *   the founder seat that goes with it. An explicit role is authoritative: it
 *   overwrites whatever membership row happens to be sitting there.
 */
export async function joinClub(user, clubId, { role } = {}) {
  const club = await getDoc(clubRef(clubId));
  if (!club.exists()) throw new Error('That club no longer exists.');
  const data = club.data();
  const email = (user.email || '').toLowerCase();

  const existing = await getDoc(memberRef(clubId, user.uid));

  /* Already a member and nobody is provisioning: nothing to create, but the
     club index on the profile still has to be made to agree. It is what the
     hub lists from, and it can be out of step — a delete sets it to null, and
     a membership row left behind by a deleted club outlives the club itself.
     Returning early without this is what makes a club vanish from My clubs
     while still being perfectly reachable by its address. */
  if (existing.exists() && !role) {
    const currentRole = existing.data().role || 'student';
    await setDoc(doc(db, 'users', user.uid), {
      email,
      clubs: { [clubId]: currentRole }
    }, { merge: true }).catch((e) => console.warn('Could not repair the club index', e));
    return { clubId, role: currentRole, already: true, slug: data.slug || clubId };
  }

  // A ban blocks the join outright, whatever route was used to get here.
  // Provisioning skips it: you cannot be banned from a club you are creating,
  // and a stale ban row is exactly the kind of leftover this guards against.
  if (!role) {
    try {
      const ban = await getDoc(banRef(clubId, user.uid));
      if (ban.exists() && ban.data().type === 'ban') {
        throw new BannedError({ clubId, slug: data.slug || clubId, name: data.name, ...ban.data() });
      }
    } catch (e) {
      if (e instanceof BannedError) throw e;
      // a rules hiccup reading the ban must not silently allow a banned join
      console.warn('Ban check failed:', e);
    }
  }

  const pending = (data.pendingAdmins || []).map((e) => String(e).toLowerCase());
  const finalRole = role || (pending.includes(email) ? 'admin' : 'student');

  await setDoc(memberRef(clubId, user.uid), {
    uid: user.uid,
    role: finalRole,
    email,
    username: user.displayName || email.split('@')[0] || 'Player',
    avatarColor: CLUB_COLORS[Math.floor(Math.random() * CLUB_COLORS.length)],
    points: 0,
    currentStreak: 0,
    longestStreak: 0,
    joinedAt: Date.now()
  });

  /* Reaching here always means a membership row was written for this club —
     either a fresh join, or provisioning over a row left behind by whatever
     used to live at this address. Both are a new member of *this* club. */
  await updateDoc(clubRef(clubId), { memberCount: increment(1) }).catch(() => {});
  await updateDoc(publicClubRef(clubId), { memberCount: increment(1) }).catch(() => {});

  /* So the Network can tell the next person with this address that they are
     already in, instead of taking a registration nobody needs. */
  await indexMemberEmail(clubId, email);
  await setDoc(doc(db, 'users', user.uid), {
    email,
    clubs: { [clubId]: finalRole }
  }, { merge: true });

  return { clubId, role: finalRole, slug: data.slug || clubId };
}

/* Every subcollection a club owns. Deleting a document in Firestore does NOT
   delete what lives underneath it, so a club removed without this leaves its
   whole membership behind — and the next club to take that address inherits
   the ghosts: old roles, old points, old bans. */
const CLUB_SUBCOLLECTIONS = [
  'events', 'puzzles', 'announcements', 'shopItems', 'shopOrders',
  'attendanceForms', 'attendanceResponses', 'puzzleAttempts', 'bans', 'integrations',
  'applications', 'memberEmails', 'media'
];

const purge = async (col) => {
  try {
    const snap = await getDocs(col);
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    return snap.size;
  } catch (e) {
    console.warn('Could not clear a collection while deleting the club', e);
    return 0;
  }
};

/**
 * Removes a club and everything under it.
 *
 * Order matters, because the rules decide what you may delete by reading your
 * own membership row: it is deleted last, and the club document just before
 * it, or you lose the permission you need half way through.
 */
export async function deleteClubDeep(user, club) {
  const clubId = club.id;

  // 1 — the join code, which is a root document pointing back here
  if (club.code) {
    await deleteDoc(doc(db, 'clubCodes', String(club.code))).catch(() => {});
  }

  // 1b — and the public listing, which is another one
  await deleteDoc(publicClubRef(clubId)).catch(() => {});

  // 1c — and every check-in this club published for the world to scan, which
  //      live at the root too and so do not go with the events they describe
  try {
    const open = await getDocs(query(collection(db, 'publicAttendance'),
      where('clubId', '==', clubId), limit(200)));
    await Promise.all(open.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  } catch (e) { console.warn('Could not withdraw the check-ins this club published', e); }

  // 2 — anything this club scheduled out in the root tournaments collection
  try {
    const { tournCol, deleteTournament } = await import('./tournaments-core.js');
    const snap = await getDocs(query(tournCol(), where('clubId', '==', clubId), limit(200)));
    for (const d of snap.docs) {
      await deleteTournament({ id: d.id, ...d.data() }).catch(() => {});
    }
  } catch (e) { console.warn('Could not clear the club tournaments', e); }

  // 3 — content
  for (const name of CLUB_SUBCOLLECTIONS) {
    await purge(collection(db, 'clubs', clubId, name));
  }

  // 4 — every membership except your own, which is still authorising all this
  try {
    const members = await getDocs(collection(db, 'clubs', clubId, 'members'));
    await Promise.all(members.docs
      .filter((d) => d.id !== user.uid)
      .map((d) => deleteDoc(d.ref).catch(() => {})));
  } catch (e) { console.warn('Could not clear the member list', e); }

  // 5 — the club itself, then the seat that let you do it
  await deleteDoc(clubRef(clubId));
  await deleteDoc(memberRef(clubId, user.uid)).catch(() => {});

  // 6 — and your own index, so the hub stops listing it
  await setDoc(doc(db, 'users', user.uid), {
    clubs: { [clubId]: null }
  }, { merge: true }).catch(() => {});
}

export async function myClubs(user) {
  const snap = await getDoc(doc(db, 'users', user.uid));
  const profile = snap.exists() ? snap.data() : {};
  const map = profile.clubs || {};
  const banned = profile.bannedFrom || {};
  const ids = Object.keys(map).filter((id) => map[id] && !banned[id]);
  const out = [];
  await Promise.all(ids.map(async (id) => {
    const c = await getDoc(clubRef(id));
    if (!c.exists()) return;
    // trust the membership doc over the cached index
    const m = await getDoc(memberRef(id, user.uid));
    if (!m.exists()) return;
    out.push({ id, ...c.data(), role: m.data().role || 'student' });
  }));
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return out;
}
