/* ═══════════════════════════════════════════════════════════════════════
   match-links.js — "send this to a friend and we'll play".

     matchLinks/{code}   the offer: terms, who made it, who took it

   A link is a one-shot seat. The first signed-in person who opens it and is
   allowed to use it becomes the opponent, the game is created inside a
   transaction, and the link is spent. Nobody else can take it afterwards.

   Two rules decide "allowed to use it":
     global link  — anybody signed in
     club link    — members of that club only, checked against the real
                    membership document rather than anything on the link

   Both sides must be signed in, which is the whole reason the claim runs as
   a transaction against the creator's own snapshot: the game is built from
   two real players or it is not built at all.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, doc, collection, getDoc, setDoc, updateDoc, onSnapshot, runTransaction,
  memberRef, makeCode, esc, toast
} from './club-core.js';

import { readRating } from './glicko2.js';
import {
  buildGame, playerSnap, duelsCol, tcLabel, tcCategory, TIME_CONTROLS
} from './club-duels.js';

const linkCol = () => collection(db, 'matchLinks');
const linkRef = (id) => doc(db, 'matchLinks', id);
const userRef = (uid) => doc(db, 'users', uid);

/* Long enough that guessing one is pointless, short enough to read aloud. */
const newLinkId = () => makeCode(4) + makeCode(4);

export const LINK_TTL = 24 * 60 * 60 * 1000;

export const matchLinkURL = (id) => `${location.origin}/m/${encodeURIComponent(id)}`;

export const linkIsLive = (l) =>
  !!l && l.status === 'open' && Date.now() - l.createdAt < LINK_TTL;

/* ── creating ──────────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {'club'|'global'} o.scope
 * @param {string|null} o.clubId
 * @param {string} o.clubName    only for the "club members only" line
 * @param {boolean} o.rated
 * @param {{initial:number,increment:number}} o.tc
 * @param {'white'|'black'|'random'} o.color  the color the *creator* wants
 * @param {object} o.me          a playerSnap of the creator
 */
export async function createMatchLink(o) {
  const id = newLinkId();
  await setDoc(linkRef(id), {
    from: o.me,
    scope: o.scope,
    clubId: o.scope === 'club' ? o.clubId : null,
    clubName: o.scope === 'club' ? (o.clubName || 'the club') : null,
    rated: !!o.rated,
    color: o.color || 'random',
    tc: o.tc,
    status: 'open',
    createdAt: Date.now(),
    claimedBy: null,
    gameId: null
  });
  return id;
}

/* ── claiming ──────────────────────────────────────────────────────── */

export class LinkError extends Error {
  constructor(code, message) { super(message); this.name = 'LinkError'; this.code = code; }
}

/* Why a link might refuse you. Each one is a different sentence on screen,
   because "that didn't work" helps nobody. */
export async function claimMatchLink(id, user) {
  const snap = await getDoc(linkRef(id));
  if (!snap.exists()) throw new LinkError('missing', 'That match link does not exist.');
  const link = { id, ...snap.data() };

  if (link.gameId && (link.from.uid === user.uid || link.claimedBy === user.uid)) {
    return { link, gameId: link.gameId, rejoined: true };
  }
  if (link.status === 'cancelled') throw new LinkError('cancelled', 'Whoever made this link cancelled it.');
  if (link.status !== 'open') throw new LinkError('taken', 'Somebody has already taken this match.');
  if (Date.now() - link.createdAt >= LINK_TTL) throw new LinkError('expired', 'This match link has expired. Links last 24 hours.');
  if (link.from.uid === user.uid) throw new LinkError('own', 'This is your own match link — send it to somebody else.');

  // a club link is checked against the club, not against anything on the link
  if (link.scope === 'club') {
    const mem = await getDoc(memberRef(link.clubId, user.uid)).catch(() => null);
    if (!mem || !mem.exists()) {
      throw new LinkError('not-member',
        `This match link is for members of ${link.clubName || 'a club'} only.`);
    }
  }

  const profile = await getDoc(link.scope === 'club' ? memberRef(link.clubId, user.uid) : userRef(user.uid))
    .catch(() => null);
  const source = (profile && profile.exists() && profile.data()) || {};

  const me = playerSnap(
    user.uid,
    source.username || user.displayName || (user.email || '').split('@')[0] || 'Player',
    source.avatarColor,
    readRating(source),
    source
  );

  // the creator picked their side, so the claimant gets whatever is left
  const gameId = await runTransaction(db, async (tx) => {
    const fresh = await tx.get(linkRef(id));
    if (!fresh.exists()) throw new LinkError('missing', 'That match link does not exist.');
    const l = fresh.data();
    if (l.status !== 'open') throw new LinkError('taken', 'Somebody has already taken this match.');

    const sides = assignSides(l.color, l.from, me);
    const ref = doc(duelsCol());
    tx.set(ref, buildGame({
      scope: l.scope,
      clubId: l.clubId,
      rated: l.rated,
      tc: l.tc,
      white: sides.white,
      black: sides.black
    }));
    tx.update(linkRef(id), {
      status: 'claimed',
      claimedBy: user.uid,
      claimedName: me.username,
      claimedAt: Date.now(),
      gameId: ref.id
    });
    return ref.id;
  });

  return { link, gameId, rejoined: false };
}

function assignSides(creatorWants, creator, claimant) {
  let creatorWhite;
  if (creatorWants === 'white') creatorWhite = true;
  else if (creatorWants === 'black') creatorWhite = false;
  else creatorWhite = Math.random() < 0.5;
  return creatorWhite
    ? { white: creator, black: claimant }
    : { white: claimant, black: creator };
}

export const cancelMatchLink = (id) =>
  updateDoc(linkRef(id), { status: 'cancelled' }).catch(() => {});

export const watchMatchLink = (id, cb) =>
  onSnapshot(linkRef(id), (s) => cb(s.exists() ? { id, ...s.data() } : null), () => {});

/* ═══════════════════════════════════════════════════════════════════ */
/*  THE SHEET — set the terms, get the link, wait for somebody          */
/* ═══════════════════════════════════════════════════════════════════ */

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

/**
 * @param {object} ctx     the club ctx, or a global-only one (clubId null)
 * @param {object} opts
 * @param {object} opts.ratings   from loadMyRatings
 * @param {'club'|'global'} [opts.scope]
 */
export function openMatchLinkSheet(ctx, opts = {}) {
  const globalOnly = !ctx.clubId;
  const state = {
    scope: globalOnly ? 'global' : (opts.scope || 'club'),
    tcId: opts.tcId || '5+3',
    color: opts.color || 'random',
    rated: opts.rated !== false
  };

  const sheet = el(`
    <div class="modal ml-modal">
      <div class="modal-card ml-card">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <div data-step="setup">
          <h3>Send a match link</h3>
          <p class="modal-meta" style="margin:0 0 4px">
            Pick the terms, and we'll make a link you can send to anyone. The game starts
            the moment they open it.
          </p>

          <div class="duel-field"${globalOnly ? ' hidden' : ''}>
            <label>Where</label>
            <div class="duel-seg" id="ml-scope">
              <button class="duel-seg-opt" data-v="club">In the club</button>
              <button class="duel-seg-opt" data-v="global">Global</button>
            </div>
            <small class="duel-hint" id="ml-scope-hint"></small>
          </div>

          <div class="duel-field">
            <label for="ml-tc">Time control</label>
            <select id="ml-tc"></select>
          </div>

          <div class="duel-field">
            <label>Your color</label>
            <div class="duel-seg colors" id="ml-color">
              <button class="duel-seg-opt" data-v="white"><span class="duel-piece w">♔</span>White</button>
              <button class="duel-seg-opt" data-v="random"><span class="duel-piece r">⁇</span>Random</button>
              <button class="duel-seg-opt" data-v="black"><span class="duel-piece b">♚</span>Black</button>
            </div>
          </div>

          <div class="duel-field">
            <label>Stakes</label>
            <div class="duel-seg" id="ml-rated">
              <button class="duel-seg-opt" data-v="rated">Rated</button>
              <button class="duel-seg-opt" data-v="casual">Casual</button>
            </div>
          </div>

          <button class="btn primary lg block" id="ml-make">Create match link</button>
        </div>

        <div data-step="wait" hidden>
          <h3>Your match link</h3>
          <p class="modal-meta" style="margin:0 0 4px">
            Send it however you like — JagChess doesn't post it anywhere.
          </p>
          <div class="ml-url-row">
            <input id="ml-url" readonly />
            <button class="btn primary" id="ml-copy">Copy</button>
          </div>
          <div class="ml-terms" id="ml-terms"></div>
          <div class="ml-who" id="ml-who"></div>
          <div class="ml-waiting" id="ml-waiting">
            <span class="ml-pulse"></span>
            <span>Waiting for someone to open it…</span>
          </div>
          <div class="ml-foot">
            <button class="btn subtle" id="ml-cancel">Cancel this link</button>
            <button class="btn subtle" id="ml-done">Close</button>
          </div>
          <p class="field-hint" style="margin:10px 0 0">
            The link works for 24 hours, for one opponent. You can close this window —
            the game will be waiting on your duels page when they take it.
          </p>
        </div>
      </div>
    </div>`);

  document.body.appendChild(sheet);

  const q = (sel) => sheet.querySelector(sel);
  let stopWatch = null;
  let linkId = null;

  const close = () => {
    if (stopWatch) stopWatch();
    sheet.remove();
  };
  q('[data-x]').onclick = close;
  q('#ml-done').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };

  /* ── time controls ── */
  const tcSel = q('#ml-tc');
  let lastCat = '';
  tcSel.innerHTML = TIME_CONTROLS.map((t) => {
    const head = t.cat !== lastCat ? (lastCat ? '</optgroup>' : '') + `<optgroup label="${t.cat}">` : '';
    lastCat = t.cat;
    return head + `<option value="${t.id}">${t.min} + ${t.inc}</option>`;
  }).join('') + '</optgroup>';
  tcSel.value = state.tcId;
  tcSel.onchange = () => { state.tcId = tcSel.value; };

  /* ── segmented controls ── */
  const paint = () => {
    const on = (id, val) => sheet.querySelectorAll('#' + id + ' [data-v]')
      .forEach((b) => b.classList.toggle('on', b.dataset.v === val));
    on('ml-scope', state.scope);
    on('ml-color', state.color);
    on('ml-rated', state.rated ? 'rated' : 'casual');
    const hint = q('#ml-scope-hint');
    if (hint) {
      hint.textContent = state.scope === 'club'
        ? `Only members of ${(ctx.club && ctx.club.name) || 'this club'} can use the link.`
        : 'Anybody signed in to JagChess can use the link.';
    }
  };
  const seg = (id, key) => {
    const wrap = q('#' + id);
    if (!wrap) return;
    wrap.onclick = (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      state[key] = key === 'rated' ? b.dataset.v === 'rated' : b.dataset.v;
      paint();
    };
  };
  seg('ml-scope', 'scope');
  seg('ml-color', 'color');
  seg('ml-rated', 'rated');
  paint();

  /* ── make it ── */
  q('#ml-make').onclick = async () => {
    const btn = q('#ml-make');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const t = TIME_CONTROLS.find((x) => x.id === state.tcId) || TIME_CONTROLS[5];
      const tc = { initial: t.min * 60000, increment: t.inc * 1000 };
      const ratings = opts.ratings || { club: readRating(ctx.member), global: readRating(ctx.member), sources: {} };
      const mine = state.scope === 'club' ? ratings.club : ratings.global;
      const source = state.scope === 'club'
        ? ((ratings.sources && ratings.sources.club) || ctx.member || {})
        : ((ratings.sources && ratings.sources.global) || {});

      const me = playerSnap(
        ctx.user.uid,
        (ctx.member && ctx.member.username) || (ctx.user.email || '').split('@')[0],
        ctx.member && ctx.member.avatarColor,
        mine, source
      );

      linkId = await createMatchLink({
        scope: state.scope,
        clubId: ctx.clubId,
        clubName: (ctx.club && ctx.club.name) || '',
        rated: state.rated,
        tc,
        color: state.color,
        me
      });

      q('[data-step="setup"]').hidden = true;
      q('[data-step="wait"]').hidden = false;
      q('#ml-url').value = matchLinkURL(linkId);
      q('#ml-terms').innerHTML = `
        <span class="duel-pill">${tcLabel(tc)} ${tcCategory(tc)}</span>
        <span class="duel-pill ${state.rated ? 'rated' : ''}">${state.rated ? 'Rated' : 'Casual'}</span>
        <span class="duel-pill soft">${state.scope === 'club' ? esc((ctx.club && ctx.club.name) || 'Club') + ' only' : 'Anyone'}</span>`;
      q('#ml-who').innerHTML = state.scope === 'club'
        ? `<b>Who can use this</b><span>Only members of ${esc((ctx.club && ctx.club.name) || 'this club')}, signed in.</span>`
        : '<b>Who can use this</b><span>Anybody signed in to JagChess.</span>';
      setTimeout(() => { q('#ml-url').select(); }, 40);

      stopWatch = watchMatchLink(linkId, (l) => {
        if (!l) return;
        if (l.status === 'claimed' && l.gameId) {
          q('#ml-waiting').innerHTML =
            `<span class="ml-pulse on"></span><span>${esc(l.claimedName || 'Someone')} took it — starting…</span>`;
          setTimeout(() => { close(); location.hash = 'duel/' + l.gameId; }, 700);
        }
      });
    } catch (e) {
      console.error(e);
      toast(e.message || 'Could not create that link.', 'error');
      btn.disabled = false;
      btn.textContent = 'Create match link';
    }
  };

  q('#ml-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(q('#ml-url').value);
      toast('Match link copied', 'ok');
    } catch {
      q('#ml-url').select();
      toast('Press Ctrl+C to copy', 'error');
    }
  };

  q('#ml-cancel').onclick = async () => {
    if (linkId) await cancelMatchLink(linkId);
    toast('Match link cancelled');
    close();
  };
}
