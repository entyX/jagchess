/* ═══════════════════════════════════════════════════════════════════════
   club-metrics.js — Insights, for a club's admins only.

   The questions an organiser actually asks on a Monday: is the club
   growing, is anyone using it, who is new, and who has drifted off. Every
   number is counted from records the club already keeps — member rows,
   puzzle solves, check-ins and club games — so there is nothing to set up
   and nothing that can disagree with the rest of the site.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  db, clubCol, collection, getDocs, query, where, limit, esc, fmtDate, initials
} from './club-core.js';

const DAY = 86400e3;
const WEEK = 7 * DAY;

/* ── loading ───────────────────────────────────────────────────────── */

async function load(ctx) {
  const id = ctx.clubId;
  const now = Date.now();
  const safe = async (p) => { try { return (await p).docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) { console.warn(e); return []; } };

  const [members, solves, checkins, games, events, applications] = await Promise.all([
    safe(getDocs(clubCol(id, 'members'))),
    safe(getDocs(query(clubCol(id, 'puzzleAttempts'), where('completedAt', '>=', now - 60 * DAY)))),
    safe(getDocs(query(clubCol(id, 'attendanceResponses'), where('submittedAt', '>=', now - 90 * DAY)))),
    safe(getDocs(query(collection(db, 'duels'), where('clubId', '==', id), limit(400)))),
    safe(getDocs(query(clubCol(id, 'events'), where('date', '>=', now - 90 * DAY)))),
    safe(getDocs(query(clubCol(id, 'applications'), limit(200))))
  ]);
  return { members: members.filter((m) => !m.deleted), solves, checkins, games, events, applications, now };
}

/* ── the sums ──────────────────────────────────────────────────────── */

function analyse(d) {
  const { now } = d;
  /* the last thing each member did, from any of the four places it shows */
  const lastSeen = new Map();
  const bump = (uid, t) => { if (uid && t && t > (lastSeen.get(uid) || 0)) lastSeen.set(uid, t); };
  d.members.forEach((m) => bump(m.uid || m.id, m.lastSeenAt));
  d.solves.forEach((s) => bump(s.userId, s.completedAt));
  d.checkins.forEach((c) => bump(c.userId, c.submittedAt));
  const finished = d.games.filter((g) => g.status === 'finished' && g.endedAt);
  finished.forEach((g) => (g.uids || []).forEach((u) => bump(u, g.endedAt)));

  const total = d.members.length;
  const joined30 = d.members.filter((m) => (m.joinedAt || 0) >= now - 30 * DAY).length;
  const active7 = d.members.filter((m) => (lastSeen.get(m.uid || m.id) || 0) >= now - WEEK).length;
  const solves7 = d.solves.filter((s) => s.completedAt >= now - WEEK);
  const solvers7 = new Set(solves7.map((s) => s.userId)).size;
  const games30 = finished.filter((g) => g.endedAt >= now - 30 * DAY).length;

  /* new members per week, oldest week first */
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = now - i * WEEK;
    const start = end - WEEK;
    weeks.push({
      label: fmtDate(start, { month: 'short', day: 'numeric' }),
      value: d.members.filter((m) => m.joinedAt >= start && m.joinedAt < end).length
    });
  }

  /* puzzle solves per day, last 30 days */
  const days = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const start = today.getTime() - i * DAY;
    days.push({
      label: fmtDate(start, { month: 'short', day: 'numeric' }),
      value: d.solves.filter((s) => s.completedAt >= start && s.completedAt < start + DAY).length
    });
  }

  /* who did the most this month: a solve is one, a check-in two, a game one */
  const score = new Map();
  const add = (uid, n) => uid && score.set(uid, (score.get(uid) || 0) + n);
  d.solves.filter((s) => s.completedAt >= now - 30 * DAY).forEach((s) => add(s.userId, 1));
  d.checkins.filter((c) => c.submittedAt >= now - 30 * DAY).forEach((c) => add(c.userId, 2));
  finished.filter((g) => g.endedAt >= now - 30 * DAY).forEach((g) => (g.uids || []).forEach((u) => add(u, 1)));
  const byUid = new Map(d.members.map((m) => [m.uid || m.id, m]));
  const mostActive = [...score.entries()]
    .filter(([uid]) => byUid.has(uid))
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([uid, s]) => ({ m: byUid.get(uid), s }));

  const recent = d.members.slice().sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)).slice(0, 6);

  /* members who joined a while back and haven't done anything in three weeks */
  const quiet = d.members
    .filter((m) => m.role === 'student' && (m.joinedAt || 0) < now - 14 * DAY)
    .filter((m) => (lastSeen.get(m.uid || m.id) || 0) < now - 21 * DAY)
    .sort((a, b) => (lastSeen.get(a.uid || a.id) || 0) - (lastSeen.get(b.uid || b.id) || 0))
    .slice(0, 6)
    .map((m) => ({ m, last: lastSeen.get(m.uid || m.id) || 0 }));

  /* turnout at recent events */
  const turnout = d.events
    .filter((e) => e.date < now)
    .sort((a, b) => b.date - a.date).slice(0, 6)
    .map((e) => ({ e, n: d.checkins.filter((c) => c.eventId === e.id).length }));

  const pending = d.applications.filter((a) => !a.status || a.status === 'pending').length;

  return { total, joined30, active7, solves7: solves7.length, solvers7, games30, weeks, days, mostActive, recent, quiet, turnout, pending };
}

/* ── a column chart, plain SVG ─────────────────────────────────────── */

/* One series, so no legend: the card's title says what is plotted. Columns
   are capped at 24px and rounded only at the top; the tallest is labelled,
   everything else is on hover or in the table. */
function columnChart(series, { name, unit }) {
  const W = 520, H = 190, padL = 30, padB = 26, padT = 18;
  const max = Math.max(1, ...series.map((s) => s.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = W - padL, plotH = H - padB - padT;
  const band = plotW / series.length;
  const bw = Math.min(24, band - 2);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const peak = series.reduce((b, s, i) => (s.value > series[b].value ? i : b), 0);

  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  const bars = series.map((s, i) => {
    const x = padL + i * band + (band - bw) / 2;
    const h = Math.max(0, (s.value / top) * plotH);
    const r = Math.min(4, h, bw / 2);
    const yy = padT + plotH - h;
    const path = h <= 0 ? '' : `M${x},${padT + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${padT + plotH} Z`;
    return `<g class="mc-col" data-i="${i}">
      <rect class="mc-hit" x="${padL + i * band}" y="${padT}" width="${band}" height="${plotH}"></rect>
      ${path ? `<path class="mc-bar" d="${path}"></path>` : ''}
      ${i === peak && s.value > 0 ? `<text class="mc-peak" x="${x + bw / 2}" y="${yy - 6}" text-anchor="middle">${s.value}</text>` : ''}
    </g>`;
  }).join('');

  const every = Math.ceil(series.length / 6);
  const labels = series.map((s, i) => (i % every === 0 || i === series.length - 1)
    ? `<text class="mc-x" x="${padL + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(s.label)}</text>` : '').join('');

  return `<div class="mc" data-unit="${esc(unit)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)}">
      ${ticks.map((v) => `<line class="mc-grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"></line>
        <text class="mc-y" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${bars}
      ${labels}
    </svg>
    <div class="mc-tip" hidden></div>
  </div>
  <details class="mc-table"><summary>Show as a table</summary>
    <table><thead><tr><th>${esc(name.split(',')[0])}</th><th>${esc(unit)}</th></tr></thead>
    <tbody>${series.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.value}</td></tr>`).join('')}</tbody></table>
  </details>`;
}

function niceStep(max) {
  const rough = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))));
  const n = rough / mag;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag);
}

function wireChart(root, series, fmt) {
  root.querySelectorAll('.mc').forEach((chart, n) => {
    const tip = chart.querySelector('.mc-tip');
    const data = series[n];
    chart.querySelectorAll('.mc-col').forEach((g) => {
      g.addEventListener('pointerenter', () => {
        const s = data[+g.dataset.i];
        chart.querySelectorAll('.mc-col').forEach((o) => o.classList.toggle('dim', o !== g));
        tip.innerHTML = `<b>${s.value}</b> ${esc(fmt[n](s.value))}<small>${esc(s.label)}</small>`;
        tip.hidden = false;
        const r = g.getBoundingClientRect();
        const c = chart.getBoundingClientRect();
        tip.style.left = Math.min(c.width - 140, Math.max(0, r.left - c.left + r.width / 2 - 70)) + 'px';
      });
    });
    chart.addEventListener('pointerleave', () => {
      tip.hidden = true;
      chart.querySelectorAll('.mc-col').forEach((o) => o.classList.remove('dim'));
    });
  });
}

/* ── the page ──────────────────────────────────────────────────────── */

const ago = (t, now) => {
  if (!t) return 'Never active';
  const d = Math.floor((now - t) / DAY);
  if (d < 1) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 14) return d + ' days ago';
  return Math.floor(d / 7) + ' weeks ago';
};

const person = (m, right) => `
  <div class="mi-person">
    <span class="lb-avatar" style="background:${esc(m.avatarColor || '#2e90fa')};width:32px;height:32px;font-size:11.5px">${esc(initials(m.username || '?'))}</span>
    <span class="mi-person-name">${esc(m.username || 'Member')}</span>
    <span class="mi-person-right">${right}</span>
  </div>`;

export async function renderMetrics(ctx, host) {
  host.innerHTML = '<div class="mi-loading">Counting…</div>';
  const raw = await load(ctx);
  const a = analyse(raw);
  const pct = a.total ? Math.round((a.active7 / a.total) * 100) : 0;
  const blockOf = (type) => ((ctx.club.blocks || []).find((b) => b.type === type) || {}).id;

  host.innerHTML = `
    <div class="mi">
      ${a.pending ? `<a class="mi-banner" href="#members">
        <b>${a.pending} ${a.pending === 1 ? 'person has' : 'people have'} asked to join</b>
        <span>Review sign-ups on the Members page</span></a>` : ''}

      <div class="mi-kpis">
        <div class="mi-kpi">
          <span class="mi-kpi-label">Members</span>
          <b class="tabular">${a.total}</b>
          <span class="mi-kpi-note">${a.joined30 ? `<em class="up">+${a.joined30}</em> joined in the last 30 days` : 'No one new in the last 30 days'}</span>
        </div>
        <div class="mi-kpi">
          <span class="mi-kpi-label">Active this week</span>
          <b class="tabular">${a.active7}</b>
          <span class="mi-kpi-note">${pct}% of the club opened it or played</span>
        </div>
        <div class="mi-kpi">
          <span class="mi-kpi-label">Puzzles solved this week</span>
          <b class="tabular">${a.solves7}</b>
          <span class="mi-kpi-note">by ${a.solvers7} ${a.solvers7 === 1 ? 'member' : 'members'}</span>
        </div>
        <div class="mi-kpi">
          <span class="mi-kpi-label">Club games, last 30 days</span>
          <b class="tabular">${a.games30}</b>
          <span class="mi-kpi-note">rated and casual 1v1s inside the club</span>
        </div>
      </div>

      <div class="mi-grid">
        <section class="tile mi-chart">
          <h3>New members per week</h3>
          ${columnChart(a.weeks, { name: 'Week starting, new members', unit: 'New members' })}
        </section>
        <section class="tile mi-chart">
          <h3>Puzzles solved per day</h3>
          ${columnChart(a.days, { name: 'Day, puzzles solved', unit: 'Puzzles solved' })}
        </section>

        <section class="tile">
          <h3>Newest members</h3>
          ${a.recent.length ? a.recent.map((m) => person(m, esc(m.joinedAt ? fmtDate(m.joinedAt, { month: 'short', day: 'numeric' }) : ''))).join('')
            : '<div class="empty-state">No members yet.</div>'}
        </section>

        <section class="tile">
          <h3>Most active this month</h3>
          ${a.mostActive.length ? a.mostActive.map(({ m, s }) => person(m, `<b class="tabular">${s}</b> <small>pts of activity</small>`)).join('')
            : `<div class="empty-state">Nothing yet this month. ${blockOf('puzzles') ? 'Posting a puzzle is the quickest way to get people going.' : ''}</div>`}
          <p class="mi-foot">A solved puzzle or a game counts 1, showing up to a meeting counts 2.</p>
        </section>

        <section class="tile">
          <h3>Haven't been around lately</h3>
          ${a.quiet.length ? a.quiet.map(({ m, last }) => person(m, `<small>${esc(ago(last, raw.now))}</small>`)).join('')
            : '<div class="empty-state">Everyone has been active in the last three weeks.</div>'}
          ${a.quiet.length ? '<p class="mi-foot">A quick message or a fresh puzzle often brings people back.</p>' : ''}
        </section>

        <section class="tile">
          <h3>Turnout at recent meetings</h3>
          ${a.turnout.length ? `<div class="mi-turnout">${a.turnout.map(({ e, n }) => {
            const w = a.total ? Math.min(100, Math.round((n / a.total) * 100)) : 0;
            return `<div class="mi-turn-row">
              <span class="mi-turn-name"><b>${esc(e.title)}</b><small>${esc(fmtDate(e.date, { month: 'short', day: 'numeric' }))}</small></span>
              <span class="mi-turn-bar"><i style="width:${w}%"></i></span>
              <b class="mi-turn-n tabular">${n}</b>
            </div>`;
          }).join('')}</div>` : `<div class="empty-state">No past events with check-ins yet. Turn on attendance for an event and this fills in.</div>`}
        </section>
      </div>
    </div>`;

  wireChart(host, [a.weeks, a.days], [
    (v) => (v === 1 ? 'new member' : 'new members'),
    (v) => (v === 1 ? 'puzzle solved' : 'puzzles solved')
  ]);

  return () => {};
}
