/* ═══════════════════════════════════════════════════════════════════════
   lichess-create.js — the Lichess tournament form.

   This is the JagChess copy of lichess's own tournament setup, and it is
   deliberately the WHOLE of it rather than a friendly subset: every field
   POST /api/tournament and POST /api/swiss/new/{teamId} accept is on this
   form, with lichess's own allowed values, because a host who has to finish
   the job on lichess.org was not given a tournament mode at all.

   Two things are saved when you press Create:

     1. the tournament, on lichess, through the official endpoint — that is
        the real event, with a real lichess id;
     2. the tournament AND the exact configuration used, in our database, so
        the site has the event from the moment it exists rather than waiting
        for the next sync sweep to notice it.

   The form also remembers what you last filled in, per kind, so running the
   same Friday arena next week is a matter of changing the date.

   Every constraint checked here is one lichess documents and would other-
   wise reject: the clock/duration ratio, the berserk rule, and the fact
   that a 0+1 game cannot be rated. Failing early with a sentence is kinder
   than a 400 from an API the host never asked to talk to.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, toast } from './club-core.js';
import * as api from './lichess-api.js';
import * as store from './lichess-store.js';
import { session, ensureScopes, SCOPES, connect } from './lichess-auth.js';

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

/* ── lichess's allowed values, exactly ─────────────────────────────── */

export const ARENA_CLOCK_TIMES = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50, 60];
export const ARENA_INCREMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 15, 20, 25, 30, 40, 50, 60];
export const ARENA_MINUTES = [20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 150, 180, 210, 240, 270, 300, 330, 360, 420, 480, 540, 600, 720];
export const WAIT_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];

export const SWISS_CLOCK_LIMITS = [0, 15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480, 600, 900, 1200, 1500, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200, 7800, 8400, 9000, 9600, 10200, 10800];
export const SWISS_ROUND_INTERVALS = [
  [-1, 'Automatic'], [5, '5 seconds'], [10, '10 seconds'], [20, '20 seconds'],
  [30, '30 seconds'], [45, '45 seconds'], [60, '1 minute'], [120, '2 minutes'],
  [180, '3 minutes'], [300, '5 minutes'], [600, '10 minutes'], [900, '15 minutes'],
  [1200, '20 minutes'], [1800, '30 minutes'], [2700, '45 minutes'], [3600, '1 hour'],
  [86400, '1 day'], [172800, '2 days'], [604800, '1 week'],
  [99999999, 'Schedule each round by hand']
];

export const MIN_RATINGS = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600];
export const MAX_RATINGS = [2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100, 1000, 900, 800];
export const MIN_RATED_GAMES = [0, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200];
export const ACCOUNT_AGES = [
  [1, '1 day'], [3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month'],
  [60, '2 months'], [90, '3 months'], [180, '6 months'], [365, '1 year'],
  [730, '2 years'], [1095, '3 years']
];

export const VARIANTS = [
  ['standard', 'Standard'], ['chess960', 'Chess960'], ['crazyhouse', 'Crazyhouse'],
  ['antichess', 'Antichess'], ['atomic', 'Atomic'], ['horde', 'Horde'],
  ['kingOfTheHill', 'King of the Hill'], ['racingKings', 'Racing Kings'],
  ['threeCheck', 'Three-check']
];

export const SWISS_CHAT = [
  [0, 'Nobody'], [10, 'Team leaders only'], [20, 'Team members only'], [30, 'Every lichess player']
];

/* ── the rules lichess will apply anyway ───────────────────────────── */

/**
 * The clock-to-duration check from the API description, word for word:
 *   3 <= (minutes * 60) / (96 * clockTime + 48 * clockIncrement + 15) <= 150
 *
 * It exists because a 30-minute arena of 30+30 games fits one game, and a
 * 12-hour arena of bullet fits thousands. Checking it here means the host
 * finds out while they can still change the number.
 */
export function arenaRatio(clockTime, clockIncrement, minutes) {
  const denom = 96 * Number(clockTime) + 48 * Number(clockIncrement) + 15;
  if (!denom) return null;
  return (Number(minutes) * 60) / denom;
}

export function checkArena(f) {
  if (Number(f.clockTime) + Number(f.clockIncrement) <= 0) {
    return 'A game needs a clock: the initial time and the increment cannot both be zero.';
  }
  if (f.rated && (
    (Number(f.clockTime) === 0.25 && Number(f.clockIncrement) === 0) ||
    (Number(f.clockTime) === 0 && Number(f.clockIncrement) === 1))) {
    return 'Lichess does not rate 15-second or 0+1 tournaments. Set it to casual, or lengthen the clock.';
  }
  if (f.berserkable && Number(f.clockIncrement) > Number(f.clockTime) * 2) {
    return 'Berserk is only allowed when the increment is at most twice the initial time.';
  }
  const r = arenaRatio(f.clockTime, f.clockIncrement, f.minutes);
  if (r != null && (r < 3 || r > 150)) {
    return r < 3
      ? 'That is too short for this time control — barely a game would fit. Make it last longer, or shorten the clock.'
      : 'That is far too long for this time control. Shorten it, or lengthen the clock.';
  }
  return null;
}

export function checkSwiss(f) {
  if (Number(f['clock.limit']) + Number(f['clock.increment']) <= 0) {
    return 'A game needs a clock: the initial time and the increment cannot both be zero.';
  }
  if (f.rated && Number(f['clock.limit']) === 15 && Number(f['clock.increment']) === 0) {
    return 'Lichess does not rate 15-second tournaments. Set it to casual, or lengthen the clock.';
  }
  const n = Number(f.nbRounds);
  if (!(n >= 3 && n <= 100)) return 'A Swiss runs between 3 and 100 rounds.';
  return null;
}

/* ── remembering the last one ──────────────────────────────────────── */

const MEM = 'jag-lichess-tmt';

const remembered = (kind) => {
  try { return JSON.parse(localStorage.getItem(MEM + ':' + kind) || 'null') || {}; }
  catch (_) { return {}; }
};
const remember = (kind, state) => {
  try {
    /* Not the name and not the date: those are the two things that must be
       thought about again. Not the password either — a tournament password
       left lying in localStorage is a small thing that is nonetheless not
       ours to keep. Everything else is the setup, and the setup is what a
       club repeats week after week. */
    const { name, dateStr, timeStr, password, ...rest } = state;
    localStorage.setItem(MEM + ':' + kind, JSON.stringify(rest));
  } catch (_) {}
};

/* ── the form ──────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const dateInputs = (ms) => {
  const d = new Date(ms);
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  };
};

const opts = (list, sel, label) => list.map((v) => {
  const [val, text] = Array.isArray(v) ? v : [v, label ? label(v) : String(v)];
  return `<option value="${esc(String(val))}"${String(val) === String(sel) ? ' selected' : ''}>${esc(text)}</option>`;
}).join('');

/**
 * Opens the Lichess tournament form.
 *
 * @param {object} ctx     JagChess context
 * @param {Array}  teams   the monitored lichess teams for this scope
 * @param {Function} onDone  called with the stored tournament row
 */
export function openLichessCreate(ctx, teams, onDone) {
  const soon = new Date(Date.now() + 60 * 60000);
  soon.setMinutes(0, 0, 0);
  const d0 = dateInputs(soon.getTime());

  const state = {
    kind: 'arena',
    name: '',
    description: '',
    rated: true,
    variant: 'standard',
    position: '',
    password: '',
    when: 'schedule',                 // 'schedule' | 'wait'
    waitMinutes: 5,
    ...d0,

    // arena
    clockTime: 3,
    clockIncrement: 0,
    minutes: 60,
    berserkable: true,
    streakable: true,
    hasChat: true,
    teamBattleByTeam: '',

    // swiss
    swissTeamId: (teams[0] && teams[0].teamId) || '',
    clockLimit: 300,
    clockIncrementSec: 0,
    nbRounds: 7,
    roundInterval: -1,
    chatFor: 20,
    forbiddenPairings: '',

    // conditions, shared
    restrictTeamId: '',
    minRating: '',
    maxRating: '',
    nbRatedGame: '',
    accountAge: '',
    allowList: '',
    bots: false,
    playYourGames: false,

    ...remembered('arena')
  };
  Object.assign(state, d0);

  const wrap = el(`
    <div class="modal tn-modal">
      <div class="modal-card tn-create li-create">
        <button class="icon-btn modal-close" data-x title="Close">✕</button>
        <h3>New Lichess tournament</h3>
        <p class="modal-meta" style="margin:0">
          Created on lichess.org through the official API, under your lichess account,
          and shown here live from the moment it exists.
        </p>

        <div id="li-who"></div>

        <div class="tn-field">
          <label>Kind</label>
          <div class="tn-choice" id="li-kind">
            <button type="button" class="tn-opt on" data-v="arena">
              <b>Arena</b><small>Timed and auto-paired. Anyone can join while it runs.</small>
            </button>
            <button type="button" class="tn-opt" data-v="swiss">
              <b>Swiss</b><small>A fixed number of rounds for one team. Everyone plays every round.</small>
            </button>
          </div>
        </div>

        <div class="tn-field" data-swiss hidden>
          <label for="li-team">Team</label>
          <select id="li-team">${teams.map((t) =>
            `<option value="${esc(t.teamId)}">${esc(t.name)}</option>`).join('')}</select>
          <small class="tn-hint">A Swiss tournament belongs to a team and only its members can enter — that is how lichess builds them. You must lead this team on lichess.</small>
        </div>

        <div class="tn-field">
          <label for="li-name">Name <span class="opt">optional</span></label>
          <input id="li-name" maxlength="30" placeholder="Friday Night Arena" autocomplete="off" />
          <small class="tn-hint">Up to 30 characters. Leave it empty and lichess names it after a grandmaster.</small>
        </div>

        <div class="tn-field">
          <label for="li-desc">Description <span class="opt">optional</span></label>
          <textarea id="li-desc" rows="2" placeholder="Anything entrants should know. Markdown works on lichess."></textarea>
        </div>

        <div class="tn-field">
          <label>Starts</label>
          <div class="duel-seg" id="li-when">
            <button type="button" class="duel-seg-opt on" data-v="schedule">On a date</button>
            <button type="button" class="duel-seg-opt" data-v="wait">After a wait</button>
          </div>
        </div>

        <div class="tn-row-2" data-when-schedule>
          <div class="tn-field">
            <label for="li-date">Date</label>
            <input id="li-date" type="date" value="${state.dateStr}" />
          </div>
          <div class="tn-field">
            <label for="li-time">Time</label>
            <input id="li-time" type="time" value="${state.timeStr}" />
          </div>
        </div>
        <div class="tn-field" data-when-wait hidden>
          <label for="li-wait">Starts in</label>
          <select id="li-wait">${opts(WAIT_MINUTES, 5, (v) => v + (v === 1 ? ' minute' : ' minutes'))}</select>
        </div>

        <!-- ── arena clock ── -->
        <div data-arena>
          <div class="tn-row-2">
            <div class="tn-field">
              <label for="li-ct">Initial time</label>
              <select id="li-ct">${opts(ARENA_CLOCK_TIMES, 3, (v) => v === 0 ? '0 minutes' : v < 1 ? (v * 60) + ' seconds' : v + (v === 1 ? ' minute' : ' minutes'))}</select>
            </div>
            <div class="tn-field">
              <label for="li-ci">Increment</label>
              <select id="li-ci">${opts(ARENA_INCREMENTS, 0, (v) => v + (v === 1 ? ' second' : ' seconds'))}</select>
            </div>
            <div class="tn-field">
              <label for="li-min">Lasts</label>
              <select id="li-min">${opts(ARENA_MINUTES, 60, (v) => v + ' minutes')}</select>
            </div>
          </div>
          <small class="tn-hint" id="li-ratio"></small>
        </div>

        <!-- ── swiss clock ── -->
        <div data-swiss hidden>
          <div class="tn-row-2">
            <div class="tn-field">
              <label for="li-sl">Initial time</label>
              <select id="li-sl">${opts(SWISS_CLOCK_LIMITS, 300, secLabel)}</select>
            </div>
            <div class="tn-field">
              <label for="li-si">Increment</label>
              <input id="li-si" type="number" min="0" max="120" value="0" />
            </div>
            <div class="tn-field">
              <label for="li-rounds">Rounds</label>
              <input id="li-rounds" type="number" min="3" max="100" value="7" />
            </div>
          </div>
          <div class="tn-row-2">
            <div class="tn-field">
              <label for="li-interval">Between rounds</label>
              <select id="li-interval">${opts(SWISS_ROUND_INTERVALS, -1)}</select>
            </div>
            <div class="tn-field">
              <label for="li-chat">Chat</label>
              <select id="li-chat">${opts(SWISS_CHAT, 20)}</select>
            </div>
          </div>
        </div>

        <div class="tn-row-2">
          <div class="tn-field">
            <label for="li-variant">Variant</label>
            <select id="li-variant">${opts(VARIANTS, 'standard')}</select>
          </div>
          <div class="tn-field">
            <label>Stakes</label>
            <div class="duel-seg" id="li-rated">
              <button type="button" class="duel-seg-opt on" data-v="rated">Rated</button>
              <button type="button" class="duel-seg-opt" data-v="casual">Casual</button>
            </div>
          </div>
        </div>
        <small class="tn-hint" id="li-rated-hint"></small>

        <div class="tn-field">
          <label for="li-fen">Starting position <span class="opt">optional FEN</span></label>
          <input id="li-fen" placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" autocomplete="off" />
          <small class="tn-hint">Leave empty for the normal starting position. A custom position makes the games casual on lichess.</small>
        </div>

        <!-- ── arena-only switches ── -->
        <div data-arena>
          ${switchRow('li-berserk', 'Allow berserk', 'Players may halve their own clock for an extra point on a win.', true)}
          ${switchRow('li-streak', 'Streaks', 'After two wins in a row, a win is worth 4 points instead of 2.', true)}
          ${switchRow('li-chaton', 'Tournament chat', 'Lets entrants talk to each other on the lichess tournament page.', true)}
        </div>

        <!-- ── who may enter ── -->
        <details class="li-more">
          <summary>Who may enter</summary>

          <div class="tn-field" data-arena>
            <label for="li-restrict">Members of a team only <span class="opt">optional</span></label>
            <input id="li-restrict" placeholder="team-id, or a lichess team URL" autocomplete="off" />
            <small class="tn-hint">Leave empty and anybody on lichess may join. This is the setting that decides whether this site asks players to join a team first.</small>
          </div>

          <div class="tn-field" data-arena>
            <label for="li-battle">Team battle <span class="opt">optional</span></label>
            <input id="li-battle" placeholder="a team you lead" autocomplete="off" />
            <small class="tn-hint">Makes this a battle between teams rather than individuals. The other teams are added on lichess afterwards. Do not use this and the setting above together.</small>
          </div>

          <div class="tn-row-2">
            <div class="tn-field">
              <label for="li-minr">Minimum rating</label>
              <select id="li-minr"><option value="">No minimum</option>${opts(MIN_RATINGS, '')}</select>
            </div>
            <div class="tn-field">
              <label for="li-maxr">Maximum rating</label>
              <select id="li-maxr"><option value="">No maximum</option>${opts(MAX_RATINGS, '')}</select>
            </div>
          </div>
          <small class="tn-hint">Maximum rating is judged on the best rating reached in the last seven days.</small>

          <div class="tn-row-2">
            <div class="tn-field">
              <label for="li-games">Rated games played</label>
              <select id="li-games"><option value="">No minimum</option>${opts(MIN_RATED_GAMES, '')}</select>
            </div>
            <div class="tn-field" data-arena>
              <label for="li-age">Account age</label>
              <select id="li-age"><option value="">Any</option>${opts(ACCOUNT_AGES, '')}</select>
            </div>
          </div>

          <div class="tn-field">
            <label for="li-allow">Allowed players <span class="opt">optional</span></label>
            <textarea id="li-allow" rows="2" placeholder="thibault, german11, %titled"></textarea>
            <small class="tn-hint">A list of lichess usernames, separated by commas. If it is not empty, nobody else can enter. Add <code>%titled</code> to let any titled player in as well.</small>
          </div>

          <div class="tn-field">
            <label for="li-pass">Password <span class="opt">optional</span></label>
            <input id="li-pass" autocomplete="off" placeholder="Leave empty for a public tournament" />
            <small class="tn-hint">A password makes the tournament private on lichess. Entrants are asked for it here too.</small>
          </div>

          <div data-arena>${switchRow('li-bots', 'Allow bots', 'Lets lichess BOT accounts enter.', false)}</div>
          <div data-swiss hidden>${switchRow('li-pyg', 'Must have played their last Swiss', 'Keeps out players who recently signed up and then did not turn up.', false)}</div>

          <div class="tn-field" data-swiss hidden>
            <label for="li-forbid">Players who must not meet <span class="opt">optional</span></label>
            <textarea id="li-forbid" rows="2" placeholder="PlayerA PlayerB&#10;PlayerC PlayerD"></textarea>
            <small class="tn-hint">Two usernames per line, separated by a space.</small>
          </div>
        </details>

        <p class="create-error" id="li-blocked" hidden>Add a lichess team first — a Swiss tournament has to belong to one.</p>

        <div class="tn-create-foot">
          <span class="create-error" id="li-error"></span>
          <button class="btn subtle" data-x>Cancel</button>
          <button class="btn primary" id="li-save">Create on Lichess</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(wrap);
  const q = (s) => wrap.querySelector(s);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };

  /* ── the lichess identity strip ── */

  function paintWho() {
    const s = session();
    q('#li-who').innerHTML = s
      ? `<div class="li-who ok">
           <span class="li-dot"></span>
           <span>Creating as <b>${esc(s.username)}</b> on lichess.</span>
         </div>`
      : `<div class="li-who">
           <span>Creating a tournament needs your lichess account.</span>
           <button class="btn primary sm" id="li-login">Log in with Lichess</button>
         </div>`;
    const b = q('#li-login');
    if (b) b.onclick = () => connect([SCOPES.tournament]);
  }

  /* ── restore, paint, wire ── */

  const setVal = (sel, v) => { const n = q(sel); if (n != null && v != null) n.value = v; };
  const setChk = (sel, v) => { const n = q(sel); if (n) n.checked = !!v; };

  function load() {
    setVal('#li-ct', state.clockTime); setVal('#li-ci', state.clockIncrement);
    setVal('#li-min', state.minutes); setVal('#li-variant', state.variant);
    setVal('#li-sl', state.clockLimit); setVal('#li-si', state.clockIncrementSec);
    setVal('#li-rounds', state.nbRounds); setVal('#li-interval', state.roundInterval);
    setVal('#li-chat', state.chatFor); setVal('#li-wait', state.waitMinutes);
    setVal('#li-team', state.swissTeamId);
    setVal('#li-minr', state.minRating); setVal('#li-maxr', state.maxRating);
    setVal('#li-games', state.nbRatedGame); setVal('#li-age', state.accountAge);
    setVal('#li-allow', state.allowList); setVal('#li-restrict', state.restrictTeamId);
    setVal('#li-battle', state.teamBattleByTeam); setVal('#li-fen', state.position);
    setVal('#li-forbid', state.forbiddenPairings);
    setChk('#li-berserk', state.berserkable); setChk('#li-streak', state.streakable);
    setChk('#li-chaton', state.hasChat); setChk('#li-bots', state.bots);
    setChk('#li-pyg', state.playYourGames);
  }

  function readForm() {
    state.name = q('#li-name').value.trim();
    state.description = q('#li-desc').value.trim();
    state.variant = q('#li-variant').value;
    state.position = q('#li-fen').value.trim();
    state.password = q('#li-pass').value.trim();
    state.dateStr = q('#li-date').value;
    state.timeStr = q('#li-time').value;
    state.waitMinutes = +q('#li-wait').value;

    state.clockTime = +q('#li-ct').value;
    state.clockIncrement = +q('#li-ci').value;
    state.minutes = +q('#li-min').value;
    state.berserkable = q('#li-berserk').checked;
    state.streakable = q('#li-streak').checked;
    state.hasChat = q('#li-chaton').checked;
    state.teamBattleByTeam = api.parseTeamId(q('#li-battle').value) || '';
    state.restrictTeamId = api.parseTeamId(q('#li-restrict').value) || '';

    state.swissTeamId = q('#li-team') ? q('#li-team').value : '';
    state.clockLimit = +q('#li-sl').value;
    state.clockIncrementSec = Math.max(0, Math.min(120, +q('#li-si').value || 0));
    state.nbRounds = +q('#li-rounds').value || 7;
    state.roundInterval = +q('#li-interval').value;
    state.chatFor = +q('#li-chat').value;
    state.forbiddenPairings = q('#li-forbid').value.trim();

    state.minRating = q('#li-minr').value;
    state.maxRating = q('#li-maxr').value;
    state.nbRatedGame = q('#li-games').value;
    state.accountAge = q('#li-age').value;
    state.allowList = q('#li-allow').value.trim();
    state.bots = q('#li-bots').checked;
    state.playYourGames = q('#li-pyg').checked;
  }

  function paint() {
    const arena = state.kind === 'arena';
    wrap.querySelectorAll('#li-kind [data-v]').forEach((b) =>
      b.classList.toggle('on', b.dataset.v === state.kind));
    wrap.querySelectorAll('#li-rated [data-v]').forEach((b) =>
      b.classList.toggle('on', b.dataset.v === (state.rated ? 'rated' : 'casual')));
    wrap.querySelectorAll('#li-when [data-v]').forEach((b) =>
      b.classList.toggle('on', b.dataset.v === state.when));
    wrap.querySelectorAll('[data-arena]').forEach((n) => (n.hidden = !arena));
    wrap.querySelectorAll('[data-swiss]').forEach((n) => (n.hidden = arena));
    wrap.querySelectorAll('[data-when-schedule]').forEach((n) => (n.hidden = state.when !== 'schedule'));
    wrap.querySelectorAll('[data-when-wait]').forEach((n) => (n.hidden = state.when !== 'wait'));

    q('#li-rated-hint').textContent = state.rated
      ? 'Games count towards the players’ lichess ratings.'
      : 'Nobody’s lichess rating moves. Standings are kept all the same.';

    if (arena) {
      const r = arenaRatio(state.clockTime, state.clockIncrement, state.minutes);
      const games = r == null ? null : Math.round(r);
      q('#li-ratio').textContent = games == null ? ''
        : r < 3 ? 'Too short for this clock — lichess will refuse it.'
          : r > 150 ? 'Far too long for this clock — lichess will refuse it.'
            : `Room for roughly ${games} games per player.`;
      q('#li-ratio').className = 'tn-hint' + (r != null && (r < 3 || r > 150) ? ' bad' : '');
    }

    /* A Swiss needs a team, and this form only offers teams the site is
       already monitoring — a tournament nobody here would ever see is not
       worth creating from here. */
    const blocked = !arena && !teams.length;
    q('#li-save').disabled = blocked;
    q('#li-blocked').hidden = !blocked;
  }

  q('#li-kind').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    readForm();
    state.kind = b.dataset.v;
    Object.assign(state, remembered(state.kind));
    load();
    paint();
  };
  q('#li-rated').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    state.rated = b.dataset.v === 'rated';
    paint();
  };
  q('#li-when').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    state.when = b.dataset.v;
    paint();
  };
  ['#li-ct', '#li-ci', '#li-min'].forEach((s) => {
    q(s).onchange = () => { readForm(); paint(); };
  });

  paintWho();
  load();
  paint();
  setTimeout(() => q('#li-name').focus(), 60);

  /* ── creating ── */

  q('#li-save').onclick = async () => {
    const err = q('#li-error');
    err.textContent = '';
    readForm();

    if (!session()) {
      await connect([SCOPES.tournament]);
      return;
    }
    const ok = await ensureScopes([SCOPES.tournament]);
    if (!ok) return;

    let startsAtMs = null;
    if (state.when === 'schedule') {
      if (!state.dateStr || !state.timeStr) { err.textContent = 'Pick a date and a time.'; return; }
      startsAtMs = new Date(`${state.dateStr}T${state.timeStr}`).getTime();
      if (!isFinite(startsAtMs)) { err.textContent = 'That date does not look right.'; return; }
      if (startsAtMs < Date.now() - 60000) { err.textContent = 'That start time has already passed.'; return; }
    }

    const form = state.kind === 'arena' ? arenaForm(state, startsAtMs) : swissForm(state, startsAtMs);
    const problem = state.kind === 'arena' ? checkArena(form) : checkSwiss(form);
    if (problem) { err.textContent = problem; return; }

    const btn = q('#li-save');
    btn.disabled = true;
    btn.textContent = 'Creating on lichess…';

    try {
      const token = session().token;
      const created = state.kind === 'arena'
        ? await api.createArena(token, form)
        : await api.createSwiss(state.swissTeamId, token, form);

      /* The team row this tournament will be filed under. For an arena with
         no team restriction there may not be one, and that is fine: the
         tournament is still ours to show. */
      const teamId = state.kind === 'swiss' ? state.swissTeamId
        : (state.restrictTeamId || state.teamBattleByTeam || '');
      const team = teams.find((t) => t.teamId === teamId) || {
        teamId: teamId || null,
        name: teamId || null,
        key: null,
        scope: ctx.clubId ? 'club' : 'global',
        clubId: ctx.clubId || null,
        clubName: (ctx.club && ctx.club.name) || null
      };

      const shape = state.kind === 'arena'
        ? store.shapeArena({ ...created, teamMember: state.restrictTeamId || null }, team, extras(ctx, state, form))
        : store.shapeSwiss(created, team, { teamId: state.swissTeamId, ...extras(ctx, state, form) });

      await store.upsertTournament(shape);
      remember(state.kind, state);

      close();
      toast('Created on lichess', 'ok');
      if (onDone) onDone({ id: shape.lichessId, ...shape });
    } catch (e) {
      console.error(e);
      err.textContent = e.status === 400
        ? 'Lichess refused it: ' + (e.message || 'check the settings.')
        : e.status === 401
          ? 'Your lichess login has expired. Log in again.'
          : (e.message || 'Could not create that tournament.');
      btn.disabled = false;
      btn.textContent = 'Create on Lichess';
    }
  };
}

/* The handful of fields that record this was made here, and with what. */
const extras = (ctx, state, form) => ({
  createdVia: 'jagchess',
  createdBy: (session() || {}).username || null,
  createdByUid: ctx.user.uid,
  createdAtHere: Date.now(),
  /* The exact configuration, kept so that "run it again" is possible and so
     that an admin can see what was asked for even after lichess has
     normalized it. */
  config: { kind: state.kind, form }
});

/* ── form bodies, in lichess's own field names ─────────────────────── */

export function arenaForm(s, startsAtMs) {
  const f = {
    name: s.name || undefined,
    clockTime: s.clockTime,
    clockIncrement: s.clockIncrement,
    minutes: s.minutes,
    variant: s.variant,
    rated: !!s.rated,
    berserkable: !!s.berserkable,
    streakable: !!s.streakable,
    hasChat: !!s.hasChat,
    description: s.description || undefined,
    password: s.password || undefined,
    position: s.position || undefined
  };
  if (startsAtMs) f.startDate = startsAtMs;
  else f.waitMinutes = s.waitMinutes;

  if (s.teamBattleByTeam) f.teamBattleByTeam = s.teamBattleByTeam;
  else if (s.restrictTeamId) f['conditions.teamMember.teamId'] = s.restrictTeamId;

  if (s.minRating) f['conditions.minRating.rating'] = +s.minRating;
  if (s.maxRating) f['conditions.maxRating.rating'] = +s.maxRating;
  if (s.nbRatedGame !== '' && s.nbRatedGame != null) f['conditions.nbRatedGame.nb'] = +s.nbRatedGame;
  if (s.accountAge) f['conditions.accountAge'] = +s.accountAge;
  if (s.allowList) f['conditions.allowList'] = s.allowList;
  if (s.bots) f['conditions.bots'] = true;
  return f;
}

export function swissForm(s, startsAtMs) {
  const f = {
    name: s.name || undefined,
    'clock.limit': s.clockLimit,
    'clock.increment': s.clockIncrementSec,
    nbRounds: s.nbRounds,
    variant: s.variant,
    rated: !!s.rated,
    description: s.description || undefined,
    password: s.password || undefined,
    position: s.position || undefined,
    roundInterval: s.roundInterval,
    chatFor: s.chatFor
  };
  if (startsAtMs) f.startsAt = startsAtMs;
  if (s.forbiddenPairings) f.forbiddenPairings = s.forbiddenPairings;
  if (s.minRating) f['conditions.minRating.rating'] = +s.minRating;
  if (s.maxRating) f['conditions.maxRating.rating'] = +s.maxRating;
  if (s.nbRatedGame !== '' && s.nbRatedGame != null) f['conditions.nbRatedGame.nb'] = +s.nbRatedGame;
  if (s.allowList) f['conditions.allowList'] = s.allowList;
  if (s.playYourGames) f['conditions.playYourGames'] = true;
  return f;
}

/* ── little bits ───────────────────────────────────────────────────── */

function secLabel(v) {
  if (v === 0) return '0 seconds';
  if (v < 60) return v + ' seconds';
  const m = v / 60;
  return (Number.isInteger(m) ? m : m.toFixed(1)) + (m === 1 ? ' minute' : ' minutes');
}

function switchRow(id, title, sub, on) {
  return `<label class="tn-switch">
    <span><b>${esc(title)}</b><small>${esc(sub)}</small></span>
    <span class="switch">
      <input type="checkbox" id="${id}"${on ? ' checked' : ''} />
      <span class="switch-track"><span class="switch-knob"></span></span>
    </span>
  </label>`;
}
