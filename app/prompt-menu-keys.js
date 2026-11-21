/**
 * The keys the slash-command popup owns while it is open, and what each one does
 * there.
 *
 * It lives on its own because it is a **third owner** of the same physical keys the
 * caret editor and the history already answer: up/down read the history when no menu is
 * up and move the menu's cursor when one is, Enter submits the line or takes the
 * highlighted command, and Tab — which `app/tui-keys.js` claims before blessed dispatches
 * it — completes the name into the box unless the menu wants it first. Keeping that
 * arbitration in `app/prompt-keys.js` mixed two unrelated questions (where does the
 * caret go, whose key is this) in one file and pushed it past the project's line budget.
 *
 * Pure arbitration: no widget, no editor, no screen. The caller passes the menu and the
 * two things a claim needs to do something — write the box (`complete`) and submit the
 * line (`accept`) — and gets back "was this key mine?".
 */

/**
 * Handle one key against an open menu.
 *
 * @param {object} options
 * @param {object|null} options.menu the popup state (app/slash-menu.js)
 * @param {string} [options.name] the key's blessed name (`up`, `enter`, …)
 * @param {Function} [options.refresh] repaint hook, called after a move
 * @param {Function} [options.complete] writes a completed name into the box; returns true
 *   when it took the key (see `createPromptMenuKeys().complete`)
 * @param {Function} [options.accept] submits the accepted command text
 * @returns {boolean} true when the menu consumed the key, so nothing else should
 */
export function claimMenuKey({ menu = null, name = '', refresh = () => {}, accept = null } = {}) {
  if (!menu || typeof menu.isOpen !== 'boolean' || !menu.isOpen) return false;

  if (name === 'up') {
    menu.move(-1);
    refresh();
    return true;
  }
  if (name === 'down') {
    menu.move(1);
    refresh();
    return true;
  }
  if (name === 'enter' || name === 'return') {
    const accepted = menu.acceptText();
    if (!accepted) return false;
    // The box is deliberately left alone: the submission is what empties it, exactly as
    // Enter on the line does. Writing `/name` here first would be a valid query and the
    // popup would spring back open over the command being run.
    menu.hide();
    refresh();
    if (typeof accept === 'function') accept(accepted);
    return true;
  }

  return false;
}

/**
 * Tab, from the pre-dispatch gate: complete the highlighted command's name into the box
 * and leave the caret after the space it adds, so arguments can be typed next.
 *
 * Returns true when the popup took the key — which is what tells `app/tui-keys.js` not to
 * walk the mode ring on the same press. False for a closed menu, so Tab keeps meaning what
 * it meant: a mode switch.
 *
 * @param {object} options
 * @param {object|null} options.menu the popup state
 * @param {Function} options.write writes the completed text into the box
 * @returns {boolean} whether the key was consumed
 */
export function completeMenuKey({ menu = null, write = null } = {}) {
  if (!menu || typeof menu.isOpen !== 'boolean' || !menu.isOpen) return false;
  const text = typeof menu.completeText === 'function' ? menu.completeText() : '';
  if (!text) return false;
  // The space it adds is already past the name, which `slashQuery()` refuses, so the
  // popup cannot spring back over the command it just finished.
  menu.hide();
  if (typeof write === 'function') write(text);
  return true;
}