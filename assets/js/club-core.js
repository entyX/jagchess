/* ═══════════════════════════════════════════════════════════════════════
   club-core.js — shared plumbing for the clubs layer.
   Firebase handles, club-scoped collection helpers, and small UI utilities.
   ═══════════════════════════════════════════════════════════════════════ */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, orderBy, increment, writeBatch, limit,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

export {
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, increment, writeBatch, limit,
  runTransaction, signOut
};

const cfg = window.FIREBASE_CONFIG;
export const app = getApps().length ? getApps()[0] : initializeApp(cfg);
export const auth = getAuth(app);
export const db = getFirestore(app);

/* ── club-scoped paths ─────────────────────────────────────────────── */

export const clubRef = (clubId) => doc(db, 'clubs', clubId);
export const clubCol = (clubId, name) => collection(db, 'clubs', clubId, name);
export const clubDoc = (clubId, name, id) => doc(db, 'clubs', clubId, name, id);
export const memberRef = (clubId, uid) => doc(db, 'clubs', clubId, 'members', uid);

/* ── auth gate ─────────────────────────────────────────────────────── */

export function requireUser() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = '/login?next=' + next;
        return;
      }
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

export const CLUB_COLORS = ['#58cc02', '#1cb0f6', '#a05cf7', '#ff9600', '#ff4b4b', '#14b8a6', '#ffc800', '#526b7a'];
export const CLUB_ICONS = ['♞', '♜', '♛', '♚', '♝', '♟', '🏆', '🎓', '⚡', '🔥', '🎯', '🧠'];

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

export async function joinClub(user, clubId, { role } = {}) {
  const club = await getDoc(clubRef(clubId));
  if (!club.exists()) throw new Error('That club no longer exists.');
  const data = club.data();

  const existing = await getDoc(memberRef(clubId, user.uid));
  if (existing.exists()) return { clubId, already: true, slug: data.slug || clubId };

  // a ban blocks the join outright, whatever route was used to get here
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

  const email = (user.email || '').toLowerCase();
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

  await updateDoc(clubRef(clubId), { memberCount: increment(1) }).catch(() => {});
  await setDoc(doc(db, 'users', user.uid), {
    email,
    clubs: { [clubId]: finalRole }
  }, { merge: true });

  return { clubId, role: finalRole, slug: data.slug || clubId };
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
