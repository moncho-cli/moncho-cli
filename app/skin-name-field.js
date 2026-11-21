import { slugName } from '../utils/skins-store.js';

/**
 * The editable **name field** of the `/skins prompt` modal (`docs/interface/skins`).
 *
 * The model proposes a name, but the name is the user's to accept or change: a request
 * like "a warm sunset" can come back as anything, and the person who asked is the one
 * who knows what they want it called. The field is therefore *prefilled* with the
 * proposal and left editable.
 *
 * Pure and terminal-free: it holds a buffer and answers the row to paint, so the naming
 * rules are unit tested without a screen. The modal owns the keyboard and asks this
 * object what to do with each character.
 *
 * The name a skin is **saved under** is the slug of the buffer (`slugName`), because the
 * store writes `agent/skins/<slug>.json`. So the field answers three things:
 *
 *  - `value` — exactly what the user typed, for the row;
 *  - `slug` — what will actually be written, shown beside the buffer when they differ;
 *  - `error` — why the name cannot be used, or `''` when it can.
 *
 * `default` is refused: the store will not write over the built-in skin, so a name that
 * slugs to it would fail at save time. Refusing it here means the user finds out while
 * they can still fix it, not after they pressed Apply.
 */

/** The caret shown at the end of the buffer while the field has the focus. */
export const SKIN_NAME_CARET = '▏';

/** The built-in skin's name, which cannot be written to disk. */
export const SKIN_NAME_RESERVED = 'default';

/**
 * Why `value` cannot be a skin name, or `''` when it can.
 *
 * @param {string} value the raw buffer
 * @returns {string} the reason, or an empty string
 */
export function validateSkinName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'give the skin a name';
  const slug = slugName(raw);
  if (!slug) return 'that name has no usable characters';
  if (slug === SKIN_NAME_RESERVED) {
    return `"${SKIN_NAME_RESERVED}" is the built-in skin; pick another name`;
  }
  return '';
}

/**
 * Create one name field, prefilled with the proposal.
 *
 * @param {object} [options]
 * @param {string} [options.name] the proposed name the field starts with
 * @returns {object} the field: `value`, `slug`, `error`, `valid`, the mutators and the rows
 */
export function createSkinNameField({ name = '' } = {}) {
  let buffer = String(name ?? '');

  const field = {
    /** Exactly what the user typed. */
    get value() {
      return buffer;
    },
    /** What the skin will be written as. */
    get slug() {
      return slugName(buffer);
    },
    /** Why the buffer cannot be used, or `''`. */
    get error() {
      return validateSkinName(buffer);
    },
    /** True when the buffer names a skin that can be saved. */
    get valid() {
      return field.error === '';
    },

    /** Replace the whole buffer (a fresh proposal, or a reset). */
    setValue(next) {
      buffer = String(next ?? '');
      return field;
    },
    /** Append one character the user typed. */
    insert(text) {
      buffer += String(text ?? '');
      return field;
    },
    /** Drop the last character. */
    backspace() {
      buffer = buffer.slice(0, -1);
      return field;
    },
    /** Empty the buffer. */
    clear() {
      buffer = '';
      return field;
    },

    /**
     * The row to paint: the label, the buffer, the caret while focused, and the slug
     * beside it when the user typed something that will be folded.
     */
    row({ focused = false } = {}) {
      const caret = focused ? SKIN_NAME_CARET : '';
      const folded = field.slug && field.slug !== buffer ? `  → ${field.slug}` : '';
      return `name: ${buffer}${caret}${folded}`;
    },

    /** The reason row, or `''` when the name is usable. */
    errorRow() {
      const error = field.error;
      return error ? `⚠ ${error}` : '';
    },
  };

  return field;
}
