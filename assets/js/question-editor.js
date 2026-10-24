/* ═══════════════════════════════════════════════════════════════════════
   question-editor.js — the stack of question cards an admin builds a form
   out of.

   It started life inside the registration editor and was lifted out when
   attendance needed the same thing. That is the whole point of it being a
   file: an admin who has built one form already knows how to build the
   other, down to the move-up arrow and the confirm before a delete. Two
   copies of this would have drifted within a month.

   What the editor owns: the list of questions, the cards, and the dirty
   flag. What the caller owns: where the list came from, the built-in rows
   above it, and what Save does. The caller reads the list back with
   `read()` — never off the DOM.
   ═══════════════════════════════════════════════════════════════════════ */

import { esc, confirmDialog } from './club-core.js';
import {
  QUESTION_TYPES, MAX_QUESTIONS, MAX_OPTIONS, normalizeQuestion, newQuestionId
} from './registration-form.js';

const TOOL_SVG = {
  up: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
  down: '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',
  del: '<path d="M6 6l12 12M18 6 6 18"/>'
};
const tool = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${TOOL_SVG[name]}</svg>`;

export const sliderHint = (q) => {
  const steps = Math.round((q.max - q.min) / q.step) + 1;
  return `${q.min} to ${q.max} in steps of ${q.step} — ${steps} position${steps === 1 ? '' : 's'}.`;
};

/**
 * @param {HTMLElement} list     the container the cards are drawn into
 * @param {object} opts
 *   questions   — the starting list (normalized here, so raw is fine)
 *   coreHTML    — markup for the built-in rows above the editable ones, if any
 *   coreCount   — how many of those there are, so numbering continues
 *   emptyHTML   — what to say when the club has added nothing yet
 *   max         — question ceiling (defaults to the registration one)
 *   onDirty     — called whenever anything at all changes
 *   onCount     — called after every repaint with the current length, so the
 *                 caller can disable its own "Add a question" button
 * @returns {{ read: Function, paint: Function, add: Function, count: Function }}
 */
export function mountQuestionEditor(list, opts = {}) {
  const max = opts.max || MAX_QUESTIONS;
  const coreCount = opts.coreCount || 0;
  const onDirty = opts.onDirty || (() => {});
  const onCount = opts.onCount || (() => {});
  let questions = (opts.questions || []).map(normalizeQuestion);

  const questionHTML = (q, i) => `
    <div class="reg-q" data-q="${esc(q.id)}">
      <div class="reg-q-top">
        <span class="reg-q-num">${coreCount + i + 1}</span>
        <input class="reg-q-label" data-label type="text" maxlength="200"
               value="${esc(q.label)}" placeholder="Ask something…" />
        <div class="reg-q-tools">
          <button class="reg-tool" data-up type="button" title="Move up"${i === 0 ? ' disabled' : ''}>${tool('up')}</button>
          <button class="reg-tool" data-down type="button" title="Move down"${i === questions.length - 1 ? ' disabled' : ''}>${tool('down')}</button>
          <button class="reg-tool danger" data-del type="button" title="Delete question">${tool('del')}</button>
        </div>
      </div>

      <div class="reg-q-body">
        <div class="reg-q-field">
          <label>Answer type</label>
          <select data-type>
            ${Object.entries(QUESTION_TYPES).map(([k, m]) =>
              `<option value="${k}"${q.type === k ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>

        <div class="reg-q-field">
          <label>Required</label>
          <label class="reg-switch">
            <input type="checkbox" data-req${q.required ? ' checked' : ''} />
            <span class="reg-switch-track"><span class="reg-switch-thumb"></span></span>
            <span class="reg-switch-text">${q.required ? 'Must be answered' : 'Optional'}</span>
          </label>
        </div>

        ${q.type === 'choice' ? `
        <div class="reg-q-field wide">
          <label>Options</label>
          <div class="reg-opts" data-opts>
            ${q.options.map((o, oi) => `
              <div class="reg-opt">
                <span class="reg-opt-dot"></span>
                <input type="text" data-opt maxlength="120" value="${esc(o)}" placeholder="Option ${oi + 1}" />
                <button class="reg-tool" data-rmopt type="button" title="Remove option"${q.options.length < 2 ? ' disabled' : ''}>${tool('del')}</button>
              </div>`).join('')}
          </div>
          <button class="btn subtle sm reg-addopt" data-addopt type="button"${q.options.length >= MAX_OPTIONS ? ' disabled' : ''}>Add option</button>
        </div>` : ''}

        ${q.type === 'slider' ? `
        <div class="reg-q-field wide">
          <label>Range</label>
          <div class="reg-range-fields">
            <div><span>From</span><input type="number" data-min value="${q.min}" /></div>
            <div><span>To</span><input type="number" data-max value="${q.max}" /></div>
            <div><span>Step</span><input type="number" data-step min="0.001" step="any" value="${q.step}" /></div>
          </div>
          <p class="field-hint">${esc(sliderHint(q))}</p>
        </div>` : ''}

        <div class="reg-q-field wide">
          <label>Helper text <span class="opt">optional</span></label>
          <input type="text" data-help maxlength="200" value="${esc(q.help || '')}"
                 placeholder="A note under the question…" />
        </div>
      </div>
    </div>`;

  /* ── reading the cards back into the model ── */

  function syncFromDom() {
    list.querySelectorAll('.reg-q[data-q]').forEach((card) => {
      const q = questions.find((x) => x.id === card.dataset.q);
      if (!q) return;
      q.label = card.querySelector('[data-label]').value;
      q.help = card.querySelector('[data-help]').value;
      q.required = card.querySelector('[data-req]').checked;
      q.type = card.querySelector('[data-type]').value;
      const options = [...card.querySelectorAll('[data-opt]')].map((i) => i.value);
      if (options.length) q.options = options;
      const min = card.querySelector('[data-min]');
      if (min) {
        q.min = Number(min.value);
        q.max = Number(card.querySelector('[data-max]').value);
        q.step = Number(card.querySelector('[data-step]').value);
      }
    });
  }

  /* Structure changed: read the cards, normalize, redraw. Anything the user
     typed is kept, because syncFromDom runs first. */
  const restructure = (mutate) => {
    syncFromDom();
    mutate();
    questions = questions.map(normalizeQuestion);
    onDirty();
    paint();
  };

  function paint() {
    list.innerHTML = (opts.coreHTML || '') + questions.map(questionHTML).join('') +
      (questions.length ? '' : (opts.emptyHTML || ''));
    wire();
    onCount(questions.length);
  }

  function wire() {
    list.querySelectorAll('.reg-q[data-q]').forEach((card) => {
      const id = card.dataset.q;
      const at = () => questions.findIndex((x) => x.id === id);

      card.querySelectorAll('input, select').forEach((f) => {
        f.addEventListener('input', () => onDirty());
      });

      card.querySelector('[data-req]').addEventListener('change', (e) => {
        card.querySelector('.reg-switch-text').textContent =
          e.target.checked ? 'Must be answered' : 'Optional';
        onDirty();
      });

      // a type change swaps which extra fields belong on the card
      card.querySelector('[data-type]').addEventListener('change', (e) => {
        const next = e.target.value;
        restructure(() => {
          const q = questions[at()];
          q.type = next;
          if (next === 'choice' && !(q.options || []).length) q.options = ['Option 1', 'Option 2'];
          if (next === 'slider' && q.min == null) { q.min = 0; q.max = 10; q.step = 1; }
        });
      });

      card.querySelector('[data-up]').onclick = () => restructure(() => {
        const i = at();
        if (i > 0) questions.splice(i - 1, 0, questions.splice(i, 1)[0]);
      });
      card.querySelector('[data-down]').onclick = () => restructure(() => {
        const i = at();
        if (i < questions.length - 1) questions.splice(i + 1, 0, questions.splice(i, 1)[0]);
      });

      card.querySelector('[data-del]').onclick = async () => {
        const q = questions[at()];
        const ok = await confirmDialog({
          title: 'Delete this question?',
          body: `"${q.label || 'Untitled question'}" stops being asked. Answers already sent in keep
                 the question they were given, so nothing you have collected is lost.`,
          confirmText: 'Delete question',
          danger: true
        });
        if (!ok) return;
        restructure(() => questions.splice(at(), 1));
      };

      const addOpt = card.querySelector('[data-addopt]');
      if (addOpt) addOpt.onclick = () => restructure(() => {
        const q = questions[at()];
        q.options = (q.options || []).concat('Option ' + ((q.options || []).length + 1));
      });

      card.querySelectorAll('[data-rmopt]').forEach((b, oi) => (b.onclick = () => restructure(() => {
        const q = questions[at()];
        if ((q.options || []).length > 1) q.options.splice(oi, 1);
      })));

      const min = card.querySelector('[data-min]');
      if (min) {
        [min, card.querySelector('[data-max]'), card.querySelector('[data-step]')]
          .forEach((f) => f.addEventListener('change', () => restructure(() => {})));
      }
    });
  }

  paint();

  return {
    /** The list as the cards currently read. Always call this before saving. */
    read() {
      syncFromDom();
      questions = questions.map(normalizeQuestion);
      return questions;
    },
    paint,
    count: () => questions.length,
    atMax: () => questions.length >= max,
    add() {
      if (questions.length >= max) return;
      restructure(() => questions.push(normalizeQuestion({
        id: newQuestionId(), type: 'short', label: '', required: false
      })));
    },
    /** Replace the whole list — used when the editor switches to another event. */
    set(next) {
      questions = (next || []).map(normalizeQuestion);
      paint();
    }
  };
}
