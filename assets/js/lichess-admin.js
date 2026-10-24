/* ═══════════════════════════════════════════════════════════════════════
   lichess-admin.js — the Lichess panel, for whoever runs the place.

   One component, mounted in two places:

     • /admin → Lichess, where a site administrator configures the teams
       whose tournaments appear on the global /tournaments page;
     • a club's Tournaments page, where a club admin does the same for that
       club's own Tournaments block.

   Both are the same screen because they are the same job; what differs is
   the ctx handed in, which decides whether the teams are global or the
   club's. See lichess-store.js for how that scope is keyed.

   What it shows, in the order somebody debugging would want it:

     1. the connection — is lichess answering, are we rate-limited, is any
        tab actually doing the syncing right now;
     2. the teams — with their last sync, their errors, and the controls;
     3. what has been detected — every tournament that came from them;
     4. the sync log — the last forty calls, with latency and outcome.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, toast, confirmDialog, fmtDate, fmtTime } from './club-core.js';
import * as api from './lichess-api.js';
import * as store from './lichess-store.js';
import { validateTeam, syncTeam, syncNow, startSync } from './lichess-sync.js';
import { session, connect, disconnect, onAuthChange, SCOPES } from './lichess-auth.js';
import { phaseOf, PHASE_LABEL, clockLabel, speedOf, hashFor, countdown } from './lichess-ui.js';

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

const ago = (ms) => (ms ? countdown(Date.now() - ms) + ' ago' : 'never');

const INTERVALS = [
  [60, 'Every minute'], [120, 'Every 2 minutes'], [300, 'Every 5 minutes'],
  [600, 'Every 10 minutes'], [1800, 'Every 30 minutes'], [3600, 'Every hour']
];

/**
 * Mounts the panel.
 *
 * @param {object} ctx        JagChess context (clubId null for the site)
 * @param {HTMLElement} host
 * @param {object} [opts]     { ownSync: start a sync worker from this page }
 * @returns {Function} cleanup
 */
export function renderLichessAdmin(ctx, host, opts = {}) {
  let teams = [];
  let rows = [];
  let events = [];
  let health = { state: 'unknown', leader: false };
  let dead = false;
  let busy = null;

  host.innerHTML = '<div class="la-wrap"><div class="empty-state">Loading…</div></div>';

  function paint() {
    if (dead) return;
    host.innerHTML = `
      <div class="la-wrap">
        ${connectionHTML()}
        ${accountHTML()}
        ${teamsHTML()}
        ${detectedHTML()}
        ${logHTML()}
      </div>`;
    wire();
  }

  /* ── 1. the connection ─────────────────────────────────────────── */

  function connectionHTML() {
    const lights = [
      ['Lichess connection', health.state === 'connected' ? 'CONNECTED'
        : health.state === 'degraded' ? 'DEGRADED'
          : health.state === 'offline' ? 'OFFLINE' : 'IDLE',
      health.state],
      ['Team synchronization', teams.length === 0 ? 'NOT SET UP'
        : teams.every((t) => !t.monitoring) ? 'DISABLED'
          : teams.some((t) => t.lastSyncOk === false) ? 'ERROR' : 'ACTIVE',
      teams.length === 0 ? 'unknown'
        : teams.every((t) => !t.monitoring) ? 'offline'
          : teams.some((t) => t.lastSyncOk === false) ? 'degraded' : 'connected'],
      ['This tab', health.leader ? 'SYNCING' : 'WATCHING', health.leader ? 'connected' : 'unknown']
    ];

    const live = rows.filter((r) => r.status === 'started');
    const liveGames = live.reduce((n, r) => n + (r.nbOngoing || 0), 0);

    return `
      <section class="tile la-health">
        <div class="tn-standings-head">
          <h3>Lichess</h3>
          <span class="muted">${health.parkedForMs ? 'rate-limited for ' + Math.ceil(health.parkedForMs / 1000) + 's' : ''}</span>
        </div>
        <div class="la-lights">${lights.map(([label, value, tone]) => `
          <div class="la-light ${tone}">
            <span class="la-dot"></span>
            <span class="la-light-body"><small>${esc(label)}</small><b>${esc(value)}</b></span>
          </div>`).join('')}</div>
        <div class="la-stats">
          <div><b>${teams.length}</b><span>Teams</span></div>
          <div><b>${rows.length}</b><span>Tournaments</span></div>
          <div><b>${live.length}</b><span>Live now</span></div>
          <div><b>${liveGames || '—'}</b><span>Games running</span></div>
          <div><b>${health.errorCount || 0}</b><span>API errors</span></div>
          <div><b>${health.lastOkAt ? ago(health.lastOkAt) : 'never'}</b><span>Last good call</span></div>
        </div>
        ${health.lastError ? `<p class="field-hint bad" style="margin:10px 0 0">
          Last error: ${esc(health.lastError.message)} — ${esc(health.lastError.path || '')} (${ago(health.lastError.at)})
        </p>` : ''}
        <p class="field-hint" style="margin:10px 0 0">
          Synchronization runs in one browser tab at a time, chosen by a lease, so the site
          never makes more than one request to lichess at once. Nothing syncs while nobody
          has JagChess open — the next visitor catches up.
        </p>
      </section>`;
  }

  /* ── the admin's own lichess account ───────────────────────────── */

  function accountHTML() {
    const s = session();
    return `<section class="tile la-account">
      <div class="tn-standings-head"><h3>Your Lichess account</h3></div>
      ${s ? `<div class="li-me-row"><span class="li-dot"></span><b>${esc(s.username)}</b>
          <span class="muted">${(s.scopes || []).length} permission${(s.scopes || []).length === 1 ? '' : 's'} granted</span></div>
        <p class="field-hint">${esc((s.scopes || []).join(', ') || 'read-only')}</p>
        <button class="btn subtle sm" id="la-disconnect">Disconnect</button>`
        : `<p class="field-hint" style="margin:0 0 10px">
            Adding and monitoring a team needs no login at all — that data is public. You only
            need an account to create tournaments from here.</p>
          <button class="btn primary sm" id="la-login">Log in with Lichess</button>`}
    </section>`;
  }

  /* ── 2. the teams ──────────────────────────────────────────────── */

  function teamsHTML() {
    return `
      <section class="tile la-teams">
        <div class="tn-standings-head">
          <h3>Monitored teams</h3>
          <button class="btn primary sm" id="la-add">＋ Add a team</button>
        </div>
        ${teams.length ? `<div class="la-team-list">${teams.map(teamRowHTML).join('')}</div>` : `
          <div class="empty-state">
            No lichess team is being monitored${ctx.clubId ? ' for this club' : ''} yet.
            Add one and its tournaments appear here on their own.
          </div>`}
      </section>`;
  }

  function teamRowHTML(t) {
    const mine = rows.filter((r) => r.teamId === t.teamId);
    const err = t.lastError;
    return `
      <div class="la-team ${t.monitoring ? '' : 'off'}" data-team="${esc(t.key)}">
        <div class="la-team-head">
          <div class="la-team-id">
            <b>${esc(t.name)}</b>
            <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.teamId)} ↗</a>
          </div>
          <label class="switch la-switch" title="${t.monitoring ? 'Monitoring' : 'Paused'}">
            <input type="checkbox" data-monitor="${esc(t.key)}" ${t.monitoring ? 'checked' : ''} />
            <span class="switch-track"><span class="switch-knob"></span></span>
          </label>
        </div>
        ${t.description ? `<p class="la-team-desc">${esc(String(t.description).slice(0, 200))}</p>` : ''}
        <div class="la-team-meta">
          <span>${t.nbMembers || 0} members</span>
          <span>${mine.length} tournament${mine.length === 1 ? '' : 's'} detected</span>
          <span>Last sync ${ago(t.lastSyncAt)}</span>
          <span class="${t.lastSyncOk === false ? 'bad' : t.lastSyncOk ? 'ok' : ''}">
            ${t.lastSyncOk === false ? 'Last sync failed' : t.lastSyncOk ? 'Healthy' : 'Not synced yet'}
          </span>
        </div>
        ${err ? `<p class="field-hint bad" style="margin:6px 0 0">${esc(err.message)}${err.status ? ` (HTTP ${err.status})` : ''}</p>` : ''}
        <div class="la-team-actions">
          <select data-interval="${esc(t.key)}">
            ${INTERVALS.map(([v, l]) =>
              `<option value="${v}"${v === (t.syncEverySec || 300) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
          <button class="btn subtle sm" data-sync="${esc(t.key)}">${busy === t.key ? 'Syncing…' : 'Sync now'}</button>
          <button class="btn subtle sm danger" data-remove="${esc(t.key)}">Remove</button>
        </div>
      </div>`;
  }

  /* ── 3. what was detected ──────────────────────────────────────── */

  function detectedHTML() {
    if (!rows.length) return '';
    const shown = rows.slice(0, 25);
    return `
      <section class="tile la-detected">
        <div class="tn-standings-head">
          <h3>Detected tournaments</h3>
          <span class="muted">${rows.length}</span>
        </div>
        <div class="la-rows">${shown.map((r) => {
          const phase = phaseOf(r);
          return `<div class="la-row" data-open="${esc(r.id)}">
            <span class="tn-status ${phase}">${PHASE_LABEL[phase]}</span>
            <span class="la-row-name">
              <b>${esc(r.name)}</b>
              <small>${esc(r.kind === 'swiss' ? 'Swiss' : 'Arena')} · ${esc(clockLabel(r.clock))} ${esc(speedOf(r.clock))}
                · ${r.rated ? 'rated' : 'casual'}
                · ${r.membershipRequired ? 'team members only' : 'open to anyone'}</small>
            </span>
            <span class="la-row-when">${fmtDate(r.startsAt)} ${fmtTime(r.startsAt)}</span>
            <span class="la-row-n">${r.nbPlayers || 0}</span>
            <span class="la-row-sync ${r.archived ? 'ok' : ''}">${r.archived ? 'archived' : ago(r.lastSyncedAt)}</span>
          </div>`;
        }).join('')}</div>
        ${rows.length > shown.length ? `<p class="field-hint" style="margin:8px 0 0">${rows.length - shown.length} more not shown.</p>` : ''}
      </section>`;
  }

  /* ── 4. the log ────────────────────────────────────────────────── */

  function logHTML() {
    return `
      <section class="tile la-log">
        <div class="tn-standings-head">
          <h3>Recent synchronization</h3>
          <span class="muted">${events.length}</span>
        </div>
        ${events.length ? `<div class="la-rows">${events.map((e) => `
          <div class="la-row la-event ${e.ok ? '' : 'bad'}">
            <span class="la-ev-dot"></span>
            <span class="la-row-name"><b>${esc(e.action)}</b><small>${esc(e.endpoint || '')}</small></span>
            <span class="la-row-when">${fmtTime(e.at)}</span>
            <span class="la-row-n">${e.ms}ms</span>
            <span class="la-row-sync">${e.ok ? 'ok' : esc(String(e.status || 'failed'))}</span>
            ${e.error ? `<span class="la-ev-err">${esc(e.error)}</span>` : ''}
          </div>`).join('')}</div>`
          : '<div class="empty-state">Nothing has been synchronized yet.</div>'}
      </section>`;
  }

  /* ── wiring ────────────────────────────────────────────────────── */

  function wire() {
    const q = (s) => host.querySelector(s);

    if (q('#la-add')) q('#la-add').onclick = () => openAddTeam(ctx, () => {});
    if (q('#la-login')) q('#la-login').onclick = () => connect([SCOPES.tournament]);
    if (q('#la-disconnect')) q('#la-disconnect').onclick = async () => {
      await disconnect();
      toast('Lichess account disconnected');
    };

    host.querySelectorAll('[data-monitor]').forEach((n) => {
      n.onchange = () => store.setTeamMonitoring(n.dataset.monitor, n.checked)
        .catch(() => toast('Could not change that', 'error'));
    });
    host.querySelectorAll('[data-interval]').forEach((n) => {
      n.onchange = () => store.setTeamInterval(n.dataset.interval, +n.value)
        .catch(() => toast('Could not change that', 'error'));
    });
    host.querySelectorAll('[data-sync]').forEach((n) => {
      n.onclick = async () => {
        const team = teams.find((t) => t.key === n.dataset.sync);
        if (!team || busy) return;
        busy = team.key;
        paint();
        try {
          const found = await syncNow(ctx, team);
          toast(found ? `${found} tournament${found === 1 ? '' : 's'} from ${team.name}` : 'Nothing new', 'ok');
        } catch (e) {
          toast(e.message || 'Sync failed', 'error');
        } finally {
          busy = null;
          paint();
        }
      };
    });
    host.querySelectorAll('[data-remove]').forEach((n) => {
      n.onclick = async () => {
        const team = teams.find((t) => t.key === n.dataset.remove);
        if (!team) return;
        const ok = await confirmDialog({
          title: `Stop monitoring ${team.name}?`,
          body: 'New tournaments from this team will not be picked up. The ones already detected stay exactly where they are — this does not delete any history.',
          confirmText: 'Stop monitoring', danger: true
        });
        if (ok) {
          await store.removeTeam(team.key).catch(() => toast('Could not remove it', 'error'));
          toast('Stopped monitoring ' + team.name);
        }
      };
    });
    host.querySelectorAll('[data-open]').forEach((n) => {
      n.onclick = () => { location.hash = hashFor(n.dataset.open); };
    });
  }

  /* ── subscriptions ─────────────────────────────────────────────── */

  const stops = [
    store.watchTeams(ctx, (r) => { teams = r; paint(); }),
    store.watchTournaments(ctx, (r) => { rows = r; paint(); }),
    store.watchSyncEvents(ctx, (r) => { events = r; paint(); }),
    onAuthChange(() => paint())
  ];

  /* The admin page is a natural place to run the worker: somebody is sitting
     in front of it, and it is the page where the result is visible. Where the
     page around it already runs one — a club's Tournaments page — this panel
     only reports, and reads the connection state straight from the API
     client rather than claiming to know nothing. */
  const stopSync = opts.ownSync === false ? null : startSync(ctx, {
    onState: (s) => { health = s; }
  });

  const tick = setInterval(() => {
    if (dead) return;
    if (!stopSync) health = { ...health, ...api.health() };
    paint();
  }, 5000);

  return () => {
    dead = true;
    stops.forEach((s) => { try { s(); } catch (_) {} });
    if (stopSync) stopSync();
    clearInterval(tick);
  };
}

/* ── adding a team ─────────────────────────────────────────────────── */

/**
 * Add-a-team, with validation against lichess before anything is stored.
 *
 * A team id that does not exist is caught here rather than becoming a row
 * that fails to sync forever, and the admin sees the real team — name,
 * member count, description — before committing to it.
 */
export function openAddTeam(ctx, onDone) {
  const wrap = el(`
    <div class="modal"><div class="modal-card la-add">
      <button class="icon-btn modal-close" data-x title="Close">✕</button>
      <h3>Add a Lichess team</h3>
      <p class="modal-meta">
        Paste the team's page address, or just its id. JagChess then watches it for
        tournaments and puts each one on ${ctx.clubId ? 'this club’s' : 'the'} Tournaments page by itself.
      </p>

      <div class="tn-field">
        <label for="la-input">Team</label>
        <input id="la-input" placeholder="https://lichess.org/team/example-team" autocomplete="off" />
        <small class="tn-hint">Either form works: the full URL, or the last part of it.</small>
      </div>

      <div class="tn-field">
        <label for="la-every">Check for new tournaments</label>
        <select id="la-every">${INTERVALS.map(([v, l]) =>
          `<option value="${v}"${v === 300 ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>

      <div id="la-preview"></div>

      <div class="tn-create-foot">
        <span class="create-error" id="la-error"></span>
        <button class="btn subtle" data-x>Cancel</button>
        <button class="btn subtle" id="la-check">Check</button>
        <button class="btn primary" id="la-save" disabled>Add team</button>
      </div>
    </div></div>`);

  document.body.appendChild(wrap);
  const q = (s) => wrap.querySelector(s);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  setTimeout(() => q('#la-input').focus(), 60);

  let found = null;

  async function check() {
    const err = q('#la-error');
    err.textContent = '';
    q('#la-save').disabled = true;
    found = null;
    q('#la-preview').innerHTML = '<div class="la-checking">Asking lichess…</div>';
    try {
      found = await validateTeam(q('#la-input').value);
      q('#la-preview').innerHTML = `
        <div class="la-found">
          <b>${esc(found.name)}</b>
          <span>${found.nbMembers || 0} members${found.open ? ' · anyone may join' : ' · joining is reviewed'}</span>
          ${found.description ? `<p>${esc(String(found.description).slice(0, 240))}</p>` : ''}
          <a href="${esc(api.teamUrl(found.id))}" target="_blank" rel="noopener">See it on lichess ↗</a>
        </div>`;
      q('#la-save').disabled = false;
    } catch (e) {
      q('#la-preview').innerHTML = '';
      err.textContent = e.message || 'Could not check that team.';
    }
  }

  q('#la-check').onclick = check;
  q('#la-input').onkeydown = (e) => { if (e.key === 'Enter') check(); };

  q('#la-save').onclick = async () => {
    if (!found) return;
    const btn = q('#la-save');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const team = await store.addTeam(ctx, found, { syncEverySec: +q('#la-every').value });
      close();
      toast('Now monitoring ' + team.name, 'ok');
      /* A first sweep straight away, so the admin sees something rather than
         an empty list for the next five minutes. */
      syncTeam(ctx, team).catch(() => {});
      if (onDone) onDone(team);
    } catch (e) {
      q('#la-error').textContent = e.code === 'permission-denied'
        ? 'You do not have permission to configure lichess teams here.'
        : (e.message || 'Could not add that team.');
      btn.disabled = false;
      btn.textContent = 'Add team';
    }
  };
}
