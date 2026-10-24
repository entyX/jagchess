/* ═══════════════════════════════════════════════════════════════════════
   club-import.js — one-time copy of the pre-clubs data into a club.

   Copy-only: it writes into clubs/{clubId}/… using the SAME document ids so
   every relationship (eventId, puzzleId, userId) still resolves. Nothing in
   the old root collections is modified or deleted, and re-running it simply
   overwrites the copies with the same values.

   Only accounts that predate the club are treated as returning members —
   anyone who signs up afterwards is a new user and joins clubs deliberately.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, clubRef, clubDoc, memberRef,
  doc, collection, getDoc, getDocs, setDoc, updateDoc
} from './club-core.js';

const CONTENT = [
  'events',
  'puzzles',
  'announcements',
  'shopItems',
  'shopOrders',
  'attendanceForms',
  'attendanceResponses',
  'puzzleAttempts'
];

const AVATARS = ['#e9a93a', '#2e90fa', '#a05cf7', '#ff9600', '#ff4b4b', '#14b8a6'];

export async function importLegacy(clubId, onProgress = () => {}, { force = false } = {}) {
  const clubSnap = await getDoc(clubRef(clubId));
  if (!clubSnap.exists()) return { total: 0, counts: {}, problems: ['club missing'] };

  /* A copy that has already run must not run again. This is a one-way street:
     the source collections still hold everything, so re-running it rewrites
     every document the club has since deleted straight back into place. */
  if (!force && clubSnap.data().legacyImported) {
    return { total: 0, counts: clubSnap.data().legacyCounts || {}, problems: [], skipped: true };
  }

  const cutoff = clubSnap.data().createdAt || Date.now();

  let total = 0;
  const counts = {};
  const problems = [];

  for (const name of CONTENT) {
    onProgress(`Copying ${name}…`);
    let n = 0;
    try {
      const snap = await getDocs(collection(db, name));
      for (const d of snap.docs) {
        try {
          await setDoc(clubDoc(clubId, name, d.id), d.data(), { merge: true });
          n++;
        } catch (err) {
          problems.push(`${name}/${d.id}: ${err.code || err.message}`);
        }
      }
    } catch (err) {
      // one unreadable collection must not abandon the rest of the move
      problems.push(`${name}: ${err.code || err.message}`);
    }
    counts[name] = n;
    total += n;
  }

  // users → club members (returning accounts only)
  onProgress('Copying members…');
  let members = 0;
  try {
    const snap = await getDocs(collection(db, 'users'));
    for (const d of snap.docs) {
      const u = d.data();
      if (u.deleted === true) continue;
      if (!u.createdAt || u.createdAt >= cutoff) continue; // signed up after the move

      const role = u.role === 'admin' ? 'admin' : 'student';
      try {
        await setDoc(memberRef(clubId, d.id), {
          uid: d.id,
          role,
          email: (u.email || '').toLowerCase(),
          username: u.username || (u.email || '').split('@')[0] || 'Player',
          avatarColor: u.avatarColor || AVATARS[members % AVATARS.length],
          points: u.points || 0,
          currentStreak: u.currentStreak || 0,
          longestStreak: u.longestStreak || 0,
          completedWeeks: u.completedWeeks || [],
          lastAttendanceWeek: u.lastAttendanceWeek || null,
          banned: u.banned === true,
          joinedAt: u.createdAt || Date.now(),
          importedAt: Date.now()
        }, { merge: true });

        await setDoc(doc(db, 'users', d.id), { clubs: { [clubId]: role } }, { merge: true })
          .catch((e) => problems.push(`index ${d.id}: ${e.code || e.message}`));

        members++;
      } catch (err) {
        problems.push(`member ${d.id}: ${err.code || err.message}`);
      }
    }
  } catch (err) {
    problems.push(`users: ${err.code || err.message}`);
  }

  counts.members = members;
  total += members;

  /* Marked done whether or not every single document made it.
   *
   * This used to be `legacyImported: problems.length === 0`, so one unreadable
   * row left the flag false and the copy re-ran on every visit — quietly
   * rewriting content the club had deleted in between, which reads to an
   * admin as deleted things coming back by themselves. A migration that
   * cannot say "I ran" is worse than one that ran imperfectly, so the
   * failures are recorded beside the flag instead of resetting it. */
  const clean = problems.length === 0;
  await updateDoc(clubRef(clubId), {
    legacyImported: true,
    legacyImportClean: clean,
    legacyImportedAt: Date.now(),
    legacyCounts: counts,
    legacyProblems: problems.slice(0, 25)
  });

  if (problems.length) console.warn('Import finished with problems:', problems);
  return { total, counts, problems };
}
