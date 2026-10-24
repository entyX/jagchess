/* ═══════════════════════════════════════════════════════════════════════
   registration-form.js — the shape of a club's registration form, and the
   one renderer that draws it.

   Four screens use this file now: the registration editor in club settings
   and the public form on the JagChess Network page, plus the attendance
   editor and the attendance modal. Keeping the schema, the renderer and the
   reader together is what stops those drifting — an answer is always read
   back the way the question was drawn.

   Three questions are built in and are not stored on the club: first name,
   last name, email. Registration always asks them, always first, and no
   admin can remove or reorder them. Attendance asks them too, but only of
   somebody who is not signed in — a member has already told the club all
   three, and asking again would be the longest part of a ten-second form.
   Either way they are not stored on the club, because storing them would
   mean a club could end up without them.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc } from './club-core.js';

/* ── the built-in questions ────────────────────────────────────────── */

export const CORE_QUESTIONS = [
  { id: 'firstName', type: 'short', label: 'What is your first name?', required: true, core: true, autocomplete: 'given-name', max: 60 },
  { id: 'lastName',  type: 'short', label: 'What is your last name?',  required: true, core: true, autocomplete: 'family-name', max: 60 },
  { id: 'email',     type: 'email', label: 'What is your email address?', required: true, core: true, autocomplete: 'email', max: 140 }
];

export const QUESTION_TYPES = {
  short:  { label: 'Short answer',    hint: 'A single line of text.' },
  long:   { label: 'Long answer',     hint: 'A paragraph box.' },
  choice: { label: 'Multiple choice', hint: 'Pick one of the options you write.' },
  slider: { label: 'Slider',          hint: 'A number between two ends, in fixed steps.' }
};

export const MAX_QUESTIONS = 20;
export const MAX_OPTIONS = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());

let seq = 0;
export const newQuestionId = () =>
  'q' + Date.now().toString(36) + (seq++).toString(36) + Math.floor(Math.random() * 46656).toString(36);

/* ── reading what is stored ────────────────────────────────────────── */

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** One stored question, cleaned up enough to render. */
export function normalizeQuestion(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const type = QUESTION_TYPES[q.type] ? q.type : 'short';
  const out = {
    id: String(q.id || newQuestionId()),
    type,
    label: String(q.label || q.text || '').slice(0, 200),
    help: String(q.help || '').slice(0, 200),
    required: q.required === true
  };
  if (type === 'choice') {
    out.options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => String(o == null ? '' : o).slice(0, 120))
      .filter((o) => o.trim())
      .slice(0, MAX_OPTIONS);
    if (!out.options.length) out.options = ['Option 1'];
  }
  if (type === 'slider') {
    out.min = num(q.min, 0);
    out.max = num(q.max, 10);
    out.step = Math.abs(num(q.step, 1)) || 1;
    if (out.max <= out.min) out.max = out.min + out.step;
  }
  return out;
}

/** The custom questions a club has added, in order. Never the built-ins. */
export function normalizeForm(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : []);
  return list.slice(0, MAX_QUESTIONS).map(normalizeQuestion);
}

/** Built-ins first, then whatever the club added — the order people see. */
export const allQuestions = (custom) => CORE_QUESTIONS.concat(normalizeForm(custom));

/* ── drawing the form ──────────────────────────────────────────────── */

function fieldBody(q, value) {
  const name = 'rq-' + q.id;
  const v = value == null ? '' : value;

  if (q.type === 'long') {
    return `<textarea class="rf-input" rows="4" name="${esc(name)}" data-q="${esc(q.id)}"
      maxlength="2000" placeholder="Your answer…">${esc(v)}</textarea>`;
  }

  if (q.type === 'choice') {
    return `<div class="rf-choices" data-q="${esc(q.id)}">${q.options.map((opt) => `
      <label class="rf-choice">
        <input type="radio" name="${esc(name)}" value="${esc(opt)}"${String(v) === opt ? ' checked' : ''} />
        <span class="rf-choice-dot"></span>
        <span class="rf-choice-text">${esc(opt)}</span>
      </label>`).join('')}</div>`;
  }

  if (q.type === 'slider') {
    const start = v === '' ? q.min : num(v, q.min);
    return `<div class="rf-slider" data-q="${esc(q.id)}">
      <div class="rf-slider-top">
        <input type="range" class="rf-range" min="${q.min}" max="${q.max}" step="${q.step}" value="${start}" />
        <output class="rf-range-out">${esc(String(start))}</output>
      </div>
      <div class="rf-range-ends"><span>${esc(String(q.min))}</span><span>${esc(String(q.max))}</span></div>
    </div>`;
  }

  const type = q.type === 'email' ? 'email' : 'text';
  return `<input class="rf-input" type="${type}" data-q="${esc(q.id)}" name="${esc(name)}"
    maxlength="${q.max || 400}"${q.autocomplete ? ` autocomplete="${esc(q.autocomplete)}"` : ''}
    value="${esc(v)}" placeholder="Your answer…" />`;
}

/**
 * An explicit list of questions, exactly as given — nothing prepended.
 *
 * This is the one attendance uses, because what it asks depends on who is
 * looking: a signed-in member gets the club's own questions and nothing
 * else. Registration goes through renderForm below, which is this with the
 * built-ins put back in front.
 *
 * @param {Array} questions  already normalized
 * @param {object} [opts]
 *   values — answers to pre-fill with
 */
export function renderQuestions(questions, opts = {}) {
  const values = opts.values || {};
  return questions.map((q, i) => `
    <div class="rf-field${q.core ? ' is-core' : ''}" data-field="${esc(q.id)}">
      <label class="rf-label">
        <span class="rf-num">${i + 1}</span>
        <span class="rf-label-text">${esc(q.label)}${q.required ? '<i class="rf-req" title="Required">*</i>' : ''}</span>
      </label>
      ${q.help ? `<p class="rf-help">${esc(q.help)}</p>` : ''}
      ${fieldBody(q, values[q.id])}
      <p class="rf-error" data-err="${esc(q.id)}" hidden></p>
    </div>`).join('');
}

/**
 * The whole registration form, built-ins included.
 * @param {Array} custom   the club's own questions
 * @param {object} [opts]
 *   values — answers to pre-fill with
 */
export function renderForm(custom, opts = {}) {
  return renderQuestions(allQuestions(custom), opts);
}

/* Live slider readouts, and clearing an error as soon as it is addressed.
   Call once after the form is in the document. */
export function wireForm(root) {
  root.querySelectorAll('.rf-slider').forEach((wrap) => {
    const range = wrap.querySelector('.rf-range');
    const out = wrap.querySelector('.rf-range-out');
    const paint = () => {
      out.textContent = range.value;
      const span = Number(range.max) - Number(range.min);
      const pct = span ? (Number(range.value) - Number(range.min)) / span : 0;
      wrap.style.setProperty('--rf-fill', (pct * 100).toFixed(2) + '%');
    };
    range.addEventListener('input', paint);
    paint();
  });

  root.querySelectorAll('[data-q]').forEach((f) => {
    f.addEventListener('input', () => {
      const err = root.querySelector('[data-err="' + CSS.escape(f.dataset.q) + '"]');
      if (err) err.hidden = true;
      const field = f.closest('.rf-field');
      if (field) field.classList.remove('bad');
    });
  });
}

/* ── reading it back ───────────────────────────────────────────────── */

/**
 * Reads an explicit list back, the counterpart to renderQuestions.
 * @returns {{ ok: boolean, values: object, firstBad: string|null }}
 *   `values` is keyed by question id; sliders come back as numbers.
 */
export function readQuestions(root, questions) {
  const values = {};
  let firstBad = null;

  const fail = (q, message) => {
    const err = root.querySelector('[data-err="' + CSS.escape(q.id) + '"]');
    if (err) { err.textContent = message; err.hidden = false; }
    const field = root.querySelector('[data-field="' + CSS.escape(q.id) + '"]');
    if (field) field.classList.add('bad');
    if (!firstBad) firstBad = q.id;
  };

  root.querySelectorAll('.rf-error').forEach((e) => (e.hidden = true));
  root.querySelectorAll('.rf-field').forEach((f) => f.classList.remove('bad'));

  for (const q of questions) {
    let value = '';

    if (q.type === 'choice') {
      const picked = root.querySelector('.rf-choices[data-q="' + CSS.escape(q.id) + '"] input:checked');
      value = picked ? picked.value : '';
    } else if (q.type === 'slider') {
      const range = root.querySelector('.rf-slider[data-q="' + CSS.escape(q.id) + '"] .rf-range');
      value = range ? Number(range.value) : q.min;
    } else {
      const input = root.querySelector('[data-q="' + CSS.escape(q.id) + '"]');
      value = input ? String(input.value || '').trim() : '';
    }

    // a slider always holds a value, so "required" cannot be failed by one
    if (q.required && q.type !== 'slider' && value === '') {
      fail(q, 'This one is required.');
      continue;
    }
    if (q.type === 'email' && value && !isEmail(value)) {
      fail(q, 'That does not look like an email address.');
      continue;
    }
    values[q.id] = value;
  }

  return { ok: !firstBad, values, firstBad };
}

/** The registration form read back: built-ins included. */
export const readForm = (root, custom) => readQuestions(root, allQuestions(custom));

/** How one answer reads on the admin's side of the screen. */
export const answerText = (q, value) => {
  if (value == null || value === '') return '—';
  if (q.type === 'slider') return String(value) + (q.max != null ? ' / ' + q.max : '');
  return String(value);
};
