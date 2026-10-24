/* ═══════════════════════════════════════════════════════════════════════
   tests/club-photo.test.mjs — a club's own picture, in a real browser.

   Two things are being checked and only one of them is the happy path.

   The first is the pipeline: a picked file has to come back as a data URL
   small enough to live on a Firestore document, at its own proportions and
   with its transparency intact, whatever it started as. It is shrunk in
   the browser, so this needs a real canvas.

   The second is the part that would be a security hole rather than a bug.
   `photo` arrives from a club document, which the club's staff write and
   which is mirrored where the whole internet can read it. By the time it
   reaches the page it is attacker-controlled text. So it is matched
   against the shape of a base64 image URL and dropped if it is anything
   else, and what survives goes in an `img`, not a style attribute — there
   is no CSS for it to break out of. Both halves are checked here, because
   a regression in either is silent.

   Run it with:  node tests/club-photo.test.mjs
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
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
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

const PORT = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const NOISE = /firestore|WebChannel|transport errored|@firebase|ERR_|net::/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (NOISE.test(m.text())) return;
  errors.push('console: ' + m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/tests/fixture.html`, { waitUntil: 'networkidle' });

const out = await page.evaluate(async () => {
  const log = [];
  const say = (name, cond, extra) =>
    log.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });

  const C = await import('/assets/js/club-core.js');

  /* A wide picture, so "kept its shape" means something. */
  const drawFile = async (w, h, noisy) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#58cc02';
    g.fillRect(0, 0, w, h);
    if (noisy) {
      for (let i = 0; i < 6000; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 80% ${30 + (i % 50)}%)`;
        g.fillRect((i * 17) % w, (i * 29) % h, 7, 7);
      }
    } else {
      g.fillStyle = '#123240';
      g.fillRect(w / 2 - 40, h / 2 - 40, 80, 80);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new File([blob], 'club.png', { type: 'image/png' });
  };

  // ── the pipeline ──────────────────────────────────────────────────
  {
    const url = await C.clubPhotoFrom(await drawFile(900, 400));
    say('a picked file becomes a data URL', /^data:image\/(webp|png);base64,/.test(url),
      url.slice(0, 32));
    say('and never a format without transparency', !/^data:image\/jpeg/.test(url));
    say('and it is small enough to store', url.length <= C.CLUB_PHOTO_MAX,
      url.length + ' of ' + C.CLUB_PHOTO_MAX);
    say('and it passes the check on the way back out', !!C.clubPhoto({ photo: url }));

    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    /* The whole picture, at its own proportions. Cropping it to a square
       is what cut the edges off a logo, which is the common case. */
    say('the shape is kept, not cropped to a square',
      Math.abs((img.naturalWidth / img.naturalHeight) - (900 / 400)) < 0.05,
      img.naturalWidth + 'x' + img.naturalHeight);
    say('and it is scaled down to fit', Math.max(img.naturalWidth, img.naturalHeight) <= 256,
      img.naturalWidth + 'x' + img.naturalHeight);
    say('a square picture stays square', await (async () => {
      const sq = await C.clubPhotoFrom(await drawFile(500, 500));
      const i = await new Promise((res) => { const e = new Image(); e.onload = () => res(e); e.src = sq; });
      return i.naturalWidth === i.naturalHeight;
    })());

    /* Noise is what makes a picture refuse to compress, so this is the
       path that has to fall back through smaller sizes rather than store
       something enormous. */
    const busy = await C.clubPhotoFrom(await drawFile(1600, 1600, true));
    say('a detailed picture still comes under the cap', busy.length <= C.CLUB_PHOTO_MAX,
      busy.length);

    /* A logo is usually a shape on nothing. If the encoder loses the alpha
       channel it comes back on a black or white card, which is the bug
       this whole path exists to avoid. */
    {
      const c = document.createElement('canvas');
      c.width = c.height = 200;
      const g = c.getContext('2d');
      g.fillStyle = '#ff4b4b';
      g.beginPath(); g.arc(100, 100, 60, 0, Math.PI * 2); g.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const out = await C.clubPhotoFrom(new File([blob], 'logo.png', { type: 'image/png' }));

      const back = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = out; });
      const probe = document.createElement('canvas');
      probe.width = back.naturalWidth; probe.height = back.naturalHeight;
      probe.getContext('2d').drawImage(back, 0, 0);
      const corner = probe.getContext('2d').getImageData(1, 1, 1, 1).data;
      say('a transparent corner stays transparent', corner[3] < 24, 'alpha ' + corner[3]);
    }

    let refused = null;
    try { await C.clubPhotoFrom(new File(['hello'], 'x.txt', { type: 'text/plain' })); }
    catch (e) { refused = e.message; }
    say('a file that is not a picture is refused', /not a picture/.test(refused || ''), refused);
  }

  // ── what is allowed back out ──────────────────────────────────────
  {
    say('no picture, no picture', C.clubPhoto({}) === null);
    say('an empty one is none', C.clubPhoto({ photo: '' }) === null);

    /* Each of these is a club document somebody could write. */
    const nasty = [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'https://example.com/pic.png',
      'data:image/png;base64,AAA");background:url(evil',
      'data:image/png;base64,<script>'
    ];
    for (const v of nasty) {
      say('refused: ' + v.slice(0, 34), C.clubPhoto({ photo: v }) === null, v.slice(0, 60));
    }

    const huge = 'data:image/png;base64,' + 'A'.repeat(C.CLUB_PHOTO_MAX);
    say('and one too big to be stored', C.clubPhoto({ photo: huge }) === null);
  }

  // ── the markup ────────────────────────────────────────────────────
  {
    const box = document.createElement('div');
    document.body.appendChild(box);

    box.innerHTML = C.clubAvatar({ color: '#ff4b4b', icon: '♜' }, 'club-avatar');
    say('a club with no picture keeps its badge',
      box.querySelector('.club-avatar').textContent.trim() === '♜',
      box.querySelector('.club-avatar').textContent.trim());
    say('in its own colour',
      /255, 75, 75/.test(getComputedStyle(box.querySelector('.club-avatar')).backgroundColor),
      getComputedStyle(box.querySelector('.club-avatar')).backgroundColor);
    say('and is not marked as having one', !box.querySelector('.has-photo'));

    const real = await C.clubPhotoFrom(await drawFile(400, 400));
    box.innerHTML = C.clubAvatar({ color: '#ff4b4b', icon: '♜', photo: real }, 'club-avatar sm');
    say('a club with one shows it', !!box.querySelector('.has-photo img'));
    say('keeping the class that sizes it',
      box.querySelector('.has-photo').classList.contains('sm'));
    say('and dropping the glyph', !/♜/.test(box.querySelector('.has-photo').textContent));
    say('the whole picture is shown',
      getComputedStyle(box.querySelector('.has-photo img')).objectFit === 'contain',
      getComputedStyle(box.querySelector('.has-photo img')).objectFit);
    /* What is left of the square when the picture is not one has to be
       nothing at all — not the page's grey, and not white. */
    const bg = getComputedStyle(box.querySelector('.has-photo')).backgroundColor;
    say('and the rest of the box is transparent',
      bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent', bg);
    say('with no card drawn behind it',
      getComputedStyle(box.querySelector('.has-photo')).boxShadow === 'none',
      getComputedStyle(box.querySelector('.has-photo')).boxShadow);

    /* The whole reason it is an img: a data URL that tried to close a
       style attribute has nothing to close. */
    box.innerHTML = C.clubAvatar({ photo: 'data:image/png;base64,AA"><img onerror=x src=y>' }, 'club-avatar');
    say('a photo that tries to break out is just dropped',
      !box.querySelector('img'), box.innerHTML.slice(0, 80));
    say('and the badge is drawn instead', !!box.querySelector('.club-avatar'));

    box.remove();
  }

  // ── the badge behind it ───────────────────────────────────────────
  {
    say('there are plenty of glyphs to pick from', C.CLUB_ICONS.length >= 30, C.CLUB_ICONS.length);
    say('and enough colours to tell clubs apart', C.CLUB_COLORS.length >= 12, C.CLUB_COLORS.length);
    say('no glyph is listed twice', new Set(C.CLUB_ICONS).size === C.CLUB_ICONS.length);
    say('no colour is either', new Set(C.CLUB_COLORS).size === C.CLUB_COLORS.length);
    say('every colour is a hex value', C.CLUB_COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c)),
      C.CLUB_COLORS.filter((c) => !/^#[0-9a-f]{6}$/i.test(c)).join(','));

    /* The first of each is what a new club gets and what every fallback
       reaches for, so appending must never reorder them. The colour is the
       brand green, which the fallbacks in club-core also use. */
    say('the original default is still first', C.CLUB_ICONS[0] === '♞', C.CLUB_ICONS[0]);
    say('and the brand green leads the colours', C.CLUB_COLORS[0] === '#1faf5a', C.CLUB_COLORS[0]);
  }

  // ── the listing carries it ────────────────────────────────────────
  {
    const payload = C.publicClubPayload({ id: 'c1', name: 'Jags', photo: 'data:image/webp;base64,AAAA' });
    say('the public listing copies the picture',
      payload.photo === 'data:image/webp;base64,AAAA', payload.photo);
    say('and defaults it rather than leaving it out',
      C.publicClubPayload({ id: 'c1' }).photo === '');
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
