/* ═══════════════════════════════════════════════════════════════════════
   newsletter-mail.js — the "also email this" field under an announcement.

   One component, two homes: the legacy admin console and the club
   Newsletters block. Each host supplies its own roster through `getPeople`,
   so this file never knows whether it is reading global users or club
   members.

   Recipients behave like Gmail's To field — Enter, comma, semicolon or a
   space after a finished address turns the text into a pill, and anyone
   already in the club is offered as a card with their avatar, name and
   address while you type.

   Delivery goes out through the club's own connected Gmail, so every club
   sends on its own credentials, its own address and its own quota. There is
   deliberately no shared relay: one club can never spend another's
   allowance, and no single account can be abused into a site-wide outage.
   Nothing secret lives here — the OAuth token is short-lived, held in
   memory, and never written down.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  connectGmail, disconnectGmail, connectedAccount, isConfigured as gmailConfigured,
  sendViaGmail, wrapEmail,
} from './gmail-send.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (s) => EMAIL_RE.test(String(s || '').trim());

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const initialsOf = (name) => {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
};

const ROLE_LABEL = { founder: 'Founder', admin: 'Admin', student: 'Student' };
const isStaffRole = (r) => r === 'admin' || r === 'founder';

const TEMPLATE = `
  <div class="nl-toggle">
    <label class="nl-switch">
      <input type="checkbox" data-nl="enabled" />
      <span class="nl-switch-track"><span class="nl-switch-thumb"></span></span>
    </label>
    <div class="nl-toggle-copy">
      <span class="nl-toggle-title">Email this to students</span>
      <span class="nl-toggle-sub">Send the announcement to inboxes as well as posting it.</span>
    </div>
  </div>

  <div class="nl-panel" data-nl="panel" hidden>
    <div class="nl-field">
      <label>Sending from</label>
      <div class="nl-account" data-nl="account">
        <div class="nl-account-info">
          <span class="nl-account-avatar" data-nl="account-avatar">?</span>
          <span class="nl-account-text">
            <span class="nl-account-name" data-nl="account-name">No account connected</span>
            <span class="nl-account-email" data-nl="account-email">Mail goes out from your own Gmail.</span>
          </span>
        </div>
        <button type="button" class="btn subtle nl-connect" data-nl="connect">Connect Gmail</button>
      </div>
      <span class="nl-hint" data-nl="account-hint">Your club sends on its own account, so the address really is yours.</span>
    </div>

    <div class="nl-field">
      <label data-nl="sender-label">Replies go to</label>
      <select data-nl="sender"></select>
      <span class="nl-hint">Founders and admins only.</span>
    </div>

    <div class="nl-field">
      <div class="nl-field-head">
        <label data-nl="to-label">To</label>
        <button type="button" class="btn subtle nl-add-all" data-nl="add-all"></button>
      </div>
      <div class="nl-input-shell">
        <div class="nl-chips" data-nl="chips">
          <input type="text" data-nl="input" placeholder="Type an email, then press Enter…" autocomplete="off" />
        </div>
        <div class="nl-dropdown" data-nl="dropdown" hidden></div>
      </div>
      <span class="nl-hint" data-nl="count">No recipients yet.</span>
    </div>
  </div>

  <div class="nl-status" data-nl="status" hidden></div>`;

/**
 * @param {HTMLElement} mount   container the field is rendered into
 * @param {object} opts
 *   getPeople()   -> [{ email, name, role, avatarColor }]  the roster
 *   getMe()       -> email of the signed-in admin, preselected as reply-to
 *   getClubName() -> club name, shown in the email header
 *   addAllLabel   -> text on the bulk-add button
 * @returns control surface for the surrounding form
 */
export function mountNewsletterMail(mount, opts = {}) {
  const {
    getPeople = () => [],
    getMe = () => '',
    getClubName = () => '',
    addAllLabel = 'Add all club members',
  } = opts;

  mount.classList.add('nl-mail');
  mount.innerHTML = TEMPLATE;

  const $ = (name) => mount.querySelector(`[data-nl="${name}"]`);
  const toggle = $('enabled');
  const panel = $('panel');
  const senderSel = $('sender');
  const chipsWrap = $('chips');
  const input = $('input');
  const dropdown = $('dropdown');
  const addAllBtn = $('add-all');
  const countEl = $('count');
  const statusEl = $('status');
  const connectBtn = $('connect');
  const acctAvatar = $('account-avatar');
  const acctName = $('account-name');
  const acctEmail = $('account-email');
  const acctHint = $('account-hint');

  addAllBtn.textContent = addAllLabel;

  let recipients = [];
  let suggestions = [];
  let activeIdx = -1;

  /* ── roster helpers ─────────────────────────────────────────────────── */

  // Everyone who can actually receive mail — no tombstoned or banned rows.
  const people = () => getPeople()
    .filter((p) => p && p.email && isValidEmail(p.email) && !p.deleted && !p.banned)
    .map((p) => ({ ...p, email: String(p.email).trim().toLowerCase() }));

  const personBy = (email) => people().find((p) => p.email === email);

  /* Who replies go to — a staff member, chosen from the dropdown. */
  const replyToAddress = () => (senderSel.value || '').trim().toLowerCase();

  /* The address the message physically leaves from. Normally the connected
     Gmail; on the shared-worker fallback the reply-to admin stands in. */
  const sendingAddress = () => connectedAccount()?.email || replyToAddress();

  const setStatus = (msg, kind = 'info') => {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.className = `nl-status ${kind}`;
  };

  /* ── the connected mailbox ──────────────────────────────────────────── */

  const dropSendingAddressFromRecipients = () => {
    const from = sendingAddress();
    const before = recipients.length;
    recipients = recipients.filter((e) => e !== from);
    if (recipients.length !== before) {
      setStatus('Removed the sending address from the recipient list.', 'info');
    }
    renderChips();
  };

  const renderAccount = () => {
    const acct = connectedAccount();
    if (acct) {
      acctAvatar.textContent = initialsOf(acct.name || acct.email);
      // initials show through unless there is a real photo to cover them
      acctAvatar.style.backgroundImage = acct.picture ? `url("${esc(acct.picture)}")` : '';
      acctAvatar.classList.toggle('has-photo', !!acct.picture);
      acctName.textContent = acct.name || acct.email;
      acctEmail.textContent = acct.email;
      connectBtn.textContent = 'Change';
      acctHint.textContent = 'Mail is sent from this account and counts against its own Gmail limit.';
      mount.classList.add('nl-connected');
    } else {
      acctAvatar.textContent = '?';
      acctAvatar.style.backgroundImage = '';
      acctAvatar.classList.remove('has-photo');
      acctName.textContent = 'No account connected';
      acctEmail.textContent = gmailConfigured()
        ? 'Connect a Gmail to send from your own address.'
        : 'Gmail sending is not set up on this site yet.';
      connectBtn.textContent = 'Connect Gmail';
      connectBtn.disabled = !gmailConfigured();
      acctHint.textContent = 'Your club sends on its own account, so the address really is yours.';
      mount.classList.remove('nl-connected');
    }
  };

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    const label = connectBtn.textContent;
    connectBtn.textContent = 'Connecting…';
    try {
      if (connectedAccount()) disconnectGmail();
      const acct = await connectGmail({ interactive: true });
      renderAccount();
      dropSendingAddressFromRecipients();
      setStatus(`Connected ${acct.email}. Mail will be sent from this address.`, 'ok');
    } catch (err) {
      renderAccount();
      setStatus(`Could not connect Gmail — ${err.message}.`, 'warn');
    } finally {
      connectBtn.disabled = !gmailConfigured() && !connectedAccount();
      if (connectBtn.textContent === 'Connecting…') connectBtn.textContent = label;
    }
  });

  /* ── reply-to dropdown — founders and admins only ───────────────────── */

  const renderSender = () => {
    const staff = people()
      .filter((p) => isStaffRole(p.role))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

    const previous = senderSel.value;
    senderSel.innerHTML = staff.length
      ? staff.map((p) =>
          `<option value="${esc(p.email)}">${esc(p.name ? `${p.name} · ${p.email}` : p.email)}</option>`
        ).join('')
      : '<option value="">No admins found</option>';

    // Keep the current pick if it survived the refresh, else default to you.
    const has = (mail) => staff.some((p) => p.email === mail);
    const me = String(getMe() || '').toLowerCase();
    const pick = [previous, me].find((m) => m && has(m));
    senderSel.value = pick || (staff[0] ? staff[0].email : '');
    senderSel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  senderSel.addEventListener('change', dropSendingAddressFromRecipients);

  /* ── recipient chips ────────────────────────────────────────────────── */

  const updateCount = () => {
    const n = recipients.length;
    countEl.textContent = n
      ? `${n} recipient${n === 1 ? '' : 's'} · everyone is BCC'd, so nobody sees the list.`
      : 'No recipients yet.';
  };

  const renderChips = () => {
    // Drop the old pills but leave the input where it is.
    chipsWrap.querySelectorAll('.nl-chip').forEach((el) => el.remove());
    recipients.forEach((email, i) => {
      const p = personBy(email);
      const chip = document.createElement('span');
      chip.className = 'nl-chip';
      chip.title = p?.name ? `${p.name} · ${email}` : email;
      chip.innerHTML =
        `<span class="nl-chip-avatar" style="background:${esc(p?.avatarColor || '#8296a4')}">${esc(initialsOf(p?.name || email))}</span>` +
        `<span class="nl-chip-label">${esc(p?.name || email)}</span>` +
        `<button type="button" class="nl-chip-x" data-idx="${i}" aria-label="Remove ${esc(email)}" title="Remove ${esc(email)}">×</button>`;
      chipsWrap.insertBefore(chip, input);
    });
    updateCount();
  };

  /* Returns true when the address landed as a chip. On failure the typed
     text is left alone so a half-finished address can go on being typed. */
  const addRecipient = (raw) => {
    const email = String(raw || '').trim().toLowerCase().replace(/^[<,;]+|[>,;]+$/g, '');
    if (!email) return false;
    if (!isValidEmail(email)) {
      setStatus(`"${email}" isn't a valid email address.`, 'warn');
      return false;
    }
    if (email === sendingAddress()) {
      setStatus('That address is the sender — it receives its own copy already.', 'warn');
      input.value = '';
      hideDropdown();
      return false;
    }
    if (!recipients.includes(email)) recipients.push(email);
    input.value = '';
    renderChips();
    hideDropdown();
    setStatus('');
    return true;
  };

  /* ── autocomplete ───────────────────────────────────────────────────── */

  function hideDropdown() {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
    suggestions = [];
    activeIdx = -1;
  }

  const highlight = () => {
    dropdown.querySelectorAll('.nl-suggestion').forEach((el, i) => {
      const on = i === activeIdx;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const refreshSuggestions = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { hideDropdown(); return; }
    const from = sendingAddress();
    const matches = people()
      .filter((p) =>
        p.email !== from &&
        !recipients.includes(p.email) &&
        (p.email.includes(q) || (p.name || '').toLowerCase().includes(q)))
      .slice(0, 6);

    if (!matches.length) { hideDropdown(); return; }
    suggestions = matches;
    activeIdx = 0;
    dropdown.hidden = false;
    dropdown.innerHTML = matches.map((p, i) => {
      const role = p.role || 'student';
      return `<div class="nl-suggestion${i === 0 ? ' active' : ''}" data-email="${esc(p.email)}">
        <span class="nl-suggestion-avatar" style="background:${esc(p.avatarColor || '#8296a4')}">${esc(initialsOf(p.name || p.email))}</span>
        <span class="nl-suggestion-text">
          <span class="nl-suggestion-name">${esc(p.name || p.email.split('@')[0])}</span>
          <span class="nl-suggestion-email">${esc(p.email)}</span>
        </span>
        <span class="nl-suggestion-role ${esc(role)}">${esc(ROLE_LABEL[role] || 'Student')}</span>
      </div>`;
    }).join('');
  };

  input.addEventListener('input', refreshSuggestions);
  input.addEventListener('focus', refreshSuggestions);

  input.addEventListener('keydown', (e) => {
    const typed = input.value.trim();

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      activeIdx = (activeIdx + step + suggestions.length) % suggestions.length;
      highlight();
      return;
    }

    // Space only commits once the text already reads as a whole address, so
    // it stays usable while an address is still being typed.
    const commits = e.key === 'Enter' || e.key === ',' || e.key === ';' ||
      (e.key === ' ' && isValidEmail(typed));

    if (commits) {
      e.preventDefault();
      const picked = suggestions[activeIdx];
      if (picked && e.key === 'Enter') addRecipient(picked.email);
      else if (typed) addRecipient(typed);
      return;
    }

    if (e.key === 'Backspace' && !input.value && recipients.length) {
      recipients.pop();
      renderChips();
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  // Losing focus shouldn't silently drop a finished address.
  input.addEventListener('blur', () => {
    const typed = input.value.trim();
    if (typed && isValidEmail(typed)) addRecipient(typed);
  });

  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!/[,;\s]/.test(text)) return;   // a single address — let it paste normally
    e.preventDefault();
    const added = text.split(/[,;\s]+/).filter(Boolean)
      .reduce((n, part) => n + (addRecipient(part) ? 1 : 0), 0);
    if (added) setStatus(`Added ${added} address${added === 1 ? '' : 'es'}.`, 'ok');
  });

  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.nl-suggestion');
    if (!item) return;
    e.preventDefault();          // beat the input's blur handler to the punch
    addRecipient(item.dataset.email);
    input.focus();
  });

  chipsWrap.addEventListener('click', (e) => {
    const x = e.target.closest('.nl-chip-x');
    if (x) {
      recipients.splice(parseInt(x.dataset.idx, 10), 1);
      renderChips();
    } else {
      input.focus();
    }
  });

  const onDocClick = (e) => {
    if (!chipsWrap.contains(e.target) && !dropdown.contains(e.target)) hideDropdown();
  };
  document.addEventListener('click', onDocClick);

  /* ── bulk add ───────────────────────────────────────────────────────── */

  addAllBtn.addEventListener('click', () => {
    const from = sendingAddress();
    const before = recipients.length;
    people().forEach((p) => {
      if (p.email !== from && !recipients.includes(p.email)) recipients.push(p.email);
    });
    const added = recipients.length - before;
    renderChips();
    setStatus(
      added ? `Added ${added} club member${added === 1 ? '' : 's'}.`
            : 'Everyone in the club is already on the list.',
      added ? 'ok' : 'info'
    );
  });

  /* ── the toggle ─────────────────────────────────────────────────────── */

  const syncPanel = () => {
    const on = toggle.checked;
    panel.hidden = !on;
    mount.classList.toggle('nl-on', on);
    if (!on) { hideDropdown(); setStatus(''); }
    else if (!senderSel.options.length) renderSender();
  };
  toggle.addEventListener('change', syncPanel);

  /* ── delivery ───────────────────────────────────────────────────────── */

  /* Always the club's own connected Gmail — their address, their quota,
     their account answerable for it. There is no shared relay to fall back
     to, by design. */
  const send = async (subject, html) => {
    if (!recipients.length) throw new Error('add at least one recipient first');
    if (!connectedAccount()) {
      throw new Error(gmailConfigured()
        ? 'connect a Gmail account first — that is what the message is sent from'
        : 'email sending is not set up on this site yet');
    }

    const replyTo = replyToAddress();
    const replyToName = personBy(replyTo)?.name || '';

    return sendViaGmail({
      subject,
      html: wrapEmail(subject, html, replyToName || replyTo || connectedAccount().email, getClubName()),
      recipients: [...recipients],
      replyTo,
      replyToName,
      onProgress: (done, total) => {
        if (total > done) setStatus(`Sending… ${done} of ${total}.`, 'info');
      },
    });
  };

  renderSender();
  renderAccount();
  renderChips();
  syncPanel();

  return {
    get enabled() { return toggle.checked; },
    get recipients() { return [...recipients]; },
    get sender() { return sendingAddress(); },
    get replyTo() { return replyToAddress(); },
    /** re-read the roster after it loads or changes */
    refresh() { renderSender(); renderAccount(); renderChips(); },
    reset() {
      recipients = [];
      input.value = '';
      toggle.checked = false;
      syncPanel();
      renderChips();
      hideDropdown();
      setStatus('');
    },
    /** commit anything typed but never turned into a chip */
    flush() { if (input.value.trim()) addRecipient(input.value); },
    status: setStatus,
    send,
    destroy() { document.removeEventListener('click', onDocClick); },
  };
}
