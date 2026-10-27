/* ═══════════════════════════════════════════════════════════════════════
   tour.js — a short guided walk around a page.

   One step at a time: the thing being explained is lit up, everything else
   dims, and a small card says what it is and why you'd use it. Steps whose
   target isn't on screen (a page this club doesn't have, a button only
   admins see) are skipped rather than pointing at nothing.

   A club's tour runs by itself the first time someone opens that club on
   this device, and any time after from the user menu.
   ═══════════════════════════════════════════════════════════════════════ */

const SEEN_KEY = (clubId, who) => `jag.tour.${who}.${clubId}`;

let active = null;

/**
 * @param {Array<{target?: string, title: string, body: string, before?: Function}>} steps
 *        target is a selector; a step without one is a centred card
 */
export function runTour(steps, { onDone } = {}) {
  if (active) active.end();

  const layer = document.createElement('div');
  layer.className = 'tour';
  layer.innerHTML = `
    <div class="tour-spot"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-live="polite">
      <div class="tour-step"></div>
      <h4 class="tour-title"></h4>
      <p class="tour-body"></p>
      <div class="tour-foot">
        <button class="btn ghost sm" data-skip>Skip tour</button>
        <div class="spacer"></div>
        <button class="btn subtle sm" data-back>Back</button>
        <button class="btn primary sm" data-next>Next</button>
      </div>
    </div>`;
  document.body.appendChild(layer);

  const spot = layer.querySelector('.tour-spot');
  const card = layer.querySelector('.tour-card');
  let i = -1;

  const visible = (sel) => {
    if (!sel) return null;
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return r.width && r.height ? n : null;
  };

  const show = async (next, dir) => {
    let n = next;
    // walk past steps whose target isn't on the page
    while (n >= 0 && n < steps.length) {
      const s = steps[n];
      if (s.before) await s.before();
      if (!s.target || visible(s.target)) break;
      n += dir;
    }
    if (n < 0) n = Math.max(0, i);
    if (n >= steps.length) { end(true); return; }
    i = n;
    const s = steps[i];
    const shown = steps.length;

    layer.querySelector('.tour-step').textContent = `${i + 1} of ${shown}`;
    layer.querySelector('.tour-title').textContent = s.title;
    layer.querySelector('.tour-body').textContent = s.body;
    layer.querySelector('[data-back]').hidden = i === 0;
    layer.querySelector('[data-next]').textContent = i === steps.length - 1 ? 'Got it' : 'Next';

    const target = visible(s.target);
    if (target) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    requestAnimationFrame(() => position(target));
    layer.querySelector('[data-next]').focus({ preventScroll: true });
  };

  function position(target) {
    if (!target) {
      spot.style.cssText = `left:50%;top:50%;width:0;height:0`;
      card.style.cssText = `left:50%;top:50%;transform:translate(-50%,-50%)`;
      card.dataset.side = 'center';
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;

    const cw = Math.min(330, innerWidth - 24);
    const ch = card.offsetHeight || 180;
    let left, top, side;
    if (r.right + cw + 24 < innerWidth) { left = r.right + 16; top = r.top; side = 'right'; }
    else if (r.bottom + ch + 24 < innerHeight) { left = r.left; top = r.bottom + 14; side = 'below'; }
    else if (r.left - cw - 24 > 0) { left = r.left - cw - 16; top = r.top; side = 'left'; }
    else { left = r.left; top = r.top - ch - 14; side = 'above'; }
    left = Math.max(12, Math.min(left, innerWidth - cw - 12));
    top = Math.max(12, Math.min(top, innerHeight - ch - 12));
    card.style.cssText = `left:${left}px;top:${top}px;width:${cw}px`;
    card.dataset.side = side;
  }

  function end(finished) {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    layer.classList.add('out');
    setTimeout(() => layer.remove(), 200);
    active = null;
    if (onDone) onDone(!!finished);
  }

  const onResize = () => position(visible(steps[i] && steps[i].target));
  const onKey = (e) => {
    if (e.key === 'Escape') end(false);
    if (e.key === 'ArrowRight') show(i + 1, 1);
    if (e.key === 'ArrowLeft' && i > 0) show(i - 1, -1);
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey);
  layer.querySelector('[data-next]').onclick = () => show(i + 1, 1);
  layer.querySelector('[data-back]').onclick = () => show(i - 1, -1);
  layer.querySelector('[data-skip]').onclick = () => end(false);

  active = { end };
  show(0, 1);
  return { end };
}

/* ── the club tours ────────────────────────────────────────────────── */

const isPhone = () => window.innerWidth <= 900;
const openDrawer = () => { if (isPhone()) document.getElementById('app').classList.add('nav-open'); };
const closeDrawer = () => document.getElementById('app').classList.remove('nav-open');

function adminSteps(ctx) {
  return [
    {
      title: `Welcome to ${ctx.club.name || 'your club'}`,
      body: 'This takes about a minute. It shows where everything is, so you can run the club without reading a manual.'
    },
    {
      target: '#nav-blocks', before: openDrawer,
      title: 'Your club\'s pages',
      body: 'Events, puzzles, newsletters and the rest. Members see the same list. Use + to add a page, and drag one to reorder.'
    },
    {
      target: '#nav-admin', before: openDrawer,
      title: 'Only admins see this',
      body: 'Members is where you approve sign-ups and make someone an admin. Insights shows who is active. Settings has the club\'s name, colour and join code.'
    },
    {
      target: '#mode-switch', before: openDrawer,
      title: 'See it as a student',
      body: 'Flip this on to see exactly what your members see. Flip it off to get back to managing.'
    },
    {
      target: '#customize-btn', before: closeDrawer,
      title: 'Make the home page yours',
      body: 'Add announcements, a poster, a countdown to your next tournament. Drag things around and resize them.'
    },
    {
      target: '#invite-btn', before: closeDrawer,
      title: 'Bring people in',
      body: 'Share a link, a QR code to project in class, or a sign-up form for people without an account. There\'s a message ready to paste too.'
    },
    {
      target: '#setup-card', before: openDrawer,
      title: 'Your checklist',
      body: 'Four steps to a club that runs itself. It disappears once they\'re done.'
    }
  ];
}

function memberSteps(ctx) {
  return [
    {
      title: `Welcome to ${ctx.club.name || 'the club'}`,
      body: 'Here\'s a 30-second look around.'
    },
    {
      target: '#nav-blocks', before: openDrawer,
      title: 'Everything the club does',
      body: 'Meetings, puzzles, news and games all live here.'
    },
    {
      target: '#topbar-stats', before: closeDrawer,
      title: 'Points and streaks',
      body: 'Solve puzzles, show up to meetings and win games to earn points. Come every week to keep your streak going.'
    },
    {
      target: '.wt-quick-duel, .wt-welcome',
      title: 'Play someone',
      body: 'Start a game with a clubmate or anyone on JagChess. Your rating goes up as you win.'
    }
  ];
}

export function runClubTour(ctx) {
  const who = ctx.isAdmin ? 'admin' : 'member';
  return runTour(who === 'admin' ? adminSteps(ctx) : memberSteps(ctx), {
    onDone: () => {
      closeDrawer();
      try { localStorage.setItem(SEEN_KEY(ctx.clubId, who), '1'); } catch (_) {}
    }
  });
}

/* First visit on this device: wait for the home page to settle, then go. */
export function maybeRunClubTour(ctx) {
  const who = ctx.isAdmin ? 'admin' : 'member';
  try { if (localStorage.getItem(SEEN_KEY(ctx.clubId, who))) return; } catch (_) { return; }
  setTimeout(() => {
    if (document.querySelector('.modal:not([hidden]), .tour')) return;   // something else has the floor
    runClubTour(ctx);
  }, 1200);
}
