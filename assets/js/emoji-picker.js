/* ═══════════════════════════════════════════════════════════════════════
   emoji-picker.js — a small emoji menu for the rich-text toolbars.

   The one thing that makes or breaks a picker like this is the caret. A
   toolbar button steals focus the moment it is pressed, and an editor that
   has lost focus has lost the cursor with it — so every press here cancels
   its own mousedown instead. Nothing ever takes focus away from the editor,
   which means there is no selection to save and restore, and no chance of
   an emoji landing at the top of the document instead of where you were
   typing.

   Insertion goes through `insertText`, so it joins the browser's own undo
   stack: one ctrl-Z takes the emoji back out.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc } from './club-core.js';

/* Each entry is [emoji, search words]. Kept deliberately short — a few
   hundred people actually use, not every code point that exists. */
const GROUPS = [
  ['Smileys', [
    ['😀', 'grin smile happy'], ['😃', 'smile happy joy'], ['😄', 'smile happy laugh'],
    ['😁', 'grin beam happy'], ['😆', 'laugh satisfied'], ['😅', 'sweat laugh relief'],
    ['🤣', 'rofl laughing floor'], ['😂', 'joy tears laugh cry'], ['🙂', 'slight smile'],
    ['🙃', 'upside down silly'], ['😉', 'wink'], ['😊', 'blush smile happy'],
    ['😇', 'innocent halo angel'], ['🥰', 'love hearts adore'], ['😍', 'heart eyes love'],
    ['😘', 'kiss blow'], ['😗', 'kissing'], ['😋', 'yum tasty tongue'],
    ['😛', 'tongue cheeky'], ['🤪', 'zany goofy wild'], ['🤨', 'raised eyebrow suspicious'],
    ['🧐', 'monocle inspect'], ['🤓', 'nerd glasses study'], ['😎', 'cool sunglasses'],
    ['🥳', 'party celebrate birthday'], ['😏', 'smirk'], ['😒', 'unamused meh'],
    ['😞', 'disappointed sad'], ['😔', 'pensive sad'], ['😕', 'confused'],
    ['🙁', 'frown sad'], ['😣', 'persevere struggle'], ['😖', 'confounded'],
    ['😫', 'tired weary'], ['😩', 'weary tired'], ['🥺', 'pleading please puppy'],
    ['😢', 'cry sad tear'], ['😭', 'sob crying loud'], ['😤', 'triumph steam determined'],
    ['😠', 'angry mad'], ['😡', 'rage furious'], ['🤯', 'mind blown explode'],
    ['😳', 'flushed surprised'], ['🥵', 'hot heat'], ['🥶', 'cold freezing'],
    ['😱', 'scream fear shock'], ['😨', 'fearful scared'], ['😰', 'anxious sweat'],
    ['🤔', 'thinking hmm think'], ['🤫', 'shush quiet'], ['🤐', 'zipper silence'],
    ['😐', 'neutral'], ['😑', 'expressionless'], ['😶', 'no mouth speechless'],
    ['🙄', 'eye roll'], ['😬', 'grimace awkward'], ['🤥', 'lying pinocchio'],
    ['😴', 'sleep zzz'], ['🤒', 'sick thermometer'], ['🤕', 'hurt bandage'],
    ['🥱', 'yawn bored tired'], ['😵', 'dizzy knocked out']
  ]],
  ['People', [
    ['👍', 'thumbs up yes good like'], ['👎', 'thumbs down no bad'], ['👏', 'clap applause bravo'],
    ['🙌', 'raise hands celebrate praise'], ['👋', 'wave hello hi bye'], ['🤝', 'handshake deal agree'],
    ['🙏', 'pray thanks please'], ['💪', 'strong muscle flex'], ['✌️', 'peace victory'],
    ['🤞', 'fingers crossed luck'], ['👌', 'ok perfect'], ['🤙', 'call me shaka'],
    ['👇', 'point down below'], ['👉', 'point right'], ['👈', 'point left'],
    ['☝️', 'point up'], ['✍️', 'writing hand sign'], ['🫡', 'salute respect'],
    ['🧠', 'brain smart think'], ['👀', 'eyes look see'], ['🗣️', 'speaking announce'],
    ['👤', 'person user'], ['👥', 'people users group'], ['🧑‍🏫', 'teacher coach'],
    ['🧑‍🎓', 'student graduate'], ['👑', 'crown king queen champion']
  ]],
  ['Chess', [
    ['♟️', 'pawn chess'], ['♞', 'knight chess horse'], ['♝', 'bishop chess'],
    ['♜', 'rook chess castle'], ['♛', 'queen chess'], ['♚', 'king chess'],
    ['♙', 'white pawn chess'], ['♘', 'white knight chess'], ['♗', 'white bishop chess'],
    ['♖', 'white rook chess'], ['♕', 'white queen chess'], ['♔', 'white king chess'],
    ['🏁', 'checkered flag finish end'], ['⏱️', 'stopwatch clock time blitz'],
    ['⏳', 'hourglass time'], ['🧩', 'puzzle tactics'], ['🎯', 'target goal aim'],
    ['🤝', 'draw handshake agree']
  ]],
  ['Activity', [
    ['🏆', 'trophy win champion first'], ['🥇', 'gold medal first'], ['🥈', 'silver medal second'],
    ['🥉', 'bronze medal third'], ['🎖️', 'medal award'], ['🏅', 'medal sports'],
    ['🎉', 'party tada celebrate'], ['🎊', 'confetti celebrate'], ['🎈', 'balloon party'],
    ['🎁', 'gift present prize'], ['🔥', 'fire hot streak'], ['⚡', 'lightning fast energy'],
    ['✨', 'sparkles new shine'], ['💥', 'boom impact'], ['🚀', 'rocket launch fast'],
    ['📈', 'chart up growth rating'], ['📉', 'chart down drop'], ['🎓', 'graduation school'],
    ['🏫', 'school building'], ['♟️', 'chess pawn game'], ['🎮', 'game controller play'],
    ['🎲', 'dice random luck']
  ]],
  ['Objects', [
    ['📅', 'calendar date event'], ['📆', 'calendar day'], ['🗓️', 'calendar spiral'],
    ['⏰', 'alarm clock time'], ['📍', 'pin location place'], ['🗺️', 'map directions'],
    ['📣', 'megaphone announce shout'], ['📢', 'loudspeaker announce'], ['🔔', 'bell notify reminder'],
    ['📝', 'memo note write'], ['📋', 'clipboard list'], ['📌', 'pushpin pin'],
    ['📎', 'paperclip attach'], ['📖', 'book read study'], ['📚', 'books library'],
    ['✉️', 'envelope mail email'], ['📧', 'email mail'], ['💬', 'speech bubble chat'],
    ['💡', 'idea lightbulb tip'], ['🔗', 'link chain url'], ['💻', 'laptop computer'],
    ['📱', 'phone mobile'], ['☕', 'coffee drink'], ['🍕', 'pizza food'],
    ['🍪', 'cookie snack'], ['🥤', 'drink cup']
  ]],
  ['Symbols', [
    ['❤️', 'heart love red'], ['🧡', 'orange heart'], ['💛', 'yellow heart'],
    ['💚', 'green heart'], ['💙', 'blue heart'], ['💜', 'purple heart'],
    ['✅', 'check tick done yes'], ['☑️', 'ballot check done'], ['❌', 'cross no wrong'],
    ['⚠️', 'warning caution'], ['❗', 'exclamation important'], ['❓', 'question'],
    ['⭐', 'star favourite'], ['🌟', 'glowing star'], ['💯', 'hundred perfect score'],
    ['🔴', 'red circle'], ['🟢', 'green circle'], ['🔵', 'blue circle'],
    ['➡️', 'arrow right next'], ['⬅️', 'arrow left back'], ['🔁', 'repeat loop'],
    ['🆕', 'new'], ['🆓', 'free'], ['🔒', 'lock private'], ['🔓', 'unlock public']
  ]]
];

const RECENT_KEY = 'jag.emoji.recent';
const RECENT_MAX = 24;

const readRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, RECENT_MAX); }
  catch { return []; }
};

const rememberRecent = (emoji) => {
  try {
    const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode — the picker still works, it just forgets */ }
};

const ALL = GROUPS.flatMap(([, list]) => list);
const wordsFor = (emoji) => (ALL.find(([e]) => e === emoji) || [, ''])[1];

/**
 * Turns a toolbar button into an emoji menu.
 *
 * @param {HTMLElement} button  the toolbar button to hang the panel off
 * @param {(emoji: string) => void} onPick  called with the chosen character
 * @returns {Function} teardown
 */
export function mountEmojiButton(button, onPick) {
  let panel = null;

  const close = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    button.classList.remove('on');
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const onAway = (e) => {
    if (panel && !panel.contains(e.target) && !button.contains(e.target)) close();
  };

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  const pick = (emoji) => {
    rememberRecent(emoji);
    onPick(emoji);
    close();
  };

  function open() {
    panel = document.createElement('div');
    panel.className = 'emoji-panel';
    panel.innerHTML = `
      <div class="emoji-search">
        <input type="text" placeholder="Search emoji…" autocomplete="off" spellcheck="false" aria-label="Search emoji" />
      </div>
      <div class="emoji-scroll" data-scroll></div>`;

    document.body.appendChild(panel);
    place();
    paint('');

    const input = panel.querySelector('input');

    /* Everything is driven from pointerdown, cancelled before it lands: the
       editor never loses focus, so the caret is still where it was. */
    panel.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('[data-emoji]');
      if (cell) { e.preventDefault(); pick(cell.dataset.emoji); return; }
      if (e.target !== input) e.preventDefault();
    });

    input.addEventListener('input', () => paint(input.value.trim().toLowerCase()));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = panel.querySelector('[data-emoji]');
      if (first) pick(first.dataset.emoji);
    });

    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('keydown', onKey, true);
  }

  function place() {
    const r = button.getBoundingClientRect();
    const width = 318;
    const left = Math.max(10, Math.min(r.left, window.innerWidth - width - 10));
    const below = window.innerHeight - r.bottom;
    panel.style.left = left + 'px';
    if (below > 330) panel.style.top = r.bottom + 8 + 'px';
    else panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  }

  function paint(term) {
    const cell = ([e, words]) =>
      `<button type="button" class="emoji-cell" data-emoji="${esc(e)}" title="${esc(words.split(' ')[0])}" tabindex="-1">${e}</button>`;

    if (term) {
      const hits = ALL.filter(([, words]) => words.includes(term));
      panel.querySelector('[data-scroll]').innerHTML = hits.length
        ? `<div class="emoji-grid">${hits.map(cell).join('')}</div>`
        : '<div class="emoji-none">No emoji match that.</div>';
      return;
    }

    const recent = readRecent();
    const sections = [];
    if (recent.length) {
      sections.push(['Recent', recent.map((e) => [e, wordsFor(e)])]);
    }
    panel.querySelector('[data-scroll]').innerHTML = sections.concat(GROUPS).map(([name, list]) => `
      <div class="emoji-group">
        <div class="emoji-group-name">${esc(name)}</div>
        <div class="emoji-grid">${list.map(cell).join('')}</div>
      </div>`).join('');
  }

  /* The button itself must not take focus either, or the first emoji of a
     session lands nowhere. */
  const onDown = (e) => {
    e.preventDefault();
    if (panel) close();
    else { button.classList.add('on'); open(); }
  };

  button.addEventListener('pointerdown', onDown);
  button.addEventListener('click', (e) => e.preventDefault());

  return () => { close(); button.removeEventListener('pointerdown', onDown); };
}
