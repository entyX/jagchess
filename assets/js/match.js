/* ═══════════════════════════════════════════════════════════════════════
   match.js — /m/<code>, where a match link is opened.

   Everything interesting is in match-links.js; this page is the doorway.
   The one thing it has to get right is the signed-out case: the link is
   preserved through the login round trip, so nobody loses a game because
   they were not logged in when they tapped it.
   ═══════════════════════════════════════════════════════════════════════ */

import { auth, esc, initials } from './club-core.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { claimMatchLink, LinkError } from './match-links.js';
import { tcLabel, tcCategory } from './club-duels.js';
import { displayRating } from './glicko2.js';

const host = document.getElementById('m-root');

const linkId = decodeURIComponent(location.pathname.replace(/^\/m\/?/, '').replace(/\/$/, ''));

const card = (inner, bad) =>
  `<div class="mlp-card${bad ? ' bad' : ''}">${inner}</div>`;

const mark = (glyph) => `<div class="mlp-mark" aria-hidden="true">${glyph}</div>`;

function show(html) { host.innerHTML = html; }

function fail(title, body, actions) {
  show(card(`
    ${mark('✕')}
    <h1>${esc(title)}</h1>
    <p>${esc(body)}</p>
    <div class="mlp-actions">${actions || '<a class="btn primary" href="/play">Play someone else</a>'}</div>`, true));
}

if (!linkId) {
  fail('No match link here', 'That address is missing its link code. Ask whoever sent it to you for the full link.');
} else {
  show(card(`<div class="mlp-spinner"></div><h1>Opening the match…</h1>
    <p>One moment while we check the link.</p>`));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      /* Straight back here after logging in — the link is the whole point. */
      const next = encodeURIComponent(location.pathname);
      show(card(`
        ${mark('♞')}
        <h1>Sign in to play</h1>
        <p>Someone has sent you a game on JagChess. Both players have to be signed in,
           and you will land straight back on this match afterwards.</p>
        <div class="mlp-actions">
          <a class="btn primary lg" href="/login?next=${next}">Sign in</a>
          <a class="btn subtle lg" href="/login?mode=signup&next=${next}">Create an account</a>
        </div>`));
      return;
    }

    try {
      const { link, gameId, rejoined } = await claimMatchLink(linkId, user);
      show(card(`
        ${mark('♞')}
        <h1>${rejoined ? 'Back to your game' : 'Match accepted'}</h1>
        <div class="mlp-from">
          <span class="lb-avatar" style="background:${esc(link.from.avatarColor || '#1cb0f6')}">${esc(initials(link.from.username))}</span>
          <span><b>${esc(link.from.username)}</b></span>
        </div>
        <div class="mlp-terms">
          <span class="tn-pill">${tcLabel(link.tc)} ${tcCategory(link.tc)}</span>
          <span class="tn-pill ${link.rated ? 'rated' : ''}">${link.rated ? 'Rated' : 'Casual'}</span>
          <span class="tn-pill soft">${link.scope === 'club' ? esc(link.clubName || 'Club') : 'Global'}</span>
        </div>
        <p>Taking you to the board…</p>`));

      // a club game belongs on the club's page, so the rating chips read right
      const dest = link.scope === 'club' && link.clubId
        ? `/clubs/${encodeURIComponent(link.clubId)}#duel/${gameId}`
        : `/play#duel/${gameId}`;
      setTimeout(() => { location.replace(dest); }, 900);
    } catch (e) {
      if (e instanceof LinkError) {
        const extra = e.code === 'not-member'
          ? '<a class="btn primary" href="/clubs">Join the club</a><a class="btn subtle" href="/play">Play globally</a>'
          : e.code === 'own'
            ? '<a class="btn primary" href="/play">Back to Play a match</a>'
            : null;
        fail(TITLES[e.code] || 'That link will not open', e.message, extra);
      } else {
        console.error(e);
        fail('Something went wrong', 'We could not open that match. Try the link again in a moment.');
      }
    }
  });
}

const TITLES = {
  missing: 'That link does not exist',
  cancelled: 'This match was called off',
  taken: 'Somebody got there first',
  expired: 'This link has expired',
  own: 'That is your own link',
  'not-member': 'This link is for club members'
};
