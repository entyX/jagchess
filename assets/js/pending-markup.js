/* ═══════════════════════════════════════════════════════════════════════
   pending-markup.js — the pending list written out as text, and read back.

   One line is one person:

     someone@school.org␣␣First Last

   the address, two spaces, then the name. Only the address is required —
   everything after it is a convenience, because a hundred addresses pasted
   out of a spreadsheet is the normal way this list arrives.

   It is an editor, not an importer: what is saved becomes the pending list
   exactly, so a line taken out takes that person out. The sync itself lives
   in club-registration.js, next to the collection it writes. Everything in
   here is pure — text in, the same answer out, no database and no DOM —
   which is why it is its own file. It is the half that can be tested.
   ═══════════════════════════════════════════════════════════════════════ */

/* Its own, rather than club-core's: importing that would drag Firebase in
   behind it and this file would stop being loadable on its own. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

export const emailKey = (s) => String(s || '').trim().toLowerCase();

/** The pending list as text — what the editor opens on. */
export const markupFromApplicants = (rows) => (rows || []).map((a) => {
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ').trim();
  return name ? `${a.email}  ${name}` : String(a.email || '');
}).join('\n');

/** One line, taken apart. */
export function parseMarkupLine(raw, no) {
  const text = String(raw == null ? '' : raw).replace(/\r$/, '');
  const line = { no: (no || 0) + 1, raw: text, blank: !text.trim() };
  if (line.blank) return line;

  const m = /^([^\S\n]*)(\S+)([^\S\n]*)([\s\S]*)$/.exec(text);
  line.lead = m[1];
  line.email = m[2];
  line.sep = m[3];
  line.rest = m[4];

  line.emailOk = EMAIL_RE.test(line.email);
  line.key = emailKey(line.email);

  const words = line.rest.trim().split(/\s+/).filter(Boolean);
  line.first = words[0] || '';
  line.last = words.slice(1).join(' ');

  /* Kept apart from whether the address works: a name written with one space
     instead of two is still somebody we can write to. It is worth pointing
     at and it is not worth refusing, so it colours the line and never stops
     the save.

     What it does not judge is how many words a name is made of. Somebody
     with one name, or three, has typed no mistake — the only thing this
     file knows about the shape of a name is the whitespace around it. */
  line.formatOk = !line.lead && (words.length
    ? line.sep === '  ' && line.rest === words.join(' ')
    : line.sep === '');
  return line;
}

/**
 * The whole textarea.
 * @param {string} text
 * @param {Set<string>|string[]} memberKeys addresses already in the club
 */
export function parseMarkup(text, memberKeys) {
  const members = memberKeys instanceof Set
    ? memberKeys
    : new Set((memberKeys || []).map(emailKey).filter(Boolean));

  const lines = String(text == null ? '' : text).split('\n').map(parseMarkupLine);
  const live = lines.filter((l) => !l.blank);

  const seen = new Map();
  live.forEach((l) => { if (l.emailOk) seen.set(l.key, (seen.get(l.key) || 0) + 1); });

  live.forEach((l) => {
    l.dup = !!l.emailOk && seen.get(l.key) > 1;
    l.member = !!l.emailOk && members.has(l.key);
    l.tone = !l.emailOk ? 'bad'
      : l.dup && l.member ? 'both'
      : l.dup ? 'dup'
      : l.member ? 'mem'
      : '';
  });

  /* Somebody already in the club is not pending and never will be, so they
     come off the markup on the way out rather than being written back as a
     place nobody would ever see. */
  const people = [];
  const taken = new Set();
  live.forEach((l) => {
    if (!l.emailOk || l.member || taken.has(l.key)) return;
    taken.add(l.key);
    people.push({ email: l.key, firstName: l.first, lastName: l.last });
  });

  return {
    lines,
    people,
    bad: live.filter((l) => !l.emailOk).length,
    dupes: [...seen.values()].filter((n) => n > 1).length,
    members: live.filter((l) => l.member).length,
    sloppy: live.filter((l) => l.emailOk && !l.formatOk).length
  };
}

/** The painted layer that sits under the caret. */
export function markupHTML(parsed) {
  return parsed.lines.map((l) => {
    if (l.blank) return esc(l.raw);
    const lead = l.lead ? `<span class="mk-off">${esc(l.lead)}</span>` : '';
    const mail = `<span class="mk-mail${l.tone ? ' ' + l.tone : ''}">${esc(l.email)}</span>`;
    const tail = l.sep + l.rest;
    const rest = tail ? `<span class="mk-name${l.formatOk ? '' : ' mk-off'}">${esc(tail)}</span>` : '';
    return lead + mail + rest;
  }).join('\n') + '\n';
}
