/* ═══════════════════════════════════════════════════════════════════════
   tests/calendar.browser.test.mjs — the Google Calendar translation.

   Everything in google-calendar.js that talks to Google needs a token and
   a person, and none of that can be tested here. What CAN be tested is the
   half that decides what a club event looks like to Google and what a
   Google event looks like on the club calendar — which is also the half
   where a mistake is silent: a wrong end time or a dropped id does not
   throw, it just quietly makes a duplicate event in somebody's calendar
   every time they press save.

   It runs in a browser because the module is written for one.

   Run it with:  node tests/calendar.browser.test.mjs
   ═══════════════════════════════════════════════════════════════════════ */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel === '/' ? '/index.html' : rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = 'http://localhost:' + server.address().port;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : extra); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(base + '/tests/fixture.html', { waitUntil: 'domcontentloaded' });

const r = await page.evaluate(async (b) => {
  const G = await import(b + '/assets/js/google-calendar.js');
  const start = Date.parse('2026-10-02T18:30:00Z');
  const ev = { id: 'e1', clubId: 'c1', title: 'Club night', desc: 'bring a board', date: start, durationMin: 90 };
  const g = G.toGoogle(ev);

  const back = G.fromGoogle({
    id: 'gid1', summary: g.summary, description: g.description,
    start: g.start, end: g.end, htmlLink: 'https://cal/x'
  });

  return {
    g,
    endsAfter90: Date.parse(g.end.dateTime) - Date.parse(g.start.dateTime),
    back,
    ours: G.fromGoogle({
      id: 'gid2', summary: 'x', start: g.start, end: g.end,
      extendedProperties: { private: { jagchessEventId: 'e1', jagchessClubId: 'c1' } }
    }),
    allDay: G.fromGoogle({ id: 'gid3', summary: 'Holiday', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }),
    noStart: G.fromGoogle({ id: 'gid4', summary: 'broken' }),
    untitled: G.toGoogle({ date: start }),
    tiny: G.toGoogle({ title: 't', date: start, durationMin: 1 }),
    link: G.CALENDAR_LINK,
    calendarId: G.CALENDAR_ID,
    configured: G.isConfigured(),
    account: G.connectedAccount()
  };
}, base);

// ── a club event, as Google wants it ────────────────────────────────
eq('the title becomes the summary', r.g.summary, 'Club night');
eq('the description carries', r.g.description, 'bring a board');
ok('it is a timed event, not an all-day one', !!r.g.start.dateTime && !r.g.start.date);
eq('the end is the duration past the start', r.endsAfter90, 90 * 60000);
eq('it is stamped with the club event it came from', r.g.extendedProperties.private.jagchessEventId, 'e1');
eq('and with the club', r.g.extendedProperties.private.jagchessClubId, 'c1');
eq('an event with no title still has one', r.untitled.summary, 'Untitled');
eq('a duration under the floor is raised to it',
  Date.parse(r.tiny.end.dateTime) - Date.parse(r.tiny.start.dateTime), 5 * 60000);

// ── and back again ──────────────────────────────────────────────────
eq('the summary comes back as the title', r.back.title, 'Club night');
eq('the duration survives the round trip', r.back.durationMin, 90);
eq('so does the instant', r.back.date, Date.parse('2026-10-02T18:30:00Z'));
eq('it is marked as borrowed', r.back.source, 'google');
/* The prefix is what keeps a Google id out of the club's own id space:
   openEvent looks a row up by id and must never find a Google row where a
   club event was meant. */
eq('its id is prefixed', r.back.id, 'g:gid1');
eq('the Google id is kept for later writes', r.back.googleEventId, 'gid1');
eq('and the link to it', r.back.htmlLink, 'https://cal/x');

// ── the club's own events, seen from the far side ───────────────────
/* This is the one that stops every club event being drawn twice: pushed
   out, then pulled back in as though it were somebody else's. */
eq('a pushed event is recognised on the way back', r.ours.jagchessEventId, 'e1');
ok('an ordinary Google event is not', !r.back.jagchessEventId);

// ── the awkward ones ────────────────────────────────────────────────
ok('an all-day event is flagged', r.allDay.allDay === true);
eq('and still has a title', r.allDay.title, 'Holiday');
eq('an event with no start is dropped rather than drawn at 1970', r.noStart, null);
eq('an event with no summary reads as untitled',
  (await page.evaluate(async (b) => (await import(b + '/assets/js/google-calendar.js'))
    .fromGoogle({ id: 'g', start: { dateTime: '2026-01-01T00:00:00Z' } }).title, base)), '(no title)');

// ── nothing is connected until somebody connects it ─────────────────
eq('no client id in the fixture means not configured', r.configured, false);
eq('and no account', r.account, null);
eq('the calendar is the account’s own', r.calendarId, 'primary');
ok('there is a link to open it', /^https:\/\/calendar\.google\.com\//.test(r.link));

// ── asking for a scope is not being given it ────────────────────────
/* The bug this covers: with calendar.events missing from the consent
   screen, Google still completes the sign-in and still returns a token,
   and every calendar call then 403s. Before this the failures were
   swallowed one per event and the club saw an empty calendar and no
   reason for it. */
const scope = await page.evaluate(async (b) => {
  const G = await import(b + '/assets/js/google-calendar.js');
  const e = new G.ScopeError();
  return {
    accessBeforeAnyToken: G.hasCalendarAccess(),
    name: e.name,
    code: e.code,
    isError: e instanceof Error,
    message: e.message
  };
}, base);

ok('no calendar access before a token has ever been granted', scope.accessBeforeAnyToken === false);
eq('the scope failure is its own kind of error', scope.name, 'ScopeError');
eq('and carries a code the UI can branch on', scope.code, 'no-calendar-scope');
ok('it is still an Error, so ordinary catches work', scope.isError);
ok('and says something', scope.message.length > 0);

ok('nothing threw while loading the module', errors.length === 0, errors.join('; '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
