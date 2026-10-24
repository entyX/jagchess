/* ═══════════════════════════════════════════════════════════════════════
   tests/puzzles.browser.test.mjs — the puzzle block, driven in a real
   browser with the real vendor scripts.

   puzzle-model.test.mjs covers the graph. This covers everything the graph
   cannot: chessboard.js, the drag that reaches the drop handler, the wizard
   moving between its four steps, and the modal that counts the points up.
   Firestore is never reached — the page is given a throwaway config and the
   snapshot listener is simply left to fail, because every screen here is
   drawn before it would have answered.

   Drags are real: mousedown on the piece, mousemove across the board,
   mouseup on the target. That is the only way into the drop handler, and the
   drop handler is the whole solver.

   Run it with:  node tests/puzzles.browser.test.mjs
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

/* The page has to come off an http origin, not about:blank — a module
   import from a blank document is a cross-origin fetch and is refused. */
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

const out = await page.evaluate(async (base) => {
  const log = [];
  const say = (name, cond, extra) => log.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });

  const M = await import('/assets/js/puzzle-model.js');
  const P = await import('/assets/js/club-puzzles.js');

  say('chess.js global', typeof window.Chess === 'function');
  say('chessboard global', typeof window.Chessboard === 'function');
  say('model loaded', typeof M.addMove === 'function');
  say('puzzles module loaded', typeof P.mountSolver === 'function');

  // ── a puzzle built the way the builder builds one ────────────────
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let t = M.normalizeTree(null), r;
  r = M.addMove(t, M.ROOT, 'e4');  t = r.tree; const n1 = r.id;
  r = M.addMove(t, n1, 'e5');      t = r.tree; const n2 = r.id;
  r = M.addMove(t, n2, 'Qh5');     t = r.tree;
  r = M.addMove(t, n2, 'Nf3');     t = r.tree;   // a second good move

  const puzzle = M.normalizePuzzle({
    id: 'p1', title: 'Smoke', fen: START, playerColor: 'w', points: 25,
    expiresAt: 0, latePenaltyPct: 40, tree: { root: t.root, nodes: t.nodes }
  });
  say('two branches', puzzle.stats.branches === 2, puzzle.stats.branches);
  // e4 then Qh5 (or Nf3) — the player finds two of the three moves
  say('two moves to find', puzzle.stats.moves === 2, puzzle.stats.moves);

  // ── the solver renders and accepts the right move ────────────────
  const mount = document.getElementById('host');
  let solvedWith = null;
  const solver = P.mountSolver({
    mount, puzzle, practice: true,
    onSolved: (res) => { solvedWith = res; }
  });

  say('board rendered', !!mount.querySelector('.chessboard .board-b72b1'));
  say('one dot per move to find', mount.querySelectorAll('.pzs-dot').length === 2,
    mount.querySelectorAll('.pzs-dot').length);
  say('color chip', /White to play/.test(mount.querySelector('.pzs-chip').textContent));
  // the icon footer is the preview's arrangement only
  say('member page keeps the worded Restart',
    mount.querySelector('[data-restart]').textContent.trim() === 'Restart',
    mount.querySelector('[data-restart]').textContent.trim());
  say('and shows no source icon beside it', !mount.querySelector('.pzs-foot a'));

  say('e4 is a known child', M.childByMove(puzzle.tree, M.ROOT, 'e4') !== null);
  say('d4 is not', M.childByMove(puzzle.tree, M.ROOT, 'd4') === null);

  /* A real drag, the way chessboard.js receives one: mousedown on the piece,
     mousemove across the board, mouseup over the target square. This is the
     only way to reach the drop handler, and the drop handler is the whole
     solver. */
  const centre = (sq) => {
    const cell = mount.querySelector('.square-' + sq);
    const b = cell.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  };
  const drag = async (from, to) => {
    const a = centre(from), b = centre(to);
    const piece = mount.querySelector('.square-' + from + ' .piece-417db');
    if (!piece) return false;
    const fire = (target, type, pt) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, buttons: 1
    }));
    fire(piece, 'mousedown', a);
    fire(document, 'mousemove', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    fire(document, 'mousemove', b);
    fire(document, 'mouseup', b);
    await new Promise((r2) => setTimeout(r2, 120));
    return true;
  };

  say('squares are addressable', !!mount.querySelector('.square-e2'));

  // a move the puzzle does not want is refused and the board stays put
  await drag('d2', 'd4');
  say('wrong move rejected', /Not the move/.test(mount.querySelector('.pzs-status').textContent),
    mount.querySelector('.pzs-status').textContent);
  say('wrong move leaves no dot filled', mount.querySelectorAll('.pzs-dot.on').length === 0);
  say('wrong move explained', /not what this puzzle is looking for/.test(mount.textContent));

  // the move it does want advances, and the reply comes back on its own
  await drag('e2', 'e4');
  say('right move accepted', mount.querySelectorAll('.pzs-dot.on').length === 1,
    mount.querySelectorAll('.pzs-dot.on').length);
  await new Promise((r2) => setTimeout(r2, 700));
  say('opponent replied with e5', !!mount.querySelector('.square-e5 .piece-417db'));
  say('prompted for the next move', /Your move/.test(mount.querySelector('.pzs-status').textContent),
    mount.querySelector('.pzs-status').textContent);

  // finishing it fires onSolved exactly once
  await drag('d1', 'h5');
  say('solve reported', !!solvedWith, JSON.stringify(solvedWith));
  say('solve counted two moves', solvedWith && solvedWith.moves === 2, solvedWith && solvedWith.moves);
  say('solve timed', solvedWith && typeof solvedWith.seconds === 'number');
  say('board says solved', /Solved/.test(mount.querySelector('.pzs-status').textContent));

  solver.destroy();
  say('solver destroy clean', true);

  // ── the celebrate modal animates and counts ──────────────────────
  const score = M.scoreFor({ points: 25, expiresAt: 1, latePenaltyPct: 33 }, 2);
  say('late score truncates', score.points === 16, score.points);

  const win = P.celebrate({ score, seconds: 95, moves: 3 });
  const card = document.querySelector('.pz-win');
  say('win modal in the document', !!card);
  await new Promise((r2) => setTimeout(r2, 60));
  say('win modal eased in', card.classList.contains('is-in'));
  say('time reads properly', /1 minute 35 seconds/.test(card.textContent), card.querySelector('[data-time]').textContent);
  say('late notice shown', /33% came off/.test(card.textContent));

  await new Promise((r2) => setTimeout(r2, 2400));
  const counted = card.querySelector('[data-count]').textContent;
  say('points counted up to the total', counted === '+16', counted);
  win.close();

  // ── the preview modal opens on a real puzzle ─────────────────────
  const prev = P.openPuzzlePreview({
    id: 'p1', title: 'Smoke', fen: START, playerColor: 'b', points: 5,
    source: 'lichess.org/training/9', tree: { root: t.root, nodes: t.nodes }
  });
  const pv = document.querySelector('.pz-preview');
  say('preview opened', !!pv);
  say('preview says nothing is awarded', /nothing is awarded/.test(pv.textContent));
  /* Both of the preview's controls live in the footer, as icons: the head is
     already carrying the title and the close. */
  const foot = pv.querySelector('.pzs-foot');
  const srcBtn = pv.querySelector('a[href="https://lichess.org/training/9"]');
  const restartBtn = pv.querySelector('[data-restart]');
  say('source button rendered', !!srcBtn);
  say('source sits in the footer', !!srcBtn && srcBtn.closest('.pzs-foot') === foot);
  say('restart sits beside it', !!restartBtn && restartBtn.closest('.pzs-foot') === foot);
  say('source is not in the head', !pv.querySelector('.pz-preview-head a'));
  say('both are icons, not words',
    !!srcBtn && !!restartBtn && !srcBtn.textContent.trim() && !restartBtn.textContent.trim(),
    JSON.stringify((srcBtn ? srcBtn.textContent : '') + '|' + (restartBtn ? restartBtn.textContent : '')).slice(0, 60));
  say('both carry an svg', !!srcBtn.querySelector('svg') && !!restartBtn.querySelector('svg'));
  say('source tooltip reads Source', srcBtn.getAttribute('data-tip') === 'Source',
    srcBtn.getAttribute('data-tip'));
  say('restart tooltip reads Restart', restartBtn.getAttribute('data-tip') === 'Restart',
    restartBtn.getAttribute('data-tip'));
  say('both are labelled for screen readers',
    srcBtn.getAttribute('aria-label') === 'Source' && restartBtn.getAttribute('aria-label') === 'Restart');
  say('the source opens in a new tab',
    srcBtn.target === '_blank' && /noopener/.test(srcBtn.rel), srcBtn.rel);
  /* The bug this replaces: chessboard.js parks the piece you are dragging
     on <body> with no z-index, so inside a modal it vanished behind the
     overlay and the move looked like a teleport. */
  {
    const sq = (name) => pv.querySelector('.square-' + name);
    const box = (elm) => elm.getBoundingClientRect();
    const from = sq('e7');                      // black is solving here
    say('preview board is playable', !!from && !!from.querySelector('.piece-417db'));

    const a = box(from);
    const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    const mid = { x: start.x + 4, y: start.y - 60 };
    const fire = (t2, type, pt) => t2.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, buttons: 1
    }));

    fire(from.querySelector('.piece-417db'), 'mousedown', start);
    fire(document, 'mousemove', mid);
    await new Promise((r2) => setTimeout(r2, 60));

    const ghost = [...document.body.children].find((c) =>
      c.classList && c.classList.contains('piece-417db') &&
      getComputedStyle(c).display !== 'none');
    say('a dragged piece exists', !!ghost);

    if (ghost) {
      const gs = getComputedStyle(ghost);
      const modalZ = Number(getComputedStyle(document.querySelector('.pz-preview')).zIndex) || 0;
      say('the dragged piece is visible', gs.display !== 'none' && gs.visibility !== 'hidden',
        gs.display + '/' + gs.visibility);
      say('and sits above the modal', Number(gs.zIndex) > modalZ,
        gs.zIndex + ' vs ' + modalZ);
      say('it follows the cursor', Math.abs(box(ghost).top + box(ghost).height / 2 - mid.y) < 40,
        box(ghost).top.toFixed(0) + ' vs ' + mid.y.toFixed(0));
      say('it does not swallow the mouse', gs.pointerEvents === 'none', gs.pointerEvents);
    }

    fire(document, 'mouseup', mid);
    await new Promise((r2) => setTimeout(r2, 200));
  }

  prev.close();
  say('preview closed', !document.querySelector('.pz-preview'));

  // ── shared helpers for driving a builder ─────────────────────────
  const newWizard = async () => {
    const wiz = document.createElement('div');
    document.body.appendChild(wiz);
    // Firestore is unreachable here; every screen is drawn before the
    // snapshot would have answered, which is the part being checked.
    P.renderPuzzles({ clubId: 'smoke', isAdmin: true, mode: 'admin',
      user: { uid: 'u1' }, member: {}, club: { name: 'Smoke' } }, wiz, {});
    await new Promise((r2) => setTimeout(r2, 250));
    const q = (sel) => wiz.querySelector(sel);
    const all = (sel) => [...wiz.querySelectorAll(sel)];
    const centre = (sq) => {
      const cell = wiz.querySelector('.square-' + sq);
      const b = cell.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const play = async (from, to) => {
      const a = centre(from), b = centre(to);
      const piece = wiz.querySelector('.square-' + from + ' .piece-417db');
      if (!piece) return false;
      const fire = (t2, type, pt) => t2.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, button: 0, buttons: 1
      }));
      fire(piece, 'mousedown', a);
      fire(document, 'mousemove', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      fire(document, 'mousemove', b);
      fire(document, 'mouseup', b);
      await new Promise((r3) => setTimeout(r3, 250));
      return true;
    };
    const wait = (ms) => new Promise((r3) => setTimeout(r3, ms));
    const moves = () => all('.pz-node:not(.is-root)');
    return { wiz, q, all, play, wait, moves };
  };

  // ── the builder wizard, step by step ─────────────────────────────
  {
    const { wiz, q, all, play, wait, moves } = await newWizard();

    say('wizard rendered', !!q('.pz-wiz'));
    say('builder is the full page', !!wiz.querySelector('.pz-admin'));
    say('published list sits under the builder',
      !!wiz.querySelector('.pz-admin > .pz-build + .pz-published'));
    say('four steps shown', all('.pz-step-pill').length === 4);
    const flat = () => wiz.textContent.replace(/\s+/g, ' ');
    say('step one reads Color, not Colour', flat().includes('Color'));
    say('no British spelling anywhere on the page', !/colour/i.test(flat()),
      (flat().match(/.{0,45}colour.{0,45}/i) || [''])[0]);
    say('colour cards offered', all('[data-pick]').length === 2);
    say('no board on step 1', !q('.chessboard'));

    // ── every step is on the rail, with the ones that cannot open yet
    //    saying why rather than going nowhere
    say('position step reachable from the start', !all('.pz-step-pill')[1].classList.contains('locked'));
    say('moves step locked until a position exists', all('.pz-step-pill')[2].classList.contains('locked'));
    say('details step locked too', all('.pz-step-pill')[3].classList.contains('locked'));
    say('locked step explains itself',
      /Set the starting position first/.test(all('.pz-step-pill')[2].textContent));

    all('.pz-step-pill')[2].click();
    await wait(150);
    say('clicking a locked step does not move', !!q('[data-pick]'));

    all('.pz-step-pill')[1].click();
    await wait(220);
    say('clicking Position on the rail works', !!q('[data-confirm]'));

    all('.pz-step-pill')[0].click();
    await wait(200);
    say('and back to Color', !!q('[data-pick]'));

    q('[data-pick="b"]').click();
    await wait(220);
    say('step 2 reached', !!q('[data-confirm]'));
    say('position board mounted', !!q('.chessboard .board-b72b1'));
    say('spare pieces shown', all('.spare-pieces-7492f .piece-417db').length > 0,
      all('.spare-pieces-7492f .piece-417db').length);
    say('board faces black', /Black is solving/.test(wiz.textContent));

    // ── the board is the whole width, and the controls sit under it
    say('setup is one column', !!q('.pz-setup'));
    const setupBoard = q('.pz-setup-board .board-b72b1');
    const setupTools = q('.pz-setup-foot .pz-stage-tools');
    say('tools are under the board',
      setupTools.getBoundingClientRect().top > setupBoard.getBoundingClientRect().bottom);
    say('every control is in that row',
      !!q('[data-standard]') && !!q('[data-clear]') && !!q('[data-fen]') && !!q('[data-confirm]'));
    say('confirm moved under the board too',
      q('[data-confirm]').closest('.pz-setup-foot') !== null);

    // ── the frame hugs the board, and only the board
    const frame = getComputedStyle(setupBoard).boxShadow;
    say('board carries its own frame', /rgb/.test(frame) && frame !== 'none', frame.slice(0, 40));
    const container = getComputedStyle(q('.pz-setup-board'));
    say('the box round the board carries no frame of its own',
      container.boxShadow === 'none', container.boxShadow);
    say('and no dark fill either',
      /rgba\(0, 0, 0, 0\)|transparent/.test(container.backgroundColor), container.backgroundColor);
    say('its padding only leaves room for the frame',
      parseFloat(container.paddingLeft) >= 7 && parseFloat(container.paddingLeft) <= 12,
      container.paddingLeft);
    const cBox = q('.pz-setup-board').getBoundingClientRect();
    const bBox = setupBoard.getBoundingClientRect();
    const leftGap = bBox.left - cBox.left;
    const rightGap = cBox.right - bBox.right;
    say('board is centred in its container', Math.abs(leftGap - rightGap) < 1.5,
      `left ${leftGap.toFixed(2)} right ${rightGap.toFixed(2)}`);
    say('spare pieces are outside the frame',
      q('.spare-pieces-7492f').getBoundingClientRect().top < bBox.top);

    // an empty board cannot be confirmed
    q('[data-clear]').click();
    await wait(140);
    q('[data-confirm]').click();
    await wait(160);
    say('empty board refused', !q('[data-err]').hidden, q('[data-err]').textContent);
    say('still on step 2', !!q('[data-confirm]'));

    q('[data-standard]').click();
    await wait(160);
    q('[data-confirm]').click();
    await wait(260);
    say('step 3 reached', !!q('[data-flow]'));
    say('flowchart starts with a prompt', /the first move appears here/.test(flat()), flat().slice(-160));
    say('black to move first', /Black to move/.test(wiz.textContent));

    // ── the moves board sits inside a tidy frame too
    const mBoard = q('.pz-stage-board .board-b72b1');
    const mWrap = q('.pz-stage-board .chessboard');
    const mb = mBoard.getBoundingClientRect();
    const mw = mWrap.getBoundingClientRect();
    say('moves board centred', Math.abs((mb.left - mw.left) - (mw.right - mb.right)) < 1.5,
      `${(mb.left - mw.left).toFixed(2)} vs ${(mw.right - mb.right).toFixed(2)}`);

    await play('e7', 'e6');
    say('move recorded with no button', moves().length === 1, moves().length);
    say('recorded move reads e6', /e6/.test(moves()[0].textContent), moves()[0].textContent.trim());
    say('a Start node anchors the chart', !!q('.pz-node.is-root'));
    say('last move flagged as the end', !!q('.pz-node-flag'));
    say('an edge was drawn', all('.pz-flow-edges path').length === 1,
      all('.pz-flow-edges path').length);
    say('turn flipped to white', /White to move/.test(wiz.textContent));
    say('count updated', /1 move to find/.test(q('[data-stat]').textContent), q('[data-stat]').textContent);

    await play('d2', 'd4');
    say('second move recorded', moves().length === 2);
    say('only the last carries the flag', all('.pz-node-flag').length === 1);
    say('two edges now', all('.pz-flow-edges path').length === 2);
    say('the two moves are on different rows',
      moves()[0].getBoundingClientRect().top !== moves()[1].getBoundingClientRect().top);

    // every node carries its own delete
    const target = moves()[1];
    target.querySelector('[data-del]').click();
    await wait(220);
    say('deleting from the chart removes the move', moves().length === 1, moves().length);

    // the rail goes backwards now that the position exists
    all('.pz-step-pill')[1].click();
    await wait(220);
    say('rail returns to Position', !!q('[data-confirm]'));
    all('.pz-step-pill')[2].click();
    await wait(240);
    say('rail returns to Moves', !!q('[data-flow]'));
    say('the recorded move survived the trip', moves().length === 1);

    all('.pz-step-pill')[3].click();
    await wait(220);
    say('rail reaches Details once a move exists', !!q('#pzd-title'));
    say('details asks the right things',
      !!q('#pzd-desc') && !!q('#pzd-source') && !!q('#pzd-points') && !!q('#pzd-expiry'));
    say('no max attempts field', !wiz.querySelector('[id*="max"]'));
    say('late cut hidden until a date is set', q('[data-late]').hidden);
    say('summary counts the moves', q('[data-sum-moves]').textContent === '1',
      q('[data-sum-moves]').textContent);

    q('#pzd-points').value = '25';
    q('#pzd-points').dispatchEvent(new Event('input', { bubbles: true }));
    q('#pzd-expiry').value = '2030-01-01';
    q('#pzd-expiry').dispatchEvent(new Event('input', { bubbles: true }));
    q('#pzd-late').value = '33';
    q('#pzd-late').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(90);
    say('late cut revealed by the date', !q('[data-late]').hidden);
    say('late worth truncates to 16', q('[data-sum-late]').textContent === '16 pts',
      q('[data-sum-late]').textContent);
    say('on-time worth is 25', q('[data-sum-full]').textContent === '25 pts',
      q('[data-sum-full]').textContent);
    say('preview offered while building', !!q('[data-preview]'));
    say('publish is the primary action', !!q('[data-publish]'));

    wiz.remove();
  }

  // ── branching, and the + that merges two branches ────────────────
  {
    const { wiz, q, all, play, wait, moves } = await newWizard();

    q('[data-pick="b"]').click();
    await wait(220);
    q('[data-standard]').click();
    await wait(150);
    q('[data-confirm]').click();
    await wait(260);

    // one line: 1...e6 2.d4 d5
    await play('e7', 'e6');
    await play('d2', 'd4');
    await play('d7', 'd5');
    say('first line built', moves().length === 3, moves().length);
    say('one ending so far', all('.pz-node-flag').length === 1);
    say('no merge offered yet', all('.pz-merge').length === 0);

    // ── a second good first move opens a branch ────────────────────
    q('[data-back]').click();
    await wait(220);
    say('back at the start', /Play the first move/.test(wiz.textContent));
    say('Start node is selected', q('.pz-node.is-root').classList.contains('on'));

    await play('d7', 'd5');
    say('second branch opened', moves().length === 4, moves().length);
    say('two endings now', all('.pz-node-flag').length === 2);
    say('ways counted', /2 ways/.test(q('[data-stat]').textContent), q('[data-stat]').textContent);
    say('the branch sits beside its sibling, not under it', (() => {
      const row = moves().filter((n) => Math.abs(n.getBoundingClientRect().top
        - moves()[0].getBoundingClientRect().top) < 2);
      return row.length === 2;
    })(), 'first row size');

    // ── replaying an existing move follows it rather than duplicating ──
    const before = moves().length;
    await play('d2', 'd4');
    say('no duplicate node from a repeated move', moves().length === before + 1,
      `${moves().length} vs ${before + 1}`);

    // ── the transposition offers a + between the two branches ──────
    // 1...d5 2.d4 e6 reaches the same board as 1...e6 2.d4 d5
    await play('e7', 'e6');
    await wait(250);
    say('no interrupting dialog', !document.querySelector('.modal'),
      document.querySelectorAll('.modal').length + ' modals');
    say('a + appears between the two branches', all('.pz-merge').length === 1,
      all('.pz-merge').length);
    say('the + explains what it joins',
      /reach the same position/.test(q('.pz-merge').getAttribute('title')),
      q('.pz-merge').getAttribute('title'));
    say('the help line points at it', /press \+ to merge/.test(q('[data-help]').textContent),
      q('[data-help]').textContent);

    // it sits between the two moves it would join
    const mergeBtn = q('.pz-merge');
    const mb2 = mergeBtn.getBoundingClientRect();
    const sameRow = moves().filter((n) => Math.abs(n.getBoundingClientRect().top +
      n.getBoundingClientRect().height / 2 - (mb2.top + mb2.height / 2)) < 3);
    say('the + is level with the pair it joins', sameRow.length === 2, sameRow.length);

    const nodesBefore = moves().length;
    mergeBtn.click();
    await wait(320);
    say('merging two leaves needs no confirmation', !document.querySelector('.modal'));
    say('one node fewer after the merge', moves().length === nodesBefore - 1,
      `${moves().length} vs ${nodesBefore - 1}`);
    say('the survivor is marked as shared', all('.pz-node.shared').length === 1,
      all('.pz-node.shared').length);
    say('both routes still lead somewhere', /2 ways/.test(q('[data-stat]').textContent),
      q('[data-stat]').textContent);
    say('the + is gone once merged', all('.pz-merge').length === 0);
    say('two parents feed one box', all('.pz-flow-edges path').length === 6,
      all('.pz-flow-edges path').length);

    // ── clicking a move stands at that position again ──────────────
    moves()[0].click();
    await wait(240);
    say('clicking a move selects it', all('.pz-node.on').length === 1);
    say('and says whose move it is now', /to move/.test(wiz.textContent));

    wiz.remove();
    document.querySelectorAll('.modal').forEach((m) => m.remove());
  }

  // ── a bad FEN must not read as an empty board ────────────────────
  say('padFen fills six fields', P.padFen('8/8/8/8/8/8/8/8 w').split(' ').length === 6);
  say('startFen keeps castling',
    P.startFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'b')
      === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');

  return log;
}, base);

let fail = 0;
for (const r of out) {
  if (!r.ok) { fail++; console.log('  FAIL:', r.name, r.extra); }
}
console.log(`${out.length - fail} passed, ${fail} failed`);
if (errors.length) { console.log('\nBrowser errors:'); errors.forEach((e) => console.log('  ' + e)); }

await browser.close();
server.close();
process.exit(fail || errors.length ? 1 : 0);
