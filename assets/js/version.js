/* ═══════════════════════════════════════════════════════════════════════
   version.js — what JagChess is running, and everything that got it here.

   Versions read YY.M.D.patch, so the number itself says when it shipped.
   The newest entry is always first; that is the one the "what's new" modal
   shows club staff, and the one the guide's changelog opens on.

   Adding a release: put a new object at the top of CHANGELOG and bump
   VERSION to match its `v`. Nothing else needs touching — the modal fires
   for staff who haven't seen that number yet.
   ═══════════════════════════════════════════════════════════════════════ */

export const VERSION = '26.9.22.5';

/* kind → the pill color the changelog paints it with */
export const CHANGE_KINDS = {
  new:     { label: 'New',      tint: 'green'  },
  improved:{ label: 'Improved', tint: 'blue'   },
  fixed:   { label: 'Fixed',    tint: 'orange' },
  /* Something that used to be here and is not any more. Its own kind rather
     than a "fixed", because removing a feature is not a repair and the people
     who were using it deserve to be told plainly. */
  gone:    { label: 'Discontinued', tint: 'red' }
};

export const CHANGELOG = [
  {
    v: '26.9.22.5',
    date: '2026-09-22',
    title: 'The pending list, in bulk',
    summary:
      'Invite everybody waiting in one message, or type the whole list in as text and let the ' +
      'colours tell you what is wrong with it. Email is redrawn in navy and PT Serif, with your ' +
      'club\'s own badge on it. The puzzles page stops keeping two lists of the same shelves.',
    changes: [
      { kind: 'improved', text: '**Email has been redrawn.** Navy instead of the old green, **PT Serif** instead of the system sans, and a card half again wide as the one it replaces — the old one left most of the reading pane empty on each side, and the margins around it are now half what they were. Bigger type came with it, so a wider line is still a readable one.' },
      { kind: 'new', text: '**Your club\'s badge is the picture on the email**, half again the size and sitting straight on the navy with nothing framed around it. It travels with the message rather than being linked to, so it arrives even in clients that refuse to fetch pictures. A club that has not uploaded one gets the square it wears everywhere else on the site — its own colour, its own glyph — rather than somebody else\'s knight.' },
      { kind: 'new', text: '**Manage, on every puzzle** — the roster with a tick against everybody who has finished it. People who solved it themselves are already ticked; tick anybody who did it on the demo board and it shows as done on their side too. Search, tick everyone, and save.' },
      { kind: 'new', text: '**Ticking moves no points, and clearing a tick takes none back.** It is there to tidy a list, not the leaderboard, so a puzzle can never be handed out for points. A solve somebody actually earned is marked as such on its row, and clearing one asks first — the points stay where they are, but the puzzle goes back on their list.' },
      { kind: 'fixed', text: '**The font menu did nothing unless you had clicked in the message first.** Opening a dropdown takes focus off the editor, and an editor that has lost focus will not reliably say what was selected in it. It now remembers, and picking a font with nothing selected sets the whole message rather than quietly setting nothing.' },
      { kind: 'new', text: '**A font menu on the newsletter editor** — PT Serif, Georgia, Times New Roman, Arial, Helvetica, Verdana, Tahoma, Trebuchet and Courier New. Every one of them is a stack ending in a face your readers already have, because no mail client is obliged to fetch a webfont and Gmail never does. The editor is set in the mail face too, so what you write is what arrives.' },
      { kind: 'new', text: '**Send all.** One invite to everybody waiting, from your own Gmail, with every address in Bcc — nobody sees who else it went to. It opens the same editable message a single invite does, greets nobody by name because it cannot, and will leave out the people already marked Invited if you ask it to.' },
      { kind: 'new', text: '**Edit markup** — the pending list written out as text, one person per line: their email address, two spaces, then their name. Only the address is required. Paste a hundred in at once, delete the ones who have left, and save; the list matches what you typed exactly.' },
      { kind: 'new', text: 'The markup colours itself as you type. **Red** is a line that is not usable, **blue** is an address written in twice, **green** is somebody who is already in the club, and **orange** is both at once. Green comes off the list when you save. Red and blue have to be sorted out first, because which of two identical rows you meant is not something the editor can guess.' },
      { kind: 'new', text: 'An address typed in by hand is labelled **Markup** on its row, carries no registration to view, and reads as *Unknown* until somebody gives it a name.' },
      { kind: 'fixed', text: '**"3 registrations · 0 not invited yet" read like a contradiction.** The head of the box now counts the two things separately: where these people came from on one line, and how many have been written to on the next.' },
      { kind: 'improved', text: 'The pending box no longer disappears when it is empty. A club that has never had a sign-up is told so, and told where the registration form and its QR code live.' },
      { kind: 'improved', text: 'Every invite now ends with a line saying that replying **STOP** means no more email from JagChess about joining a club.' },
      { kind: 'gone', text: '**The admin\'s Puzzle library tile is discontinued.** It drew the same shelves the Collections tile already listed, one screen below it. The shelves open in place instead — press the arrow on any collection and everything on it appears underneath, ready to preview, edit, adopt or delete.' },
      { kind: 'improved', text: '**Published is the club\'s own work again.** Puzzles your members built are no longer mixed in with it; they are on the shelf they were published to, which for most clubs is Custom.' },
      { kind: 'new', text: '**@members, @pending and @admin** in a newsletter\'s recipient box. Type @ and it offers all three with a head count on each; press Enter and the whole group drops in as ordinary recipients you can still take back out. The ⓘ beside **To** says what each one stands for.' },
      { kind: 'new', text: '**A newsletter can reach the people who are not in the club yet.** Everyone waiting on an invite is now offered in the recipient box by name, marked apart from members and counted separately under it, so a message written for members only is hard to send to the wrong crowd by accident.' },
      { kind: 'new', text: 'Both lists on the puzzles page can be **searched and paged** — 5, 10, 20, 30, 50 or a number of your own at a time, with a box to jump straight to a page. A collection counts as one row whether it is open or shut.' }
    ]
  },
  {
    v: '26.9.20.0',
    date: '2026-09-20',
    title: 'Lichess tournaments, actually playable',
    summary:
      'One press now gets you into a game. The board opens before the network answers, ' +
      'the page keeps itself live, and you can step through any game move by move.',
    changes: [
      { kind: 'fixed', text: '**Checking your team membership always failed.** Lichess requires a token on that endpoint even though its own documentation marks it optional, so the check could never answer — and the Join button was waiting on it. It is fixed, and Join no longer waits on it at all.' },
      { kind: 'new', text: '**Join & play — one press.** It signs you in if it has to, enters you, asks lichess to pair you immediately, and opens your board the moment it does. No second button, no hunting for the game.' },
      { kind: 'fixed', text: '**The board opened empty** while the lichess clock was already running. It now paints instantly from the pairing the page already had — both names, both ratings, the clock and the pieces — and fills in the rest as it arrives.' },
      { kind: 'fixed', text: '**A tournament that had ended went on looking live.** An arena stopped early keeps a finish time in the future, which the archiver was waiting for. It now counts from the moment the end was actually seen.' },
      { kind: 'improved', text: '**The page you are looking at keeps itself up to date**, every few seconds, instead of inheriting the pace meant for tabs nobody is watching. Standings, games and results move on their own.' },
      { kind: 'new', text: '**Step through any game** — first, back, forward, last, with the arrow keys, Home and End. Works on finished games and on live ones, with one press to jump back to the live position. Press F to flip the board.' },
      { kind: 'new', text: 'Reload in the middle of a game and you land back on your board. Leave it on purpose and you stay left.' },
      { kind: 'improved', text: 'Joining a team that reviews its applications now says your request was sent, rather than claiming you had joined and bouncing you back to the same button.' },
      { kind: 'improved', text: 'The standings no longer rebuild themselves every second, so your scroll position stays put. Only the clocks tick.' }
    ]
  },
  {
    v: '26.9.19.3',
    date: '2026-09-19',
    title: 'Lichess tournaments, live on JagChess',
    summary:
      'Point JagChess at a lichess team and its tournaments appear here by themselves — live ' +
      'standings, live games, and a board you play on without ever opening lichess.org. ' +
      'Bracket tournaments are discontinued.',
    changes: [
      { kind: 'gone', text: '**Bracket tournaments are discontinued.** They can no longer be created. Brackets that finished keep their podium, standings and games and still read normally in History; one that never finished is now labelled discontinued and has no result. Every rating change from a game that was actually played still stands.' },
      { kind: 'new', text: '**Lichess tournaments.** An admin adds a lichess team once, and every tournament that team runs turns into a page here on its own — detected, kept up to date while it runs, and archived when it ends. Nothing is added by hand.' },
      { kind: 'new', text: '**Log in with Lichess**, the official way. Watching needs no account at all. Permission is asked for one piece at a time — joining, playing, teams — so a spectator grants nothing, and Disconnect really does revoke it at lichess.' },
      { kind: 'new', text: 'A **join button that tells the truth**. It reads lichess\'s own entry conditions, so a tournament that merely turned up under a team says *open to anyone*, and one that genuinely needs membership says so and sends you to the team page — then re-checks when you come back.' },
      { kind: 'new', text: '**Play from here.** Your tournament games open on a JagChess board — clocks, move list, promotion, draw offers, resign and berserk — with the moves going to lichess through its Board API. You never have to open lichess.org.' },
      { kind: 'new', text: '**Watch any game** in a live tournament, with the standings and the games in progress beside it. Lichess delays ongoing games by three moves for everybody outside it, and the board says so rather than pretending otherwise.' },
      { kind: 'new', text: 'A **Lichess tournament mode** on the New tournament button, with lichess\'s whole setup form: arena or Swiss, every clock and duration, variants, berserk, streaks, starting position, and every entry condition — team, rating range, games played, account age, invite list, password. It is created on lichess and saved here at the same moment, and the settings are remembered for next time.' },
      { kind: 'new', text: '**Player pages** — every lichess tournament somebody has played here, their placings and their record, at /players/their-name.' },
      { kind: 'new', text: 'A **Lichess panel** for admins: the connection state, whether syncing is active, the last successful call, live tournament and game counts, the error count, and the last forty calls with their latency. In /admin for the whole site, and on a club\'s own Tournaments page for that club.' },
      { kind: 'improved', text: 'The Tournaments list shows JagChess arenas and lichess events together, sorted as one, with a filter when you want only one kind.' },
      { kind: 'improved', text: 'Lichess\'s figures and ours are never mixed up. Rank, score, rating and performance are labelled as lichess\'s own; the win / draw / loss column is counted here and carries an asterisk saying so.' },
      { kind: 'improved', text: 'Tournaments have real addresses: /tournaments/the-id, and /tournaments/the-id/games/the-game.' }
    ]
  },
  {
    v: '26.9.19.2',
    date: '2026-09-19',
    title: 'The puzzle builder, laid out properly',
    summary:
      'The line you record is drawn as a flowchart now, merging is a + between two branches, ' +
      'and the builder has the whole page to do it in.',
    changes: [
      { kind: 'new', text: 'The solution is drawn as a **flowchart** — a box per move, branches side by side, edges between them — instead of a list that could only ever describe one line.' },
      { kind: 'new', text: 'Merging is a **+ button between two branches**, and it only appears where the two really do reach the same position. No pop-up interrupts you mid-move any more.' },
      { kind: 'new', text: 'Every move in the chart has its own delete, and clicking one takes you back to that position.' },
      { kind: 'improved', text: 'All four steps are on the rail and clickable. The ones that cannot open yet say why instead of doing nothing.' },
      { kind: 'improved', text: 'The builder is the full width of the page and taller, with the published list underneath rather than beside it — room for a big flowchart.' },
      { kind: 'improved', text: 'Setting the position gives the board the whole width, with every control in one row underneath it.' },
      { kind: 'fixed', text: 'The board frame sat around the spare-piece trays as well as the board, and was thicker on one side than the other. It is drawn on the board itself now, and centred.' },
      { kind: 'fixed', text: 'Dragging a piece inside a preview no longer looks like a teleport — the piece you are holding was being hidden behind the modal.' },
      { kind: 'fixed', text: 'American spellings throughout, for real this time.' }
    ]
  },
  {
    v: '26.9.19.1',
    date: '2026-09-19',
    title: 'Puzzles, rebuilt',
    summary:
      'Building a puzzle is now four steps instead of a form. Puzzles can have more than one ' +
      'winning move, a due date, and a preview — and solving one finally feels like winning.',
    changes: [
      { kind: 'new', text: 'A **four-step builder**: pick the color, set the position, play the solution, fill in the details. Color is asked first, because everything else follows from it.' },
      { kind: 'new', text: 'Moves are **recorded as you play them** — the Record move button is gone, turns alternate on their own, and the last move of a line is flagged as the end automatically.' },
      { kind: 'new', text: '**Branches.** Click any move to go back to it and play something different: a position with two good moves can now be published honestly, and the solver meets one of the replies at random.' },
      { kind: 'new', text: '**Merging.** Two branches that reach the same board can be folded into one, so a shared continuation is written once instead of twice. Merges that would loop the puzzle are refused.' },
      { kind: 'new', text: '**Due dates**, with a percentage that comes off for solving late. A late solve still earns something; decimals are always dropped, never rounded up.' },
      { kind: 'new', text: '**Preview** — next to Edit on every puzzle, and while you are still building one. It plays exactly as a member’s copy does, and awards nothing.' },
      { kind: 'new', text: 'Puzzle details now take a **source link**, which members see as a button when they play it.' },
      { kind: 'improved', text: 'Solving one ends on a modal that eases in and counts the points up, and tells you how long it took — timed from the moment you opened the puzzle.' },
      { kind: 'improved', text: 'No more max attempts. How many moves your color has to find is counted off the line you built.' },
      { kind: 'fixed', text: 'A mistyped FEN used to be accepted as an empty board. It is now refused, along with any position missing a king.' }
    ]
  },
  {
    v: '26.9.19.0',
    date: '2026-09-19',
    title: 'Attendance for everybody in the room',
    summary:
      'Checking in no longer requires an account. Scan the QR, fill in three questions, and your ' +
      'points find you — whether you are a member, a past registration, or brand new.',
    changes: [
      { kind: 'new', text: 'Anybody can check in — **no account, no login**. A scanned attendance QR opens the form on the spot for whoever is holding the phone.' },
      { kind: 'new', text: 'Signed out, you are asked for your **first name, last name and email**, then whatever the club added. Those three are built in and cannot be removed.' },
      { kind: 'new', text: 'Signed in, you are asked **only** the club’s own questions — the club already has your name and address. No extra questions at all means one tap and it is done.' },
      { kind: 'new', text: 'The attendance form is now built the same way as the registration form: short answer, long answer, multiple choice and slider questions, each required or not, reorderable, with a **preview** showing what a member and a visitor each see.' },
      { kind: 'new', text: 'Check in with an email that already belongs to a member and the points go to **that account**, once per event. Duplicate submissions are labelled and ignored.' },
      { kind: 'new', text: 'Check in with an address the club has never seen and you are marked down as a **New user** — a pending registration is opened for you automatically from what you typed, and it holds your points.' },
      { kind: 'new', text: 'Already registered but not a member yet? That registration holds the points instead. Either way they move onto your membership the moment you join, and until then they stay off the leaderboard.' },
      { kind: 'improved', text: 'Check-ins finish on a loading screen and a checkmark, so you always know it worked.' },
      { kind: 'improved', text: 'Pending members show how many points are being held for them, and where those points came from.' }
    ]
  },
  {
    v: '26.9.15.0',
    date: '2026-09-15',
    title: 'The JagChess Network',
    summary:
      'Public clubs now have a front door. Anyone can browse them, and people without an account ' +
      'can sign up for one and be invited in by email.',
    changes: [
      { kind: 'new', text: 'The **JagChess Network** at /network — every public club in one searchable directory, open to visitors with no account at all.' },
      { kind: 'new', text: "Signed in, joining a public club from the Network is one click. Signed out, you fill in that club's registration form instead and its admins invite you." },
      { kind: 'new', text: 'A **club registration form** in Club settings: first name, last name and email are always asked, and you add your own short answer, long answer, multiple choice and slider questions on top, each required or not.' },
      { kind: 'new', text: "Share registration — a QR code and a link that open your club's sign-up form on the Network." },
      { kind: 'new', text: 'Pending members: registrations arrive under the roster on the Members page, greyed out, with their full response and a Pending filter of their own.' },
      { kind: 'new', text: 'Send email invite — a ready-written invite from your own Gmail, addressed by first name, carrying a link that drops them inside the club the moment they have an account.' },
      { kind: 'improved', text: 'A private club keeps its registration form saved, but greys it out: there is no listing for anyone to fill it in from.' }
    ]
  },
  {
    v: '26.9.9.0',
    date: '2026-09-09',
    title: 'Tournaments, the guide, and shareable match links',
    summary:
      'The biggest release since duels. Clubs and the wider site can now run real tournaments — ' +
      'lichess-style arenas or knockout brackets — and every screen in JagChess is documented.',
    changes: [
      { kind: 'new', text: 'Tournaments, in two shapes: **arena** pairs you with whoever is closest on score for a fixed stretch of time, and **bracket** is a straight knockout you can watch fill in.' },
      { kind: 'new', text: 'Club tournaments: a Tournaments page any club can add, with admins and founders deciding whether results move the club rating.' },
      { kind: 'new', text: 'Global tournaments at /tournaments — anyone can host one, and the host chooses whether it touches global ratings.' },
      { kind: 'new', text: 'Bracket tournaments can recognize a podium of 1st and 2nd, plus 3rd, or plus 3rd and 4th — turning on a third-place match between the two beaten semifinalists.' },
      { kind: 'new', text: 'Berserk is available as a host setting on arenas: halve your own clock for an extra point.' },
      { kind: 'new', text: 'Scheduling a club tournament drops it straight onto the club calendar, and a Tournaments widget can go on the dashboard.' },
      { kind: 'new', text: 'Tournament history: every finished event keeps its podium, its full standings and its games.' },
      { kind: 'new', text: 'Match links — generate a link, send it to a friend, and the game starts the moment they open it. Club links only work for club members; global links work for anyone signed in.' },
      { kind: 'new', text: 'A Play a match tab on My clubs, so a global game no longer means opening a club first.' },
      { kind: 'new', text: 'This guide, covering every module, a full club setup walkthrough, and how games and tournaments actually work.' },
      { kind: 'new', text: 'A what\'s-new note for club admins and founders whenever a release lands.' },
      { kind: 'improved', text: 'Leaderboards now carry club rating, global rating and a win / draw / loss record. Signed-in players can read the global board without joining a club.' },
      { kind: 'improved', text: 'Every duel now records its result against both players\' win-draw-loss counts, club and global kept separately.' },
      { kind: 'improved', text: 'Pricing is off the marketing site while the plans are reworked.' },
      { kind: 'fixed', text: 'American spellings throughout — customization, organization, authorized.' }
    ]
  },
  {
    v: '26.8.13.0',
    date: '2026-08-13',
    title: 'Attendance QR codes and newsletters that actually send',
    summary: 'Check-in stopped being a clipboard job, and newsletters started leaving the building.',
    changes: [
      { kind: 'new', text: 'Attendance QR codes: project one, members scan it, check-in lands on their phone with your questions attached.' },
      { kind: 'new', text: 'Newsletters can be delivered to members by email, not just archived on the page.' },
      { kind: 'improved', text: 'Streaks count from real attendance rather than logins.' },
      { kind: 'fixed', text: 'An event that had already started no longer disappeared from the upcoming list.' }
    ]
  },
  {
    v: '26.8.11.0',
    date: '2026-08-11',
    title: 'Duels: Glicko-2 ratings and live spectating',
    summary: 'One-on-one chess inside JagChess, rated the way lichess rates it.',
    changes: [
      { kind: 'new', text: 'Duels: clocks, increments, draw offers, resignation, and a board you can play from a phone.' },
      { kind: 'new', text: 'Glicko-2 ratings — separate club and global numbers, provisional until you have played.' },
      { kind: 'new', text: 'Watch any game in progress, with a live viewer count.' },
      { kind: 'new', text: 'Challenge a specific member from the leaderboard, or take a random pairing.' },
      { kind: 'improved', text: 'Roles and moderation: founders, admins, students, with bans and appeals.' }
    ]
  },
  {
    v: '26.8.10.0',
    date: '2026-08-10',
    title: 'The club builder',
    summary: 'Clubs stopped being one fixed template and became something you assemble.',
    changes: [
      { kind: 'new', text: 'Blocks: add, rename, reorder and remove the pages in your club\'s sidebar.' },
      { kind: 'new', text: 'A twelve-column dashboard you rearrange by dragging, with resizable widgets.' },
      { kind: 'new', text: 'Editor mode, so laying the club out never risks changing its data.' },
      { kind: 'new', text: 'Events, Puzzles, Newsletters, Leaderboard, Store and Donate, all as blocks.' }
    ]
  },
  {
    v: '26.5.23.0',
    date: '2026-05-23',
    title: 'JagChess opens to every club',
    summary: 'What started as one school\'s chess club became something any club could run.',
    changes: [
      { kind: 'new', text: 'Create a club, get an address at /clubs/your-club, and invite people with a code or a link.' },
      { kind: 'new', text: 'Public and private clubs, points, and a member roster.' }
    ]
  }
];

export const LATEST = CHANGELOG[0];

/* ── "what's new" bookkeeping ──────────────────────────────────────── */

const SEEN_KEY = 'jag-seen-version';

export function seenVersion() {
  try { return localStorage.getItem(SEEN_KEY) || null; } catch (_) { return null; }
}

export function markVersionSeen(v = VERSION) {
  try { localStorage.setItem(SEEN_KEY, v); } catch (_) {}
}

/* First run on a device is not an "update" — there is nothing to catch up
   on, so the note is skipped and the version quietly recorded. */
export function shouldAnnounce() {
  const seen = seenVersion();
  if (!seen) { markVersionSeen(); return false; }
  return seen !== VERSION;
}
