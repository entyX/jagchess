/* ═══════════════════════════════════════════════════════════════════════
   tests/pending-markup.test.mjs — the pending list written as text, and the
   paging control both admin lists share.

   Neither module touches Firestore or the DOM, which is exactly why they
   are their own files. Both are browser modules in a package declared
   commonjs, so they are handed to node as data URLs — the same trick
   puzzle-model.test.mjs uses, and for the same reason: it loads the real
   file rather than a copy that can drift.

   Run it with:  node tests/pending-markup.test.mjs
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const load = async (rel) => import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(fs.readFileSync(path.join(root, rel), 'utf8')));

const M = await load('assets/js/pending-markup.js');
const P = await load('assets/js/puzzle-pager.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL: ' + name + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got);

/* ── the shape one line is written in ─────────────────────────────── */

{
  const p = M.parseMarkup('1090108@apps.nsd.org  Shaurya Sahdev');
  const l = p.lines[0];
  ok('the address is read off the front', l.email === '1090108@apps.nsd.org', l.email);
  ok('and it is a usable one', l.emailOk);
  eq('first and last name split', [l.first, l.last], ['Shaurya', 'Sahdev']);
  ok('two spaces is the format', l.formatOk);
  ok('nothing is wrong with it', !l.tone, l.tone);
  eq('one person comes out', p.people, [
    { email: '1090108@apps.nsd.org', firstName: 'Shaurya', lastName: 'Sahdev' }
  ]);
}

{
  const p = M.parseMarkup('someone@school.org');
  ok('an address on its own is fine', p.lines[0].formatOk && !p.bad && !p.sloppy);
  eq('and carries no name', p.people, [
    { email: 'someone@school.org', firstName: '', lastName: '' }
  ]);
}

{
  const p = M.parseMarkup([
    'one@school.org Single Space',
    'two@school.org\tTabbed Name',
    ' three@school.org  Leading Space',
    'four@school.org  Double  Inside'
  ].join('\n'));
  ok('one space instead of two is flagged', !p.lines[0].formatOk);
  ok('so is a tab', !p.lines[1].formatOk);
  ok('so is an indent', !p.lines[2].formatOk);
  ok('so is a gap inside the name', !p.lines[3].formatOk);
  ok('all four counted as untidy', p.sloppy === 4, p.sloppy);

  /* Untidy is not unusable: every one of them is still somebody we can
     write to, so the names come through and the save is not blocked. */
  ok('none of them is an error', p.bad === 0, p.bad);
  eq('and the names are still read', p.people.map((x) => x.firstName + '/' + x.lastName),
    ['Single/Space', 'Tabbed/Name', 'Leading/Space', 'Double/Inside']);
}

{
  /* How many words a name is made of is not this file's business. */
  const p = M.parseMarkup('one@x.org  Cher\ntwo@x.org  Mary Jane Watson');
  ok('a single name is tidy', p.lines[0].formatOk);
  ok('and so is a long one', p.lines[1].formatOk);
  ok('nothing untidy at all', p.sloppy === 0, p.sloppy);
  eq('the first word is the first name, the rest the last',
    [p.people[1].firstName, p.people[1].lastName], ['Mary', 'Jane Watson']);
}

{
  const p = M.parseMarkup('hello  Nobody At All\n@school.org  No Local Part\nnope@nowhere  Missing Tld');
  ok('a line with no address is an error', p.lines[0].tone === 'bad', p.lines[0].tone);
  ok('so is an address with no name in front of the @', p.lines[1].tone === 'bad');
  ok('so is one with no domain ending', p.lines[2].tone === 'bad');
  ok('three errors counted', p.bad === 3, p.bad);
  eq('and none of them becomes a person', p.people, []);
}

/* ── the four colours ─────────────────────────────────────────────── */

{
  const members = ['Already@School.org'];
  const p = M.parseMarkup([
    'fresh@school.org  New Person',
    'twice@school.org  First Time',
    'twice@school.org  Second Time',
    'already@school.org  In The Club',
    'both@school.org  One',
    'both@school.org  Two',
    'BOTH@school.org  Three'
  ].join('\n'), members.concat('both@school.org'));

  const tone = (i) => p.lines[i].tone;
  ok('a new address is plain', tone(0) === '', tone(0));
  ok('written twice is blue', tone(1) === 'dup' && tone(2) === 'dup', [tone(1), tone(2)]);
  ok('already a member is green', tone(3) === 'mem', tone(3));
  ok('both at once is orange', tone(4) === 'both' && tone(6) === 'both', [tone(4), tone(6)]);
  ok('case does not hide a duplicate', p.dupes === 2, p.dupes);
  ok('nor does it hide a member', p.lines[3].member);

  /* Green comes off the markup on the way out — they are in the club, so a
     pending place for them would be a row nobody could ever see. Blue and
     orange never get this far: the editor will not save while either is on
     screen, because which of the two rows was meant is not its call. */
  eq('a repeat is written once and a member not at all',
    p.people.map((x) => x.email), ['fresh@school.org', 'twice@school.org']);
}

/* ── blank lines are not people ───────────────────────────────────── */

{
  const p = M.parseMarkup('\n\na@school.org\n   \n\nb@school.org\n');
  eq('only the two addresses count', p.people.map((x) => x.email),
    ['a@school.org', 'b@school.org']);
  ok('the blank lines survive as lines', p.lines.length === 7, p.lines.length);
  ok('and none of them is an error', p.bad === 0);
}

/* ── the painted layer ────────────────────────────────────────────── */

{
  const p = M.parseMarkup('bad line here\ndupe@x.org  A B\ndupe@x.org  C D');
  const html = M.markupHTML(p);
  ok('the bad address is marked', /<span class="mk-mail bad">bad<\/span>/.test(html), html);
  ok('both duplicates are marked', (html.match(/mk-mail dup/g) || []).length === 2);
  ok('one painted line per real line', html.split('\n').length === p.lines.length + 1);

  const angry = M.markupHTML(M.parseMarkup('<script>@x.org  <b>Bold</b> Name'));
  ok('nothing typed in becomes markup', !/<script>/.test(angry) && !/<b>/.test(angry), angry);
}

{
  /* The caret sits over the painted copy, so the two have to hold the same
     characters — a space eaten on one side moves every colour after it. */
  const text = 'a@x.org  One Two\n\n  b@x.org';
  const flat = M.markupHTML(M.parseMarkup(text))
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  ok('the painted text matches the typed text', flat === text + '\n', JSON.stringify(flat));
}

/* ── the list, written out ────────────────────────────────────────── */

{
  const rows = [
    { email: 'a@x.org', firstName: 'Ann', lastName: 'Lee' },
    { email: 'b@x.org', firstName: '', lastName: '' },
    { email: 'c@x.org', firstName: 'Cy', lastName: '' }
  ];
  eq('written back the way it is read', M.markupFromApplicants(rows),
    'a@x.org  Ann Lee\nb@x.org\nc@x.org  Cy');

  /* The round trip is the whole promise of the editor: open it, save it
     untouched, and nothing about the list has moved. */
  const back = M.parseMarkup(M.markupFromApplicants(rows));
  eq('and reads back to the same people', back.people, [
    { email: 'a@x.org', firstName: 'Ann', lastName: 'Lee' },
    { email: 'b@x.org', firstName: '', lastName: '' },
    { email: 'c@x.org', firstName: 'Cy', lastName: '' }
  ]);
  ok('with nothing flagged', !back.bad && !back.dupes && !back.sloppy);
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  PAGING                                                             */
/* ═══════════════════════════════════════════════════════════════════ */

const rows = Array.from({ length: 47 }, (_, i) => i + 1);

{
  const st = P.newPageState(10);
  eq('page one is the first ten', P.pageSlice(st, rows), rows.slice(0, 10));
  st.page = 5;
  eq('the last page is the remainder', P.pageSlice(st, rows), [41, 42, 43, 44, 45, 46, 47]);

  /* A list that shrinks underneath you — a search, a deletion — must not
     leave the reader on a page that no longer exists. */
  st.page = 5;
  eq('a shrunken list pulls the page back', P.pageSlice(st, rows.slice(0, 12)), [11, 12]);
  ok('and the state says so', st.page === 2, st.page);

  st.page = 0;
  P.pageSlice(st, rows);
  ok('page zero is page one', st.page === 1, st.page);

  const empty = P.newPageState(10);
  eq('an empty list has a page', P.pageSlice(empty, []), []);
  ok('and it is page one of one', empty.page === 1);
}

{
  const st = P.newPageState(10);
  const html = P.pagerHTML(st, rows.length, 'puzzle', 'puzzles');
  ok('it says where you are', /Page 1 of 5/.test(html), html.slice(0, 120));
  ok('and how many there are', /47 puzzles/.test(html));
  ok('back is dead on the first page', /data-step="-1"[^>]*disabled/.test(html));
  ok('forward is not', !/data-step="1"[^>]*disabled/.test(html));
  ok('the page you are on is marked', /class="pg-num on" data-page="1"/.test(html));
  ok('every size is offered', [5, 10, 20, 30, 50]
    .every((n) => html.includes(`value="${n}"`)) && html.includes('>Custom<'));
  ok('and no custom box until you ask', !/data-custom/.test(html));

  st.custom = true;
  st.size = 7;
  ok('asking for one shows it', /data-custom[\s\S]*value="7"/.test(P.pagerHTML(st, 47, 'x', 'xs')));
}

{
  /* 1 … 6 7 8 … 40: the ends because they are where you jump to, the
     neighbours because they are where you step. */
  const st = P.newPageState(1);
  st.page = 20;
  const nums = (h) => (h.match(/data-page="(\d+)"/g) || []).map((m) => Number(m.match(/\d+/)[0]));
  eq('the middle shows both ends and both neighbours',
    nums(P.pagerHTML(st, 40, 'x', 'xs')), [1, 19, 20, 21, 40]);

  st.page = 1;
  eq('the start counts up', nums(P.pagerHTML(st, 40, 'x', 'xs')), [1, 2, 3, 40]);

  st.page = 40;
  eq('the end counts down', nums(P.pagerHTML(st, 40, 'x', 'xs')), [1, 38, 39, 40]);

  st.page = 2;
  eq('a short list is every page of it', nums(P.pagerHTML(st, 3, 'x', 'xs')), [1, 2, 3]);
  ok('with no gap marks', !/pg-gap/.test(P.pagerHTML(st, 3, 'x', 'xs')));
  ok('and a long one has them', /pg-gap/.test(P.pagerHTML(Object.assign(P.newPageState(1), { page: 20 }), 40, 'x', 'xs')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
