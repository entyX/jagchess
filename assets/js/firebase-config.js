window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAQzYQjxFtCNBsrm8q2E0yU2Vn5Mr6olK0",
  authDomain: "jagchess.web.app",
  projectId: "nchs-chess-club",
  storageBucket: "nchs-chess-club.firebasestorage.app",
  messagingSenderId: "683171999944",
  appId: "1:683171999944:web:b41d3705ba0f592b24b5fd",
  measurementId: "G-645TQN4KN9"
};

/* Local development only. Opening the site on localhost with ?emu=1 points
   every page at the Firebase emulators (see "emulators" in firebase.json)
   instead of the live project, and remembers that on this browser until
   ?emu=0. Nothing here can switch on anywhere but localhost. */
(function () {
  try {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    const q = new URLSearchParams(location.search).get('emu');
    if (q !== null) localStorage.setItem('jag.emu', q === '0' ? '' : '1');
    window.JAG_EMULATORS = localStorage.getItem('jag.emu') === '1';
  } catch (e) { /* storage blocked: stay on the live project */ }
})();
