/**
 * The actions of the `/skins prompt` modal, and the key that decides each one
 * (`docs/interface/skins`).
 *
 * The rule this module exists to enforce: **an apply action cannot be chosen until the
 * skin is ready.** Not by refusing the keypress — by the action not being on the list at
 * all. While the model is still thinking there is nothing to apply, so the only action
 * offered is Cancel; `availableActions()` returns exactly that. A refusal that is
 * structural cannot be bypassed by a keystroke the modal did not anticipate, and it cannot
 * be reached by a stale paint.
 *
 * Pure and terminal-free: the list, the gating and the key decision are all values, so the
 * keyboard is unit tested without a screen. The modal owns the widget and the field; this
 * module owns *what a key means*.
 */

/** The actions the modal offers, in cursor order. `needs` is the gate. */
export const SKIN_ACTIONS = Object.freeze([
  { id: 'apply', label: 'Apply for this session', needs: 'ready' },
  { id: 'save', label: 'Apply and save to agent/skins/', needs: 'ready' },
  { id: 'cancel', label: 'Cancel', needs: 'always' },
]);

/**
 * The actions `/skins customize` offers.
 *
 * Customizing updates the skin already in force, so there is no new name to settle and no
 * second destination to choose: the update is written over the active skin's own file.
 * Offering "apply for this session" beside "apply and save" would ask a question the
 * command has already answered — the file exists, it is the one being edited.
 */
export const CUSTOMIZE_ACTIONS = Object.freeze([
  { id: 'apply', label: 'Update the active skin', needs: 'ready' },
  { id: 'cancel', label: 'Cancel', needs: 'always' },
]);

/**
 * The actions offered in the current state.
 *
 * @param {object} [options]
 * @param {boolean} [options.ready] true once a proposal arrived and its name is usable
 * @param {boolean} [options.customize] true to offer the update-only list
 * @returns {ReadonlyArray<object>} the actions that may be chosen now
 */
export function availableActions({ ready = false, customize = false } = {}) {
  const list = customize ? CUSTOMIZE_ACTIONS : SKIN_ACTIONS;
  return list.filter((action) => action.needs === 'always' || ready);
}

/** The action at `index`, falling back to the last one offered. */
export function actionAt(actions, index) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return null;
  const position = Number.isInteger(index) ? index : 0;
  return list[Math.min(Math.max(position, 0), list.length - 1)] ?? null;
}

/** Wrap the cursor over a list of `length` actions. */
export function moveIndex(index, delta, length) {
  if (!length) return 0;
  const from = Number.isInteger(index) ? index : 0;
  return ((from + (Number(delta) || 0)) % length + length) % length;
}

/**
 * Clamp a cursor to the actions actually offered right now.
 *
 * The list shrinks under the cursor: emptying the name field takes the two apply
 * actions off it (`availableActions`), so a cursor left on Cancel pointed past the end
 * of a one-row list — no row was painted as selected and the next arrow jumped. Every
 * paint settles the cursor through here, so the highlight can never go missing.
 */
export function clampIndex(index, length) {
  const size = Number.isInteger(length) && length > 0 ? length : 0;
  if (!size) return 0;
  const from = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(from, 0), size - 1);
}

/**
 * What one keypress means in the modal.
 *
 * The answer is an intent the modal acts on — the modal never inspects the key itself,
 * so the whole keyboard contract is one pure function:
 *
 * | intent | meaning |
 * | --- | --- |
 * | `cancel` | Escape / Ctrl+C: close with no choice |
 * | `toggle` | Tab: move between the name field and the actions |
 * | `focus` | Enter in the name field: go to the actions |
 * | `edit` | a printable character in the name field |
 * | `backspace` | delete the last character of the name |
 * | `move` | up/down/j/k in the action list |
 * | `choose` | Enter in the action list |
 * | `none` | anything else |
 *
 * `ready` is the gate, and it is a parameter rather than something read off the focus.
 * Until the proposal arrives there is no name to edit and nothing to apply, so the name
 * field does not exist yet: the focus stays on the actions (where Cancel is the only
 * entry), Tab does nothing, and Enter chooses Cancel. Deriving readiness from the focus
 * instead would let a stale focus keep the field alive after the proposal failed, and it
 * would leave Enter with no meaning while the call is in flight.
 *
 * `editable` says whether the name field exists at all. `/skins customize` updates a skin
 * that already has its name, so its confirmation box has no name to choose and switches
 * the field off; Tab then has nowhere to go and Enter applies. The keyboard contract is
 * the same one either way — only the reachable focus differs.
 *
 * @param {object} options
 * @param {object} [options.key] the blessed key object (`{ name, full, ctrl, shift }`)
 * @param {string} [options.focus] `'name'` or `'actions'`
 * @param {boolean} [options.ready] true once a proposal arrived
 * @param {boolean} [options.editable] false when the modal has no name field
 * @returns {{type: string, [key: string]: any}} the intent
 */
export function decideKey({
  key = {}, focus = 'actions', ready = false, editable = true,
} = {}) {
  const name = String(key?.name ?? key?.full ?? '');
  const full = String(key?.full ?? '');

  if (name === 'escape' || full === 'C-c' || (key?.ctrl && name === 'c')) return { type: 'cancel' };

  // Not ready, or no name field: the actions are the only focus. Enter there chooses the
  // highlighted action — Cancel while the proposal is still coming, since it is the only
  // one on the list.
  if (!ready || !editable) {
    if (name === 'up' || name === 'k') return { type: 'move', delta: -1 };
    if (name === 'down' || name === 'j') return { type: 'move', delta: 1 };
    if (name === 'enter' || name === 'return') return { type: 'choose' };
    return { type: 'none' };
  }

  if (name === 'tab') return { type: 'toggle' };

  if (focus === 'name') {
    if (name === 'enter' || name === 'return') return { type: 'focus', to: 'actions' };
    if (name === 'backspace') return { type: 'backspace' };
    // The **arrow keys** move the action cursor from the name field too, without a Tab
    // first: the modal puts the focus in the field the moment the proposal lands, so a
    // reader who reaches for the arrows found them dead. `j`/`k` are deliberately *not*
    // treated as movement here — in a text field they are letters a name may contain.
    if (name === 'up') return { type: 'move', delta: -1 };
    if (name === 'down') return { type: 'move', delta: 1 };
    if (name === 'space') return { type: 'edit', text: ' ' };
    // A single printable character, and nothing a modifier turned into a command.
    if (full.length === 1 && !key?.ctrl && !key?.meta) return { type: 'edit', text: full };
    return { type: 'none' };
  }

  if (name === 'up' || name === 'k') return { type: 'move', delta: -1 };
  if (name === 'down' || name === 'j') return { type: 'move', delta: 1 };
  // Enter always chooses the highlighted action. While the proposal is still coming that
  // action is Cancel, because it is the only one on the list.
  if (name === 'enter' || name === 'return') return { type: 'choose' };
  return { type: 'none' };
}
