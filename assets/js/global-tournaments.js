/* ═══════════════════════════════════════════════════════════════════════
   global-tournaments.js — /tournaments, open to anybody signed in.

   Identical to a club's Tournaments block, with clubId null: anyone can host,
   anyone can enter, and a rated event moves the global rating rather than a
   club one.

   Four screens live behind the hash:

     (nothing)                     the list — JagChess arenas and lichess
                                   tournaments together
     tournament/<id>               one JagChess arena
     lichess/<id>                  one lichess tournament, live
     lichess/<id>/game/<gameId>    one lichess game, played or watched
     lichess-player/<username>     one player across every stored tournament

   A path is accepted as well as a hash, so /tournaments/<id>,
   /tournaments/<id>/games/<gameId> and /players/<username> all work and are
   rewritten to the hash the rest of the site routes on.
   ═══════════════════════════════════════════════════════════════════════ */

import { bootHub, hashRouter } from './hub-shell.js';
import { renderTournaments, renderTournamentView } from './tournaments-ui.js';
import {
  renderLichessTournament, renderLichessGame, renderLichessPlayer, hashFor
} from './lichess-ui.js';
import { closeLichessGame } from './lichess-board.js';
import { startSync } from './lichess-sync.js';
import { verify } from './lichess-auth.js';
import { linkAccount } from './lichess-store.js';
import {
  openDuelStage, closeDuelStage, closeDuelWaiting,
  watchChallenges, watchActiveDuels, gameOf
} from './club-duels.js';

const $ = (id) => document.getElementById(id);

/**
 * /tournaments/<something> is turned into the matching hash before the
 * router ever sees it. Hosting rewrites the path to this page, so without
 * this the address would load the list and lose the id.
 */
function adoptPath() {
  const player = /^\/players\/([^/]+)\/?$/.exec(location.pathname);
  if (player) {
    history.replaceState(null, '', '/tournaments#lichess-player/' + player[1]);
    return;
  }
  const m = /^\/tournaments\/([^/]+)(?:\/games?\/([^/]+))?\/?$/.exec(location.pathname);
  if (!m) return;
  const hash = m[2] ? `lichess/${m[1]}/game/${m[2]}` : hashFor(m[1]);
  history.replaceState(null, '', '/tournaments#' + hash);
}

(async function init() {
  adoptPath();
  const ctx = await bootHub('tournaments');

  $('hub-boot').hidden = true;
  $('hub-body').hidden = false;

  watchChallenges(ctx);

  /* A token that lichess has revoked is worse than no token, because every
     action would fail in a way that looks like our bug. One call settles it. */
  verify().then((s) => {
    if (s) linkAccount(ctx.user.uid, s).catch(() => {});
  });

  /* This page is where lichess tournaments are read, so it is a sensible
     place to offer to be the tab that syncs them. The lease inside decides
     whether this tab actually does any work. */
  startSync(ctx);

  const resume = $('hub-resume');
  watchActiveDuels((games) => {
    const mine = gameOf(games, ctx.user.uid);
    resume.hidden = !mine;
    if (mine) resume.onclick = () => { location.hash = 'duel/' + mine.id; };
  });

  hashRouter(async (raw) => {
    const duel = /^duel\/(.+)$/.exec(raw);
    const tourn = /^tournament\/(.+)$/.exec(raw);
    const liGame = /^lichess\/([^/]+)\/game\/([^/]+)$/.exec(raw);
    const li = /^lichess\/([^/]+)$/.exec(raw);
    const player = /^lichess-player\/(.+)$/.exec(raw);

    if (!duel) closeDuelStage();
    if (!liGame) closeLichessGame();
    closeDuelWaiting();

    const host = $('hub-main');
    const head = $('hub-head');
    host.innerHTML = '';

    /* A tournament takes the whole page, so the standing page heading goes
       away — its own hero says everything that heading would. */
    let cleanup;
    if (tourn) {
      head.hidden = true;
      cleanup = await renderTournamentView(ctx, host, tourn[1], { listHash: '' });
    } else if (li) {
      head.hidden = true;
      cleanup = await renderLichessTournament(ctx, host, li[1], { listHash: '' });
    } else if (player) {
      head.hidden = true;
      cleanup = await renderLichessPlayer(ctx, host, player[1], { listHash: '' });
    } else if (liGame) {
      /* The board is a layer over the tournament page, the same way a duel
         is a layer over the duels list. */
      head.hidden = true;
      cleanup = await renderLichessTournament(ctx, host, liGame[1], { listHash: '' });
    } else {
      // the duel stage is a layer too; keep the list underneath it.
      // The ranked hero says what the page heading would.
      head.hidden = true;
      cleanup = await renderTournaments(ctx, host, {});
    }

    if (duel) openDuelStage(ctx, duel[1]);
    if (liGame) await renderLichessGame(ctx, host, liGame[1], liGame[2], {});
    return cleanup;
  });
})();
