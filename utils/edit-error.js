/**
 * The one error type every edit refusal is built from.
 *
 * It lives in its own module so `utils/edit_lib.js` (the engine) and
 * `utils/edit-miss.js` (the diagnostics) can both raise it without importing each other:
 * the diagnostics are a *helper* of the engine, and a cycle between them would be the
 * kind of coupling the split exists to avoid.
 *
 * Every refusal carries a stable `code` plus a `details` object that becomes part of the
 * JSON response, so a caller reads the same fields whether it hit `SEARCH_NOT_FOUND` or
 * `SEARCH_NOT_UNIQUE`. `toJSON()` is what the response shape is built from.
 */
export class EditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EditError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { status: 'error', code: this.code, message: this.message, ...this.details };
  }
}
