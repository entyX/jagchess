/* ═══════════════════════════════════════════════════════════════════════
   play.js — /play, a global game without opening a club first.

   It is the club duels page with clubId set to null, so the "In the club"
   half of the interface folds away and everything is global. The game stage,
   the matchmaking queue, direct challenges and match links are all the same
   code the club uses.
   ═══════════════════════════════════════════════════════════════════════ */

import { bootHub, hashRouter } from './hub-shell.js';
import {
  renderDuels, openDuelStage, closeDuelStage, closeDuelWaiting,
  watchChallenges, watchActiveDuels, gameOf
} from './club-duels.js';

const $ = (id) => document.getElementById(id);

(async function init() {
  const ctx = await bootHub('play');

  $('hub-boot').hidden = true;
  $('hub-body').hidden = false;

  watchChallenges(ctx);

  /* The same "you have a game running" chip the club shell shows, so closing
     the tab mid-game never loses the game. */
  const resume = $('hub-resume');
  watchActiveDuels((games) => {
    const mine = gameOf(games, ctx.user.uid);
    resume.hidden = !mine;
    if (mine) resume.onclick = () => { location.hash = 'duel/' + mine.id; };
  });

  hashRouter(async (raw) => {
    const duel = /^duel\/(.+)$/.exec(raw);
    if (!duel) closeDuelStage();
    closeDuelWaiting();

    const host = $('hub-main');
    host.innerHTML = '';
    const cleanup = await renderDuels(ctx, host, {});

    if (duel) openDuelStage(ctx, duel[1]);
    return cleanup;
  });
})();
