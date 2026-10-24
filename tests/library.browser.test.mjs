/* ═══════════════════════════════════════════════════════════════════════
   tests/library.browser.test.mjs — the puzzle library, driven in a real
   browser.

   puzzle-model.test.mjs covers the rules about difficulty, visibility and
   credit. This covers what those rules are for: the panel that draws them.

   The panel is handed its data rather than fetching any — a club reads its
   own collections, /library reads the mirror — so it can be tested with no
   Firestore at all, which is the whole reason it was written that way.

   What is actually being checked, and why each one is worth a test:
     · the right half is blank until a collection is picked. That is the
       behaviour that was asked for and it is one boolean away from being
       "show the first collection", which nobody would notice was wrong
     · picking a puzzle reports the puzzle, not the card
     · a member-made puzzle offers Adopt and a club puzzle does not
     · an anonymous author is replaced by their club, not by a blank

   Run it with:  node tests/library.browser.test.mjs
   Needs playwright's chromium:  npx playwright install chromium
   ═══════════════════════════════════════════════════════════════════════ */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel === '/' ? '/tests/fixture.html' : rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const FIRESTORE_NOISE = /firestore|WebChannel|transport errored|@firebase|ERR_|net::/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (FIRESTORE_NOISE.test(text)) return;   // no project to talk to, by design
  errors.push('console: ' + text);
});

await page.goto(`${base}/tests/fixture.html`, { waitUntil: 'networkidle' });

const out = await page.evaluate(async () => {
  const log = [];
  const say = (name, cond, extra) =>
    log.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });

  const M = await import('/assets/js/puzzle-model.js');
  const L = await import('/assets/js/puzzle-library.js');
  const P = await import('/assets/js/club-puzzles.js');

  say('library module loaded', typeof L.mountLibrary === 'function');

  /* Two shelves in two clubs, so the cross-club case is the normal case
     here rather than an afterthought. */
  const collections = [
    M.normalizeCollection({
      id: 'jags__endings', name: 'Endgames', description: 'Rook and pawn, mostly.',
      kind: 'staff', visibility: 'public', clubName: 'Jags', createdByName: 'Mr Lee',
      icon: '♜', color: '#58cc02'
    }),
    M.normalizeCollection({
      id: 'owls__made', name: 'Made by us', kind: 'custom', visibility: 'public',
      clubName: 'Night Owls', createdByName: 'Ada', anonymous: true
    })
  ];

  const puzzles = [
    M.normalizePuzzle({
      id: 'p1', title: 'Lucena', collectionId: 'jags__endings', points: 20, difficulty: 8.5,
      authorName: 'Mr Lee', clubName: 'Jags', fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      tree: { root: 'r', nodes: { r: { san: null, children: ['a'] }, a: { san: 'Kb1', children: [] } } }
    }),
    M.normalizePuzzle({
      id: 'p2', title: 'My first puzzle', collectionId: 'owls__made', points: 0, difficulty: 2,
      authorName: 'Ada', anonymous: true, clubName: 'Night Owls', custom: true,
      fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      tree: { root: 'r', nodes: { r: { san: null, children: ['a'] }, a: { san: 'Kb1', children: [] } } }
    })
  ];

  const host = document.createElement('div');
  document.body.appendChild(host);

  let picked = null;
  let tooled = null;
  const lib = L.mountLibrary(host, {
    title: 'Puzzle library',
    showClub: true,
    onPick: (p) => { picked = p; },
    tools: (p) => (p.custom ? [{ action: 'adopt', label: 'Adopt', kind: 'primary' }] : []),
    onTool: (action, p) => { tooled = action + ':' + p.id; }
  });

  const q = (sel) => host.querySelector(sel);
  const all = (sel) => [...host.querySelectorAll(sel)];

  // ── nothing loaded yet ────────────────────────────────────────────
  say('panel drawn', !!q('.pzlib'));
  say('both halves exist', !!q('.pzlib-cards') && !!q('.pzlib-panel'));
  say('empty shelves say so', /No collections yet/.test(q('.pzlib-cards').textContent),
    q('.pzlib-cards').textContent.trim());

  lib.update({ collections, puzzles });

  // ── the shelves ───────────────────────────────────────────────────
  say('one card per collection', all('.pzlib-card').length === 2, all('.pzlib-card').length);
  say('counted what is on each', /1 puzzle/.test(all('.pzlib-card')[0].textContent),
    all('.pzlib-card')[0].textContent.trim());
  say('the club is named on the card', /Jags/.test(all('.pzlib-card')[0].textContent));
  say('a members-can-add shelf is marked', /Custom/.test(all('.pzlib-card')[1].textContent));

  // ── the right half stays blank until asked ────────────────────────
  say('right half is blank to start', !!q('.pzlib-blank'));
  say('and says what to do', /Pick a collection/.test(q('.pzlib-panel').textContent));
  say('no puzzles drawn yet', all('.pzlib-row').length === 0);

  // ── picking a shelf ───────────────────────────────────────────────
  all('.pzlib-card')[0].click();
  say('the blank is gone', !q('.pzlib-blank'));
  say('the shelf is named', /Endgames/.test(q('.pzlib-panel-head').textContent));
  say('its description shows', /Rook and pawn/.test(q('.pzlib-panel').textContent));
  say('only its own puzzles', all('.pzlib-row').length === 1, all('.pzlib-row').length);
  say('the puzzle is named', /Lucena/.test(q('.pzlib-row').textContent));
  say('the shelf is marked open', all('.pzlib-card')[0].classList.contains('on'));

  // ── what a card says ──────────────────────────────────────────────
  say('difficulty shown out of ten', /8\.5/.test(q('.pz-diff').textContent), q('.pz-diff').textContent);
  say('and banded by how hard', q('.pz-diff').classList.contains('is-brutal'),
    q('.pz-diff').className);
  say('points shown', /20 pts/.test(q('.pzlib-row-meta').textContent),
    q('.pzlib-row-meta').textContent.trim());
  say('author credited', /Mr Lee/.test(q('.pzlib-row .pz-by').textContent));
  say('with the club beside them', /Jags/.test(q('.pzlib-row .pz-by').textContent));
  say('a club puzzle offers no Adopt', !q('.pzlib-row [data-act]'));

  // ── picking a puzzle ──────────────────────────────────────────────
  q('.pzlib-row').click();
  say('the puzzle came back, not the card', picked && picked.id === 'p1',
    picked && picked.id);
  say('and it is marked as the one being played', q('.pzlib-row').classList.contains('on'));

  // ── the other shelf: members' own work ────────────────────────────
  all('.pzlib-card')[1].click();
  say('switched shelves', /My first puzzle/.test(q('.pzlib-panel').textContent));
  say('a member-made puzzle offers Adopt', !!q('.pzlib-row [data-act="adopt"]'));
  say('and is worth no points', /no points/.test(q('.pzlib-row-meta').textContent),
    q('.pzlib-row-meta').textContent.trim());
  say('an anonymous author is not named', !/Ada/.test(q('.pzlib-row .pz-by').textContent),
    q('.pzlib-row .pz-by').textContent.trim());
  say('the club stands in for them', /Night Owls/.test(q('.pzlib-row .pz-by').textContent));
  say('and reads as one sentence with a dot',
    q('.pzlib-row .pz-by').textContent.replace(/\s+/g, ' ').trim() === 'Anonymous · Night Owls',
    q('.pzlib-row .pz-by').textContent.replace(/\s+/g, ' ').trim());
  say('with nothing dressed up as a pill', !q('.pz-by-club'));
  say('the shelf itself is anonymous too', !/Ada/.test(q('.pzlib-panel-head').textContent));

  /* A shelf nobody is recorded as having made is not anonymous — nobody
     chose to be unnamed. Saying so would claim something never true. */
  lib.update({
    collections: collections.concat([M.normalizeCollection({
      id: 'orphan', name: 'Filed by nobody', visibility: 'public', clubName: 'Jags'
    })]),
    puzzles
  });
  all('.pzlib-card').find((c) => /Filed by nobody/.test(c.textContent)).click();
  say('a shelf with no recorded maker is not called Anonymous',
    !/Anonymous/.test(q('.pzlib-panel-head').textContent),
    q('.pzlib-panel-head').textContent.replace(/\s+/g, ' ').trim());
  say('its club still stands in for it', /Jags/.test(q('.pzlib-panel-head').textContent));
  say('the default shelf carries no chip repeating its own name',
    !all('.pzlib-card').some((c) => /Custom\s*Custom/.test(c.textContent.replace(/\s+/g, ' '))));
  lib.update({ collections, puzzles });
  all('.pzlib-card')[1].click();

  /* Adopt must not also open the puzzle: the admin pressing it is taking
     the puzzle away, not sitting down to solve it. */
  picked = null;
  q('.pzlib-row [data-act="adopt"]').click();
  say('Adopt reports the tool', tooled === 'adopt:p2', tooled);
  say('and does not open the puzzle', picked === null, picked && picked.id);

  // ── clicking the open shelf again closes it ───────────────────────
  all('.pzlib-card')[1].click();
  say('a second click puts the blank back', !!q('.pzlib-blank'));

  // ── searching the shelves ─────────────────────────────────────────
  const search = q('[data-q]');
  search.value = 'owls';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  say('search narrows the shelves', all('.pzlib-card').length === 1, all('.pzlib-card').length);
  say('and matches on the club name', /Made by us/.test(q('.pzlib-card').textContent));
  search.value = 'nothing at all';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  say('no matches says so', /Nothing matches/.test(q('.pzlib-cards').textContent));
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  say('clearing brings them back', all('.pzlib-card').length === 2);

  // ── a shelf that goes away takes its panel with it ────────────────
  all('.pzlib-card')[0].click();
  say('open again', !q('.pzlib-blank'));
  lib.update({ collections: [collections[1]], puzzles });
  say('a deleted shelf closes its panel', !!q('.pzlib-blank'));
  say('and is gone from the list', all('.pzlib-card').length === 1);

  lib.destroy();
  say('destroyed cleanly', host.innerHTML === '');

  // ── the member's page draws the library under the board ───────────
  {
    const wiz = document.createElement('div');
    document.body.appendChild(wiz);
    // Firestore is unreachable here; the layout is drawn before it answers.
    P.renderPuzzles({ clubId: 'smoke', isAdmin: false, mode: 'member',
      user: { uid: 'u1' }, member: { username: 'Ada' }, club: { name: 'Smoke' } }, wiz, {});
    await new Promise((r) => setTimeout(r, 250));

    say('the board and the list are still there', !!wiz.querySelector('.puzzle-layout'));
    say('an empty club still gets a board', !!wiz.querySelector('.pz-idle .board-b72b1'));
    say('with the pieces where they start',
      !!wiz.querySelector('.pz-idle .square-e1 .piece-417db'));
    say('and it says why it is not playable',
      /waiting for one/.test(wiz.querySelector('.pz-idle-note').textContent),
      wiz.querySelector('.pz-idle-note').textContent);
    say('the list beside it is pinned to the board’s height',
      !!wiz.querySelector('#pz-side'));
    say('a library box sits under them',
      !!wiz.querySelector('.puzzle-layout + .pzlib-tile'));
    say('it is the full width, not a third',
      getComputedStyle(wiz.querySelector('.pzlib-tile')).gridColumn !== '2');
    say('and a member is offered a puzzle of their own',
      !!wiz.querySelector('#pz-make'));
    say('which is refused while there is nowhere to put it',
      wiz.querySelector('#pz-make').disabled);
  }

  // ── an admin gets the shelves and the adopt route ─────────────────
  {
    const wiz = document.createElement('div');
    document.body.appendChild(wiz);
    P.renderPuzzles({ clubId: 'smoke', isAdmin: true, mode: 'admin',
      user: { uid: 'u1' }, member: { username: 'Mr Lee' }, club: { name: 'Smoke' } }, wiz, {});
    await new Promise((r) => setTimeout(r, 250));

    say('the collections tile is there', !!wiz.querySelector('.pz-colls'));
    say('published still sits under the builder',
      !!wiz.querySelector('.pz-admin > .pz-build + .pz-published'));
    /* The library tile is gone: it drew the same shelves the Collections
       tile already lists, so the shelves open in place instead. */
    say('and no second library tile under it', !wiz.querySelector('.pz-admin > .pzlib-tile'));
    say('collections is the last tile',
      wiz.querySelector('.pz-admin').lastElementChild.classList.contains('pz-colls'));
    say('a collection can be started', !!wiz.querySelector('[data-new]'));
    say('and the shelf every club keeps is named up front',
      /Custom/.test(wiz.querySelector('.pz-colls-note').textContent),
      wiz.querySelector('.pz-colls-note').textContent);

    wiz.querySelector('[data-new]').click();
    await new Promise((r) => setTimeout(r, 60));
    say('the form opens', !!wiz.querySelector('.pz-coll-form'));
    say('with both switches on it',
      !!wiz.querySelector('[data-kind]') && !!wiz.querySelector('.pz-coll-form [data-vis]'));
    say('staff-only is the default',
      wiz.querySelector('[data-kind] [data-k="staff"]').classList.contains('on'));
    say('and club-only is the default',
      wiz.querySelector('.pz-coll-form [data-vis] [data-v="club"]').classList.contains('on'));

    wiz.querySelector('[data-kind] [data-k="custom"]').click();
    say('members-can-add sticks',
      wiz.querySelector('[data-kind] [data-k="custom"]').classList.contains('on'));
    say('and explains itself',
      /Any member/.test(wiz.querySelector('[data-kind-hint]').textContent),
      wiz.querySelector('[data-kind-hint]').textContent);

    wiz.querySelector('.pz-coll-form [data-vis] [data-v="public"]').click();
    say('sharing explains what it takes with it',
      /every puzzle in it/.test(wiz.querySelector('[data-vis-hint]').textContent),
      wiz.querySelector('[data-vis-hint]').textContent);
  }


  /* ── the details step, which is where all three builders differ ────
     A seed with `asNew` drops the wizard straight onto step four, which
     is the only part that changes between an admin publishing, a member
     building their own, and an admin adopting one. */
  {
    const staffColl = M.normalizeCollection({
      id: 'endings', name: 'Endgames', kind: 'staff', visibility: 'public'
    });
    const shutColl = M.normalizeCollection({
      id: 'secret', name: 'Club only', kind: 'staff', visibility: 'club'
    });
    const openColl = M.normalizeCollection({
      id: 'made', name: 'Made by us', kind: 'custom', visibility: 'public'
    });

    const seed = M.normalizePuzzle({
      id: 'seedy', title: 'Lucena', description: 'A rook ending.', points: 20,
      difficulty: 8.5, playerColor: 'w', fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      tree: { root: 'r', nodes: { r: { san: null, children: ['a'] }, a: { san: 'Kb1', children: [] } } }
    });

    const ctxOf = () => ({
      clubId: 'smoke', isAdmin: true, mode: 'admin',
      user: { uid: 'u1' }, member: { username: 'Mr Lee' }, club: { id: 'smoke', name: 'Smoke' }
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sheet = () => document.querySelector('.pz-build-modal');
    const inSheet = (sel) => sheet().querySelector(sel);

    // ── an admin, with everything switched on ──────────────────────
    {
      const h = P.openBuilderModal(ctxOf(), {
        mode: 'staff', club: () => ({ id: 'smoke', name: 'Smoke' }),
        collections: () => [staffColl, shutColl], seed
      });
      await wait(200);

      say('the builder opens in a sheet', !!sheet());
      say('and lands on the details', !!inSheet('#pzd-title'));
      say('carrying the seeded title', inSheet('#pzd-title').value === 'Lucena',
        inSheet('#pzd-title').value);

      say('difficulty is asked for', !!inSheet('#pzd-diff'));
      say('out of ten, to one decimal',
        inSheet('#pzd-diff').max === '10' && inSheet('#pzd-diff').step === '0.1',
        inSheet('#pzd-diff').max + '/' + inSheet('#pzd-diff').step);
      say('seeded from the puzzle', Number(inSheet('#pzd-diff').value) === 8.5,
        inSheet('#pzd-diff').value);
      say('and written out beside it', /8\.5 \/ 10/.test(inSheet('[data-diff-out]').textContent),
        inSheet('[data-diff-out]').textContent);
      say('with a word for the number', /Brutal/i.test(inSheet('[data-diff-hint]').textContent),
        inSheet('[data-diff-hint]').textContent);

      inSheet('#pzd-diff').value = '1.2';
      inSheet('#pzd-diff').dispatchEvent(new Event('input', { bubbles: true }));
      say('moving it updates the reading', /1\.2 \/ 10/.test(inSheet('[data-diff-out]').textContent),
        inSheet('[data-diff-out]').textContent);
      say('and the summary', /1\.2 \/ 10/.test(inSheet('[data-sum-diff]').textContent));
      say('and the word with it', /Easy/i.test(inSheet('[data-diff-hint]').textContent),
        inSheet('[data-diff-hint]').textContent);
      say('the midpoint reads as neutral, not as hard',
        (() => {
          inSheet('#pzd-diff').value = '5';
          inSheet('#pzd-diff').dispatchEvent(new Event('input', { bubbles: true }));
          return /Moderate/i.test(inSheet('[data-diff-hint]').textContent);
        })(), inSheet('[data-diff-hint]').textContent);

      say('an admin may file it, or not',
        [...inSheet('#pzd-coll').options].some((o) => o.value === ''), inSheet('#pzd-coll').innerHTML);
      say('both shelves offered', inSheet('#pzd-coll').options.length === 3,
        inSheet('#pzd-coll').options.length);

      say('an admin gets the visibility switch', !!inSheet('[data-visseg]'));
      say('club-only to begin with',
        inSheet('[data-visseg] [data-v="club"]').classList.contains('on'));
      inSheet('[data-visseg] [data-v="public"]').click();
      say('sharing sticks', inSheet('[data-visseg] [data-v="public"]').classList.contains('on'));
      say('and the summary agrees', /everyone/.test(inSheet('[data-sum-vis]').textContent),
        inSheet('[data-sum-vis]').textContent);

      // the cascade: a club-only shelf takes the switch away
      inSheet('#pzd-coll').value = 'secret';
      inSheet('#pzd-coll').dispatchEvent(new Event('change', { bubbles: true }));
      say('a club-only shelf disables the switch',
        inSheet('[data-visseg] [data-v="public"]').disabled);
      say('and forces club-only', inSheet('[data-visseg] [data-v="club"]').classList.contains('on'));
      say('the summary follows', /this club/.test(inSheet('[data-sum-vis]').textContent),
        inSheet('[data-sum-vis]').textContent);
      say('and it says the choice is kept',
        /comes back/.test(inSheet('[data-vis-hint]').textContent),
        inSheet('[data-vis-hint]').textContent);

      // ...and gives it straight back
      inSheet('#pzd-coll').value = 'endings';
      inSheet('#pzd-coll').dispatchEvent(new Event('change', { bubbles: true }));
      say('reopening gives the switch back', !inSheet('[data-visseg] [data-v="public"]').disabled);
      say('with the answer it had',
        inSheet('[data-visseg] [data-v="public"]').classList.contains('on'));

      say('anonymous mode is offered', !!inSheet('#pzd-anon'));
      say('and is off by default', !inSheet('#pzd-anon').checked);
      say('points are an admin’s to set', !!inSheet('#pzd-points'));
      say('no prize section without an adoption', !inSheet('#pzd-prize'));
      h.close();
      await wait(80);
      say('the sheet closes', !sheet());
    }

    // ── a member, building their own ───────────────────────────────
    {
      const h = P.openBuilderModal({ ...ctxOf(), isAdmin: false, mode: 'member' }, {
        mode: 'student', club: () => ({ id: 'smoke', name: 'Smoke' }),
        collections: () => [staffColl, openColl], seed
      });
      await wait(200);

      say('a member gets the same wizard', !!inSheet('#pzd-title'));
      say('and the same difficulty', !!inSheet('#pzd-diff'));
      say('but no points box', !inSheet('#pzd-points'));
      say('and no due date', !inSheet('#pzd-expiry'));
      say('which is explained rather than just missing',
        /worth no points/.test(sheet().textContent));
      say('and no visibility switch of their own', !inSheet('[data-visseg]'));
      say('because the shelf decides', /decided by the collection/.test(sheet().textContent));

      const opts = [...inSheet('#pzd-coll').options].map((o) => o.value);
      say('only shelves that take members’ puzzles', opts.length === 1 && opts[0] === 'made',
        opts.join(','));
      say('and one is chosen for them', inSheet('#pzd-coll').value === 'made',
        inSheet('#pzd-coll').value);
      say('they can still ask to be anonymous', !!inSheet('#pzd-anon'));
      say('the summary shows it is worth nothing',
        /no points/.test(inSheet('[data-sum-full]').textContent),
        inSheet('[data-sum-full]').textContent);
      h.close();
      await wait(80);
    }

    // ── an admin adopting a member's puzzle ────────────────────────
    {
      const theirs = M.normalizePuzzle({
        id: 'theirs', title: 'My first puzzle', points: 0, custom: true, difficulty: 3,
        authorUid: 'u9', authorName: 'Ada', collectionId: 'made', playerColor: 'w',
        fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
        tree: { root: 'r', nodes: { r: { san: null, children: ['a'] }, a: { san: 'Kb1', children: [] } } }
      });

      P.adoptPuzzle(ctxOf(), theirs, {
        collections: () => [staffColl, openColl], club: () => ({ id: 'smoke', name: 'Smoke' })
      });
      await wait(200);

      say('adopting opens the builder', !!inSheet('#pzd-title'));
      say('with their board and their title', inSheet('#pzd-title').value === 'My first puzzle',
        inSheet('#pzd-title').value);
      say('it says whose it was', /Adopted from Ada/.test(sheet().textContent));
      say('the adopter gets points back', !!inSheet('#pzd-points'));
      say('and a prize to pay', !!inSheet('#pzd-prize'));
      say('which the summary totals',
        /10 pts/.test(inSheet('[data-sum-prize]').textContent),
        inSheet('[data-sum-prize]').textContent);

      inSheet('#pzd-prize').value = '40';
      inSheet('#pzd-prize').dispatchEvent(new Event('input', { bubbles: true }));
      say('changing the prize is reflected',
        /40 pts/.test(inSheet('[data-sum-prize]').textContent),
        inSheet('[data-sum-prize]').textContent);

      say('it is filed nowhere until the adopter says so', inSheet('#pzd-coll').value === '',
        inSheet('#pzd-coll').value);
      say('and publishing reads as adopting',
        /Adopt and publish/.test(inSheet('[data-publish]').textContent),
        inSheet('[data-publish]').textContent);

      /* An anonymous member must not be named on the sheet an admin is
         reading, or anonymity is only skin deep. */
      sheet().querySelector('[data-x]').click();
      await wait(80);

      P.adoptPuzzle(ctxOf(), M.normalizePuzzle({ ...theirs, anonymous: true }), {
        collections: () => [openColl], club: () => ({ id: 'smoke', name: 'Smoke' })
      });
      await wait(200);
      say('an anonymous author is not named to the adopter either',
        !/Ada/.test(sheet().textContent));
      say('but the adoption is still explained',
        /asked not to be named/.test(sheet().textContent));
      sheet().querySelector('[data-x]').click();
      await wait(80);
      say('closed', !sheet());
    }
  }


  /* ── promoting a pawn ──────────────────────────────────────────────
     A pawn reaching the back rank was silently made a queen, so a puzzle
     whose answer is an underpromotion could not be recorded, let alone
     solved. These two are the whole of the fix, and both are easy to get
     subtly wrong: the detection has to fire on the pawn's colour rather
     than on whose turn it is, and the picker has to be answerable without
     a mouse. */
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = new window.Chess('4k3/P6p/8/8/8/8/7p/4K3 w - - 0 1');

    say('a pawn stepping onto the eighth is a promotion', P.isPromotion(g, 'a7', 'a8'));
    say('a pawn that is not there is not', !P.isPromotion(g, 'b7', 'b8'));
    say('an ordinary pawn move is not', !P.isPromotion(g, 'a7', 'a7'));
    say('the king walking up is not', !P.isPromotion(g, 'e1', 'e2'));

    const black = new window.Chess('4k3/8/8/8/8/8/7p/4K3 b - - 0 1');
    say('and black promotes on the first rank', P.isPromotion(black, 'h2', 'h1'));
    say('not on the eighth', !P.isPromotion(black, 'h2', 'h8'));

    // ── the picker answers a click ──
    let picked = P.askPromotion('w');
    await wait(60);
    const card = document.querySelector('.pz-promo');
    say('the picker opens', !!card);
    say('all four pieces are offered', card.querySelectorAll('[data-p]').length === 4,
      card.querySelectorAll('[data-p]').length);
    say('showing the right colour',
      /wQ\.png$/.test(card.querySelector('[data-p="q"] img').getAttribute('src')),
      card.querySelector('[data-p="q"] img').getAttribute('src'));
    card.querySelector('[data-p="n"]').click();
    say('a click answers with that piece', (await picked) === 'n');
    await wait(40);
    say('and closes it', !document.querySelector('.pz-promo'));

    // ── and a keystroke ──
    picked = P.askPromotion('b');
    await wait(60);
    say('black is offered black pieces',
      /bR\.png$/.test(document.querySelector('[data-p="r"] img').getAttribute('src')));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    say('a keystroke answers too', (await picked) === 'r');

    // ── backing out leaves the pawn alone ──
    picked = P.askPromotion('w');
    await wait(60);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    say('escaping chooses nothing', (await picked) === null);
    say('and leaves nothing behind', !document.querySelector('.pz-promo'));
  }

  /* ── looking around the move chart ─────────────────────────────────
     The chart is a viewport now rather than a scroll box. What is worth
     checking is not the maths but the thing that makes it usable: the
     view has to survive a repaint, because every recorded move repaints,
     and a chart that jumped home after each move would be unusable. */
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const wiz = document.createElement('div');
    document.body.appendChild(wiz);
    P.renderPuzzles({ clubId: 'smoke', isAdmin: true, mode: 'admin',
      user: { uid: 'u1' }, member: { username: 'Mr Lee' }, club: { id: 'smoke', name: 'Smoke' } }, wiz, {});
    await wait(260);

    const q = (s) => wiz.querySelector(s);
    q('[data-pick="w"]').click();
    await wait(200);
    q('[data-confirm]').click();
    await wait(300);

    const centre = (sq) => {
      const b = wiz.querySelector('.square-' + sq).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const play = async (from, to) => {
      const a = centre(from);
      const z = centre(to);
      const piece = wiz.querySelector('.square-' + from + ' .piece-417db');
      if (!piece) return false;
      const fire = (t, ty, pt) => t.dispatchEvent(new MouseEvent(ty,
        { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, buttons: 1 }));
      fire(piece, 'mousedown', a);
      fire(document, 'mousemove', { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 });
      fire(document, 'mousemove', z);
      fire(document, 'mouseup', z);
      await wait(250);
      return true;
    };

    await play('e2', 'e4');
    say('the chart draws', !!q('[data-stage]'));
    say('with zoom controls on it', !!q('.pz-flow-zoom'));
    say('and it is a viewport, not a scroll box',
      getComputedStyle(q('[data-flow]')).overflow === 'hidden',
      getComputedStyle(q('[data-flow]')).overflow);
    say('the first chart is fitted for you',
      q('[data-stage]').style.transform.indexOf('scale') !== -1,
      q('[data-stage]').style.transform);

    q('[data-zoom-in]').click();
    const zoomed = q('[data-stage]').style.transform;
    say('zooming in changes the scale', /scale\(1\.25\)/.test(zoomed), zoomed);
    say('and says so', q('[data-zoom-label]').textContent === '125%',
      q('[data-zoom-label]').textContent);

    /* The one that matters: another move repaints the chart, and the view
       must still be where it was left. */
    await play('e7', 'e5');
    say('the view survives a repaint', q('[data-stage]').style.transform === zoomed,
      q('[data-stage]').style.transform + ' vs ' + zoomed);
    say('and the new move is on it', wiz.querySelectorAll('.pz-node:not(.is-root)').length === 2);

    q('[data-zoom-out]').click();
    q('[data-zoom-out]').click();
    say('zooming out goes back down', /scale\(0\.8\)/.test(q('[data-stage]').style.transform),
      q('[data-stage]').style.transform);

    q('[data-zoom-fit]').click();
    say('Fit puts it back on screen', q('[data-zoom-label]').textContent === '100%',
      q('[data-zoom-label]').textContent);

    /* Dragging the background pans; dragging a move does not, because
       that is a click on the move. */
    const flow = q('[data-flow]');
    const before = q('[data-stage]').style.transform;
    const box = flow.getBoundingClientRect();
    const pt = (x, y) => ({ clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
    flow.dispatchEvent(new PointerEvent('pointerdown', pt(box.left + 8, box.bottom - 80)));
    flow.dispatchEvent(new PointerEvent('pointermove', pt(box.left + 68, box.bottom - 40)));
    flow.dispatchEvent(new PointerEvent('pointerup', pt(box.left + 68, box.bottom - 40)));
    say('dragging the background pans', q('[data-stage]').style.transform !== before,
      q('[data-stage]').style.transform);

    const held = q('[data-stage]').style.transform;
    const node = wiz.querySelector('.pz-node:not(.is-root)');
    node.dispatchEvent(new PointerEvent('pointerdown', { ...pt(box.left + 40, box.top + 40), bubbles: true }));
    flow.dispatchEvent(new PointerEvent('pointermove', pt(box.left + 140, box.top + 140)));
    flow.dispatchEvent(new PointerEvent('pointerup', pt(box.left + 140, box.top + 140)));
    say('but dragging a move does not', q('[data-stage]').style.transform === held,
      q('[data-stage]').style.transform + ' vs ' + held);
  }

  return log;
});

await browser.close();
server.close();

let pass = 0, fail = 0;
for (const r of out) {
  if (r.ok) pass++;
  else { fail++; console.log('  FAIL:', r.name, r.extra); }
}
for (const e of errors) { fail++; console.log('  FAIL:', e); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
