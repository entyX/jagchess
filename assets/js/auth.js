import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, updateProfile,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, setPersistence,
  browserLocalPersistence, browserSessionPersistence,
  GoogleAuthProvider, signInWithPopup, connectAuthEmulator
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { rememberSignedIn, forgetSignedIn } from './session-hint.js';

const ADMIN_EMAILS = [
  'shaurya.sahdev7@gmail.com',
  '2025510@apps.nsd.org',
  'northcreekchessclub@gmail.com'
];

const $ = (id) => document.getElementById(id);

/* ── UI: tabs, panes, peek, strength ─────────────────────────────────── */

const paneLogin = $('pane-login');
const paneSignup = $('pane-signup');
const tabLogin = $('tab-login');
const tabSignup = $('tab-signup');
const titleEl = $('auth-title');
const subEl = $('auth-sub');

const errBox = $('alert-error');
const errText = $('alert-error-text');
const okBox = $('alert-ok');
const okText = $('alert-ok-text');

const clearAlerts = () => {
  errBox.classList.remove('show');
  okBox.classList.remove('show');
  document.querySelectorAll('input.bad').forEach(i => i.classList.remove('bad'));
};

const showError = (msg, fieldId) => {
  okBox.classList.remove('show');
  errText.textContent = msg;
  errBox.classList.add('show');
  if (fieldId) {
    const f = $(fieldId);
    if (f) { f.classList.add('bad'); f.focus(); }
  }
};

const showOk = (msg) => {
  errBox.classList.remove('show');
  okText.textContent = msg;
  okBox.classList.add('show');
};

const setMode = (mode) => {
  const signup = mode === 'signup';
  clearAlerts();
  tabLogin.classList.toggle('on', !signup);
  tabSignup.classList.toggle('on', signup);
  paneLogin.classList.toggle('on', !signup);
  paneSignup.classList.toggle('on', signup);
  titleEl.textContent = signup ? 'Create your account' : 'Welcome back';
  subEl.textContent = signup
    ? 'Join your club and start earning points today.'
    : 'Sign in to your club dashboard.';
  const url = new URL(window.location.href);
  if (signup) url.searchParams.set('mode', 'signup');
  else url.searchParams.delete('mode');
  window.history.replaceState({}, '', url);
};

tabLogin.addEventListener('click', () => setMode('login'));
tabSignup.addEventListener('click', () => setMode('signup'));
$('go-signup').addEventListener('click', () => setMode('signup'));
$('go-login').addEventListener('click', () => setMode('login'));

if (new URLSearchParams(window.location.search).get('mode') === 'signup') setMode('signup');

document.querySelectorAll('.peek').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.peek);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.style.color = showing ? '' : 'var(--blue)';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});

const strengthEl = $('strength');
const strengthLabel = $('strength-label');
const LEVELS = ['—', 'Weak', 'Fair', 'Good', 'Strong'];

const scorePassword = (v) => {
  if (!v) return 0;
  let s = 0;
  if (v.length >= 6) s++;
  if (v.length >= 10) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(s, 4);
};

$('su-password').addEventListener('input', (e) => {
  const level = scorePassword(e.target.value);
  strengthEl.dataset.level = String(level);
  strengthLabel.textContent = LEVELS[level];
});

const btnHtml = new WeakMap();

const busy = (btn, on, label) => {
  if (!btn) return;
  if (on) {
    if (!btnHtml.has(btn)) btnHtml.set(btn, btn.innerHTML);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>' + (label || '');
  } else {
    btn.disabled = false;
    if (btnHtml.has(btn)) btn.innerHTML = btnHtml.get(btn);
  }
};

/* ── Firebase ────────────────────────────────────────────────────────── */

const cfg = window.FIREBASE_CONFIG;

if (!cfg) {
  showError('Missing Firebase config. Create assets/js/firebase-config.js.');
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (window.JAG_EMULATORS) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  let blocked = false; // set when an account is suspended/deleted

  const openModal = (id) => { const m = $(id); if (m) m.classList.add('show'); };
  const closeModal = (id) => { const m = $(id); if (m) m.classList.remove('show'); };
  $('suspended-ok').addEventListener('click', () => closeModal('suspended-modal'));
  $('deleted-ok').addEventListener('click', () => closeModal('deleted-modal'));

  const ERRORS = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/user-not-found': 'No account found for this email.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'An account already exists with this email. Try signing in.',
    'auth/weak-password': 'Choose a password with at least 6 characters.',
    'auth/missing-password': 'Enter your password.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/operation-not-allowed': 'That sign-in method isn\'t enabled for this project yet.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
    'auth/popup-blocked': 'Your browser blocked the Google popup. Allow popups and retry.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/unauthorized-domain': 'This domain isn\'t authorized for sign-in in Firebase.'
  };

  const handleError = (e, fieldId) => {
    const code = e && e.code ? String(e.code) : '';
    const msg = ERRORS[code] || (typeof e === 'string' ? e : (e && e.message) || 'Something went wrong.');
    console.error('Auth error:', e);
    showError(msg, fieldId);
  };

  const nextUrl = () => {
    const raw = new URLSearchParams(window.location.search).get('next');
    // only ever follow same-origin paths
    return raw && /^\/[^/]/.test(raw) ? raw : '/clubs';
  };

  const routeUser = async (user, extra, method) => {
    const email = (user?.email || '').trim().toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);

    if (snap.exists()) {
      const data = snap.data();
      if (data.banned === true) {
        blocked = true;
        forgetSignedIn();
        await signOut(auth);
        return openModal('suspended-modal');
      }
      if (data.deleted === true) {
        blocked = true;
        forgetSignedIn();
        await signOut(auth);
        return openModal('deleted-modal');
      }
      const patch = { ...(extra || {}) };
      if (data.username) delete patch.username; // never clobber a chosen name
      if (!data.email && email) patch.email = email;
      if (isAdminEmail && data.role !== 'admin') {
        patch.role = 'admin';
        patch.promotedAt = Date.now();
      }
      patch.lastSeenAt = Date.now();
      await setDoc(ref, patch, { merge: true });
    } else {
      const payload = {
        role: isAdminEmail ? 'admin' : 'student',
        email,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ...(extra || {})
      };
      if (isAdminEmail) payload.promotedAt = Date.now();
      await setDoc(ref, payload, { merge: true });
    }

    /* Analytics, if it loaded: name the user so returning visits can be
       recognized, and count the auth itself. `method` is only set on a real
       sign-in — arriving here with a session already open is a redirect,
       not a login. */
    window.jagIdentify?.(user.uid);
    if (method) window.jagTrack?.(snap.exists() ? 'login' : 'sign_up', { method });

    /* From here on the marketing site and the Network are behind you. */
    rememberSignedIn();

    // roles now live per club — everyone lands on their club hub
    window.location.href = nextUrl();
  };

  /* already signed in → go straight through */
  onAuthStateChanged(auth, (user) => {
    if (user && !blocked) routeUser(user).catch(e => handleError(e));
    // sitting on the login screen with no session is as signed out as it gets
    else if (!user) forgetSignedIn();
  });

  /* ── sign in ── */
  paneLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlerts();
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email) return showError('Enter your email address.', 'email');
    if (!password) return showError('Enter your password.', 'password');

    const btn = $('login-btn');
    busy(btn, true, 'Signing in…');
    try {
      await setPersistence(auth, $('remember').checked ? browserLocalPersistence : browserSessionPersistence);
      const res = await signInWithEmailAndPassword(auth, email, password);
      await routeUser(res.user, undefined, 'password');
    } catch (err) {
      handleError(err, 'password');
      busy(btn, false);
    }
  });

  /* ── create account ── */
  paneSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlerts();
    const username = $('username').value.trim();
    const email = $('su-email').value.trim();
    const password = $('su-password').value;
    if (!username) return showError('Choose a display name.', 'username');
    if (username.length < 2) return showError('That display name is a little short.', 'username');
    if (!email) return showError('Enter your email address.', 'su-email');
    if (password.length < 6) return showError('Passwords need at least 6 characters.', 'su-password');

    const btn = $('signup-btn');
    busy(btn, true, 'Creating account…');
    try {
      await setPersistence(auth, browserLocalPersistence);
      const res = await createUserWithEmailAndPassword(auth, email, password);
      try { await updateProfile(res.user, { displayName: username }); } catch (_) {}
      await routeUser(res.user, { username }, 'password');
    } catch (err) {
      handleError(err, 'su-email');
      busy(btn, false);
    }
  });

  /* ── Google ── */
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const googleSignIn = async (btn) => {
    clearAlerts();
    busy(btn, true, 'Opening Google…');
    try {
      await setPersistence(auth, browserLocalPersistence);
      const res = await signInWithPopup(auth, provider);
      const name = res.user.displayName || '';
      await routeUser(res.user, name ? { username: name } : undefined, 'google');
    } catch (err) {
      handleError(err);
      busy(btn, false);
    }
  };

  $('google-btn').addEventListener('click', () => googleSignIn($('google-btn')));
  $('google-btn-2').addEventListener('click', () => googleSignIn($('google-btn-2')));

  /* ── password reset ── */
  $('forgot-link').addEventListener('click', async (e) => {
    e.preventDefault();
    clearAlerts();
    const email = $('email').value.trim();
    if (!email) return showError('Enter your email above, then tap “Forgot?”.', 'email');
    try {
      await sendPasswordResetEmail(auth, email);
      showOk('Reset link sent. Check your inbox (and spam folder).');
    } catch (err) {
      handleError(err, 'email');
    }
  });
}
