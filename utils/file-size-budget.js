import { FILE_LINE_LIMIT_DEFAULT } from '../config/constants.js';

/**
 * The file size budget: how many lines a file may hold before it must be split.
 *
 * The backlog asked for this to be **configurable**: the project chose a hard limit of
 * 300 lines, and that number went on being the rule long after 300 stopped fitting the
 * size of the code. A limit that is right for one moment of a project's life and wrong
 * for the next is not a rule but a habit — so the number lives in the environment and
 * the code reads it from there.
 *
 * The rule itself is **prose in the agent prompt** (`config/prompt.md` §3.1): the model
 * is the one who writes the files, so the model is the one who has to know the budget.
 * That makes the prompt the place where the configured number must land, and it makes
 * a drift possible — a prompt that still says 300 while the configuration says 600
 * would leave the model following a rule nobody set.
 *
 * So the prompt carries **placeholders**, and this module renders the configured
 * values into it:
 *
 *  - `{{FILE_LINE_LIMIT}}` stands for the budget, `{{FILE_LINE_CEILING}}` for the
 *    ceiling above it;
 *  - the rendered prompt is what the provider receives, so the model always reads the
 *    numbers that are actually in force;
 *  - a prompt with **no** placeholder is rendered unchanged — a rule may need no
 *    number at all;
 *  - every occurrence is replaced, so the prompt may name the budget as often as it
 *    needs to.
 *
 * The prompt file stays the **one** place the rule is written: this module renders
 * numbers into it and never restates the prose, so the wording cannot drift from the
 * numbers.
 *
 * The module is pure: it reads the configuration and the prompt text and answers the
 * prompt text with the numbers in it. It touches no filesystem and no network, so
 * every rule above is provable on its own.
 */

/** The placeholder the prompt carries where the configured budget belongs. */
export const FILE_LINE_LIMIT_PLACEHOLDER = '{{FILE_LINE_LIMIT}}';

/** The placeholder the prompt carries where the ceiling above the budget belongs. */
export const FILE_LINE_CEILING_PLACEHOLDER = '{{FILE_LINE_CEILING}}';

/** Every placeholder this module renders, and the value each one takes. */
export const FILE_LINE_PLACEHOLDERS = Object.freeze([
  FILE_LINE_LIMIT_PLACEHOLDER,
  FILE_LINE_CEILING_PLACEHOLDER,
]);

/**
 * A usable file size budget: a positive integer, else `fallback`, else the default.
 *
 * The same forgiving shape as every other knob in the project (`utils/task-pulse.js`
 * does it for the pulse limit): a broken environment variable must never be able to
 * disable the rule or invert it.
 *
 * @param {unknown} value the configured value
 * @param {number} [fallback] what to use when the value cannot be used
 * @returns {number} a positive integer
 */
export function normalizeFileLineLimit(value, fallback = FILE_LINE_LIMIT_DEFAULT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const spare = Number.parseInt(String(fallback ?? ''), 10);
  return Number.isFinite(spare) && spare > 0 ? spare : FILE_LINE_LIMIT_DEFAULT;
}

/**
 * The ceiling: the hard limit a file may not pass.
 *
 * The budget and the ceiling are two numbers, not one, because "split when you get
 * close" and "this is the point where it is refused" are different instructions. The
 * ceiling is the budget plus a half again, which is where a file that was already
 * over the budget when the task started has room to be extracted.
 *
 * @param {unknown} value the configured budget
 * @returns {number} the ceiling, in lines
 */
export function fileLineCeiling(value) {
  const limit = normalizeFileLineLimit(value);
  return Math.round(limit * 1.5);
}

/**
 * The numbers a prompt's placeholders stand for, given a configured budget.
 *
 * @param {unknown} [value] the configured budget
 * @returns {{limit: number, ceiling: number}}
 */
export function fileLineNumbers(value) {
  const limit = normalizeFileLineLimit(value);
  return { limit, ceiling: fileLineCeiling(limit) };
}

/**
 * Render the configured limits into the prompt.
 *
 * Every occurrence of every placeholder is replaced. A prompt with no placeholder is
 * returned unchanged — byte for byte — so the rule stays exactly as it was written.
 *
 * @param {string} prompt the prompt text as it was read
 * @param {object} [options]
 * @param {number} [options.limit] the configured budget
 * @returns {string} the prompt with the configured numbers in it
 */
export function renderFileLineLimit(prompt, { limit = FILE_LINE_LIMIT_DEFAULT } = {}) {
  const text = String(prompt ?? '');
  if (!FILE_LINE_PLACEHOLDERS.some((placeholder) => text.includes(placeholder))) return text;
  const { limit: budget, ceiling } = fileLineNumbers(limit);
  return text
    .split(FILE_LINE_LIMIT_PLACEHOLDER).join(String(budget))
    .split(FILE_LINE_CEILING_PLACEHOLDER).join(String(ceiling));
}

/**
 * The placeholders a prompt still carries, after rendering.
 *
 * A placeholder that survived the rendering is a **failure**: the model would read a
 * literal `{{FILE_LINE_LIMIT}}` and learn nothing. The names are reported so the
 * caller can say which one.
 *
 * @param {string} prompt the rendered prompt
 * @returns {string[]} the placeholders that are still in it
 */
export function unresolvedPlaceholders(prompt) {
  const text = String(prompt ?? '');
  return FILE_LINE_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder));
}
