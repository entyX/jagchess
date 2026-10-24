/* ═══════════════════════════════════════════════════════════════════════
   tests/mail.test.mjs — the stationery a JagChess email is wrapped in, the
   message that carries it, and the faces it can be written in.

   An email is the one thing here nobody can look at after it has gone, so
   the parts that can be checked without a mailbox are checked hard: the
   HTML a client will be handed, and the RFC 822 message Gmail is asked to
   send. Both are pure string work. Anything needing a canvas — measuring a
   badge, redrawing a WebP as a PNG — is in pending.browser.test.mjs
   instead, because it genuinely needs a browser.

   Run it with:  node tests/mail.test.mjs
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const load = async (rel) => import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(fs.readFileSync(path.join(root, rel), 'utf8')));

const G = await load('assets/js/gmail-send.js');
const F = await load('assets/js/mail-fonts.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL: ' + name + (extra === undefined ? '' : ' — ' + String(extra).slice(0, 200)));
};

/* ═══ THE STATIONERY ══════════════════════════════════════════════════ */

const BODY = '<p style="margin:0 0 14px">Boards out at first lunch.</p>';
const plain = G.wrapEmail('Club Fair', BODY, 'NC Chess', 'North Creek Chess Club');

{
  ok('it is a whole document', /^<!doctype html>/i.test(plain));
  ok('the subject is the headline', plain.includes('>Club Fair</h1>'));
  ok('the message survives verbatim', plain.includes(BODY));
  ok('the club is on the masthead', plain.includes('North Creek Chess Club'));
  ok('and who sent it is in the footer', /Sent by NC Chess/.test(plain));
  ok('replies are explained', /reply to this email/.test(plain));

  /* Navy, not the green it used to be, and not the club's own colour: a
     badge colour chosen for a bright page is a different question from a
     header bar. */
  ok('the bar is navy', plain.includes(G.BRAND_NAVY) && G.BRAND_NAVY === '#16264d', G.BRAND_NAVY);
  ok('and there is no green left anywhere', !/#58cc02|#46a302/i.test(plain));

  ok('PT Serif is the face', plain.includes("'PT Serif'"));
  ok('with faces to fall back on that everybody has',
    /Georgia/.test(plain) && /serif/.test(plain));
  ok('and Outlook, which fetches no webfont, is told what to use instead',
    /\[if mso\][\s\S]*Georgia/.test(plain));
}

{
  /* 600px leaves a third of a modern reading pane empty each side. */
  const width = /width:100%;max-width:(\d+)px/.exec(plain);
  ok('the card fills a modern reading pane', Number(width[1]) === 1240, width && width[1]);
  ok('but still fluid under that', /width:100%;max-width:1240px/.test(plain));
  ok('and Word, which ignores max-width, is given a real one',
    /\[if mso\]><table[^>]*width="1240"/.test(plain), plain.match(/\[if mso\]><table[^>]*/));
  ok('it narrows its padding on a phone', /@media only screen and \(max-width:700px\)/.test(plain));
  /* Wider means longer lines, which bigger type pulls back in. */
  ok('and the body is set large enough for the measure', /font:400 19px\/1\.7/.test(plain));
  /* Every padding in the card comes off the one gutter, so the masthead,
     the heading, the writing and the footer all share a left edge. */
  const edges = [...plain.matchAll(/jc-pad[^>]*padding:[\d.]+px (\d+)px/g)].map((m) => Number(m[1]));
  ok('and every edge inside the card lines up',
    edges.length >= 4 && new Set(edges).size === 1, edges);
}

{
  /* Without one, every client fills the preview line with whatever text
     comes first, which here is the club's name for a second time. */
  ok('there is a preview line', /North Creek Chess Club — Club Fair/.test(plain));
  ok('and it is hidden from the message itself', /display:none;max-height:0/.test(plain));
}

/* ── the masthead picture ─────────────────────────────────────────── */

{
  const withLogo = G.wrapEmail('Hi', BODY, 'Me', 'Club',
    { logo: { src: 'cid:clublogo', width: 64, height: 64 }, color: '#a05cf7' });
  ok('a logo is drawn where the glyph was', withLogo.includes('src="cid:clublogo"'));
  /* A plate behind a badge is a frame nobody asked for, and a logo with a
     shape of its own reads better without one. The card underneath is still
     white; the cell holding the picture is not. */
  const cell = /<td[^>]*>\s*<img src="cid:clublogo"/.exec(withLogo);
  ok('and it sits straight on the navy, with nothing behind it',
    !!cell && !/background/.test(cell[0]), cell && cell[0]);
  ok('so the club colour is not used when there is a badge',
    !withLogo.includes('#a05cf7'));
  /* Word's layout ignores CSS on an image; without real attributes it
     prints a 256px badge at 256px. */
  ok('with width and height as attributes, not only as style',
    /width="64" height="64"/.test(withLogo));
  ok('and no knight beside it', !withLogo.includes('♞'));

  const url = G.wrapEmail('Hi', BODY, 'Me', 'Club',
    { logo: { src: 'https://jagchess.web.app/assets/img/jagchess-mark.png', width: 46, height: 46 } });
  ok('a remote address works the same way',
    url.includes('src="https://jagchess.web.app/assets/img/jagchess-mark.png"'));

  /* No badge: the square the club wears everywhere else on the site —
     its own colour, its own glyph, which is what people know it by. */
  const glyph = G.wrapEmail('Hi', BODY, 'Me', 'Club', { icon: '♠', color: '#a05cf7' });
  ok('a club with no badge shows its own glyph', glyph.includes('♠'));
  ok('on a square in its own colour', glyph.includes('background:#a05cf7'));
  ok('not a hardcoded knight', !glyph.includes('♞'));
  ok('and a club with neither still gets something',
    G.wrapEmail('Hi', BODY, 'Me', 'Club').includes('♞'));
  ok('on a square that at least matches the bar',
    G.wrapEmail('Hi', BODY, 'Me', 'Club').includes('background:' + G.BRAND_NAVY_SOFT));
  ok('and a colour cannot break out of the style it sits in',
    !/background:[^;"]*<script/.test(
      G.wrapEmail('Hi', BODY, 'Me', 'Club', { icon: 'x', color: '"><script>' })));
}

/* ── nothing typed in becomes markup ──────────────────────────────── */

{
  const nasty = G.wrapEmail('<script>alert(1)</script>', BODY, '"><b>me', '<img src=x onerror=1>');
  ok('a subject cannot carry a tag', !/<script>/.test(nasty));
  ok('nor can a club name', !/<img src=x/.test(nasty));
  ok('nor can a sender', !/"><b>/.test(nasty));
  ok('and the escaped text is still readable', /&lt;script&gt;/.test(nasty));

  /* The body is the one thing that is deliberately raw — it is the rich
     text an admin wrote, and it has already been built as mail-safe HTML
     by whoever is sending. */
  ok('the message itself is left alone', nasty.includes(BODY));
}

/* ═══ THE MESSAGE ═════════════════════════════════════════════════════ */

const base = {
  fromEmail: 'me@school.org', fromName: 'Mr Lee',
  to: 'them@school.org', bcc: [], subject: 'Club Fair', html: '<p>hi</p>',
};

{
  const mime = G.buildMime(base);
  ok('a plain message is one part', /^Content-Type: text\/html; charset=UTF-8$/m.test(mime));
  ok('with no boundary anywhere near it', !/boundary/.test(mime));
  ok('headers are split from the body by a blank line', mime.includes('\r\n\r\n<p>hi</p>'));
  ok('the sender is named', /^From: Mr Lee <me@school\.org>$/m.test(mime));

  const bcc = G.buildMime({ ...base, bcc: ['a@x.org', 'b@x.org'] });
  ok('a mailing hides its list in Bcc', /^Bcc: a@x\.org, b@x\.org$/m.test(bcc));
  ok('and a message to one person carries no Bcc header at all', !/^Bcc:/m.test(mime));

  const reply = G.buildMime({ ...base, replyTo: 'admin@school.org', replyToName: 'Ada' });
  ok('replies can be pointed elsewhere', /^Reply-To: Ada <admin@school\.org>$/m.test(reply));
  ok('but not at the sender, who would get them anyway',
    !/^Reply-To:/m.test(G.buildMime({ ...base, replyTo: 'me@school.org' })));

  const utf8 = G.buildMime({ ...base, subject: 'Café ♞ night' });
  ok('a subject that is not ASCII is encoded', /^Subject: =\?UTF-8\?B\?/m.test(utf8),
    /^Subject:.*$/m.exec(utf8));
}

{
  /* A club badge lives as a data URL in its own document, and a data URL in
     an img is stripped by every mail client there is. Sent as a related
     part it arrives. */
  const inline = {
    cid: 'clublogo', contentType: 'image/png', filename: 'logo.png',
    base64: 'A'.repeat(200),
  };
  const mime = G.buildMime({ ...base, html: '<img src="cid:clublogo">', inline });

  const mark = /boundary="([^"]+)"/.exec(mime);
  ok('a message with a picture is multipart/related',
    /^Content-Type: multipart\/related; type="text\/html"; boundary=/m.test(mime));
  ok('related, not mixed — it is part of the page, not an attachment',
    !/multipart\/mixed/.test(mime));
  ok('the boundary is declared once and used three times',
    mime.split('--' + mark[1]).length === 4, mime.split('--' + mark[1]).length);
  ok('it ends on the closing boundary', mime.trimEnd().endsWith(`--${mark[1]}--`));

  ok('the html is still in there', mime.includes('<img src="cid:clublogo">'));
  ok('the picture answers to the id the html asks for', /^Content-ID: <clublogo>$/m.test(mime));
  ok('and is marked inline rather than attached',
    /^Content-Disposition: inline; filename="logo\.png"$/m.test(mime));
  ok('its type is carried', /^Content-Type: image\/png; name="logo\.png"$/m.test(mime));
  ok('and it is base64', /^Content-Transfer-Encoding: base64$/m.test(mime));

  /* RFC 2045 caps a base64 line at 76 characters. Gmail forgives one long
     line; a couple of gateways in between do not. */
  const payload = mime.slice(mime.indexOf('Content-ID')).split('\r\n\r\n')[1].split('\r\n--')[0];
  const lines = payload.split('\r\n');
  ok('the payload is wrapped', lines.length > 1, lines.length);
  ok('at 76 characters or fewer', lines.every((l) => l.length <= 76),
    Math.max(...lines.map((l) => l.length)));
  ok('and nothing is lost in the wrapping', lines.join('') === inline.base64);
}

/* ═══ THE FACES ═══════════════════════════════════════════════════════ */

{
  ok('PT Serif is the one offered first', F.MAIL_FONTS[0].name === 'PT Serif');
  ok('and it is the default the rest of the mail is set in',
    F.MAIL_FONTS[0].stack === F.MAIL_SERIF);
  ok('the default is what the stationery uses', plain.includes(F.MAIL_SERIF));
  ok('there are serifs and sans-serifs to choose between',
    F.MAIL_FONTS.some((f) => /sans-serif$/.test(f.stack)) &&
    F.MAIL_FONTS.some((f) => /[^-]serif$/.test(f.stack)));
  ok('and a monospace', F.MAIL_FONTS.some((f) => /monospace$/.test(f.stack)));

  /* Every stack has to end on something the reader's machine already has,
     because a mail client is under no obligation to fetch a webfont and
     Gmail never does. */
  ok('every one of them ends on a generic family',
    F.MAIL_FONTS.every((f) => /(?:^|,\s*)(serif|sans-serif|monospace)$/.test(f.stack)),
    F.MAIL_FONTS.filter((f) => !/(serif|sans-serif|monospace)$/.test(f.stack)).map((f) => f.name));
  ok('and none of them is only a webfont',
    F.MAIL_FONTS.every((f) => f.stack.split(',').length >= 2));

  const html = F.fontSelectHTML('nw-font');
  ok('the control knows its id', html.includes('id="nw-font"'));
  ok('one option per face', (html.match(/<option/g) || []).length === F.MAIL_FONTS.length);
  ok('each drawn in the face it names', /style="font-family:'PT Serif'/.test(html));
  /* A stack is written with single quotes inside a double-quoted
     attribute. A double quote in one would close the attribute early and
     hand the rest of it to the parser as markup. */
  ok('no stack carries a quote that would break out of the attribute',
    F.MAIL_FONTS.every((f) => !f.stack.includes('"')),
    F.MAIL_FONTS.filter((f) => f.stack.includes('"')).map((f) => f.name));
  ok('and every option value survives as one attribute',
    (html.match(/<option value="/g) || []).length === F.MAIL_FONTS.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
