/* ═══════════════════════════════════════════════════════════════════════
   guide.js — the documentation site at /guide.

   One page of content is on screen at a time, chosen by the hash. Pages are
   plain objects with a `body()` that returns HTML, so adding a page means
   adding one entry to PAGES — the sidebar, the search index and the
   previous/next links all read from that array.

   The site is deliberately readable signed out: nothing here touches
   Firebase, so a club can link a parent or a new member straight at it.
   ═══════════════════════════════════════════════════════════════════════ */

import { CHANGELOG, VERSION, CHANGE_KINDS, markVersionSeen } from './version.js';
import * as art from './guide-art.js';

const $ = (s) => document.querySelector(s);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* the only markup the changelog needs: **bold** and `code` */
const md = (s) => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

const note = (body, kind = '') =>
  `<div class="doc-note ${kind}"><span class="doc-note-ico">${kind === 'warn' ? '!' : kind === 'tip' ? '★' : 'i'}</span><p>${body}</p></div>`;

const steps = (rows) =>
  `<ol class="doc-steps">${rows.map(([t, b]) => `<li><b>${t}</b>${b}</li>`).join('')}</ol>`;

const table = (head, rows) => `<div class="doc-table-wrap"><table class="doc-table">
  <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;

const cards = (rows) => `<div class="doc-cards">${rows.map(([ico, tint, name, desc]) =>
  `<div class="doc-card"><div class="doc-card-ico" style="background:${tint}">${ico}</div>
   <b>${name}</b><small>${desc}</small></div>`).join('')}</div>`;

/* ═══ THE CHANGELOG PAGE ════════════════════════════════════════════ */

function changelogBody() {
  return `
    <p class="doc-lede">Every release of JagChess, newest first. Versions read
    <code>YY.M.D.patch</code>, so the number tells you the day it shipped.</p>
    ${CHANGELOG.map((e, i) => {
      const d = new Date(e.date + 'T12:00:00');
      return `
      <div class="cl-entry${i === 0 ? ' latest' : ''}" id="v${e.v.replace(/\./g, '-')}">
        <div class="cl-head">
          <span class="cl-v">${esc(e.v)}</span>
          <span class="cl-date">${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
          ${e.v === VERSION ? '<span class="cl-current">Running now</span>' : ''}
        </div>
        <h3>${esc(e.title)}</h3>
        <p class="cl-summary">${esc(e.summary)}</p>
        <ul class="cl-list">${e.changes.map((c) => {
          const k = CHANGE_KINDS[c.kind] || CHANGE_KINDS.new;
          return `<li><span class="cl-kind ${k.tint}">${k.label}</span><span>${md(c.text)}</span></li>`;
        }).join('')}</ul>
      </div>`;
    }).join('')}`;
}

/* ═══ PAGES ═════════════════════════════════════════════════════════ */

const PAGES = [
  /* ── start here ─────────────────────────────────────────────────── */
  {
    id: 'welcome', group: 'Start here', title: 'Welcome to JagChess',
    eyebrow: 'Introduction', eyebrowTint: '',
    keywords: 'intro start overview what is jagchess getting started',
    body: () => `
      <p class="doc-lede">JagChess is a home for a chess club. Not a group chat with a
      spreadsheet bolted on — a real site your club builds itself, where the puzzles, the
      calendar, the ratings, the tournaments and the prizes all live in one place.</p>

      ${art.clubShell()}

      <h2>The shape of it</h2>
      <p>Three ideas carry the whole platform. Learn these and nothing else will surprise you.</p>

      ${cards([
        ['♞', 'var(--green-soft)', 'Clubs', 'A club is a site at its own address, with its own members, roles, points and ratings. You can belong to as many as you like.'],
        ['▦', 'var(--blue-soft)', 'Blocks', 'Each page in a club\'s sidebar is a block you chose to add: Events, Puzzles, Tournaments, Store. Add them, rename them, remove them.'],
        ['◧', 'var(--purple-soft)', 'Widgets', 'The dashboard is a twelve-column grid. Admins drag widgets around it until it looks like their club.']
      ])}

      <h2>What you can do here</h2>
      <ul>
        <li><strong>Run the club side of a club</strong> — a calendar with attendance and streaks, puzzles worth points, newsletters that actually reach inboxes, a store where points buy real things.</li>
        <li><strong>Play chess</strong> — rated one-on-one duels with real clocks, against your club or against anyone on JagChess, and games you can watch live.</li>
        <li><strong>Run tournaments</strong> — timed arenas in the lichess mould, rated or casual, or a real Lichess tournament run through the official API.</li>
        <li><strong>Keep score properly</strong> — Glicko-2 ratings, separate for your club and the world, with a win / draw / loss record beside them.</li>
      </ul>

      <h2>Where things live</h2>
      ${table(['Address', 'What it is'], [
        ['<code>/clubs</code>', 'Your hub. Every club you are in, and the tabs for global play, tournaments and this guide.'],
        ['<code>/clubs/&lt;name&gt;</code>', 'One club. The sidebar, the dashboard and every block that club has added.'],
        ['<code>/play</code>', 'A global game without opening a club first.'],
        ['<code>/tournaments</code>', 'Global tournaments — anyone can host one, anyone can enter, and live lichess events appear here too.'],
        ['<code>/leaderboard</code>', 'Every player on JagChess by global rating, with their record.'],
        ['<code>/m/&lt;code&gt;</code>', 'A match link somebody sent you.'],
        ['<code>/guide</code>', 'This guide.']
      ])}

      ${art.hubFig()}

      ${note('New here? <a href="#quickstart">Setting up a club</a> takes you from nothing to a working club in about five minutes. If you have been sent a join code instead, you want <a href="#invites">Inviting people</a>.', 'tip')}
    `
  },
  {
    id: 'changelog', group: 'Start here', title: 'Changelog',
    eyebrow: 'Releases', eyebrowTint: 'gold',
    keywords: 'changelog updates releases version history new whats new',
    body: changelogBody
  },

  /* ── setting up ─────────────────────────────────────────────────── */
  {
    id: 'quickstart', group: 'Setting up', title: 'Set up a club',
    eyebrow: 'Walkthrough', eyebrowTint: '',
    keywords: 'create club setup start new club founder slug join code template',
    body: () => `
      <p class="doc-lede">Start to finish: an empty account to a club your members can
      actually use. It really does take about five minutes.</p>

      <h2>1. Create the club</h2>
      <p>Sign in, and you land on <strong>My clubs</strong>. Hit <strong>Create your own</strong>.</p>

      ${art.createClub()}

      ${steps([
        ['Name it', 'The name sets the web address underneath it — "North Creek Chess Club" becomes <code>/clubs/north-creek-chess-club</code>. It checks availability as you type. <strong>The address is fixed once the club exists</strong>, so that every link you ever hand out keeps working. Pick the name you actually want.'],
        ['Give it a face', 'An icon and a color. These show on the club card, in the sidebar and on every invite. Change them later from Club settings.'],
        ['Decide who can join', '<strong>Public</strong> lists the club in the join search, so anybody can walk in. <strong>Private</strong> hides it, and only the join code gets people through the door. School clubs are usually private.'],
        ['Keep the join code', 'Six characters, no confusable letters. Regenerate it whenever you want — the old one stops working the moment you do.'],
        ['Name your admins up front', 'Type in email addresses and they become admins the moment they join, without you having to promote anyone by hand.'],
        ['Choose a starting point', '<strong>Starter chess club</strong> arrives with every block already added and arranged — the fastest way to see what JagChess does. <strong>Blank</strong> gives you a dashboard and nothing else.']
      ])}

      ${note('Not sure? Take the starter. Removing a block you do not want takes one click, and the data behind it is kept anyway, so nothing is lost if you change your mind twice.', 'tip')}

      <h2>2. Shape the sidebar</h2>
      <p>Every page in your club is a <strong>block</strong>. The sidebar's "Pages" group is
      where they live, and the <strong>+</strong> beside it is where you add more.</p>

      ${art.blockPicker()}

      <p>Click a block to add it. It appears in the sidebar immediately, for everyone. In
      editor mode each entry grows a pencil and a cross, for renaming and removing.</p>

      ${note('Removing a block only removes the page. Its events, puzzles or orders stay in the database, so adding the block back brings everything with it.')}

      <h2>3. Lay out the dashboard</h2>
      <p>The dashboard is the first thing a member sees. Switch the toggle at the bottom of
      the sidebar from <strong>Admin</strong> to <strong>Editor</strong> and it becomes a grid you can push around.</p>

      ${art.editorMode()}

      <p>Widgets are not blocks. A widget is a small live view — the next few events, the top
      of the leaderboard, the newest puzzle — that sits on the dashboard and links through to
      the full page. Add them with <strong>＋ Add widget</strong>.</p>

      ${table(['Widget', 'Shows'], [
        ['Welcome banner', 'A greeting, your club description and two shortcut buttons.'],
        ['Quick duel', 'Your club and global ratings, and a button straight into a game.'],
        ['Upcoming events', 'The next few things on the calendar.'],
        ['Tournaments', 'What is running now and what is coming up.'],
        ['Leaderboard', 'The top six by points.'],
        ['Daily puzzle', 'A shortcut into the newest puzzle.'],
        ['Latest news', 'Most recent announcements.'],
        ['Member count', 'How many people are in the club.'],
        ['Store preview', 'A few items members can spend points on.'],
        ['Tip of the day', 'A rotating chess tip.']
      ])}

      ${note('<strong>Reset layout</strong> in the editor bar puts every widget back to the default arrangement. It only touches layout — never your club\'s content.', 'warn')}

      <h2>4. Fill it with something</h2>
      <p>An empty club is a sad club. Before you invite anybody, put a few things in it:</p>
      <ul>
        <li><strong>Two or three events</strong> — even just the next few practice sessions. See <a href="#mod-events">Events</a>.</li>
        <li><strong>One puzzle</strong> — it takes a minute and gives members a reason to come back tomorrow. See <a href="#mod-puzzles">Puzzles</a>.</li>
        <li><strong>A welcome newsletter</strong> — what the club is, when it meets, what happens here. See <a href="#mod-newsletters">Newsletters</a>.</li>
        <li><strong>A tournament on the calendar</strong> — nothing pulls a club in like a date. See <a href="#mod-tournaments">Tournaments</a>.</li>
      </ul>

      <h2>5. Invite people</h2>
      <p>Now open the doors — the <a href="#invites">next page</a> covers every way in.</p>
    `
  },
  {
    id: 'invites', group: 'Setting up', title: 'Inviting people',
    eyebrow: 'Membership', eyebrowTint: 'blue',
    keywords: 'invite join code qr link members share private public',
    body: () => `
      <p class="doc-lede">Three ways into a club: a code, a link, or a QR code on a projector.
      They all end at the same place.</p>

      ${art.inviteFig()}

      <h2>The join code</h2>
      <p>Six characters, generated when the club is created, shown in <strong>Club settings</strong>.
      A member enters it at <strong>My clubs → Join a club</strong> and they are in. Regenerating it
      from Club settings kills the old code immediately — the fix for a code that has spread further than you meant.</p>

      <h2>The invite link</h2>
      <p>The <strong>Invite</strong> button in the topbar opens a sheet with a link and a QR code. The link
      is built to work for whoever opens it:</p>
      ${table(['They are…', 'What happens'], [
        ['Signed out', 'Sent to log in, then dropped straight back at your club.'],
        ['Signed in, not a member', 'They land on the join gate with the code already applied.'],
        ['Already a member', 'The club just opens.'],
        ['Banned from the club', 'They are told, and offered the appeal form.']
      ])}

      ${note('A <strong>private</strong> club\'s invite link carries its join code, so only admins and the founder can see the Invite button. In a public club any member can share it, because anybody could join anyway.', 'warn')}

      <h2>The QR code</h2>
      <p>Download it as a PNG, put it on a slide, a poster or the door. It encodes the same
      invite link. Events have their own QR codes for attendance check-in — that is a
      different code, covered under <a href="#mod-events">Events</a>.</p>

      <h2>Admins before they arrive</h2>
      <p>List email addresses under <strong>Admins</strong> when you create the club, or add them later in
      Club settings, and those people become admins the moment they join. No promotion step.</p>
    `
  },
  {
    id: 'roles', group: 'Setting up', title: 'Roles & moderation',
    eyebrow: 'Permissions', eyebrowTint: 'gold',
    keywords: 'roles founder admin student permissions kick ban appeal transfer ownership moderation',
    body: () => `
      <p class="doc-lede">Every club has exactly one founder, any number of admins, and
      everybody else. Here is precisely what each can do.</p>

      ${art.rolesFig()}

      <h2>The rules that never bend</h2>
      <ul>
        <li><strong>Only a founder sets roles.</strong> Admins cannot promote or demote anybody, including themselves.</li>
        <li><strong>A founder cannot be kicked, banned or demoted</strong> by anyone. The only way out of the chair is to hand it over.</li>
        <li><strong>Admins may only moderate students</strong> — never another admin, never the founder.</li>
        <li><strong>Nobody may act on themselves.</strong> No self-promotion, no self-ban.</li>
      </ul>

      <h2>Kicking and banning</h2>
      <p>From <strong>Members</strong>, staff can remove someone or ban them. A kick takes their
      membership; a ban also stops them coming back through the code, the link or the public
      list. You can attach a reason, and the person sees it.</p>

      <h3>Appeals</h3>
      <p>A banned member trying to rejoin gets a notice with the reason, and a box to write an
      appeal. Appeals land in <strong>Members</strong> for staff to read and act on.</p>

      <h2>Handing the club over</h2>
      <p><strong>Club settings → Transfer ownership</strong>. Pick a member, confirm, and they become
      founder while you drop to admin. It is instant and it is not reversible from your side —
      only the new founder can hand it back.</p>

      ${note('Deleting a club removes it for every member and frees nothing: the address stops working immediately. There is no undo, so the confirm dialog makes you mean it.', 'warn')}
    `
  },

  /* ── modules ────────────────────────────────────────────────────── */
  {
    id: 'blocks', group: 'Modules', title: 'Modules overview',
    eyebrow: 'Modules', eyebrowTint: 'blue',
    keywords: 'blocks modules pages overview list what blocks',
    body: () => `
      <p class="doc-lede">Nine blocks, each one a full page in your club's sidebar. Add only
      the ones you will use — an unused page is worse than a missing one.</p>

      ${cards([
        ['📅', 'var(--blue-soft)', 'Events', 'A calendar for practices, tournaments and meetings, with QR check-in, attendance rewards and streaks.'],
        ['♟', 'var(--green-soft)', 'Puzzles', 'Tactical positions published from a board or a FEN. Members solve them for points.'],
        ['✉', 'var(--purple-soft)', 'Newsletters', 'Rich announcements, archived on the page and optionally delivered by email.'],
        ['🏆', 'var(--gold-soft)', 'Leaderboard', 'Points, club rating, global rating and a win / draw / loss record.'],
        ['⚔', 'var(--blue-soft)', 'Duels', 'One-on-one chess with clocks and Glicko-2 ratings. Play the club or the world.'],
        ['◆', 'var(--purple-soft)', 'Tournaments', 'Timed arenas, rated or casual, plus live Lichess tournaments, with full history.'],
        ['🎁', 'var(--orange-soft)', 'Store', 'Members spend points on merch, entry fees or privileges. Orders need approval.'],
        ['♥', 'var(--red-soft)', 'Donate', 'A page asking supporters to fund equipment, coaching and travel.'],
        ['◧', 'var(--surface-2)', 'Dashboard & Profile', 'Always present. The dashboard is the widget grid; profile is where a member sets their name and color.']
      ])}

      <h2>Adding and removing</h2>
      <p>The <strong>+</strong> beside "Pages" in the sidebar opens the picker. In editor mode each
      sidebar entry grows a pencil to rename and a cross to remove.</p>
      ${note('Rename freely. The block\'s <em>type</em> is what decides how the page behaves; the name is only what members read. A club can call its Duels page "Ladder" and nothing breaks.')}
    `
  },
  {
    id: 'mod-events', group: 'Modules', title: 'Events',
    eyebrow: 'Module', eyebrowTint: 'blue',
    keywords: 'events calendar attendance qr check in streak practice meeting rsvp',
    body: () => `
      <p class="doc-lede">A month calendar, an upcoming list, and the attendance machinery
      that turns showing up into points and streaks.</p>

      ${art.calendarFig()}

      <h2>Adding an event</h2>
      <p>Admins get the form beside the calendar: title, date, time, type, a short description
      and a duration. It appears on the grid and in <strong>Upcoming</strong> straight away.</p>
      <p>Types are color-coded — <code>classic</code>, <code>tournament</code>, <code>practice</code>,
      <code>meeting</code>, <code>lesson</code>, <code>match</code> — so a month reads at a glance.</p>

      ${note('Scheduling a tournament from the <a href="#mod-tournaments">Tournaments</a> block writes its calendar entry for you, tagged <code>tournament</code>. You do not add it twice.', 'tip')}

      <h2>Attendance</h2>
      <p>Pick an event in the attendance panel and you get a form builder — the same one as the
      club registration form in Club settings. Set what checking in is worth, add short
      answer, long answer, multiple choice and slider questions, reorder them, and preview exactly
      what people will see.</p>
      ${steps([
        ['Open the event\'s QR code', 'From the attendance panel. Project it, or print it and stick it on the door.'],
        ['Anyone in the room scans it', 'No account and no login needed — the check-in opens on their phone as it is.'],
        ['They answer and check in', 'A loading screen, then a checkmark. Points follow the address they gave.'],
        ['Streaks take care of themselves', 'Consecutive attended events build the streak in the topbar.']
      ])}

      <h3>What each person is asked</h3>
      <p><strong>Signed in</strong> — only the questions you added. The club already has their name
      and their address, so it does not ask again. If you added nothing, checking in is one tap:
      the form completes on its own.</p>
      <p><strong>Signed out</strong> — first name, last name and email first, then your questions.
      Those three are built in and cannot be removed or reordered, because without them a check-in
      is an anonymous tally.</p>

      <h3>Where the points go</h3>
      ${steps([
        ['The address belongs to a member', 'The points go to that account, once per event. A second submission on the same address is labelled a duplicate and awarded nothing.'],
        ['The address already registered', 'Their pending registration holds the points until they join.'],
        ['The address is new', 'They are marked New user, and a pending registration is opened for them automatically from the name and address they just typed. It holds the points.'],
        ['They join the club', 'Whatever was being held moves onto their membership row, and only then does it count on the leaderboard.']
      ])}
      ${note('Points earned without an account are settled the next time an admin opens the club — not at the instant of the check-in. Somebody who is not signed in cannot write to a member\'s points, and should not be able to.', 'tip')}

      <p>A member who arrives without scanning still gets prompted: if an event is running
      right now, the check-in finds them when they open the club.</p>
    `
  },
  {
    id: 'mod-puzzles', group: 'Modules', title: 'Puzzles',
    eyebrow: 'Module', eyebrowTint: '',
    keywords: 'puzzles tactics fen points solve daily puzzle position branch merge expiry due date deadline preview manage completed mark done roster',
    body: () => `
      <p class="doc-lede">Publish a position, set what solving it is worth, and let the club
      grind through it. The single best reason for a member to open the site on a Tuesday.</p>

      <h2>Building one</h2>
      <p>Four steps, in the order you actually decide them. Nothing is typed twice and there is
      no attempts box to guess at.</p>
      ${steps([
        ['Pick the color', 'Who is solving. It is the first thing asked because everything else follows from it — the board faces their way and the moves you record alternate from there.'],
        ['Set the starting position', 'Drag pieces on from the trays and off to the bin. Standard start, clear board and Import FEN are all one click. Confirm it when it looks right.'],
        ['Play the solution', 'Just play it. Every move is recorded as you make it — no Record button — and turns alternate on their own: your move, their reply, your move. The last move of a line is flagged as the end automatically.'],
        ['Fill in the details', 'Title, description, a source link, points, an optional due date and what comes off for solving late.']
      ])}

      <h3>More than one good move</h3>
      <p>Click any move in the line to stand at that position again, then play something
      different — that opens a <strong>second branch</strong>, and both are accepted as correct.
      Whoever solves it will meet one of the replies at random.</p>
      <p>If two branches arrive at the <strong>same board</strong>, you are asked whether to
      <strong>merge</strong> them, and the continuation is shared instead of typed twice. A merged
      move is drawn with a dashed border. Merging is only offered where the position really is
      identical, and never where it would send the puzzle round in a circle.</p>

      <h3>Moves to find</h3>
      <p>Counted off the line you built — the shortest number of moves your solver's own color
      has to get right. It replaces the old max-attempts field, which nobody could answer
      honestly anyway. Wrong moves are simply refused; there is no attempt limit.</p>

      <h2>Due dates and the late cut</h2>
      <p>A due date does not close a puzzle, it discounts it. Set one, and choose what percentage
      comes off for solving after it — someone who gets to it late still earns something, just
      not the full amount.</p>
      ${table(['Puzzle worth', 'Late cut', 'Solved late, worth'], [
        ['20 points', '25%', '15 points'],
        ['25 points', '33%', '16 points — 16.75, and the decimals are dropped'],
        ['10 points', '100%', 'nothing, but the puzzle still works']
      ])}
      ${note('Decimals are always truncated, never rounded up. A late solve can never be worth more than the arithmetic says.', 'tip')}

      <h2>Preview</h2>
      <p>Next to <strong>Edit</strong> on every published puzzle, and on the details step while you
      are still building. It plays exactly as a member's copy does — same board, same replies,
      same modal at the end — except nothing is awarded and nothing is recorded. Check a puzzle
      before the club does.</p>

      <h2>Marking it done for somebody</h2>
      <p>Puzzles get set in a room as well as on a screen. <strong>Manage</strong>, next to Preview
      on every published puzzle and on every puzzle inside a collection, opens the roster with a
      tick against everybody who has finished it. People who solved it themselves arrive already
      ticked; tick anybody else and it shows as done on their side too.</p>
      ${note('Ticking gives <strong>no points</strong> and clearing a tick takes <strong>none away</strong>. It is there to tidy a list, not to move the leaderboard — so a puzzle can never be handed out for points.', 'warn')}
      <p>The two kinds of completion are told apart on the row: a solve says when it happened and
      what it paid, and carries an <strong>Earned</strong> mark; a tick says who ticked it. That
      matters when you clear one. Clearing a tick is nothing. Clearing a solve somebody was paid
      for leaves the points where they are — nothing here ever moves points — but puts the puzzle
      back on their list, where solving it a second time <em>would</em> pay out again, so it asks
      you first.</p>
      <p>Somebody whose row has been ticked and who then plays the puzzle properly gets the
      replay screen rather than the payout, because as far as the club is concerned they have
      already done it.</p>

      <h2>Solving</h2>
      <p>Members play the moves on the board. A wrong move says so and lets them try again; a
      correct line pays out once, and the attempt is recorded so nobody farms the same puzzle
      twice. When it lands, the points count up on screen along with how long it took — the clock
      starts the moment the puzzle is opened, not on the first move. Points feed the
      <a href="#mod-leaderboard">leaderboard</a> and the <a href="#mod-store">store</a>.</p>

      ${note('Puzzle points and chess <em>ratings</em> are unrelated. Points are your club\'s own currency; ratings only move when you play a rated game. See <a href="#ratings">Ratings &amp; records</a>.')}
    `
  },
  {
    id: 'mod-newsletters', group: 'Modules', title: 'Newsletters',
    eyebrow: 'Module', eyebrowTint: 'purple',
    keywords: 'newsletters announcements email archive gmail send news recipients @members @pending @admin groups',
    body: () => `
      <p class="doc-lede">Write once. It lands on the club page, in the Latest news widget,
      and — if you want — in every member's inbox.</p>

      <h2>Writing</h2>
      <p>Admins get a rich editor: headings, bold, lists, links and images. Each newsletter
      keeps its own date and stays in the archive, so a club builds a readable history rather
      than a chat log that scrolls away.</p>

      <h2>Sending by email</h2>
      <p>With Gmail delivery connected, a newsletter can go out to the club roster as a
      formatted email. You pick the recipients, preview the message, and send.</p>

      <h2>Adding people with @</h2>
      <p>The recipient box takes ordinary addresses, and it takes three shortcuts that each stand
      for a whole group. Type <code>@</code> and it offers them with a head count on each.</p>
      ${table(['Shortcut', 'Who it adds'], [
        ['<code>@members</code>', 'Everybody in the club — students, admins and the founder.'],
        ['<code>@pending</code>', 'Everybody waiting on an invite. They signed up through the JagChess Network or were typed into the markup on the Members page, and have no account yet.'],
        ['<code>@admin</code>', 'The founder and every admin, and nobody else.']
      ])}
      <p>A shortcut drops its people in as ordinary recipients rather than staying as one group
      chip, so you can see exactly who the message is going to and take any of them straight back
      out. Anybody not in the club yet is marked on their chip and counted separately under the
      box — worth a glance before you send something written for members only.</p>

      ${note('Delivery is opt-in per newsletter. Writing one never emails anybody until you press send, so drafts are safe.', 'tip')}
    `
  },
  {
    id: 'mod-leaderboard', group: 'Modules', title: 'Leaderboard',
    eyebrow: 'Module', eyebrowTint: 'gold',
    keywords: 'leaderboard ranking points rating standings wins draws losses record global club',
    body: () => `
      <p class="doc-lede">Three tabs — points, club rating and global rating — and a win /
      draw / loss record on every row.</p>

      ${art.leaderboardFig()}

      <h2>The tabs</h2>
      ${table(['Tab', 'Ranks by', 'Where the number comes from'], [
        ['Points', 'Club points, highest first', 'Puzzles solved, events attended, anything an admin awards.'],
        ['Club rating', 'Glicko-2 within this club', 'Rated duels and rated club tournaments against club members.'],
        ['Global rating', 'Glicko-2 across JagChess', 'Rated global duels and rated global tournaments, against anybody.']
      ])}

      <p>On the rating tabs, players who have never finished a rated game show <code>?</code>
      and sit below everybody who has — an unplayed 1000 tells you nothing.</p>

      <h2>Reading it from outside a club</h2>
      <p>Signed-in players can read the <strong>global</strong> board without belonging to any club at
      all — it is the <strong>Leaderboard</strong> tab on the hub, at <code>/leaderboard</code>, and it sorts by
      global rating, most wins or most games. Club ratings stay inside their club, because a club
      number only means something next to the other members of that club.</p>

      <h2>Duel and watch buttons</h2>
      <p>Every row you are not on carries a <strong>Duel</strong> button, and a <strong>Watch</strong> button
      whenever that player has a game in progress.</p>

      <h2>Hiding staff</h2>
      <p>Admins get a switch at the top: <strong>hide staff from the leaderboard</strong>. Turn it on and
      admins and the founder drop off the ranking, so the board is a contest between students.
      It affects the leaderboard widget too.</p>
    `
  },
  {
    id: 'mod-duels', group: 'Modules', title: 'Duels',
    eyebrow: 'Module', eyebrowTint: 'blue',
    keywords: 'duels play chess game clock time control challenge spectate watch rated casual',
    body: () => `
      <p class="doc-lede">One-on-one chess with real clocks and real ratings. The full detail
      of actually playing is under <a href="#playing">Playing a game</a>; this is the page it starts from.</p>

      <h2>The setup panel</h2>
      ${table(['Choice', 'What it changes'], [
        ['Where', '<strong>In the club</strong> pairs you only with club members and moves your club rating. <strong>Global</strong> pairs you with anyone on JagChess and moves your global rating.'],
        ['Who', '<strong>Random</strong> puts you in the queue. Naming a player sends them a direct challenge instead.'],
        ['Time control', 'From 1+0 bullet to 30+20 classical. The first number is minutes on the clock, the second is seconds added per move.'],
        ['Color', 'White, Black or random. Two players who both want White will not be paired with each other.'],
        ['Stakes', '<strong>Rated</strong> moves both ratings and both records. <strong>Casual</strong> moves nothing.']
      ])}

      <h2>Finding a game</h2>
      <p>Press <strong>Play</strong> with "Random" and you enter the queue. It looks for the closest
      rating to yours and widens as you wait — after twenty-five seconds it stops caring about
      rating and takes whoever is there. Leaving the page takes you out of the queue.</p>

      <h2>Challenging someone</h2>
      <p>Name a player instead and they get a challenge — a pop-up wherever they are in the
      club, and a bar on their duels page that does not go away until they answer. Navigating
      away withdraws it rather than leaving it hanging.</p>

      <h2>Live games</h2>
      <p>The side panel lists every game in progress, club or global. Click one to watch: same
      screen the players see, without the clock pressure. A viewer count shows how many people
      are watching.</p>

      ${note('Want to play someone who is not here yet? Generate a <a href="#match-links">match link</a> and send it to them.', 'tip')}
    `
  },
  {
    id: 'mod-tournaments', group: 'Modules', title: 'Tournaments',
    eyebrow: 'Module', eyebrowTint: 'purple',
    keywords: 'tournaments arena create host schedule rated berserk lichess',
    body: () => `
      <p class="doc-lede">The Tournaments block is where a club runs events. How an arena
      actually plays gets its own page — <a href="#tournaments">Tournaments in depth</a> — this
      is how to create and manage one.</p>

      ${art.tournamentForm()}

      <h2>Creating one</h2>
      <p>Admins and founders see <strong>New tournament</strong>. Everything on the form:</p>
      ${table(['Setting', 'Notes'], [
        ['Name', 'What members see in the list and on the calendar.'],
        ['Starts at', 'Date and time. Until then the tournament is open for entries but nothing pairs.'],
        ['Time control', 'One game\'s clock — the same list the duels page uses.'],
        ['Lasts', 'How long the whole thing runs, in minutes. When it expires the leader wins.'],
        ['Rated', 'Rated moves the club rating (or global rating, outside a club) and every player\'s record. Casual moves nothing.'],
        ['Berserk', 'Off by default. Lets players halve their own clock for a bonus point.'],
        ['Add to calendar', 'On by default when the club has an Events block. Writes the calendar entry for you.']
      ])}

      ${note('Rated club tournaments move the <strong>club</strong> rating and only pair club members. Rated global tournaments move the <strong>global</strong> rating and are open to anybody signed in.')}

      <h2>Managing one</h2>
      <ul>
        <li><strong>Before it starts</strong> — the host can edit it or cancel it. Entrants can join and withdraw freely.</li>
        <li><strong>While it runs</strong> — the host can finish it early. Standings freeze where they are and the leader wins.</li>
        <li><strong>After it ends</strong> — it moves to <a href="#history">History</a> with its podium and final standings intact.</li>
      </ul>

      <h2>On the dashboard</h2>
      <p>Add the <strong>Tournaments</strong> widget in editor mode and the dashboard shows what is
      running now and what is next, with a way straight in.</p>

      <h2>Global tournaments</h2>
      <p>Everything above works the same at <code>/tournaments</code> on the hub, except that anybody
      can host, anybody can enter, and rated events move the global rating.</p>

      <h2>Lichess tournaments</h2>
      <p>The same page can also run and show real lichess events, with their own setup form and
      their own live standings. That has a page of its own:
      <a href="#lichess">Lichess tournaments</a>.</p>
    `
  },
  {
    id: 'mod-store', group: 'Modules', title: 'Store & Donate',
    eyebrow: 'Module', eyebrowTint: 'gold',
    keywords: 'store shop points spend orders rewards merch donate donations fundraising',
    body: () => `
      <p class="doc-lede">The place points become real. Plus a donations page for the people
      who want to fund the club rather than earn from it.</p>

      <h2>Store</h2>
      <p>Admins list items with a name, a picture, a description and a cost in points.
      Members add to a cart, check out with points, and the order arrives for approval.</p>
      ${steps([
        ['A member orders', 'Their points are held against the order.'],
        ['An admin sees it', 'Pending orders sit in the admin view of the Store block.'],
        ['You approve or reject', 'Approving completes the order. Rejecting returns the points.'],
        ['You hand the thing over', 'That part is still on you.']
      ])}
      ${note('Good things to sell: club hoodies, tournament entry, a pass to skip cleanup, choosing next week\'s puzzle theme, a lesson with the coach.', 'tip')}

      <h2>Donate</h2>
      <p>A simple page asking supporters to help fund equipment, coaching and travel. Set the
      wording to match what your club actually needs — parents respond to specifics far more
      than to a general appeal.</p>
    `
  },

  /* ── playing ────────────────────────────────────────────────────── */
  {
    id: 'playing', group: 'Playing chess', title: 'Playing a game',
    eyebrow: 'How to play', eyebrowTint: 'blue',
    keywords: 'play game move board promotion draw resign clock flag timeout spectate how to play',
    body: () => `
      <p class="doc-lede">Every game in JagChess — duel, match link or tournament round —
      happens on this one screen.</p>

      ${art.duelBoard()}

      <h2>Moving</h2>
      <p>Two ways, and they work together:</p>
      <ul>
        <li><strong>Drag</strong> a piece to its square.</li>
        <li><strong>Tap</strong> a piece, then tap where it goes. Better on a phone.</li>
      </ul>
      <p>Either way, picking a piece up dots every square it may legally reach. Captures get a
      ring instead of a dot. An illegal move snaps back rather than being rejected with a message.</p>

      <h3>Promotion</h3>
      <p>Push a pawn to the last rank and a chooser appears — queen, rook, bishop or knight.
      The move is not sent until you pick.</p>

      <h2>The clock</h2>
      <p>Your clock runs while it is your move and stops the moment you play. The increment is
      added <em>after</em> your move, so a 5+3 game gives you three seconds back each time. Under
      twenty seconds the clock turns red and starts showing tenths.</p>
      <p>Run out and you lose on time — unless your opponent has no material to mate with, in
      which case it is a draw.</p>

      <h2>Ending it</h2>
      ${table(['Result', 'How'], [
        ['Checkmate', 'Detected automatically.'],
        ['Timeout', 'A clock hits zero.'],
        ['Resignation', 'The Resign button, behind a confirmation.'],
        ['Draw by agreement', 'One player offers, the other accepts.'],
        ['Stalemate', 'Automatic.'],
        ['Threefold repetition', 'Automatic — the full move history is kept, which is what makes this detectable.'],
        ['Insufficient material', 'Automatic.']
      ])}

      <p>When a rated game ends, both ratings are worked out from the snapshot taken when the
      game started and written once. Your win / draw / loss record updates at the same moment.</p>

      <h2>Watching</h2>
      <p>Spectating is the identical screen with no clock of your own and no buttons. The
      viewer count at the top counts everybody watching. Players are not counted as viewers.</p>

      ${note('Closed the tab mid-game? Your game is still there. The <strong>Back to your game</strong> chip appears in the topbar on every page until it finishes.', 'tip')}
    `
  },
  {
    id: 'match-links', group: 'Playing chess', title: 'Match links',
    eyebrow: 'Playing', eyebrowTint: '',
    keywords: 'match link invite friend send link play a friend url share game link',
    body: () => `
      <p class="doc-lede">You want to play one specific person, and they are not online right
      now. Generate a link, send it however you like, and the game starts the moment they open it.</p>

      ${art.matchLinkFig()}

      <h2>Making one</h2>
      ${steps([
        ['Set your terms', 'Time control, color and rated or casual — the same choices as a normal duel.'],
        ['Press <b>Create match link</b>', 'On the duels page, or on <strong>Play a match</strong> from the hub.'],
        ['Send it', 'Copy the link into a message, an email, wherever. Nothing is posted anywhere by JagChess.'],
        ['Wait', 'The page tells you when somebody opens it, and drops you both into the game.']
      ])}

      <h2>Who a link works for</h2>
      ${table(['Link type', 'Who can use it'], [
        ['Global', 'Anybody signed in to JagChess. Moves the global rating if it is rated.'],
        ['Club', 'Only members of that club. Anybody else is told the link is not valid for them. Moves the club rating if it is rated.']
      ])}

      ${note('<strong>Both players must be signed in.</strong> Someone opening a match link signed out is sent to log in and returned to the link afterwards, so nothing is lost.', 'warn')}

      <h2>The small print</h2>
      <ul>
        <li><strong>One opponent.</strong> First person to open it takes the seat; after that the link is spent.</li>
        <li><strong>It expires.</strong> An unclaimed link stops working after 24 hours.</li>
        <li><strong>You cannot claim your own link.</strong> Opening it yourself just shows you the waiting screen again.</li>
        <li><strong>Cancel any time</strong> before it is claimed, from the waiting screen.</li>
      </ul>
    `
  },
  {
    id: 'tournaments', group: 'Playing chess', title: 'Tournaments in depth',
    eyebrow: 'Format', eyebrowTint: 'purple',
    keywords: 'arena pairing scoring streak berserk pause ties discontinued bracket knockout',
    body: () => `
      <p class="doc-lede">JagChess runs one native format: the arena. It is built for an
      evening with uneven turnout, which is what a club night usually is.</p>

      <h2 id="arena">Arena</h2>
      <p>The lichess format. Everybody who has joined is in a pool; whenever you are free, you
      are paired with whoever is nearest you on score. Lose and you are paired again within
      seconds. It runs until the clock expires.</p>

      ${art.arenaFig()}

      <h3>Scoring</h3>
      ${table(['Result', 'Points', 'On a streak'], [
        ['Win', '2', '4'],
        ['Draw', '1', '2'],
        ['Loss', '0', '0']
      ])}
      <p><strong>The streak:</strong> win two games in a row and you are on a streak. Everything after
      that is worth double, until a game you do not win — that game scores normally and the
      streak resets. Two more wins starts it again.</p>

      <h3>Pausing</h3>
      <p>Need to stop? Press <strong>Pause</strong> and you will not be paired again. Your score is kept
      exactly where it is. Press <strong>Join</strong> to come back in — you can do this as often as you like.</p>

      <h3>Berserk</h3>
      <p>Off unless the host turned it on. Berserk halves <em>your own</em> clock before the game
      starts, and in exchange a win is worth <strong>one extra point</strong>. A draw or a loss gets you
      nothing for it. It is a gamble, and that is the point.</p>

      <h3>Ties</h3>
      <p>Level on points at the end? The tie-break order is: more wins, then fewer games played
      (a better score from fewer games is a better score), then higher rating.</p>

      <h2 id="bracket">Brackets, discontinued</h2>
      <p>JagChess used to offer a second format: a single-elimination bracket, seeded by rating,
      with an optional third-place play-off. It was <strong>discontinued in 26.9.19.3</strong> and can
      no longer be created.</p>
      <p>Brackets that finished before then keep everything they had — podium, final standings,
      games — and still read normally in <a href="#history">History</a>. One that never finished is
      shown as discontinued and has no result. Either way, every rating change from a game that
      was actually played still stands.</p>
      ${note('Want a knockout with a real draw and a real final? Run it on Lichess — see <a href="#lichess">Lichess tournaments</a> — or use an arena, which decides a clear winner in a fixed amount of time.', 'tip')}

      <h2>Rated or casual</h2>
      <p>A rated tournament moves ratings and records exactly as a rated duel does, game by
      game as each one finishes. Casual tournaments still keep full standings and still go in
      the history — they simply do not touch anybody's rating.</p>
    `
  },
  {
    id: 'lichess', group: 'Playing chess', title: 'Lichess tournaments',
    eyebrow: 'Integration', eyebrowTint: 'blue',
    keywords: 'lichess oauth team arena swiss tmt board api join membership sync live games',
    body: () => `
      <p class="doc-lede">JagChess can run a tournament of its own, or it can show you a
      <strong>real lichess one</strong> — live standings, live games, and a board you play on
      here instead of on lichess.org.</p>

      <h2>What it is</h2>
      <p>An admin points JagChess at a <strong>lichess team</strong>. From then on every
      tournament that team runs turns into a page here on its own: no copying, no pasting,
      no announcing. When it starts, the page goes live. When it ends, everything about it
      is archived here and stays.</p>
      ${note('Everything comes through the official lichess API. Nothing is scraped, and nothing here touches a lichess account except with that account holder\'s own permission.')}

      <h2>Setting it up</h2>
      ${steps([
        ['Open the setup', 'A club: the <strong>Lichess</strong> tab on the club\'s Tournaments page, admins only. The whole site: <code>/admin</code> → Lichess.'],
        ['Add a team', 'Paste the team address — <code>lichess.org/team/your-team</code> — or just its id. JagChess checks it with lichess and shows you what it found before you commit.'],
        ['Pick how often to check', 'Every five minutes by default. A live tournament is refreshed far more often than that regardless.'],
        ['That is all', 'Tournaments appear by themselves. You never add one by hand.']
      ])}

      <h2>Logging in with Lichess</h2>
      <p>Watching needs nothing at all — no lichess account, no login, no permission of any
      kind. You connect one only to take part, and it is asked for once, at the moment you
      press <strong>Join &amp; play</strong>. A tournament that does not need a team does not
      ask about teams.</p>
      <p><strong>Disconnect</strong> tells lichess to revoke the permission, not just this site
      to forget it.</p>

      <h2>Joining one</h2>
      <p><strong>Join &amp; play</strong> is one press and you are playing. It signs you in
      with Lichess if it has to, enters you, asks lichess to pair you straight away, and opens
      your board the moment it does — you do not press anything else. Reload in the middle of
      a game and you land back on your board.</p>
      <p>The button says exactly one true thing at a time:</p>
      ${table(['You see', 'It means'], [
        ['Log in with Lichess', 'You have not connected an account yet.'],
        ['Join &amp; play', 'One press: entered, paired, and on your board.'],
        ['Finding you a game…', 'You are in and lichess is pairing you. Stay put — the board opens by itself.'],
        ['Join <em>team</em> on Lichess', 'This particular tournament really does require that team. Joining happens on lichess; come back and the page checks again.'],
        ['You are in', 'Your rank and score, live, as lichess reports them.'],
        ['View results', 'It is over. Everything is still here.'],
        ['Unavailable', 'Lichess no longer has it. The last thing we saw is still shown.']
      ])}
      ${note('A tournament found through a team is <strong>not</strong> automatically a team-only tournament. JagChess reads the entry conditions from lichess and will never tell you to join a team you do not need — the page says plainly which of the two it is.', 'tip')}

      <h2>Playing from here</h2>
      <p>Press <strong>Play</strong> once a tournament is running and your game opens on a
      JagChess board: your clocks, the move list, resign, draw offers, berserk, promotion,
      the lot. Moves go straight to lichess through its Board API and your opponent's come
      back live. You never have to open lichess.org.</p>
      <p>Watching somebody else's game works too, with one caveat that is not ours: lichess
      <strong>delays ongoing games by three moves</strong> for every outside viewer, to stop
      cheat bots. The board tells you when you are watching delayed.</p>
      <p>Any game can be <strong>stepped through move by move</strong> — the four buttons under
      the move list, or the arrow keys, Home and End. It works on a game still being played
      too, with one press to jump back to the live position. <kbd>F</kbd> flips the board.</p>

      <h2>Creating one</h2>
      <p><strong>＋ New tournament</strong> asks where it should run. Choose
      <strong>Lichess tournament</strong> and you get lichess's own setup form, in full —
      arena or Swiss, every clock and duration lichess allows, variants, berserk, streaks,
      starting position, and every entry condition: team, rating range, games played,
      account age, an invite list, a password.</p>
      <p>It is created on lichess under your account, and saved here at the same moment, so
      it is on the Tournaments page before anybody has refreshed anything. The settings are
      remembered for next time — running the same Friday arena again is a matter of changing
      the date.</p>
      ${note('Impossible combinations are caught before lichess sees them: a clock that does not fit the duration, berserk with too large an increment, a 0+1 game set to rated.')}

      <h2>What is Lichess\'s and what is ours</h2>
      <p>This matters, so the pages say it out loud. <strong>Rank, score, rating and
      performance are lichess\'s own figures.</strong> The win / draw / loss column is counted
      by JagChess from the games it has stored — it is marked with an asterisk everywhere it
      appears, and it is not a lichess statistic. Nothing JagChess adds up is a rating.</p>

      <h2>Afterwards</h2>
      <p>When a tournament ends, JagChess pulls the whole thing down once — final standings,
      every game, every move, the clocks, the podium — and stops asking lichess about it.
      From then on the history is served from here and survives whatever happens upstream.</p>

      <h2>For admins: is it working?</h2>
      <p>The Lichess panel shows the connection, whether synchronization is active, when the
      last successful call was, how many tournaments and games are live, the error count, and
      the last forty calls with their latency. If lichess is rate-limiting or unreachable it
      says so rather than quietly showing stale numbers.</p>
      ${note('Synchronization runs in one open browser tab at a time, chosen automatically, so the site never makes more than one request to lichess at once. Nothing syncs while nobody has JagChess open — the next visitor catches up, and every page says when it last synchronized.')}
    `
  },
  {
    id: 'history', group: 'Playing chess', title: 'Tournament history',
    eyebrow: 'Records', eyebrowTint: 'gold',
    keywords: 'history past tournaments winners podium results archive standings',
    body: () => `
      <p class="doc-lede">Nothing is thrown away when a tournament ends.</p>

      <h2>Finding it</h2>
      <p>The <strong>History</strong> tab on any Tournaments page — a club's block, or the global page at
      <code>/tournaments</code>. Newest first, JagChess arenas and
      <a href="#lichess">lichess tournaments</a> together, with a filter if you want only one kind.</p>

      <h2>What is kept</h2>
      <ul>
        <li><strong>The podium</strong> — champion, runner-up and third.</li>
        <li><strong>Final standings</strong> — every entrant, in order, with score and win / draw / loss.</li>
        <li><strong>The terms</strong> — format, time control, rated or casual, who hosted it, when it ran.</li>
        <li><strong>The games</strong> — every game played, replayable move by move.</li>
      </ul>

      ${note('A club\'s history is visible to its members. Global tournament history is readable by anybody signed in.')}
    `
  },
  {
    id: 'ratings', group: 'Playing chess', title: 'Ratings & records',
    eyebrow: 'Scoring', eyebrowTint: 'green',
    keywords: 'rating glicko provisional elo record wins draws losses points difference',
    body: () => `
      <p class="doc-lede">JagChess rates with Glicko-2, the system lichess uses. Here is what
      the number actually means.</p>

      <h2>Two ratings, not one</h2>
      ${table(['Rating', 'Moves when', 'Compared against'], [
        ['Club rating', 'You finish a rated game against a member of that club', 'The other members of that club'],
        ['Global rating', 'You finish a rated global game', 'Everybody on JagChess']
      ])}
      <p>They are stored separately and never mix. Being in five clubs means five club ratings
      and one global rating, and a bad night in one club leaves the others untouched.</p>

      <h2>Where everyone starts</h2>
      <p>Everybody begins at <strong>1000</strong>, with the uncertainty set as high as it goes. Until
      you have finished a rated game your rating shows as <code>?</code>, because a number nobody
      has tested is not information.</p>

      <h2>Why the changes are uneven</h2>
      <p>Glicko-2 tracks how <em>sure</em> it is about you as well as how strong you are. A new
      player's rating moves in big jumps while it finds their level; a player with two hundred
      games moves by a point or two. Beating someone far above you is worth a lot; losing to
      someone far below you costs a lot. That is the system working, not a bug.</p>

      <h2>Points are not rating</h2>
      ${table(['', 'Points', 'Rating'], [
        ['Earned by', 'Puzzles, attendance, admin awards', 'Winning rated games'],
        ['Can go down', 'Only by spending in the store', 'Yes, every time you lose'],
        ['Scope', 'One club', 'One club, or global'],
        ['Used for', 'The store, the points leaderboard', 'Pairing, seeding, the rating leaderboards']
      ])}

      <h2>Your record</h2>
      <p>Every rated game also adds to a <strong>win / draw / loss</strong> count, kept separately for
      each club and for global play. It shows on the leaderboard beside your rating, and unlike
      a rating it never goes down — it only tells you what happened.</p>

      ${note('Casual games move nothing: not rating, not record. Play casual when you are experimenting, rated when you mean it.')}
    `
  }
];

const byId = (id) => PAGES.find((p) => p.id === id);

/* ═══ SIDEBAR ═══════════════════════════════════════════════════════ */

function buildSidebar() {
  const groups = [];
  PAGES.forEach((p) => {
    let g = groups.find((x) => x.name === p.group);
    if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
    g.items.push(p);
  });
  $('#doc-side').innerHTML = groups.map((g) => `
    <div class="doc-side-group">
      <div class="doc-side-label">${esc(g.name)}</div>
      ${g.items.map((p) => `<a href="#${p.id}" data-p="${p.id}"><span class="doc-side-dot"></span>${esc(p.title)}</a>`).join('')}
    </div>`).join('');
}

function markSidebar(id) {
  document.querySelectorAll('#doc-side a').forEach((a) => a.classList.toggle('on', a.dataset.p === id));
}

/* ═══ ROUTING ═══════════════════════════════════════════════════════ */

function render(id) {
  const page = byId(id) || PAGES[0];
  const i = PAGES.indexOf(page);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];

  document.title = page.title + ' · JagChess guide';
  markSidebar(page.id);

  $('#doc-main').innerHTML = `
    <span class="doc-eyebrow ${page.eyebrowTint || ''}">${esc(page.eyebrow)}</span>
    <h1>${esc(page.title)}</h1>
    ${page.body()}
    <div class="doc-foot-nav">
      ${prev ? `<a href="#${prev.id}"><span>Previous</span><b>${esc(prev.title)}</b></a>` : '<span></span>'}
      ${next ? `<a class="next" href="#${next.id}"><span>Next</span><b>${esc(next.title)}</b></a>` : '<span></span>'}
    </div>`;

  // the changelog is the page that answers "what changed", so reaching it is
  // what marks this version as caught up on
  if (page.id === 'changelog') markVersionSeen();

  document.body.classList.remove('nav-open');
}

function route() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [id, anchor] = raw.split('/');
  render(id || 'welcome');
  if (anchor) {
    const el = document.getElementById(anchor);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  }
  // an in-page id on the same page (#tournaments/arena style, or a bare match)
  const direct = raw && document.getElementById(raw);
  if (direct && !byId(raw)) { direct.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ═══ SEARCH ════════════════════════════════════════════════════════ */

/* Titles and keywords only. The bodies are HTML strings and searching them
   would match markup as readily as prose. */
function search(term) {
  const t = term.trim().toLowerCase();
  const box = $('#doc-hits');
  if (!t) { box.hidden = true; return; }

  const hits = PAGES
    .map((p) => {
      const title = p.title.toLowerCase();
      const keys = (p.keywords || '').toLowerCase();
      let score = 0;
      if (title.startsWith(t)) score = 100;
      else if (title.includes(t)) score = 70;
      else if (keys.split(/\s+/).some((k) => k.startsWith(t))) score = 40;
      else if (keys.includes(t)) score = 20;
      return { p, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title))
    .slice(0, 8);

  box.hidden = false;
  box.innerHTML = hits.length
    ? hits.map((h) => `<a href="#${h.p.id}"><b>${esc(h.p.title)}</b><small>${esc(h.p.group)}</small></a>`).join('')
    : '<div class="doc-search-empty">Nothing matches that.</div>';
}

/* ═══ BOOT ══════════════════════════════════════════════════════════ */

buildSidebar();
route();
window.addEventListener('hashchange', route);

const input = $('#doc-q');
input.addEventListener('input', () => search(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { input.value = ''; $('#doc-hits').hidden = true; input.blur(); }
  if (e.key === 'Enter') {
    const first = $('#doc-hits a');
    if (first) { location.hash = first.getAttribute('href').slice(1); input.value = ''; $('#doc-hits').hidden = true; input.blur(); }
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.doc-search')) $('#doc-hits').hidden = true;
});

$('#doc-burger').onclick = () => document.body.classList.toggle('nav-open');
$('#doc-scrim').onclick = () => document.body.classList.remove('nav-open');

/* "/" focuses search, the way documentation sites are expected to behave */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    input.focus();
  }
});
