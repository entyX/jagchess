# The Lichess integration

What JagChess does with lichess.org, which official endpoints it uses, and —
the part worth reading — what it **cannot** do and why.

Everything below was checked against the official API description at
[github.com/lichess-org/api](https://github.com/lichess-org/api) (OpenAPI
2.0.174) and against live responses from lichess.org. Nothing is scraped, no
browser is automated, and no rate limit, authentication check or fair-play
system is worked around anywhere in this codebase.

---

## What it does

An administrator adds a lichess **team**. From then on the site watches that
team, and every tournament it runs turns into a page here by itself: live
standings, live games, a board you can play on, and a permanent archive once
it is over.

```
lichess APIs  →  one sync worker  →  Firestore  →  every open page
```

| File | What it is |
|---|---|
| `assets/js/lichess-api.js` | every call to lichess.org, and nothing else |
| `assets/js/lichess-auth.js` | OAuth2 authorization code flow with PKCE |
| `assets/js/lichess-store.js` | the Firestore model, and the merge rules |
| `assets/js/lichess-sync.js` | the worker: detection, polling, archiving |
| `assets/js/lichess-live.js` | your own event stream: instant pairing news |
| `assets/js/lichess-ui.js` | the tournament page and the join flow |
| `assets/js/lichess-board.js` | playing and watching a game |
| `assets/js/lichess-create.js` | the Lichess tournament form |
| `assets/js/lichess-admin.js` | team setup and the monitoring panel |

---

## Endpoints used

All of these are in the official description, and all of them answer
`Access-Control-Allow-Origin: *`, which is what makes a browser-side
integration possible at all.

### Public — no token

| Endpoint | Used for |
|---|---|
| `GET /api/team/{teamId}` | validating a team, and its name, size and description |
| `GET /api/team/{teamId}/arena` | detecting arena tournaments (nd-json) |
| `GET /api/team/{teamId}/swiss` | detecting Swiss tournaments (nd-json) |
| `GET /api/tournament/{id}` | arena detail, standings page, duels, featured game, podium |
| `GET /api/tournament/{id}/results` | full arena standings (nd-json) |
| `GET /api/tournament/{id}/games` | the archive pass: every game, with moves and clocks |
| `GET /api/swiss/{id}` | Swiss detail |
| `GET /api/swiss/{id}/results` | Swiss standings |
| `GET /api/swiss/{id}/games` | the Swiss archive pass |
| `GET /game/export/{gameId}` | one game, for the board and for replay |
| `GET /api/stream/game/{id}` | watching an ongoing game move by move |

### Authenticated — the signed-in person's own token

| Endpoint | Scope | Used for |
|---|---|---|
| `GET /api/oauth` → `POST /api/token` | — | logging in with lichess (PKCE) |
| `POST /api/token/test` | — | reading back what the token may actually do |
| `DELETE /api/token` | — | Disconnect, which really does revoke |
| `GET /api/account` | — | the connected username |
| `GET /api/team/of/{username}` | — | is this player in the team the tournament requires? |
| `GET /api/account/playing` | — | am I already in a game? the fallback for instant entry |
| `POST /api/tournament` | `tournament:write` | creating an arena from the JagChess form |
| `POST /api/swiss/new/{teamId}` | `tournament:write` | creating a Swiss |
| `POST /api/tournament/{id}/join` | `tournament:write` | Join, including `pairMeAsap` |
| `POST /api/tournament/{id}/withdraw` | `tournament:write` | Withdraw |
| `POST /api/swiss/{id}/join` / `/withdraw` | `tournament:write` | the Swiss equivalents |
| `POST /team/{teamId}/join` | `team:write` | joining the required team — see the limits |
| `GET /api/stream/event` | `board:play` | knowing when your tournament game starts |
| `GET /api/board/game/stream/{gameId}` | `board:play` | your own game, live |
| `POST /api/board/game/{gameId}/move/{uci}` | `board:play` | playing a move |
| `POST …/resign`, `…/draw/{yes\|no}`, `…/berserk` | `board:play` | the rest of playing |

Nothing is asked for until somebody presses **Join & play** — watching a
tournament, or the whole site, grants no permission at all. At that point the
request covers everything that press could need, in one consent screen, and a
tournament with no team requirement does not ask for the team permission.
Splitting them finer meant an extra full redirect at the worst moment.

---

## Verified before it was built

The brief asks for each of these to be checked rather than assumed. They were.

1. **Can a third party create a lichess tournament?** Yes — `POST /api/tournament`
   with `tournament:write`, up to 12 public or 24 private a day. The JagChess
   form exposes every field that endpoint accepts.
2. **Can a third party join a tournament?** Yes — `POST /api/tournament/{id}/join`,
   with `password`, `team` (for team battles) and `pairMeAsap`.
3. **Can team membership be checked?** Yes — `GET /api/team/of/{username}`.
   **It needs a token**, whatever the published description suggests: without
   an `Authorization` header it answers `401 {"error":"Missing authorization
   header"}`. It needs no particular scope, but it does need one.
   ([bug](#the-bugs-this-cost-us))
4. **Can a team be joined through the API?** Partly. See the limits below.
5. **Can a game be played from a third-party client?** Yes, for human accounts,
   through the Board API. Tournament games included: `POST /api/board/game/{id}/berserk`
   exists precisely because arena games are played this way.
6. **Can tournament games be streamed live?** Your own, yes, with no delay.
   Somebody else's, yes, with a deliberate three-move delay.
7. **Is there a push/stream for standings?** No. Standings are polled.
8. **Are there refresh tokens?** No. Access tokens last about a year.

---

## Limits, and what is done instead

These are the places where the brief asks for something lichess does not
offer. Each one is implemented the closest compliant way rather than worked
around.

### 1. The access token lives in the browser

JagChess is static hosting plus Firestore. There is no server to hold a token
on a user's behalf, so the PKCE flow's token is kept in `localStorage` and
nowhere else. It is never written to Firestore, never sent to any JagChess
service, and never leaves the device.

This is the model lichess documents for public clients — *"it is fine if the
user themselves can extract `code_verifier`, which will always be possible for
fully client-side apps"* — but it is a real difference from a server-side
integration, so:

* nothing is requested until somebody actually takes part;
* **Disconnect** calls `DELETE /api/token` before forgetting anything, so
  signing out ends the grant rather than merely hiding it;
* what Firestore stores is the *link* — lichess username and granted scopes —
  never a credential.

### 2. There is no backend, so the sync worker runs in a tab

The brief asks for a backend sync service and for the frontend not to hammer
lichess. Both hold here, without a backend: a Firestore document is a lease,
and only the tab holding it does the background polling. Everyone else reads
Firestore. A hundred spectators are a hundred Firestore listeners.

There is one deliberate exception. **The tournament page somebody is actually
looking at refreshes itself**, every four seconds while it is live and
visible, because the lease cadence is built for tabs nobody is watching and
reads as broken in front of someone who is. That is one open page making one
request every few seconds through the same serialized queue — comparable to
what lichess's own tournament page does over its socket — and it stops the
instant the tab is hidden.

The honest consequence of the rest: **nothing syncs in the background while
nobody has JagChess open.** The next visitor catches up, and every page says
when it last synchronized.

`lichess-api.js` also serializes every request through one queue with a
minimum gap, and parks the whole queue for a minute on a `429`, which is what
the API asks for.

### 3. Joining a team may have to happen on lichess

`POST /team/{teamId}/join` exists and is used first. It fails, legitimately,
in several cases:

* the team reviews applications, which needs a written message;
* the team has a password;
* the endpoint sits outside `/api/` and the official description does not
  promise a CORS header for it, so a browser may refuse it before lichess
  sees it.

All of them end the same, correct way: the user is offered **the team's own
page on lichess**, joins there, and the page re-checks membership against
`GET /api/team/of/{username}` when they come back. Membership is never
assumed and never cached between tournaments.

### 4. Team membership is reported by one endpoint only

`GET /api/team/{id}/arena` reports `teamMember` — the team a player must
belong to. `GET /api/tournament/{id}` does not report it at all; it reports
team battles but is silent about `teamMember`.

So a detail refresh is **not allowed to conclude that a restricted tournament
is open**. `shapeArena` is told which endpoint is talking, and
`deriveMembership` merges the two answers, treating "did not say" and "said
no" as different things. This is the one rule the brief singles out — never
tell a player to join a team they do not need — and it has its own tests in
`tests/lichess.browser.test.mjs`.

### 5. Watching someone else's game is three moves behind

`GET /api/stream/game/{id}` delays ongoing games by three moves to stop cheat
bots reading live positions. That applies to every third-party client
including this one, it is not worked around, and the board says so on screen.
Your *own* game, through the Board API, has no delay.

The same endpoint is capped at eight streams per IP and is not promised a
CORS header, so the board falls back to polling `GET /game/export/{id}` and
says which one it is using.

### 6. Live clocks are only exposed for one game at a time

The arena endpoint gives clocks for the **featured** game and a bare pairing
list (`duels`) for the rest. There is no endpoint for "the clocks of every
game in this tournament". The games list therefore shows who is playing whom
without clocks, and clocks appear when you open a board.

### 7. Standings have no stream

They are polled: every 30 seconds while a tournament is live, once more when
it finishes. `GET /api/tournament/{id}/results` warns that results can be
inconsistent while a tournament runs, so the final pass is the authoritative
one and the page says when it last synchronized.

### 8. Lichess does not publish a win/draw/loss record per player

It gives rank, score, rating and performance. The W/D/L column is counted by
JagChess from the games it has stored and is marked with an asterisk
everywhere it appears, with a footnote — it is not a lichess statistic, and
the per-player totals across tournaments are not a rating of any kind.

### 9. `nowPlaying` does not say which tournament

`GET /api/stream/event` carries `tournamentId` on every `gameStart`.
`GET /api/account/playing` does not — it only says `source: "arena"`. So the
event is an exact answer and the poll is an approximate one, and
`matches()` in `lichess-live.js` treats them differently: an exact id is
matched exactly, and a poll row is accepted on the strength of "it is a
tournament game and lichess only pairs you in one arena at a time". The
board then reads the real game and corrects itself either way.

Behind both is a third check that costs nothing: the pairing list JagChess
already syncs names both players, so a pairing with your name on it is your
game.

### 10. Only one event stream per token

`GET /api/stream/event` closes the previous stream for the same token when a
new one opens, so exactly one place in the codebase opens it.

### 11. Swiss tournaments are always team tournaments

There is no way to create a Swiss outside a team, and only team members can
enter — so `membershipRequired` is always true for a Swiss, from lichess's
own design rather than from a guess. Creating one also requires leading the
team on lichess.

---

## Data model

The document id is lichess's own id everywhere it exists. That is what makes
running the sync twice an update rather than a duplicate.

```
lichessTeams/{scope__teamId}                 a monitored team
lichessTournaments/{lichessTournamentId}     one tournament
  …/participants/{lichessUserId}             one standings row
  …/games/{lichessGameId}                    one game
lichessSyncEvents/{auto}                     the admin monitoring log
lichessSync/{scope}                          the lease
lichessAccounts/{jagchessUid}                username + scopes, never a token
```

A tournament carries `lichessId`, `teamId`, `kind`, `membershipRequired`,
`requiredTeamId`, `teamBattleTeams`, `status`, `startsAt`, `finishesAt`,
`clock`, `variant`, `rated`, `nbPlayers`, `conditions`, `lastSyncedAt` and
`archived`, plus `scope`/`clubId` which are ours rather than lichess's.

**Every write is a merge, and a value lichess did not mention is left out
rather than written as null** — otherwise one endpoint's silence would erase
what the other endpoint said. See `prune()` in `lichess-store.js`.

---

## The bugs this cost us

Worth writing down, because all three were the API behaving differently from
its own description and none of them showed up until a real tournament ran.

1. **`GET /api/team/of/{username}` requires a token.** The spec marks it
   `security: OAuth2: []`, which reads as optional. It is not. Called without
   one it 401s, which left the membership check permanently unable to answer
   and the Join button permanently stuck behind it. Fixed by passing the
   token — and, more importantly, by not gating Join on that check at all.
2. **`GET /api/tournament/{id}` has no `status` field.** It has `isFinished`,
   an ISO-8601 `startsAt` where the listing sends a number, and no
   `finishesAt`. A tournament terminated early therefore kept a finish time
   in the future, and nothing archived it until that time passed.
3. **`nowPlaying` has no `tournamentId`.** See above.

## Rate limiting and reliability

* one request at a time, globally, with a 250 ms floor between them;
* a `429` parks every request for 61 seconds and the call is retried once;
* `502`/`503`/`504` are retried; `400` is not, because we asked wrongly;
* a `404` on a tournament marks it **unavailable** rather than deleting it;
* the team listing is polled on the interval an admin chooses (5 minutes by
  default); a live tournament every 10 seconds; one starting soon every 30;
* **the tournament page you are actually looking at refreshes itself** every
  4 seconds while it is live and visible, on top of the lease worker and
  independently of it. One open page, one request every few seconds, through
  the same serialized queue — roughly what lichess's own tournament page does
  over its socket. It stops the moment the tab is hidden. Without it a page
  somebody is staring at inherited the idle cadence, and a tournament that
  had ended went on looking live;
* a finished tournament is archived once — games, moves, clocks, results and
  standings — and then never polled again;
* everything is logged to `lichessSyncEvents` with latency and outcome, and
  the admin panel shows the connection state, the last good call, the error
  count and the last forty calls.

---

## Playing from here, in one press

The whole point, and the part with the most moving pieces:

1. **Join & play** — one button, whatever state the login is in. If lichess
   has not been connected yet it connects first and remembers the intent, so
   coming back carries straight on instead of showing the same button again.
2. The join is sent with **`pairMeAsap`**, which is what tells lichess to
   pair somebody who is not sitting on its own tournament page. It lapses
   after a minute, so it is renewed while waiting.
3. Three things race to notice the pairing: the **event stream**
   (`gameStart`, instant), the **pairing list** JagChess already syncs, and a
   **`/api/account/playing` poll**. Whichever wins, the board opens by
   itself.
4. The board is **painted before any request is sent**, from the pairing the
   page already had — names, ratings, clock, pieces — because the lichess
   clock is already running. When the game is known to be yours the export
   call is skipped entirely and the Board API stream is opened first.

A reload mid-game puts you straight back on your board, and leaving a board
deliberately does not throw you back onto it.

## Testing

`npm run test:lichess` loads every module in a real browser and exercises the
pure logic: team-id parsing, the arena clock/duration rule lichess applies,
status inference from each endpoint's different answer, the membership
derivation, and pairing-to-tournament matching. It also opens a real board
and checks that it paints without waiting for the network, then steps through
a real finished game with the navigation buttons. It needs no Firestore
emulator and no lichess account.
