/* ═══════════════════════════════════════════════════════════════════════
   tests/pending.browser.test.mjs — the pending members box and the admin's
   puzzles page, drawn in a real browser.

   pending-markup.test.mjs covers the text: what a line means, which colour
   it gets, who comes out the other end. This covers what that text is
   wrapped in — the editor over the painted layer, the two counts in the
   head, the shelves that open, the pages — none of which can be checked
   without a document to draw into.

   Firestore is never reached. The page gets a throwaway config and the
   snapshot listeners are left to fail, because every screen here is drawn
   before one would have answered.

   Run it with:  node tests/pending.browser.test.mjs
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
/* The page talks to no Firestore, so its listeners fail by design. So does
   the one read this file breaks on purpose, which says so in its message. */
const NOISE = /firestore|WebChannel|transport errored|@firebase|ERR_|net::|permission|deliberate/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (NOISE.test(m.text())) return;
  errors.push('console: ' + m.text());
});

await page.goto(`${base}/tests/fixture.html`, { waitUntil: 'networkidle' });

const out = await page.evaluate(async () => {
  const log = [];
  const say = (name, cond, extra) => log.push({
    name, ok: !!cond, extra: extra === undefined ? '' : String(extra)
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const B = await import('/assets/js/club-blocks.js');
  const R = await import('/assets/js/club-registration.js');
  const P = await import('/assets/js/club-puzzles.js');

  const ctx = {
    clubId: 'smoke',
    user: { uid: 'u1', email: 'admin@school.org' },
    member: { uid: 'u1', role: 'founder', username: 'Mr Lee' },
    club: { name: 'Smoke', slug: 'smoke', code: '1234', visibility: 'public' }
  };

  /* ── the box itself ──────────────────────────────────────────────

     Its rows arrive on a Firestore snapshot that never comes here, so what
     is checked is the box the snapshot paints into: it exists, it is under
     the roster, and both of its buttons are on it.                       */

  const host = document.createElement('div');
  document.body.appendChild(host);
  B.renderBlock('members', ctx, host, {});
  await wait(200);

  const box = host.querySelector('#mb-pending');
  say('the pending box is drawn', !!box);
  say('under the roster', !!host.querySelector('#mb-real'));
  say('it says what it is for', /signed up through the JagChess Network/.test(box.textContent));
  say('Send all is offered', !!host.querySelector('#mb-send-all'));
  say('Edit markup beside it', !!host.querySelector('#mb-markup'));
  say('and somewhere for the rows to land', !!host.querySelector('#mb-pending-list'));
  say('with the counts above them', !!host.querySelector('#mb-pending-count'));

  /* ── the markup editor ───────────────────────────────────────────── */

  let saved = null;
  let cancelled = false;
  const pad = document.createElement('div');
  document.body.appendChild(pad);
  R.mountMarkupEditor(pad, {
    text: 'one@school.org  Ann Lee\ntwo@school.org',
    memberEmails: ['already@school.org'],
    onCancel: () => { cancelled = true; },
    onSave: (people) => { saved = people; return true; }
  });

  const input = pad.querySelector('.mk-input');
  const painted = pad.querySelector('.mk-paint');
  const status = () => pad.querySelector('.mk-status').textContent;
  const save = () => pad.querySelector('[data-save]');

  say('the editor opens on the list', !!input && input.value.startsWith('one@school.org  Ann Lee'));
  say('with the painted layer under it', !!painted);
  say('and the key beside it', pad.querySelectorAll('.mk-key .mk-dot').length === 4);
  say('two people counted', /2 people/.test(status()), status());
  say('the save is open', !save().disabled);
  say('and nothing is coloured', !painted.querySelector('.mk-mail.bad, .mk-mail.dup, .mk-mail.mem'));

  const type = async (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
  };

  await type('one@school.org  Ann Lee\none@school.org  Ann Lee');
  say('a repeat paints blue', painted.querySelectorAll('.mk-mail.dup').length === 2,
    painted.querySelectorAll('.mk-mail.dup').length);
  say('and stops the save', save().disabled);
  say('saying which way it is wrong', /more than once/.test(status()), status());

  await type('not an address at all');
  say('a line with no address paints red', !!painted.querySelector('.mk-mail.bad'));
  say('and stops the save too', save().disabled);

  await type('already@school.org  In The Club');
  say('somebody already in the club paints green', !!painted.querySelector('.mk-mail.mem'));
  say('which does not stop the save', !save().disabled);
  say('and is explained', /already in the club/.test(status()), status());

  await type('already@school.org  One\nalready@school.org  Two');
  say('a repeat who is also a member paints orange',
    painted.querySelectorAll('.mk-mail.both').length === 2,
    painted.querySelectorAll('.mk-mail.both').length);
  say('and stops the save', save().disabled);

  await type('one@school.org Ann Lee');
  say('one space instead of two is marked', !!painted.querySelector('.mk-name.mk-off'));
  say('but does not stop the save', !save().disabled);
  say('and is explained', /not written as/.test(status()), status());

  /* The caret is over a transparent textarea and the colours are painted
     underneath it, so the two layers have to agree on every metric that
     moves a glyph. Anything else and the colours drift off the letters. */
  const a = getComputedStyle(input);
  const b = getComputedStyle(painted);
  say('both layers share a font', a.fontFamily === b.fontFamily && a.fontSize === b.fontSize,
    a.fontFamily + ' / ' + b.fontFamily);
  say('and a line height', a.lineHeight === b.lineHeight, a.lineHeight + ' / ' + b.lineHeight);
  say('and the same padding', a.padding === b.padding, a.padding + ' / ' + b.padding);
  say('and wrap the same way', a.whiteSpace === b.whiteSpace && a.wordBreak === b.wordBreak);
  say('the typed text itself is invisible', a.color === 'rgba(0, 0, 0, 0)', a.color);
  say('but the caret is not', a.caretColor !== a.color, a.caretColor);

  await type('fresh@school.org  New Person\nalready@school.org  In The Club');
  save().click();
  await wait(40);
  say('saving hands over the people, not the text', Array.isArray(saved), JSON.stringify(saved));
  say('a member in the club is dropped on the way out',
    saved && saved.length === 1 && saved[0].email === 'fresh@school.org', JSON.stringify(saved));
  say('with their name carried through',
    saved && saved[0].firstName === 'New' && saved[0].lastName === 'Person');

  pad.querySelector('[data-cancel]').click();
  say('and cancel says so', cancelled);
  pad.remove();

  /* ── a markup row, and an invite going to everybody ──────────────── */

  const typed = { id: 'a1', email: 'typed@school.org', source: 'markup', status: 'pending' };
  const signed = {
    id: 'a2', email: 'signed@school.org', firstName: 'Sam', lastName: 'Ray',
    status: 'invited', submittedAt: Date.now()
  };

  const row = document.createElement('div');
  row.innerHTML = R.applicantRowHTML(typed) + R.applicantRowHTML(signed);
  say('a markup row has nothing to view', !row.querySelector('[data-app="a1"] [data-view]'));
  say('a registration does', !!row.querySelector('[data-app="a2"] [data-view]'));
  say('both can be invited', row.querySelectorAll('[data-invite]').length === 2);
  say('an address with no name reads as unknown',
    /Unknown/.test(row.querySelector('[data-app="a1"]').textContent));
  say('and says where it came from',
    /added by hand/.test(row.querySelector('[data-app="a1"]').textContent));
  say('a markup row is labelled', !!row.querySelector('[data-app="a1"] .role-pill.markup'));

  R.openBulkInvite(ctx, [typed, signed]);
  await wait(60);
  const modal = document.querySelector('.invite-card');
  say('the same modal opens for everybody', !!modal);
  say('addressed to the group, not a person', /Invite 2 people/.test(modal.querySelector('h3').textContent),
    modal.querySelector('h3').textContent);
  say('every address is shown', modal.querySelectorAll('.iv-chip').length === 2);
  say('and hidden from each other', /Bcc/.test(modal.textContent));

  const body = modal.querySelector('#iv-body');
  say('nobody is greeted by name', /^Hi there,/.test(body.value), body.value.slice(0, 30));
  say('not even the one who has one', !/Sam/.test(body.value));
  say('the invite link is in there', body.value.includes('invite=1'));
  say('and the way out of the mailing list', /reply with the word STOP/.test(body.value));

  const skip = modal.querySelector('[data-skip]');
  say('the invited one can be left out', !!skip);
  skip.click();
  await wait(30);
  say('and taking them out leaves one', modal.querySelectorAll('.iv-chip').length === 1,
    modal.querySelectorAll('.iv-chip').length);
  say('which is the one never written to',
    modal.querySelector('.iv-chip').textContent === 'typed@school.org');
  modal.querySelector('.modal-close').click();

  /* One person keeps their name on the greeting. */
  R.openInviteMail(ctx, signed);
  await wait(60);
  const one = document.querySelector('.invite-card');
  say('one invite greets them by name', /^Hi Sam,/.test(one.querySelector('#iv-body').value));
  say('and still offers the way out', /STOP/.test(one.querySelector('#iv-body').value));
  say('with no Bcc list on it', !one.querySelector('.iv-to-list'));
  one.querySelector('.modal-close').click();

  /* ── the admin's puzzles page ────────────────────────────────────── */

  const pz = document.createElement('div');
  document.body.appendChild(pz);
  P.renderPuzzles({ ...ctx, isAdmin: true, mode: 'admin' }, pz, {});
  await wait(250);

  say('published can be searched', !!pz.querySelector('#pz-q'));
  say('and paged', !!pz.querySelector('#pz-pager'));
  say('collections can be searched too', !!pz.querySelector('.pz-colls .pz-search'));
  say('there is no library tile left', !pz.querySelector('.pzlib-tile'));
  say('collections is the last tile',
    pz.querySelector('.pz-admin').lastElementChild.classList.contains('pz-colls'));
  say('and published says where members\u2019 puzzles went',
    /under Collections/.test(pz.querySelector('.pz-pub-note').textContent));

  /* ── the paging control itself ───────────────────────────────────── */

  const G = await import('/assets/js/puzzle-pager.js');
  const pager = document.createElement('div');
  document.body.appendChild(pager);

  const st = G.newPageState(10);
  let draws = 0;
  const draw = () => {
    draws++;
    pager.innerHTML = G.pagerHTML(st, 47, 'puzzle', 'puzzles');
    G.wirePager(pager, st, 47, draw);
  };
  draw();

  pager.querySelector('[data-step="1"]').click();
  say('forward turns the page', st.page === 2, st.page);
  pager.querySelector('[data-step="-1"]').click();
  say('and back turns it again', st.page === 1, st.page);
  pager.querySelector('[data-step="-1"]').click();
  say('back does nothing on the first page', st.page === 1, st.page);

  pager.querySelector('[data-page="5"]').click();
  say('a number goes straight there', st.page === 5, st.page);
  say('and is marked as where you are', !!pager.querySelector('.pg-num.on[data-page="5"]'));
  say('forward is dead on the last page', pager.querySelector('[data-step="1"]').disabled);

  const jump = pager.querySelector('[data-goto]');
  jump.value = '3';
  jump.dispatchEvent(new Event('change', { bubbles: true }));
  say('typing a page goes there', st.page === 3, st.page);
  say('and the box empties itself', pager.querySelector('[data-goto]').value === '');

  const jump2 = pager.querySelector('[data-goto]');
  jump2.value = '99';
  jump2.dispatchEvent(new Event('change', { bubbles: true }));
  say('a page past the end lands on the last one', st.page === 5, st.page);

  const size = pager.querySelector('[data-size]');
  size.value = '20';
  size.dispatchEvent(new Event('change', { bubbles: true }));
  say('a new size is taken', st.size === 20, st.size);
  say('and puts you back at the start', st.page === 1, st.page);
  say('three pages of twenty', /Page 1 of 3/.test(pager.textContent), pager.textContent.slice(0, 40));

  const size2 = pager.querySelector('[data-size]');
  size2.value = 'custom';
  size2.dispatchEvent(new Event('change', { bubbles: true }));
  const custom = pager.querySelector('[data-custom]');
  say('custom opens a box of its own', !!custom);
  say('with the caret already in it', document.activeElement === custom);
  custom.value = '7';
  custom.dispatchEvent(new Event('change', { bubbles: true }));
  say('and it sets the size', st.size === 7, st.size);
  say('seven at a time is seven pages', /Page 1 of 7/.test(pager.textContent));
  say('the caret stays in the box', !!document.activeElement.matches('[data-custom]'));

  const nonsense = pager.querySelector('[data-custom]');
  nonsense.value = '0';
  nonsense.dispatchEvent(new Event('change', { bubbles: true }));
  say('nothing per page is refused', st.size === 7, st.size);
  pager.remove();

  /* ═══════════════════════════════════════════════════════════════ */
  /*  THE NEWSLETTER'S @ SHORTCUTS                                   */
  /* ═══════════════════════════════════════════════════════════════ */

  const N = await import('/assets/js/newsletter-mail.js');

  const roster = [
    { email: 'founder@school.org', name: 'Mr Lee', role: 'founder' },
    { email: 'admin1@school.org', name: 'Ada Ng', role: 'admin' },
    { email: 'kid1@school.org', name: 'Kid One', role: 'student' },
    { email: 'kid2@school.org', name: 'Kid Two', role: 'student' },
    { email: 'gone@school.org', name: 'Left Us', role: 'student', deleted: true }
  ];
  const queue = [
    { email: 'wait1@school.org', name: 'Wait One' },
    { email: 'wait2@school.org', name: '' },
    /* Already a member: the same person under two labels is one person. */
    { email: 'kid1@school.org', name: 'Kid One' },
    { email: 'wait1@school.org', name: 'Wait One' }
  ];

  const nlHost = document.createElement('div');
  document.body.appendChild(nlHost);
  const field = N.mountNewsletterMail(nlHost, {
    getPeople: () => roster,
    getPending: () => queue,
    getMe: () => 'founder@school.org',
    getClubName: () => 'Smoke',
    addAllLabel: 'Add all Smoke students'
  });

  const nl = (name) => nlHost.querySelector('[data-nl="' + name + '"]');
  nl('enabled').click();
  await wait(40);

  say('the info icon is beside the To label', !!nl('info'));
  say('and names all three groups',
    ['@members', '@pending', '@admin'].every((t) => nl('info').textContent.includes(t)),
    nl('info').textContent.replace(/\s+/g, ' ').slice(0, 120));
  say('the box says you can type one', /@members/.test(nl('input').placeholder));

  const to = nl('input');
  const typeTo = async (text) => {
    to.value = text;
    to.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
  };
  const press = (key) => to.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const tagRow = (tag) => nlHost.querySelector('[data-value="' + tag + '"]');

  await typeTo('@');
  say('typing @ offers every group', nlHost.querySelectorAll('.nl-suggestion-ping').length === 3,
    nlHost.querySelectorAll('.nl-suggestion-ping').length);
  /* The reply-to address gets its own copy, so it is never counted twice —
     and a deleted row is not a member at all. */
  say('with a count on each that leaves the sender out',
    /3 members/.test(tagRow('@members').textContent),
    tagRow('@members').textContent.replace(/\s+/g, ' '));
  say('and leaves a deleted row out too', !nlHost.textContent.includes('gone@school.org'));

  await typeTo('@pe');
  say('typing more narrows it to one', nlHost.querySelectorAll('.nl-suggestion').length === 1);
  say('and it is the right one', !!tagRow('@pending'));
  say('somebody who has since joined is not still waiting',
    /2 pending people/.test(tagRow('@pending').textContent),
    tagRow('@pending').textContent.replace(/\s+/g, ' '));

  await typeTo('@members');
  press('Enter');
  await wait(40);
  say('@members adds everyone in the club', field.recipients.length === 3, field.recipients.join(','));
  say('and says how many', /added 3 members/.test(nl('status').textContent), nl('status').textContent);
  say('the box is cleared for the next one', to.value === '');
  say('they are real chips you can take back out',
    nlHost.querySelectorAll('.nl-chip-x').length === 3);

  await typeTo('@members');
  press('Enter');
  await wait(40);
  say('the same group twice adds nobody twice', field.recipients.length === 3);
  say('and says so', /already/.test(nl('status').textContent), nl('status').textContent);

  await typeTo('@pending');
  press('Enter');
  await wait(40);
  say('@pending adds the people waiting', field.recipients.length === 5, field.recipients.join(','));
  say('including the one with no name', field.recipients.includes('wait2@school.org'));
  say('but not the one who already joined',
    field.recipients.filter((e) => e === 'kid1@school.org').length === 1);
  say('they are marked apart from members',
    nlHost.querySelectorAll('.nl-chip.is-pending').length === 2,
    nlHost.querySelectorAll('.nl-chip.is-pending').length);
  say('and counted apart too', /2 not in the club yet/.test(nl('count').textContent),
    nl('count').textContent);

  const reopen = async () => { field.reset(); nl('enabled').click(); await wait(40); };

  await reopen();
  await typeTo('@admin');
  press('Enter');
  await wait(40);
  say('@admin reaches the staff only', field.recipients.length === 1, field.recipients.join(','));
  say('which here is the admin, the founder being the sender',
    field.recipients[0] === 'admin1@school.org', field.recipients[0]);

  await typeTo('@everyone');
  press('Enter');
  await wait(40);
  say('a group that does not exist is refused', field.recipients.length === 1);
  say('and points at the ones that do',
    /@members, @pending or @admin/.test(nl('status').textContent), nl('status').textContent);

  /* A tag is not an address, so everything that finishes an address has to
     finish a tag too. */
  await reopen();
  await typeTo('@admin');
  press(' ');
  await wait(40);
  say('space finishes a tag as well as an address', field.recipients.length === 1,
    field.recipients.join(','));

  await reopen();
  await typeTo('@members');
  to.dispatchEvent(new Event('blur', { bubbles: true }));
  await wait(40);
  say('and so does clicking away', field.recipients.length === 3, field.recipients.join(','));

  /* Somebody waiting is offered by name in the ordinary search too,
     labelled so nobody mistakes them for a member. */
  await reopen();
  await typeTo('wait');
  const hit = nlHost.querySelector('[data-value="wait1@school.org"]');
  say('a pending person turns up in the search', !!hit);
  say('wearing a label of their own', !!hit && /Pending/.test(hit.textContent),
    hit && hit.textContent.replace(/\s+/g, ' '));
  field.destroy();
  nlHost.remove();

  /* A host that keeps no pending list is not offered the group at all. */
  const bare = document.createElement('div');
  document.body.appendChild(bare);
  const plain = N.mountNewsletterMail(bare, {
    getPeople: () => roster, getMe: () => 'founder@school.org'
  });
  bare.querySelector('[data-nl="enabled"]').click();
  await wait(40);
  const bareIn = bare.querySelector('[data-nl="input"]');
  bareIn.value = '@';
  bareIn.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(30);
  say('the site-wide console gets two groups, not three',
    bare.querySelectorAll('.nl-suggestion-ping').length === 2,
    bare.querySelectorAll('.nl-suggestion-ping').length);
  say('and its tooltip does not promise @pending',
    bare.querySelector('[data-nl="ping-pending"]').hidden);
  plain.destroy();
  bare.remove();

  /* ═══════════════════════════════════════════════════════════════ */
  /*  THE MASTHEAD PICTURE, AND THE FACE IT IS WRITTEN IN            */
  /* ═══════════════════════════════════════════════════════════════ */

  const MAIL = await import('/assets/js/gmail-send.js');
  const FZ = await import('/assets/js/mail-fonts.js');

  /* A one-pixel picture in each encoding, drawn rather than pasted, so the
     test is measuring what a browser really produces. */
  const drawn = (type, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#16264d';
    g.fillRect(0, 0, w, h);
    return c.toDataURL(type);
  };

  {
    const png = drawn('image/png', 240, 120);
    const made = await MAIL.emailLogo(png);
    say('a badge becomes a part the message carries', !!made.inline);
    say('pointed at by a cid', made.logo.src === 'cid:clublogo', made.logo.src);
    say('and never as a data URL, which every client strips',
      !/^data:/.test(made.logo.src));
    say('the base64 is the picture, without its data: preamble',
      made.inline.base64 === png.split(',')[1]);
    say('it is measured, because Word ignores CSS on an image',
      made.logo.width === 128 && made.logo.height === 64,
      made.logo.width + 'x' + made.logo.height);
    /* Fit, not fill: a club's badge is a circle for some and a wordmark for
       others, and cropping one to look like the other is not ours to do. */
    say('and kept in proportion', made.logo.width / made.logo.height === 2);
  }

  {
    const tall = await MAIL.emailLogo(drawn('image/png', 40, 200));
    say('a tall badge is held to the same height', tall.logo.height === 64, tall.logo.height);
    const wide = await MAIL.emailLogo(drawn('image/png', 2000, 100));
    say('and a very wide one is held to a width', wide.logo.width === 260, wide.logo.width);
    /* Never enlarged: a small badge blown up to the box would be a blur. */
    const small = await MAIL.emailLogo(drawn('image/png', 30, 30));
    say('a small one is left at its own size', small.logo.height === 30, small.logo.height);
  }

  {
    /* A badge is stored as WebP wherever the browser can make one, and
       Outlook has never rendered WebP — it shows nothing, and says nothing. */
    const webp = drawn('image/webp', 80, 80);
    if (/^data:image\/webp/.test(webp)) {
      const made = await MAIL.emailLogo(webp);
      say('a WebP badge is redrawn as a PNG on the way out',
        made.inline.contentType === 'image/png', made.inline.contentType);
      say('and named as one', made.inline.filename === 'logo.png');
      say('a PNG badge is left exactly as it is',
        (await MAIL.emailLogo(drawn('image/png', 80, 80))).inline.contentType === 'image/png');
    } else {
      say('this browser makes no WebP, so there is nothing to convert', true);
      say('and a PNG badge is left exactly as it is',
        (await MAIL.emailLogo(drawn('image/png', 80, 80))).inline.contentType === 'image/png');
    }
  }

  {
    const site = await MAIL.emailLogo(location.origin + '/assets/img/jagchess-mark.png');
    say('an address on the site is used as an address', site.logo.src.startsWith('http'));
    say('with nothing attached to the message', site.inline === null);
    say('measured all the same', site.logo.height === 64, JSON.stringify(site.logo));
  }

  {
    say('nothing at all is nothing, not a broken picture',
      (await MAIL.emailLogo('')).logo === null);
    say('and so is something that is not a picture',
      (await MAIL.emailLogo('data:text/html;base64,PGI+aGk8L2I+')).logo === null);
    say('a data URL that will not decode is refused rather than sent',
      (await MAIL.emailLogo('data:image/png;base64,bm90YXBuZw==')).logo === null);
  }

  /* ── the face picker ─────────────────────────────────────────────── */

  {
    const VERDANA = FZ.MAIL_FONTS.find((f) => f.name === 'Verdana').stack;
    const COURIER = FZ.MAIL_FONTS.find((f) => f.name === 'Courier New').stack;

    const build = (html) => {
      const pad = document.createElement('div');
      pad.innerHTML = FZ.fontSelectHTML('t-font') +
        `<div contenteditable="true" id="t-ed">${html}</div>`;
      document.body.appendChild(pad);
      const stop = FZ.wireFontSelect(pad.querySelector('#t-font'), pad.querySelector('#t-ed'));
      return { pad, sel: pad.querySelector('#t-font'), ed: pad.querySelector('#t-ed'), stop };
    };
    const pickFont = async (sel, stack) => {
      sel.value = stack;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(30);
    };

    {
      const { pad, sel } = build('<p>Some words</p>');
      say('the picker opens on PT Serif', /PT Serif/.test(sel.options[0].text));
      say('with the rest of the faces under it', sel.options.length === FZ.MAIL_FONTS.length);
      say('and says what it will act on', /whole message/.test(sel.title), sel.title);
      pad.remove();
    }

    /* The one that was broken: picking a font without putting the caret in
       the editor first did nothing at all, which is indistinguishable from
       the control not working. */
    {
      const { pad, sel, ed, stop } = build('<p>Some words</p>');
      await pickFont(sel, VERDANA);
      say('a font picked with nothing selected sets the whole message',
        /Verdana/i.test(ed.innerHTML), ed.innerHTML);
      /* An inline style, not a <font face>: several clients drop the tag
         and keep the style, and none of them do the reverse. */
      say('as a style a mail client will keep', /style=/i.test(ed.innerHTML), ed.innerHTML);
      say('and the whole stack goes with it, not just the name',
        /sans-serif/i.test(ed.innerHTML), ed.innerHTML);
      say('the message is not left highlighted afterwards',
        window.getSelection().isCollapsed);
      stop();
      pad.remove();
    }

    /* Opening a dropdown takes focus off a contenteditable, and a
       contenteditable that has lost focus will not reliably hand its
       selection back — so the range is remembered as it moves. */
    {
      const { pad, sel, ed, stop } = build('<p>alpha bravo</p>');
      const text = ed.firstChild.firstChild;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 5);
      const s2 = window.getSelection();
      s2.removeAllRanges();
      s2.addRange(r);
      sel.focus();                       // the dropdown stealing focus
      await wait(20);
      await pickFont(sel, COURIER);

      say('a chosen word is the only thing restyled', /Courier/i.test(ed.innerHTML), ed.innerHTML);
      say('and the rest of the line is left alone',
        /Courier[^<]*<\/span>\s*bravo|>alpha<\/span> bravo/.test(ed.innerHTML), ed.innerHTML);
      stop();
      pad.remove();
    }

    {
      /* Nothing written yet: there is nothing to restyle and nothing to
         break, and the next thing typed picks the face up. */
      const { pad, sel, ed, stop } = build('');
      await pickFont(sel, VERDANA);
      say('an empty message survives being restyled', ed.textContent === '');
      stop();
      pad.remove();
    }

    /* styleWithCSS is turned on for that one command and off again, so bold
       goes on being <b> the way the rest of the toolbar expects. */
    say('and it is turned back off behind itself',
      document.queryCommandState('styleWithCSS') === false);

    {
      /* It listens on the document, so it has to be able to stop. */
      const { pad, ed, stop } = build('<p>x</p>');
      stop();
      const before = ed.innerHTML;
      document.dispatchEvent(new Event('selectionchange'));
      say('and the listener can be taken off again', ed.innerHTML === before);
      pad.remove();
    }
  }

  /* The editor is a preview as much as an input, so it is set in the same
     face the email will be. */
  {
    const ed = document.createElement('div');
    ed.className = 'rte-editor';
    document.body.appendChild(ed);
    say('the editor is set in the mail face',
      /PT Serif/.test(getComputedStyle(ed).fontFamily), getComputedStyle(ed).fontFamily);
    ed.remove();
  }

  /* ═══════════════════════════════════════════════════════════════ */
  /*  WHO HAS FINISHED A PUZZLE                                      */
  /* ═══════════════════════════════════════════════════════════════ */

  {
    const puzzle = { id: 'p1', title: 'Back-rank mate', points: 10 };
    const roster = [
      { id: 'u1', username: 'Ada Ng', role: 'admin', avatarColor: '#1cb0f6' },
      { id: 'u2', username: 'Satya Tumuluri', role: 'student', avatarColor: '#58cc02' },
      { id: 'u3', username: 'Adhyan Rangole', role: 'student', avatarColor: '#ff9600' },
      { id: 'u4', username: 'Visagan Saravanan', role: 'student', avatarColor: '#a05cf7' },
    ];
    /* u2 solved it and was paid; u3 was ticked by an admin and was not. */
    const attempts = [
      { userId: 'u2', puzzleId: 'p1', scoreAwarded: 10, completedAt: Date.now() - 864e5 },
      { userId: 'u3', puzzleId: 'p1', scoreAwarded: 0, source: 'admin', markedByName: 'Mr Lee', completedAt: Date.now() },
    ];

    let sent = null;
    const open = (extra = {}) => P.openCompletions(ctx, puzzle, {
      load: async () => ({ members: roster, attempts }),
      commit: async (d) => { sent = { adds: d.adds.map((m) => m.id), drops: d.drops.map((m) => m.id) }; },
      ...extra,
    });
    const card = () => document.querySelector('.pzdone-card');
    const rows = () => card().querySelectorAll('.pzdone-row');
    const box = (uid) => card().querySelector(`[data-uid="${uid}"]`);
    const shut = () => { const c = card(); if (c) c.querySelector('.modal-close').click(); };

    await open();
    await wait(60);

    say('the modal opens on the roster', !!card());
    say('with one row per member', rows().length === roster.length, rows().length);
    say('and names the puzzle', /Back-rank mate/.test(card().textContent));
    say('and says plainly that no points move',
      /No points are given by ticking and none are taken/.test(card().textContent));

    /* Anybody the club already has a completion for arrives ticked,
       whichever way they got there. */
    say('somebody who solved it arrives ticked', box('u2').checked);
    say('so does somebody an admin ticked before', box('u3').checked);
    say('and nobody else does', !box('u1').checked && !box('u4').checked);
    say('the count reads as it stands', /2 of 4 done/.test(card().textContent),
      card().querySelector('.pzdone-status').textContent);

    /* The two kinds of completion are not the same thing, and the row says
       which is which — clearing one has a consequence the other does not. */
    say('a solve says it was earned',
      /Solved it/.test(box('u2').closest('.pzdone-row').textContent),
      box('u2').closest('.pzdone-row').textContent.replace(/\s+/g, ' '));
    say('and is marked as such', !!box('u2').closest('.pzdone-row').querySelector('.pz-chip'));
    say('a tick says who ticked it',
      /Marked done by Mr Lee/.test(box('u3').closest('.pzdone-row').textContent),
      box('u3').closest('.pzdone-row').textContent.replace(/\s+/g, ' '));
    say('and is not dressed up as a solve',
      !box('u3').closest('.pzdone-row').querySelector('.pz-chip'));

    say('nothing to save until something changes', card().querySelector('[data-save]').disabled);

    box('u1').checked = true;
    box('u1').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);
    say('ticking somebody wakes the save', !card().querySelector('[data-save]').disabled);
    say('and says what is about to happen', /1 to mark done/.test(card().textContent),
      card().querySelector('.pzdone-status').textContent);
    say('the row they are on says so too',
      /Will be marked done when you save/.test(box('u1').closest('.pzdone-row').textContent));

    card().querySelector('[data-save]').click();
    await wait(60);
    say('saving sends only what changed',
      JSON.stringify(sent) === JSON.stringify({ adds: ['u1'], drops: [] }), JSON.stringify(sent));
    say('and closes', !card());

    /* Search, and the bulk buttons that go with it. */
    sent = null;
    await open();
    await wait(60);
    const q = card().querySelector('[data-q]');
    q.value = 'satya';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
    say('searching narrows the roster', rows().length === 1, rows().length);
    say('to the one that matches', /Satya/.test(card().textContent));

    card().querySelector('[data-all]').click();
    await wait(30);
    /* Tick everyone means everyone you are looking at, not everyone in the
       club — otherwise a search is a trap. */
    say('tick-everyone only ticks what the search shows',
      card().querySelector('[data-save]').disabled, card().querySelector('.pzdone-status').textContent);

    q.value = '';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
    card().querySelector('[data-all]').click();
    await wait(30);
    say('with nothing searched it ticks the lot', rows().length === 4 &&
      [...rows()].every((r) => r.querySelector('input').checked));
    say('and counts the two it would add', /2 to mark done/.test(card().textContent),
      card().querySelector('.pzdone-status').textContent);
    shut();
    await wait(30);

    /* Clearing a tick an admin put there is nothing to worry about. */
    sent = null;
    await open();
    await wait(60);
    box('u3').checked = false;
    box('u3').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);
    card().querySelector('[data-save]').click();
    await wait(80);
    say('clearing an admin tick needs no warning',
      JSON.stringify(sent) === JSON.stringify({ adds: [], drops: ['u3'] }), JSON.stringify(sent));

    /* Clearing a solve somebody was paid for is a different matter: the
       points stay, but the puzzle goes back on their list. */
    sent = null;
    await open();
    await wait(60);
    box('u2').checked = false;
    box('u2').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);
    card().querySelector('[data-save]').click();
    await wait(60);
    const warn = document.querySelector('.modal .btn.danger');
    say('clearing an earned solve asks first', !!warn && !sent);
    say('and says the points are not what is moving',
      /Those points stay/.test(document.body.textContent));
    say('and that solving it again would pay out twice',
      /pay out again/.test(document.body.textContent));
    if (warn) warn.click();
    await wait(60);
    say('agreeing to it sends the clear',
      JSON.stringify(sent) === JSON.stringify({ adds: [], drops: ['u2'] }), JSON.stringify(sent));
    shut();
    await wait(30);

    /* The row a tick writes. This is the whole promise of the feature: it
       looks like a solve to the member's page and is worth nothing. */
    const row = P.markedRow(ctx, puzzle, 'u9');
    say('a tick is worth no points', row.scoreAwarded === 0 && row.scoreBase === 0, JSON.stringify(row));
    say('and claims no moves or time', row.movesUsed === 0 && row.seconds === 0);
    say('it points at the right puzzle and person',
      row.puzzleId === 'p1' && row.userId === 'u9');
    say('it is stamped as an admin’s doing', row.source === 'admin' && row.markedBy === 'u1');
    say('and it is not late, which would dock a solve', row.late === false);

    /* A club with nobody in it, and a read that fails: neither should leave
       a modal sitting there saying nothing. */
    await P.openCompletions(ctx, puzzle, { load: async () => ({ members: [], attempts: [] }) });
    await wait(60);
    say('an empty club says so', /nobody in the club yet/.test(card().textContent));
    shut();
    await wait(30);

    await P.openCompletions(ctx, puzzle, {
      load: async () => { throw new Error('deliberate — the roster read failing on purpose'); }
    });
    await wait(60);
    say('a read that fails says so rather than hanging',
      /Could not read the roster/.test(card().textContent));
    shut();
    await wait(30);
  }

  return { log, href: location.href };
});

await browser.close();
server.close();

let pass = 0, fail = 0;
for (const r of out.log) {
  if (r.ok) { pass++; continue; }
  fail++;
  console.log('  FAIL: ' + r.name + (r.extra ? ' — ' + r.extra : ''));
}
for (const e of errors) { fail++; console.log('  ' + e); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
