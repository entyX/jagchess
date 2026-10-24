/* ═══════════════════════════════════════════════════════════════════════
   puzzle-library.js — collections, the cross-club mirror, and the library
   panel both sides of the site draw.

   A club's puzzles are member-only, and they have to stay that way: a club
   that wants its work kept in the room is entitled to that. But a club that
   wants the opposite — its puzzles offered to everybody on JagChess as a
   free resource — had no way to say so, because there is no server here to
   ask on a stranger's behalf.

   So the same bargain publicClubs makes is made again, one document per
   puzzle. A puzzle whose collection and whose own switch both say "everyone"
   is copied out to `publicPuzzles/{clubId__puzzleId}`, which any signed-in
   person may read. Turn either switch back and the copy is deleted; the
   original never moves.

   Two things follow from that, and both are deliberate:

     · the mirror carries the whole puzzle, board and graph included, so the
       library can be played from without ever reading a club collection
     · the mirror is written by the club, not by the reader, so nobody can
       publish somebody else's puzzle by asking for it

   The collection is the outer switch. One set to "this club only" decides
   for everything inside it, and while it is closed a puzzle's own switch is
   set aside rather than thrown away — see effectiveVisibility in
   puzzle-model.js, which is where that rule actually lives.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDoc, getDocs, setDoc, deleteDoc, query, where,
  clubRef, clubCol, clubDoc, esc
} from './club-core.js';

import {
  normalizePuzzle, normalizeCollection, effectiveVisibility,
  difficultyText, difficultyBand, difficultyWord, bylineOf, scoreFor, hasExpired,
  DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME,
  GLOBAL_CLUB_ID, GLOBAL_CLUB_NAME, GLOBAL_COLLECTION_NAME, isGlobal
} from './puzzle-model.js';

export {
  DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME,
  GLOBAL_CLUB_ID, GLOBAL_CLUB_NAME, GLOBAL_COLLECTION_NAME, isGlobal
};

/* ── where everything lives ────────────────────────────────────────── */

export const collectionCol = (clubId) => clubCol(clubId, 'puzzleCollections');
export const collectionDoc = (clubId, id) => clubDoc(clubId, 'puzzleCollections', id);

export const mirrorId = (clubId, id) => clubId + '__' + id;

export const publicPuzzleCol = () => collection(db, 'publicPuzzles');
export const publicPuzzleRef = (clubId, puzzleId) =>
  doc(db, 'publicPuzzles', mirrorId(clubId, puzzleId));

export const publicCollectionCol = () => collection(db, 'publicPuzzleCollections');
export const publicCollectionRef = (clubId, collId) =>
  doc(db, 'publicPuzzleCollections', mirrorId(clubId, collId));

/* Nothing here is worth failing somebody's page over. */
const quiet = (promise) => promise.catch((e) => { console.warn('puzzle library', e); });

/* ── the one collection nobody has to make ─────────────────────────────
   Every club is born with a shelf for its members' own puzzles. It is not
   something an admin sets up, because the alternative is a member opening
   the builder, filling it in, and being told there is nowhere to put it —
   and the fix for that is an admin they may not be able to find.

   It is written at a fixed id, so asking for it twice is asking for it
   once, and any member may create it. Everything about it afterwards — its
   name, whether it is shared outside the club — is an admin's, which is
   why this only ever writes when the club genuinely has none. Writing it
   unconditionally would undo their edits every time somebody opened the
   page.

   `existing` is the collections the caller has already been handed by its
   own live listener, so asking the question costs no read at all.
   ─────────────────────────────────────────────────────────────────── */

/* Called from a snapshot handler, so it writes at most once per club per
   page and only when the shelf genuinely is not there. A club still holding
   the shelf's first name is not rewritten — normalizeCollection maps that
   name on the way out, which is the only way a screen can be right whether
   or not a write lands. */
const tried = new Set();

export async function ensureDefaultCollection(clubId, club, existing) {
  if (!clubId || tried.has(clubId)) return false;
  if ((existing || []).some((c) => c.isDefault || c.id === DEFAULT_COLLECTION_ID)) return false;
  tried.add(clubId);
  try {
    await setDoc(collectionDoc(clubId, DEFAULT_COLLECTION_ID), {
      name: DEFAULT_COLLECTION_NAME,
      description: 'Puzzles the club’s own members have built. Admins can adopt one.',
      icon: '♟',
      color: '#a05cf7',
      kind: 'custom',
      isDefault: true,
      /* Public from birth, and not a choice: see forcedVisibility in
         puzzle-model.js for why a members' shelf has no private mode. */
      visibility: 'public',
      clubId,
      clubName: String((club || {}).name || ''),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    return true;
  } catch (e) {
    /* Two tabs opening at once both write the same document with the same
       contents, which is harmless. Anything else is a club this person may
       not write to, and is not worth interrupting them for. */
    console.warn('Could not open the members’ collection', e);
    return false;
  }
}

/* ── making your own club's shelf visible from outside it ──────────────
   The copy that puts a club's members' shelf in the library is written
   when somebody opens that club's puzzles page, which is the right place
   for it and the wrong place to depend on: somebody who goes straight to
   /library sees no shelf at all until a clubmate happens to visit a page
   they had no reason to visit.

   So /library repairs its own view. For each club you are in whose shelf
   is missing from the mirror, the shelf is read and the copy written —
   which you are allowed to do for your OWN club's default shelf, and for
   nothing else. It costs two reads per club and only while the copy is
   genuinely absent.
   ─────────────────────────────────────────────────────────────────── */

const triedShelf = new Set();

export async function ensureClubShelfMirrored(clubId, existing) {
  if (!clubId || triedShelf.has(clubId)) return false;
  const id = mirrorId(clubId, DEFAULT_COLLECTION_ID);
  if ((existing || []).some((c) => c.id === id)) return false;
  triedShelf.add(clubId);
  try {
    const [clubSnap, collSnap] = await Promise.all([
      getDoc(clubRef(clubId)),
      getDoc(collectionDoc(clubId, DEFAULT_COLLECTION_ID))
    ]);
    /* No shelf yet means nobody in the club has opened the puzzles page
       either. Making one from out here would be writing a club document
       on behalf of a club, which is not this page's business. */
    if (!collSnap.exists()) return false;
    const coll = normalizeCollection({ id: DEFAULT_COLLECTION_ID, ...collSnap.data() });
    if (coll.kind !== 'custom') return false;
    const club = { id: clubId, ...(clubSnap.exists() ? clubSnap.data() : {}) };
    /* The count is the club's to keep current — the library counts the
       puzzles it can actually see anyway, so a zero here costs nothing and
       saves reading the whole collection from a page that does not need it. */
    await setDoc(publicCollectionRef(clubId, DEFAULT_COLLECTION_ID),
      publicCollectionPayload(coll, club, 0));
    return true;
  } catch (e) {
    console.warn('Could not publish your club’s shelf', e);
    return false;
  }
}

/* ── the shelf outside every club ──────────────────────────────────────
   Everything above is about a club's own shelf. This one belongs to no
   club, and exists for the puzzle built from /library by somebody who is
   in no club at all — under the old rule that every puzzle lives in a
   club, they simply could not build one.

   It lives only in the mirror. There is no `clubs/__global` document
   behind it, because there is no club: the mirror IS the storage, which is
   why the builder writes a global puzzle straight here instead of writing
   a club puzzle and copying it out.
   ─────────────────────────────────────────────────────────────────── */

/** The stand-in a global puzzle is credited to, shaped like a club. */
export const globalClub = () => ({
  id: GLOBAL_CLUB_ID,
  name: GLOBAL_CLUB_NAME,
  icon: '♙',
  color: '#a05cf7'
});

/** The global shelf itself, as a collection the library can draw. */
export const globalCollection = () => normalizeCollection({
  id: DEFAULT_COLLECTION_ID,
  name: GLOBAL_COLLECTION_NAME,
  description: 'Puzzles built by people on JagChess, outside any one club. Anybody can add to it.',
  icon: '♙',
  color: '#a05cf7',
  kind: 'custom',
  isDefault: true,
  anonymous: true,
  clubId: GLOBAL_CLUB_ID,
  clubName: GLOBAL_CLUB_NAME
});

/* Written at most once per page, and only when it genuinely is not there —
   `existing` is the mirror the caller is already listening to, so asking
   costs no read. Everyone who opens /library can write it, which is safe
   only because every writer writes byte-identical content. */
let triedGlobal = false;

export async function ensureGlobalCollection(existing) {
  if (triedGlobal) return false;
  const id = mirrorId(GLOBAL_CLUB_ID, DEFAULT_COLLECTION_ID);
  if ((existing || []).some((c) => c.id === id)) return false;
  triedGlobal = true;
  const count = 0;
  return !!(await quiet(setDoc(
    publicCollectionRef(GLOBAL_CLUB_ID, DEFAULT_COLLECTION_ID),
    publicCollectionPayload(globalCollection(), globalClub(), count)
  )));
}

/**
 * Publishes one global puzzle, which for this shelf is the whole of saving
 * it — there is no club copy to be the original.
 *
 * @param {object} puzzle  needs an `id` already chosen by the caller
 */
export async function publishGlobalPuzzle(puzzle) {
  if (!puzzle || !puzzle.id) return;
  return quiet(setDoc(
    publicPuzzleRef(GLOBAL_CLUB_ID, puzzle.id),
    publicPuzzlePayload(puzzle, globalClub(), globalCollection())
  ));
}

export const removeGlobalPuzzle = (puzzleId) =>
  (puzzleId ? quiet(deleteDoc(publicPuzzleRef(GLOBAL_CLUB_ID, puzzleId))) : undefined);

/* ── what gets copied ──────────────────────────────────────────────────
   Everything needed to draw the row and to play the puzzle, and nothing
   else. No attempt rows, no member list, no club document — the mirror is
   read by strangers, and a stranger has no business knowing who solved it.
   ─────────────────────────────────────────────────────────────────── */

const nameOfClub = (club) => String((club || {}).name || '');

export function publicPuzzlePayload(puzzle, club, coll) {
  const p = normalizePuzzle(puzzle);
  return {
    clubId: club.id,
    clubName: nameOfClub(club),
    clubIcon: String(club.icon || ''),
    clubColor: String(club.color || ''),
    puzzleId: p.id,
    collectionId: p.collectionId || '',
    collectionName: coll ? String(coll.name || '') : '',

    title: p.title,
    description: p.description,
    source: p.source,
    fen: p.fen,
    playerColor: p.playerColor,
    points: p.points,
    difficulty: p.difficulty,
    expiresAt: p.expiresAt,
    latePenaltyPct: p.latePenaltyPct,
    tree: { root: p.tree.root, nodes: p.tree.nodes },
    solveMoves: p.stats.moves,
    lineCount: Math.max(1, p.stats.branches),

    authorUid: p.authorUid,
    authorName: p.anonymous ? '' : p.authorName,
    anonymous: p.anonymous,
    custom: p.custom,
    originalAuthorUid: p.originalAuthorUid,
    originalAuthorName: p.originalAnonymous ? '' : p.originalAuthorName,
    originalAnonymous: p.originalAnonymous,

    createdAt: p.createdAt,
    updatedAt: Date.now()
  };
}

export function publicCollectionPayload(coll, club, count) {
  const c = normalizeCollection(coll);
  return {
    clubId: club.id,
    clubName: nameOfClub(club),
    clubIcon: String(club.icon || ''),
    clubColor: String(club.color || ''),
    collectionId: c.id,
    name: c.name,
    description: c.description,
    icon: c.icon,
    color: c.color,
    kind: c.kind,
    isDefault: c.isDefault,
    puzzleCount: Math.max(0, Math.trunc(Number(count) || 0)),
    createdBy: c.createdBy || '',
    createdByName: c.anonymous ? '' : (c.createdByName || ''),
    anonymous: c.anonymous,
    createdAt: c.createdAt,
    updatedAt: Date.now()
  };
}

/* ── keeping the copies honest ─────────────────────────────────────────
   Every one of these is best effort and none of them throws. A mirror is a
   convenience; a club's own puzzle must never fail to save because the
   copy of it could not be written.
   ─────────────────────────────────────────────────────────────────── */

/** Writes or removes one puzzle's copy, according to what it and its shelf say. */
export async function syncPublicPuzzle(club, puzzle, coll) {
  if (!club || !club.id || !puzzle || !puzzle.id) return;
  const ref = publicPuzzleRef(club.id, puzzle.id);
  if (effectiveVisibility(puzzle, coll) !== 'public') return quiet(deleteDoc(ref));
  return quiet(setDoc(ref, publicPuzzlePayload(puzzle, club, coll)));
}

export async function removePublicPuzzle(clubId, puzzleId) {
  if (!clubId || !puzzleId) return;
  return quiet(deleteDoc(publicPuzzleRef(clubId, puzzleId)));
}

/**
 * Writes or removes one collection's copy, and every puzzle inside it.
 *
 * This is the switch that cascades: closing a collection has to take the
 * whole shelf down with it, and opening it again has to put back exactly
 * the puzzles that said "everyone" for themselves — which is why each one
 * is asked again rather than being restored from a list.
 */
export async function syncPublicCollection(club, coll, puzzles) {
  if (!club || !club.id || !coll || !coll.id) return;
  const mine = (puzzles || []).filter((p) => p.collectionId === coll.id);

  await (coll.visibility === 'public'
    ? quiet(setDoc(publicCollectionRef(club.id, coll.id),
      publicCollectionPayload(coll, club, mine.length)))
    : quiet(deleteDoc(publicCollectionRef(club.id, coll.id))));

  await Promise.all(mine.map((p) => syncPublicPuzzle(club, p, coll)));
}

export async function removePublicCollection(clubId, collId) {
  if (!clubId || !collId) return;
  return quiet(deleteDoc(publicCollectionRef(clubId, collId)));
}

/* Key order out of Firestore is not the order we wrote, and updatedAt always
   differs — so a copy is "the same" only once both are set aside. */
const stable = (v) => JSON.stringify(v, (_k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, k) => { o[k] = val[k]; return o; }, {})
    : val);

const changed = (a, b) => {
  const strip = (obj) => {
    const rest = Object.assign({}, obj);
    delete rest.updatedAt;
    return stable(rest);
  };
  return strip(a || {}) !== strip(b || {});
};

/**
 * Makes the whole of a club's public shelf agree with the club.
 *
 * Run when staff open the puzzles page, in the same spirit as
 * syncPublicClub: a copy that fell behind because a tab was closed
 * mid-write is repaired by the next person who could have written it,
 * rather than staying wrong until somebody notices. It writes only what
 * actually differs, so the usual cost is a pair of list reads and nothing
 * else at all.
 */
export async function reconcilePublicLibrary(club, collections, puzzles) {
  if (!club || !club.id) return 0;
  try {
    const byId = new Map((collections || []).map((c) => [c.id, c]));

    const wantPuzzles = new Map();
    for (const p of (puzzles || [])) {
      if (effectiveVisibility(p, byId.get(p.collectionId) || null) === 'public') {
        wantPuzzles.set(mirrorId(club.id, p.id), p);
      }
    }
    const wantColls = new Map();
    for (const c of (collections || [])) {
      if (c.visibility === 'public') wantColls.set(mirrorId(club.id, c.id), c);
    }

    const [havePz, haveColl] = await Promise.all([
      getDocs(query(publicPuzzleCol(), where('clubId', '==', club.id))),
      getDocs(query(publicCollectionCol(), where('clubId', '==', club.id)))
    ]);

    const jobs = [];

    for (const d of havePz.docs) {
      if (!wantPuzzles.has(d.id)) jobs.push(quiet(deleteDoc(d.ref)));
    }
    for (const entry of wantPuzzles) {
      const id = entry[0];
      const p = entry[1];
      const had = havePz.docs.find((d) => d.id === id);
      const next = publicPuzzlePayload(p, club, byId.get(p.collectionId) || null);
      if (!had || changed(had.data(), next)) {
        jobs.push(quiet(setDoc(publicPuzzleRef(club.id, p.id), next)));
      }
    }

    for (const d of haveColl.docs) {
      if (!wantColls.has(d.id)) jobs.push(quiet(deleteDoc(d.ref)));
    }
    for (const entry of wantColls) {
      const id = entry[0];
      const c = entry[1];
      const had = haveColl.docs.find((d) => d.id === id);
      const count = (puzzles || []).filter((p) => p.collectionId === c.id).length;
      const next = publicCollectionPayload(c, club, count);
      if (!had || changed(had.data(), next)) {
        jobs.push(quiet(setDoc(publicCollectionRef(club.id, c.id), next)));
      }
    }

    await Promise.all(jobs);
    return jobs.length;
  } catch (e) {
    console.warn('Could not refresh the public puzzle library', e);
    return 0;
  }
}

/* ── one shelf for everybody's own work ────────────────────────────────
   Out on /library a club's members' shelf is not an interesting unit: it
   is one club's corner of the same thing every club has. Twenty clubs
   would mean twenty near-identical cards all called "Custom", each
   with three puzzles on it, and the one shelf a visitor actually wants —
   everything people have built — would not exist at all.

   So they are folded into one. Each club's puzzles keep their own club on
   their byline, which is where that belongs, and the shelf itself belongs
   to no club.
   ─────────────────────────────────────────────────────────────────── */

export const MERGED_CUSTOM_ID = '__members';

export function mergeCustomCollections(collections, puzzles) {
  const custom = (collections || []).filter((c) => c.kind === 'custom');
  if (!custom.length) return { collections: collections || [], puzzles: puzzles || [] };

  const ids = new Set(custom.map((c) => c.id));
  const rest = (collections || []).filter((c) => !ids.has(c.id));
  const clubs = new Set(custom.map((c) => c.clubName).filter(Boolean));

  const merged = normalizeCollection({
    id: MERGED_CUSTOM_ID,
    name: 'Custom',
    description: clubs.size === 1
      ? 'Puzzles built by members themselves.'
      : `Puzzles built by members themselves, across ${clubs.size} clubs.`,
    icon: '♟',
    color: '#a05cf7',
    kind: 'custom',
    isDefault: true,
    /* It is nobody's shelf, so nobody is credited on it — the credit is on
       each puzzle, where it says which club and which person. */
    anonymous: true,
    createdAt: Math.max(0, ...custom.map((c) => c.createdAt || 0))
  });

  return {
    collections: [merged].concat(rest),
    puzzles: (puzzles || []).map((p) =>
      (ids.has(p.collectionId) ? Object.assign({}, p, { collectionId: MERGED_CUSTOM_ID }) : p))
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  SMALL PIECES EVERY PUZZLE SURFACE SHARES                               */
/* ═══════════════════════════════════════════════════════════════════════ */

const ICON_LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="4.4" y="10.4" width="15.2" height="10.2" rx="2.6"/><path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8"/></svg>';

const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4a13 13 0 0 1 0 17.2 13 13 0 0 1 0-17.2Z"/></svg>';

export const visChip = (visibility, locked) => (visibility === 'public'
  ? '<span class="pz-chip open">' + ICON_GLOBE + ' Everyone</span>'
  : '<span class="pz-chip shut"' + (locked ? ' title="The collection decides this one"' : '') +
    '>' + ICON_LOCK + ' Club only</span>');

export const difficultyChip = (d) => {
  if (d === null || d === undefined) return '';
  return '<span class="pz-diff is-' + difficultyBand(d) + '" title="' +
    esc(difficultyWord(d)) + ' — ' + difficultyText(d) + ' out of 10">' +
    '<b>' + esc(difficultyText(d)) + '</b><i>/10</i></span>';
};

/**
 * The credit line, drawn as one plain sentence: who, then where, separated
 * by a dot. It used to put the club in a pill, which read as a status
 * rather than as the rest of the same sentence.
 */
export function bylineHTML(puzzle, opts) {
  const b = bylineOf(puzzle, opts || {});
  if (!b.names.length && !b.club) return '';

  const parts = b.names.length
    ? b.names.map((n, i) => (i ? 'adapted from ' + esc(n) : esc(n)))
    : ['Anonymous'];
  if (b.club) parts.push(esc(b.club));

  return '<span class="pz-by">' +
    /* The spaces are inside the span rather than in a margin, so the line
       still reads as a sentence when it is copied or read aloud. */
    parts.join('<span class="pz-by-dot"> · </span>') +
    '</span>';
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE PANEL                                                              */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * The Puzzle library panel: collections as cards down the left, and what is
 * on the one you picked as a list on the right.
 *
 * The two halves are shaped differently on purpose. A collection is a thing
 * you choose between, so it is a card — icon, name, how much is on it, all
 * visible at a glance. A puzzle is a thing you scan for one of, so it is a
 * row: title, difficulty and credit on one line, and twenty of them fit
 * where six cards did.
 *
 * Both sides of the site draw this off different shelves — a club reads its
 * own collections, the hub reads the mirror — so it is handed its data
 * rather than fetching any.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 *   title      — the heading
 *   sub        — a line under it
 *   showClub   — credit the club as well as the author
 *   onPick     — (puzzle) => void, when a puzzle row is clicked
 *   tools      — (puzzle) => [{ action, label, kind }], extra buttons per row
 *   onTool     — (action, puzzle) => void
 *   emptyText  — what to say when there are no collections at all
 */
export function mountLibrary(host, opts) {
  const o = opts || {};
  let collections = [];
  let puzzles = [];
  let openId = null;
  let currentId = null;
  let term = '';

  host.innerHTML = `
    <div class="pzlib">
      <div class="pzlib-head">
        <div>
          <h3>${esc(o.title || 'Puzzle library')}</h3>
          ${o.sub ? `<p class="pzlib-sub">${esc(o.sub)}</p>` : ''}
        </div>
        <div class="pzlib-head-tools">
          <label class="pzlib-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input type="search" data-q placeholder="Search collections" aria-label="Search collections" />
          </label>
        </div>
      </div>
      <div class="pzlib-body">
        <div class="pzlib-cards" data-cards></div>
        <div class="pzlib-panel" data-panel></div>
      </div>
    </div>`;

  const $ = (sel) => host.querySelector(sel);
  $('[data-q]').oninput = (e) => { term = e.target.value.trim().toLowerCase(); paintCards(); };

  const countIn = (coll) => puzzles.filter((p) => p.collectionId === coll.id).length;

  const matches = (coll) => !term ||
    String(coll.name || '').toLowerCase().includes(term) ||
    String(coll.description || '').toLowerCase().includes(term) ||
    String(coll.clubName || '').toLowerCase().includes(term);

  function paintCards() {
    const shown = collections.filter(matches);

    if (!collections.length) {
      $('[data-cards]').innerHTML = `<div class="empty-state">${esc(o.emptyText ||
        'No collections yet.')}</div>`;
      return;
    }
    if (!shown.length) {
      $('[data-cards]').innerHTML = '<div class="empty-state">Nothing matches that search.</div>';
      return;
    }

    $('[data-cards]').innerHTML = shown.map((c) => {
      const n = countIn(c);
      const tint = c.color || '#8296a4';
      return `<button class="pzlib-card${openId === c.id ? ' on' : ''}" data-coll="${esc(c.id)}" type="button">
        <span class="pzlib-card-icon" style="background:${esc(tint)}">${esc(c.icon || '♟')}</span>
        <span class="pzlib-card-name">${esc(c.name || 'Untitled collection')}</span>
        <span class="pzlib-card-count">${n} puzzle${n === 1 ? '' : 's'}</span>
        ${o.showClub && c.clubName ? `<span class="pzlib-card-club">${esc(c.clubName)}</span>` : ''}
        ${c.kind === 'custom' && !c.isDefault ? '<span class="pz-chip custom">Custom</span>' : ''}
      </button>`;
    }).join('');

    $('[data-cards]').querySelectorAll('[data-coll]').forEach((b) =>
      (b.onclick = () => open(b.dataset.coll)));
  }

  function row(p) {
    const worth = scoreFor(p);
    const tools = (o.tools ? o.tools(p) : []) || [];
    return `<div class="pzlib-row${currentId === p.id ? ' on' : ''}" data-pz="${esc(p.id)}"
        role="button" tabindex="0">
      <span class="pzlib-row-info">
        <span class="pzlib-row-title">${esc(p.title || 'Untitled puzzle')}</span>
        <span class="pzlib-row-meta">
          ${p.points ? `<span>${esc(String(worth.points))} pts</span>` : '<span>no points</span>'}
          <span>${esc(String(p.stats.moves))} move${p.stats.moves === 1 ? '' : 's'}</span>
          ${p.stats.branches > 1 ? `<span>${esc(String(p.stats.branches))} ways</span>` : ''}
          ${hasExpired(p) ? '<span class="pzlib-row-late">past its date</span>' : ''}
        </span>
        ${bylineHTML(p, { showClub: !!o.showClub })}
      </span>
      ${difficultyChip(p.difficulty)}
      ${tools.length ? `<span class="pzlib-row-tools">${tools.map((t) =>
        `<button class="btn ${esc(t.kind || 'subtle')} sm" data-act="${esc(t.action)}"
           type="button">${esc(t.label)}</button>`).join('')}</span>` : ''}
    </div>`;
  }

  /* A shelf nobody is recorded as having made is not anonymous — nobody
     chose to be unnamed, the name was simply never written down. Saying
     "Anonymous" there claims something that was never true, so what is
     shown is the club, and only where the club is worth naming. */
  function collectionBy(coll) {
    if (coll.createdByName || coll.anonymous) {
      return bylineHTML({
        authorName: coll.createdByName, anonymous: coll.anonymous, clubName: coll.clubName
      }, { showClub: !!o.showClub });
    }
    return o.showClub && coll.clubName
      ? '<span class="pz-by">' + esc(coll.clubName) + '</span>'
      : '';
  }

  function paintPanel() {
    const panel = $('[data-panel]');
    const coll = collections.find((c) => c.id === openId);

    if (!coll) {
      panel.innerHTML = `
        <div class="pzlib-blank">
          <div class="pzlib-blank-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="3" width="7.4" height="7.4" rx="2"/>
              <rect x="3" y="13.6" width="7.4" height="7.4" rx="2"/><rect x="13.6" y="13.6" width="7.4" height="7.4" rx="2"/>
            </svg>
          </div>
          <p>Pick a collection on the left and everything in it appears here.</p>
        </div>`;
      return;
    }

    const mine = puzzles.filter((p) => p.collectionId === coll.id);
    panel.innerHTML = `
      <div class="pzlib-panel-head">
        <h4>${esc(coll.name || 'Untitled collection')}</h4>
        ${coll.description ? `<p class="pzlib-panel-sub">${esc(coll.description)}</p>` : ''}
        <div class="pzlib-panel-meta">
          ${coll.kind === 'custom' ? '<span class="pz-chip custom">Members can add to this one</span>' : ''}
          ${collectionBy(coll)}
        </div>
      </div>
      ${mine.length
        ? `<div class="pzlib-list">${mine.map(row).join('')}</div>`
        : '<div class="empty-state">Nothing in this collection yet.</div>'}`;

    panel.querySelectorAll('[data-pz]').forEach((b) => {
      const p = puzzles.find((x) => x.id === b.dataset.pz);
      const go = (e) => {
        if (!p) return;
        const tool = e.target.closest('[data-act]');
        if (tool) { e.stopPropagation(); if (o.onTool) o.onTool(tool.dataset.act, p); return; }
        currentId = p.id;
        paintPanel();
        if (o.onPick) o.onPick(p);
      };
      b.onclick = go;
      b.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        go(e);
      };
    });
  }

  function open(id) {
    openId = openId === id ? null : id;
    paintCards();
    paintPanel();
  }

  paintCards();
  paintPanel();

  return {
    update(next) {
      collections = (next.collections || []).slice();
      puzzles = (next.puzzles || []).slice();
      if (openId && !collections.some((c) => c.id === openId)) openId = null;
      paintCards();
      paintPanel();
    },
    /** Marks a puzzle as the one being played, wherever it is. */
    mark(id) { currentId = id; paintPanel(); },
    open,
    destroy() { host.innerHTML = ''; }
  };
}
