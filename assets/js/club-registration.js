/* ═══════════════════════════════════════════════════════════════════════
   club-registration.js — the club's side of the JagChess Network.

   Three screens live here:

     · the registration form editor, in club settings — what someone with
       no account is asked before they can put their name down
     · the pending members who came through it, under the real roster on
       the Members page
     · the invite email that turns one of them into a member

   The form belongs to public clubs. A private club is not listed on the
   Network, so there is nobody to fill it in — the editor blurs out rather
   than disappearing, because the questions are still there, still saved,
   and come straight back the moment the club goes public again.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  clubRef, applicationCol, applicationRef, syncPublicClub, addDoc, updateDoc, deleteDoc,
  esc, fmtDate, fmtTime, toast, confirmDialog, initials, clubPhoto
} from './club-core.js';

import {
  MAX_QUESTIONS, normalizeForm, normalizeQuestion,
  renderForm, wireForm, answerText
} from './registration-form.js';

import { mountQuestionEditor } from './question-editor.js';

/* The text side of the pending list — parsing, colouring and the shape it
   is written in — lives in its own file so it can be tested without a
   database anywhere near it. Re-exported because this is the module the
   members page already talks to. */
import {
  emailKey, markupFromApplicants, parseMarkupLine, parseMarkup, markupHTML
} from './pending-markup.js';

export { emailKey, markupFromApplicants, parseMarkupLine, parseMarkup, markupHTML };

import { openRegistrationShare } from './club-share.js';
import {
  connectGmail, disconnectGmail, connectedAccount, isConfigured as gmailConfigured,
  sendDirectEmail, sendViaGmail, wrapEmail, emailLogo, BRAND_NAVY, BRAND_NAVY_SOFT
} from './gmail-send.js';

const el = (html) => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
};

const noop = () => {};

/* The link an invited person is sent. `invite=1` is what makes it different
   from an ordinary club address: it says the person opening it was asked
   here by name, so once they have an account they are taken inside rather
   than shown a join gate. The join code rides along, so an invite still
   works if the club has gone private since it was sent. */
export function inviteURL(ctx) {
  const slug = ctx.club.slug || ctx.clubId;
  const params = new URLSearchParams({ invite: '1' });
  if (ctx.club.code) params.set('code', String(ctx.club.code));
  return `${location.origin}/clubs/${encodeURIComponent(slug)}?${params.toString()}`;
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE EDITOR (club settings)                                             */
/* ═══════════════════════════════════════════════════════════════════════ */

const CORE_ROWS = [
  ['What is your first name?', 'Short answer'],
  ['What is your last name?', 'Short answer'],
  ['What is your email address?', 'Email address']
];

/**
 * Draws the "Club registration form" box into `host`.
 * @returns {Function} cleanup
 */
export function mountRegistrationEditor(ctx, host) {
  const locked = ctx.club.visibility === 'private';
  let dirty = false;

  host.innerHTML = `
    <section class="tile reg-tile">
      <div class="reg-head">
        <div>
          <h3>Club registration form</h3>
          <p class="muted reg-sub">What somebody with no JagChess account fills in to sign up for
            ${esc(ctx.club.name || 'this club')} on the Network. Members who already have an account
            skip it entirely and join with one click.</p>
        </div>
        <div class="reg-head-actions">
          <button class="btn subtle sm" data-preview type="button">Preview</button>
          <button class="btn primary sm" data-share type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="3.2" width="7" height="7" rx="1.6"/><rect x="13.8" y="3.2" width="7" height="7" rx="1.6"/><rect x="3.2" y="13.8" width="7" height="7" rx="1.6"/><path d="M13.8 13.8h3v3h-3zM20.8 13.8v3M17.8 20.8h3M13.8 20.8h.01"/></svg>
            Share registration
          </button>
        </div>
      </div>

      ${locked ? `
      <div class="reg-locked">
        <span class="reg-locked-ico" aria-hidden="true">🔒</span>
        <div>
          <b>This club is private, so nobody can register</b>
          <p>Private clubs are not listed on the JagChess Network, and a registration form with no
            way to reach it would only be misleading. Your questions are saved exactly as they are —
            switch the club to public in Club details and they come straight back.</p>
        </div>
      </div>` : ''}

      <div class="reg-stage${locked ? ' is-locked' : ''}">
        <div class="reg-list" data-list></div>
        <div class="reg-foot">
          <button class="btn subtle" data-add type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Add a question
          </button>
          <span class="reg-dirty" data-dirty hidden>Unsaved changes</span>
          <button class="btn primary" data-save type="button">Save form</button>
        </div>
      </div>
    </section>`;

  const dirtyFlag = host.querySelector('[data-dirty]');
  const addBtn = host.querySelector('[data-add]');

  const markDirty = (on = true) => {
    dirty = on;
    dirtyFlag.hidden = !on;
  };

  const coreHTML = CORE_ROWS.map(([label, type], i) => `
    <div class="reg-q is-core">
      <span class="reg-q-num">${i + 1}</span>
      <div class="reg-q-core">
        <b>${esc(label)}</b>
        <span class="reg-q-meta">${esc(type)} · Required · Always first</span>
      </div>
      <span class="reg-built-in">Built in</span>
    </div>`).join('');

  /* A private club's box is read-only, not gone: the questions are still
     there and still saved, they simply have nowhere to be asked. Re-applied
     after every repaint, because a repaint builds fresh controls. */
  const applyLock = () => {
    if (!locked) return;
    const stage = host.querySelector('.reg-stage');
    stage.setAttribute('aria-hidden', 'true');
    stage.querySelectorAll('input, select, button, textarea').forEach((f) => {
      f.disabled = true;
      f.tabIndex = -1;
    });
  };

  const editor = mountQuestionEditor(host.querySelector('[data-list]'), {
    questions: normalizeForm(ctx.club.registrationForm),
    coreHTML,
    coreCount: CORE_ROWS.length,
    max: MAX_QUESTIONS,
    emptyHTML: `<div class="reg-none">Those three are always asked. Add your own
      questions below — a grade, a rating, how they heard about the club.</div>`,
    onDirty: () => markDirty(),
    onCount: (n) => {
      addBtn.disabled = n >= MAX_QUESTIONS;
      applyLock();
    }
  });

  /* ── the box's own buttons ── */

  addBtn.onclick = () => editor.add();

  host.querySelector('[data-share]').onclick = () => openRegistrationShare(ctx);

  host.querySelector('[data-preview]').onclick = () => openPreview(ctx, editor.read());

  host.querySelector('[data-save]').onclick = async () => {
    const btn = host.querySelector('[data-save]');
    const questions = editor.read();

    const blank = questions.find((q) => !q.label.trim());
    if (blank) {
      toast('Every question needs something to ask', 'error');
      editor.paint();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await updateDoc(clubRef(ctx.clubId), { registrationForm: questions });
      ctx.club.registrationForm = questions;
      await syncPublicClub(ctx.club);
      markDirty(false);
      toast('Registration form saved', 'ok');
    } catch (e) {
      console.error(e);
      toast('Could not save the form', 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Save form';
    editor.paint();
  };

  if (locked) host.querySelector('[data-share]').disabled = true;
  applyLock();

  return noop;
}

/* ── preview ─────────────────────────────────────────────────────────── */

function openPreview(ctx, questions) {
  const modal = el(`<div class="modal"><div class="modal-card reg-preview-card">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>What people see</h3>
    <p class="modal-meta" style="margin:0">Exactly the form that appears on your club's card in the
      JagChess Network. Nothing typed here is sent anywhere.</p>
    <div class="reg-preview rf-form" data-form>${renderForm(questions)}</div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" data-x>Close preview</button></div>
  </div></div>`);

  document.body.appendChild(modal);
  wireForm(modal.querySelector('[data-form]'));
  const close = () => modal.remove();
  modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  PENDING MEMBERS (members page)                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

/* A markup row can be nothing but an address — that is the whole point of
   being able to type one in. There is no name to show and none to guess, so
   it says so rather than putting their email where their name goes. */
export const applicantName = (a) => {
  const full = [a.firstName, a.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  return a.source === 'markup' ? 'Unknown' : (a.email || 'Someone');
};

/** One greyed-out row under the real roster. */
export function applicantRowHTML(a) {
  const invited = a.status === 'invited';
  /* Nobody filled a form in for a markup row, so there is no response to
     open — the address and whatever name was typed beside it is all there
     has ever been. */
  const fromMarkup = a.source === 'markup';
  /* Points earned by checking in before they had an account. They are real
     and they are theirs — they are simply not on the leaderboard yet, because
     the leaderboard ranks members and this person is not one. Joining moves
     them across. */
  const held = Number(a.attendancePoints) || 0;
  const fromAttendance = a.source === 'attendance';
  const when = esc(fmtDate(a.submittedAt || Date.now()));
  const came = fromMarkup ? 'added by hand ' + when
    : fromAttendance ? 'checked in ' + when
    : 'signed up ' + when;
  return `
    <div class="user-row applicant${invited ? ' is-invited' : ''}" data-app="${esc(a.id)}">
      <div class="user-rank">–</div>
      <div class="user-avatar-circle applicant-avatar">${esc(initials(applicantName(a)))}</div>
      <div class="user-info">
        <div class="user-uid">${esc(applicantName(a))}
          <span class="role-pill ${invited ? 'invited' : 'pending'}">${invited ? 'Invited' : 'Pending'}</span>
          ${fromMarkup ? '<span class="role-pill markup">Markup</span>' : ''}
          ${held ? `<span class="att-tag new" title="Earned by checking in — added to their total when they join">${held} pts held</span>` : ''}</div>
        <div class="user-role">${esc(a.email || '')} · ${came}</div>
      </div>
      <div class="applicant-actions">
        ${fromMarkup ? '' : `<button class="user-edit-btn" data-view="${esc(a.id)}">View response</button>`}
        <button class="user-edit-btn primary" data-invite="${esc(a.id)}">${invited ? 'Send again' : 'Send email invite'}</button>
        <button class="user-edit-btn icon danger" data-drop="${esc(a.id)}"
                data-tip="Delete this request" aria-label="Delete this request">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
    </div>`;
}

/* ── one response, in full ───────────────────────────────────────────── */

export function openResponse(ctx, app, api = {}) {
  const questions = (app.questions || []).map(normalizeQuestion);
  const answers = app.answers || {};

  const modal = el(`<div class="modal"><div class="modal-card app-card">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>${esc(applicantName(app))}</h3>
    <div class="app-head">
      <div class="user-avatar-circle applicant-avatar" style="width:46px;height:46px;font-size:15px">${esc(initials(applicantName(app)))}</div>
      <div>
        <div class="app-head-mail">${esc(app.email || '')}</div>
        <div class="app-head-meta">${app.source === 'attendance' ? 'Checked in' : 'Signed up'}
          ${esc(fmtDate(app.submittedAt || Date.now()))} at
          ${esc(fmtTime(app.submittedAt || Date.now()))}${app.status === 'invited' && app.invitedAt
            ? ' · invited ' + esc(fmtDate(app.invitedAt)) : ''}</div>
      </div>
    </div>

    ${Number(app.attendancePoints) ? `
    <div class="app-held">
      <b>${esc(String(Number(app.attendancePoints)))} points waiting</b>
      <p>Earned by checking in to events without an account. They are not on the leaderboard —
        the moment ${esc(app.firstName || 'they')} join${app.firstName ? 's' : ''} the club with
        this address, the points move onto their membership.</p>
    </div>` : ''}

    ${app.source === 'attendance' && !questions.length ? `
    <div class="app-answers">
      <div class="empty-state">This place was opened automatically from an attendance check-in —
        the name and address above are what they typed on it. Nothing else was asked.</div>
    </div>` : `
    <div class="app-answers">
      ${questions.length ? questions.map((q) => `
        <div class="app-answer">
          <span class="app-q">${esc(q.label)}</span>
          <span class="app-a">${esc(answerText(q, answers[q.id]))}</span>
        </div>`).join('')
      : '<div class="empty-state">This registration came in without its questions attached.</div>'}
    </div>`}

    <div class="app-foot">
      <button class="btn subtle danger" data-del>Remove</button>
      <span style="flex:1"></span>
      <button class="btn subtle" data-x>Close</button>
      <button class="btn primary" data-invite>Send email invite</button>
    </div>
  </div></div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  modal.onclick = (e) => { if (e.target === modal) close(); };

  modal.querySelector('[data-invite]').onclick = () => { close(); openInviteMail(ctx, app); };
  modal.querySelector('[data-del]').onclick = async () => {
    const ok = await deleteApplication(ctx, app);
    if (ok) close();
  };
}

export async function deleteApplication(ctx, app) {
  const ok = await confirmDialog({
    title: 'Remove this registration?',
    body: `${applicantName(app)} disappears from your pending list. They can sign up again from the
           JagChess Network, and an invite you have already sent still works.`,
    confirmText: 'Remove',
    danger: true
  });
  if (!ok) return false;
  try {
    await deleteDoc(applicationRef(ctx.clubId, app.id));
    toast('Registration removed');
    return true;
  } catch (e) {
    console.error(e);
    toast('Could not remove that', 'error');
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE SAME LIST, WRITTEN OUT AS TEXT                                     */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * Draws the editor where the pending rows were.
 * @returns {{destroy:Function}}
 */
export function mountMarkupEditor(host, opts) {
  const o = opts || {};
  const members = new Set((o.memberEmails || []).map(emailKey).filter(Boolean));

  host.innerHTML = `
    <div class="mk-editor">
      <p class="mk-note">One person per line: their <b>email address</b>, two spaces, then their
        name. Only the address is required. What you save here becomes the pending list exactly —
        a line you delete removes that person, a line you add puts one there.</p>
      <div class="mk-key">
        <span><i class="mk-dot bad"></i>Something is wrong with the line</span>
        <span><i class="mk-dot dup"></i>Written in here more than once</span>
        <span><i class="mk-dot mem"></i>Already a member of the club</span>
        <span><i class="mk-dot both"></i>Both at once</span>
      </div>
      <div class="mk-wrap">
        <pre class="mk-paint" data-paint aria-hidden="true"></pre>
        <textarea class="mk-input" data-input spellcheck="false" autocapitalize="off"
          autocorrect="off" aria-label="Pending members, as text"></textarea>
      </div>
      <div class="mk-foot">
        <span class="mk-status" data-status></span>
        <span class="mk-foot-gap"></span>
        <button class="btn subtle" data-cancel type="button">Cancel</button>
        <button class="btn primary" data-save type="button">Save changes</button>
      </div>
    </div>`;

  const input = host.querySelector('[data-input]');
  const paint = host.querySelector('[data-paint]');
  const status = host.querySelector('[data-status]');
  const save = host.querySelector('[data-save]');

  input.value = String(o.text || '');
  let parsed = parseMarkup(input.value, members);

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.max(240, input.scrollHeight) + 'px';
  };

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const refresh = () => {
    parsed = parseMarkup(input.value, members);
    paint.innerHTML = markupHTML(parsed);
    grow();

    /* A duplicate and an address that is not one are the two things nobody
       else can settle: which of the two rows did you mean, and what did you
       mean to type. Everything else the save can deal with itself. */
    const stop = [
      parsed.dupes ? plural(parsed.dupes, 'address is', 'addresses are') + ' in here more than once' : '',
      parsed.bad ? plural(parsed.bad, 'line has', 'lines have') + ' no usable email address' : ''
    ].filter(Boolean);

    save.disabled = stop.length > 0;
    status.className = 'mk-status' + (stop.length ? ' is-bad' : '');
    status.textContent = stop.length
      ? stop.join(' · ') + ' — sort those out to save'
      : [
        plural(parsed.people.length, 'person', 'people'),
        parsed.members ? plural(parsed.members, 'line', 'lines') + ' already in the club, dropped on save' : '',
        parsed.sloppy ? plural(parsed.sloppy, 'line is', 'lines are') + ' not written as address␣␣First Last' : ''
      ].filter(Boolean).join(' · ');
  };

  input.oninput = refresh;
  input.onscroll = () => { paint.scrollTop = input.scrollTop; };
  refresh();
  input.focus();

  host.querySelector('[data-cancel]').onclick = () => { if (o.onCancel) o.onCancel(); };

  save.onclick = async () => {
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = 'Saving…';
    const done = o.onSave ? await o.onSave(parsed.people) : true;
    if (!done && save.isConnected) {
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  };

  return { destroy() { host.innerHTML = ''; } };
}

/**
 * Makes the pending list match the markup: adds what is new, renames what
 * changed, removes what has gone.
 *
 * `current` is the list as it stood when the editor opened, on purpose.
 * Somebody who signs up while the markup is being typed is in neither half
 * of the comparison, and is left exactly where they are rather than deleted
 * for the crime of arriving late.
 */
export async function saveMarkup(ctx, people, current) {
  const rows = current || [];
  const want = new Map(people.map((p) => [emailKey(p.email), p]));
  const have = new Map(rows.map((a) => [emailKey(a.email), a]));

  const adds = people.filter((p) => !have.has(emailKey(p.email)));
  const drops = rows.filter((a) => !want.has(emailKey(a.email)));
  const renames = rows.filter((a) => {
    const p = want.get(emailKey(a.email));
    return !!p && ((p.firstName || '') !== (a.firstName || '') || (p.lastName || '') !== (a.lastName || ''));
  });

  if (!adds.length && !drops.length && !renames.length) {
    toast('Nothing changed');
    return true;
  }

  if (drops.length) {
    const named = drops.slice(0, 5).map((a) => a.email).join(', ');
    const ok = await confirmDialog({
      title: `Remove ${drops.length === 1 ? 'one pending person' : drops.length + ' pending people'}?`,
      body: `${named}${drops.length > 5 ? ` and ${drops.length - 5} more` : ''} ` +
            `${drops.length === 1 ? 'is' : 'are'} no longer in the markup, so saving takes ` +
            `${drops.length === 1 ? 'them' : 'them'} off the pending list. ` +
            (adds.length ? `${adds.length === 1 ? 'One new person' : adds.length + ' new people'} will be added. ` : '') +
            'An invite already sent still works.',
      confirmText: 'Save changes',
      danger: true
    });
    if (!ok) return false;
  }

  try {
    await Promise.all([
      ...adds.map((p) => addDoc(applicationCol(ctx.clubId), {
        clubId: ctx.clubId,
        status: 'pending',
        firstName: String(p.firstName || '').slice(0, 60),
        lastName: String(p.lastName || '').slice(0, 60),
        email: String(p.email || '').slice(0, 140),
        answers: {},
        questions: [],
        source: 'markup',
        addedBy: ctx.user.uid,
        addedByName: ctx.member.username || '',
        submittedAt: Date.now()
      })),
      ...renames.map((a) => {
        const p = want.get(emailKey(a.email));
        return updateDoc(applicationRef(ctx.clubId, a.id), {
          firstName: String(p.firstName || '').slice(0, 60),
          lastName: String(p.lastName || '').slice(0, 60)
        });
      }),
      ...drops.map((a) => deleteDoc(applicationRef(ctx.clubId, a.id)))
    ]);

    toast([
      adds.length ? `${adds.length} added` : '',
      renames.length ? `${renames.length} renamed` : '',
      drops.length ? `${drops.length} removed` : ''
    ].filter(Boolean).join(' · '), 'ok');
    return true;
  } catch (e) {
    console.error(e);
    toast('Could not save the markup', 'error');
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  THE INVITE EMAIL                                                       */
/* ═══════════════════════════════════════════════════════════════════════ */

/* Plain text in, mail-safe HTML out. People tweak the message in a textarea,
   so a blank line has to mean a paragraph and a bare URL has to become a
   link — otherwise the invite arrives as a wall of text with the one thing
   that matters unclickable.

   Two details that matter more than they look:
   · trailing punctuation stays out of the href. ".../network." links to a
     page that does not exist, and ending a sentence on a URL is the normal
     way to write one.
   · the invite link itself is promoted to a button. It is the only thing in
     the message anybody has to act on, and a colored word buried in a
     paragraph is easy to read straight past. */
const LINK_RE = /https?:\/\/[^\s<]*[^\s<.,;:!?)\]}'"]/g;

const anchor = (url) =>
  `<a href="${url}" style="color:${BRAND_NAVY_SOFT};font-weight:700;text-decoration:underline">${url}</a>`;

const linkButton = (url) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 16px">` +
  `<tr><td style="border-radius:10px;background:${BRAND_NAVY}">` +
  `<a href="${url}" style="display:inline-block;padding:14px 30px;color:#ffffff;` +
  `font-weight:700;font-size:15px;text-decoration:none;border-radius:10px">Open my invite</a>` +
  `</td></tr></table>` +
  `<p style="margin:0 0 14px;font-size:12.5px;color:#76829a">` +
  `Or paste this into your browser:<br>${anchor(url)}</p>`;

/** The message body as the recipient's mail client will see it. */
export const inviteEmailHTML = (ctx, body) => textToHTML(body, inviteURL(ctx));

function textToHTML(text, inviteLink) {
  const linkify = (line) => esc(line).replace(LINK_RE, (url) => anchor(url));

  return String(text || '')
    .split(/\n{2,}/)
    .map((para) => {
      // a paragraph that is nothing but the invite link becomes the button
      if (inviteLink && para.trim() === inviteLink) return linkButton(esc(inviteLink));
      return `<p style="margin:0 0 14px">${para.split('\n').map(linkify).join('<br>')}</p>`;
    })
    .join('');
}

/* The message itself.
 *
 * `bulk` is one message going to everybody at once, and there are two
 * things it cannot do. It cannot greet anybody by name — half the list is
 * blind-copied and the other half would be addressed as somebody else —
 * and it cannot claim they all signed up, because an admin typed some of
 * them in. So it says what is true of every single person on it.
 */
export function defaultInviteMessage(ctx, app, opts) {
  const bulk = !!(opts && opts.bulk);
  const url = inviteURL(ctx);
  const club = ctx.club.name || 'our chess club';
  const me = ctx.member.username || (ctx.user.email || '').split('@')[0] || 'The club';

  const hello = bulk ? 'Hi there,' : `Hi ${(app && app.firstName) || 'there'},`;
  const opening = bulk
    ? `You're invited to join ${club} on JagChess. Here is the link that takes you in:`
    : `Thanks for signing up for ${club} on the JagChess Network — we'd love to have you in the ` +
      'club. Here is your personal invite link:';

  return `${hello}

${opening}

${url}

What to do next:
1. Open the link above.
2. Create a free JagChess account, or log in if you already have one.
3. That's it — you land straight inside ${club}, no join code needed.

${bulk ? 'Please keep the link to yourself.' : "The link is yours, so please don't pass it on."} See you at the board.

${me}
${club}

Don't want any more email from JagChess about club membership? Just reply with the word STOP and we'll leave you alone.`;
}

/** One person, addressed by name, in the open. */
export function openInviteMail(ctx, app) {
  return inviteMail(ctx, [app], false);
}

/**
 * Everybody waiting, in one message, with the whole list in Bcc.
 * Nobody sees who else was written to, and nobody is greeted by name —
 * see defaultInviteMessage.
 */
export function openBulkInvite(ctx, rows) {
  return inviteMail(ctx, rows || [], true);
}

function inviteMail(ctx, targets, bulk) {
  const club = ctx.club.name || 'the club';
  const configured = gmailConfigured();

  const people = (targets || []).filter((a) => a && a.email);
  if (!people.length) { toast('There is nobody to write to', 'error'); return; }

  /* An invite that has already gone out is the one thing worth being able
     to leave out of a re-send, so it is a switch rather than a rule: some
     clubs chase, some do not. */
  let skipInvited = false;
  const waiting = people.filter((a) => a.status !== 'invited');
  const invitedCount = people.length - waiting.length;
  const recipients = () => (skipInvited ? waiting : people);

  const first = people[0];
  const subject = `You're invited to join ${club} on JagChess`;

  const modal = el(`<div class="modal"><div class="modal-card invite-card">
    <button class="icon-btn modal-close" data-x>✕</button>
    <h3>${bulk
      ? `Invite ${people.length} ${people.length === 1 ? 'person' : 'people'}`
      : `Invite ${esc(first.firstName || applicantName(first))}`}</h3>
    <p class="modal-meta" style="margin:0">${bulk
      ? 'One message, from your own Gmail, with every address in Bcc — nobody sees who else it ' +
        'went to. Because it goes to everybody at once it greets nobody by name.'
      : `This goes out from your own Gmail, straight to ${esc(first.email || 'them')} — not from a ` +
        'JagChess address. Tweak anything you like before it does.'}</p>

    <div class="nl-field">
      <label>Sending from</label>
      <div class="nl-account">
        <div class="nl-account-info">
          <span class="nl-account-avatar" data-avatar>?</span>
          <span class="nl-account-text">
            <span class="nl-account-name" data-acct-name>No account connected</span>
            <span class="nl-account-email" data-acct-mail>Mail goes out from your own Gmail.</span>
          </span>
        </div>
        <button type="button" class="btn subtle nl-connect" data-connect>Connect Gmail</button>
      </div>
      <span class="nl-hint">${configured
        ? 'Replies come back to you, and the send counts against your own Gmail quota.'
        : 'Email sending is not set up on this site yet, so this invite cannot be delivered from here.'}</span>
    </div>

    ${bulk ? `
    <div class="nl-field">
      <label>To <span class="iv-to-count" data-count></span></label>
      <div class="iv-to-list" data-list></div>
      ${invitedCount ? `<label class="iv-skip">
        <input type="checkbox" data-skip />
        <span>Leave out the ${invitedCount} already marked <b>Invited</b></span>
      </label>` : ''}
      <span class="nl-hint">Everyone rides in Bcc, so no address on this list reaches any other.</span>
    </div>` : `
    <div class="nl-field">
      <label for="iv-to">To</label>
      <input id="iv-to" type="email" value="${esc(first.email || '')}" readonly />
    </div>`}

    <div class="nl-field">
      <label for="iv-subject">Subject</label>
      <input id="iv-subject" type="text" maxlength="160" value="${esc(subject)}" />
    </div>

    <div class="nl-field">
      <label for="iv-body">Message</label>
      <textarea id="iv-body" rows="14" class="invite-body">${esc(defaultInviteMessage(ctx, first, { bulk }))}</textarea>
      <span class="nl-hint">The invite link has to stay in there — it is what takes them into the club.</span>
    </div>

    <div class="nl-status" data-status hidden></div>

    <div class="invite-foot">
      <button class="btn subtle" data-reset type="button">Reset to template</button>
      <span style="flex:1"></span>
      <button class="btn subtle" data-x>Cancel</button>
      <button class="btn primary" data-send${configured ? '' : ' disabled'}>${
        bulk ? 'Send to everyone' : 'Send invite'}</button>
    </div>
  </div></div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  modal.onclick = (e) => { if (e.target === modal) close(); };

  const status = (msg, kind) => {
    const box = modal.querySelector('[data-status]');
    box.hidden = !msg;
    box.textContent = msg || '';
    box.className = 'nl-status' + (kind ? ' ' + kind : '');
  };

  const sendBtn = modal.querySelector('[data-send]');

  const paintList = () => {
    if (!bulk) return;
    const to = recipients();
    modal.querySelector('[data-count]').textContent =
      `· ${to.length} ${to.length === 1 ? 'person' : 'people'}`;
    modal.querySelector('[data-list]').innerHTML = to.length
      ? to.map((a) => `<span class="iv-chip${a.status === 'invited' ? ' sent' : ''}"
          title="${esc(applicantName(a))}">${esc(a.email)}</span>`).join('')
      : '<span class="iv-none">Nobody is left once the invited ones are taken out.</span>';
    if (configured) sendBtn.disabled = to.length === 0;
  };

  const skipBox = modal.querySelector('[data-skip]');
  if (skipBox) skipBox.onchange = () => { skipInvited = skipBox.checked; paintList(); };
  paintList();

  const paintAccount = () => {
    const acct = connectedAccount();
    modal.querySelector('[data-acct-name]').textContent = acct ? (acct.name || acct.email) : 'No account connected';
    modal.querySelector('[data-acct-mail]').textContent = acct ? acct.email : 'Mail goes out from your own Gmail.';
    modal.querySelector('[data-avatar]').textContent = acct ? initials(acct.name || acct.email) : '?';
    modal.querySelector('[data-connect]').textContent = acct ? 'Disconnect' : 'Connect Gmail';
  };
  paintAccount();

  modal.querySelector('[data-connect]').onclick = async () => {
    const btn = modal.querySelector('[data-connect]');
    if (connectedAccount()) {
      disconnectGmail();
      paintAccount();
      status('Gmail disconnected.', 'info');
      return;
    }
    if (!configured) { status('Email sending is not set up on this site yet.', 'error'); return; }
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await connectGmail();
      paintAccount();
      status('Connected — the invite will come from that address.', 'ok');
    } catch (e) {
      console.error(e);
      status('Could not connect Gmail: ' + (e.message || 'permission was declined'), 'error');
      paintAccount();
    }
    btn.disabled = false;
  };

  modal.querySelector('[data-reset]').onclick = () => {
    modal.querySelector('#iv-body').value = defaultInviteMessage(ctx, first, { bulk });
    modal.querySelector('#iv-subject').value = subject;
    status('Back to the default message.', 'info');
  };

  /* Stamping is best effort on purpose: the mail has already gone, and a row
     that failed to record that is a smaller problem than a screen saying the
     send failed when it did not. */
  const stamp = (rows) => Promise.all(rows.map((a) =>
    updateDoc(applicationRef(ctx.clubId, a.id), {
      status: 'invited',
      invitedAt: Date.now(),
      invitedBy: ctx.user.uid,
      invitedByName: ctx.member.username || ''
    }).catch((e) => console.warn('Invite sent, but the row was not stamped', e))));

  sendBtn.onclick = async () => {
    const subj = modal.querySelector('#iv-subject').value.trim();
    const body = modal.querySelector('#iv-body').value.trim();
    const to = recipients();

    if (!subj) { status('Give the email a subject.', 'error'); return; }
    if (!body) { status('The message is empty.', 'error'); return; }
    if (!to.length) { status('There is nobody left to write to.', 'error'); return; }
    if (!body.includes(inviteURL(ctx))) {
      const ok = await confirmDialog({
        title: 'Send without the invite link?',
        body: 'The link is gone from the message, so whoever receives it has no way in. Send anyway?',
        confirmText: 'Send anyway',
        danger: true
      });
      if (!ok) return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    status('Sending…', 'info');

    /* The club's badge travels with the message as a related part — see
       emailLogo. A club without one falls back to its own glyph. */
    const { logo, inline } = await emailLogo(clubPhoto(ctx.club));
    const html = wrapEmail(subj, inviteEmailHTML(ctx, body),
      ctx.member.username || 'A club admin', ctx.club.name || '',
      { logo, icon: ctx.club.icon || '', color: ctx.club.color || '' });
    const replyTo = (ctx.user.email || '').toLowerCase();
    const replyToName = ctx.member.username || '';

    try {
      if (bulk) {
        await sendViaGmail({
          subject: subj,
          html,
          inline,
          recipients: to.map((a) => a.email),
          replyTo,
          replyToName,
          onProgress: (sent, total) => status(`Sent to ${sent} of ${total}…`, 'info')
        });
      } else {
        await sendDirectEmail({ subject: subj, html, inline, to: to[0].email, replyTo, replyToName });
      }

      await stamp(to);
      window.jagTrack?.(bulk ? 'registration_invite_bulk' : 'registration_invite_sent',
        { club: ctx.clubId, count: to.length });
      close();
      toast(bulk
        ? `Invite sent to ${to.length} ${to.length === 1 ? 'person' : 'people'}`
        : 'Invite sent to ' + to[0].email, 'ok');
    } catch (e) {
      console.error(e);
      /* A batch that failed halfway has already reached people, and saying
         nothing about that would have an admin send the whole thing again. */
      const part = Number(e.sent) ? ` ${e.sent} of ${e.total} had already gone out.` : '';
      status('Could not send: ' + (e.message || 'Gmail refused the message') + part, 'error');
      sendBtn.disabled = false;
      sendBtn.textContent = bulk ? 'Send to everyone' : 'Send invite';
    }
  };
}
