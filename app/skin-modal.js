import blessed from 'neo-blessed';
import { activeTokens } from './theme.js';
import { fgTag } from './paint-tags.js';
import { SKIN_ACTIONS, availableActions, actionAt, moveIndex, decideKey } from './skin-actions.js';
import { createSkinNameField } from './skin-name-field.js';

// The body text lives in its own module (`app/skin-preview.js`) so the wording is
// available without a terminal; these are re-exported because the modal is where callers
// and tests reach for them.
export {
  formatSkinPreview, formatSkinWaiting, formatSkinBody, formatSkinHint,
} from './skin-preview.js';
import { formatSkinBody, formatSkinHint } from './skin-preview.js';

// The action list and the key contract moved to `app/skin-actions.js`; re-exported so the
// modal stays the one place a caller imports the widget from.
export { SKIN_ACTIONS, availableActions } from './skin-actions.js';

/**
 * The `/skins prompt` **subchat modal** (`docs/interface/skins`): the one place a
 * natural-language request becomes a skin.
 *
 * Four decisions:
 *
 *  - **the model call is injected.** `proposer` answers the request; the modal only
 *    sequences it and paints the answer. The whole widget is testable with a stub.
 *  - **the modal owns the keyboard** while it is open: the screen's dispatch is locked and
 *    a program-level listener is prepended, so neither the input box nor the transcript
 *    sees the keystrokes (`app/tui-modal.js` does the same).
 *  - **the name is the user's.** The proposal arrives with a name, and the field is
 *    prefilled with it — but the user may change it, because the person who asked knows
 *    what the look should be called. The field takes the focus the moment the proposal
 *    lands, so the name is read before anything is applied.
 *  - **an apply action cannot be chosen until the skin is ready.** The gate is structural:
 *    while the proposal is in flight the only action on the list is Cancel
 *    (`app/skin-actions.js#availableActions`). A refusal a keystroke could bypass would be
 *    a refusal that fails on the one path nobody tested.
 *
 * It resolves with `{ skin, save }` — the skin carrying the **edited name** — or `null`.
 * The screen-bound surface the command calls lives in `app/skin-subchat.js`.
 *
 * **Two modes, one widget.** `/skins prompt` proposes a *new* look, so the name is the
 * user's to choose and the box offers both apply choices. `/skins customize` updates the
 * skin already in force, so the name is settled: `editable: false` drops the name field
 * and `customize: true` swaps the action list for the update-only one. Everything else —
 * the waiting state, the keyboard lock, the structural gate — is the same code.
 */

/** How often the waiting state repaints. */
export const SKIN_SPINNER_INTERVAL_MS = 120;

const FOCUS_NAME = 'name';
const FOCUS_ACTIONS = 'actions';

/**
 * Open the subchat modal for one request.
 *
 * @param {object} options
 * @param {object} [options.screen] the blessed screen (null for a headless run)
 * @param {Function} [options.proposer] `(request, { base }) => Promise<skin|null>`
 * @param {string} [options.request] the request being answered
 * @param {object} [options.base] the skin the proposal is built on
 * @param {string} [options.title] the box label
 * @param {Function} [options.refresh] repaint hook
 * @param {Function} [options.onOpenChange] told true when open, false when closed
 * @param {number} [options.pageSize] rows per page of the action list
 * @param {number} [options.interval] the waiting repaint interval
 * @param {Function} [options.now] the clock
 * @param {boolean} [options.editable] false when the name is settled (customize)
 * @param {boolean} [options.customize] true to offer the update-only action list
 * @returns {Promise<{skin: object, save: boolean}|null>} the choice, or null on cancel
 */
export function openSkinModal({
  screen = null,
  proposer = null,
  request = '',
  base = null,
  title = 'Skin',
  refresh = null,
  onOpenChange = null,
  pageSize = 6,
  interval = SKIN_SPINNER_INTERVAL_MS,
  now = () => Date.now(),
  editable = true,
  customize = false,
} = {}) {
  const repaint = typeof refresh === 'function' ? refresh : () => screen?.render();
  const startedAt = now();
  let frame = 0;
  let state = { request, state: 'waiting', skin: null, error: '' };
  // The focus starts on the actions, not the name field: while the proposal is in flight
  // there is no name to edit and nothing to apply, so the only reachable action is Cancel.
  // The field appears — and takes the focus — the moment the proposal lands.
  let focus = FOCUS_ACTIONS;
  let index = 0;
  // The field is created empty and filled when the proposal lands, so the caret is never
  // shown over a name the user has not been offered yet.
  const field = createSkinNameField({ name: '' });

  /** The actions the current state allows. An uneditable box has no name to validate. */
  const actions = () => availableActions({
    ready: state.state === 'ready' && Boolean(state.skin) && (!editable || field.valid),
    customize,
  });
  const currentAction = () => actionAt(actions(), index);

  return new Promise((resolve) => {
    const widget = screen
      ? blessed.box({
        parent: screen,
        label: ` ${title} `,
        top: 'center',
        left: 'center',
        width: '80%',
        height: '60%',
        border: { type: 'line' },
        tags: true,
        padding: { left: 1, right: 1 },
        // The border is a live token (`docs/interface/skins`), so a skin repaints it.
        style: { border: { fg: activeTokens().border } },
      })
      : null;

    const previousLock = screen?.lockKeys;
    let done = false;
    let spinnerTimer = null;

    const tick = () => {
      frame += 1;
      if (!widget) return;
      paint();
    };

    /** The action rows, with the cursor on the highlighted one. */
    const actionRows = () => {
      const list = actions();
      const cursor = activeTokens().border;
      return list.map((action, position) => {
        const marker = position === index ? '>' : ' ';
        const text = `${marker} ${action.label}`;
        return position === index ? text.replace(/^>/, fgTag(cursor, '>')) : text;
      });
    };

    const paint = () => {
      if (!widget) return;
      const ready = state.state === 'ready' && Boolean(state.skin);
      const body = formatSkinBody({
        ...state,
        width: roomFor(),
        frame,
        elapsedMs: now() - startedAt,
        nameRow: ready && editable ? field.row({ focused: focus === FOCUS_NAME }) : '',
        nameError: ready && editable ? field.errorRow() : '',
        hint: formatSkinHint({
          state: state.state, nameError: ready && editable ? field.error : '', focus, editable,
        }),
      });
      widget.setContent([...body, '', ...actionRows()].join('\n'));
      repaint();
    };

    const roomFor = () => {
      const width = Number(widget?.width) || 0;
      return width > 4 ? width - 4 : 0;
    };

    const close = (value) => {
      if (done) return;
      done = true;
      stopWaiting();
      if (screen) {
        screen.program?.removeListener('keypress', onKey);
        screen.lockKeys = previousLock;
      }
      widget?.destroy();
      if (typeof onOpenChange === 'function') onOpenChange(false);
      repaint();
      resolve(value);
    };

    /** The choice the highlighted action makes, or null when it cannot be made. */
    const choice = () => {
      const action = currentAction();
      if (!action || action.id === 'cancel') return null;
      if (state.state !== 'ready' || !state.skin) return null;
      // The name the user left in the field is the name the skin is saved under. The
      // slug is what the store writes, so the choice carries it rather than the raw buffer.
      // A customize box has no field: the skin keeps the name it already has.
      const skin = { ...state.skin, name: editable ? field.slug : state.skin.name };
      return { skin, save: action.id === 'save' };
    };

    function onKey(ch, key) {
      const intent = decideKey({
        key, focus, ready: state.state === 'ready' && Boolean(state.skin), editable,
      });
      const list = actions();
      switch (intent.type) {
        case 'cancel':
          close(null);
          return;
        case 'toggle':
          focus = focus === FOCUS_NAME ? FOCUS_ACTIONS : FOCUS_NAME;
          break;
        case 'focus':
          focus = intent.to;
          break;
        case 'backspace':
          field.backspace();
          break;
        case 'edit':
          field.insert(intent.text);
          break;
        case 'move':
          index = moveIndex(index, intent.delta, list.length);
          break;
        case 'choose':
          close(choice());
          return;
        default:
          return;
      }
      paint();
    }

    function stopWaiting() {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
    }

    if (screen) {
      screen.lockKeys = true;
      if (typeof onOpenChange === 'function') onOpenChange(true);
      screen.program?.prependListener('keypress', onKey);
    }
    paint();
    startWaiting();

    function startWaiting() {
      if (!widget) return;
      spinnerTimer = setInterval(tick, interval);
      // `unref()` so an open modal never keeps the process alive on its own: the pending
      // model call is what the turn is waiting for, not this repaint.
      if (typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
    }

    // The model call runs after the first paint, so the request is on screen while it is
    // in flight. A failure is a state, never a rejection: the modal shows it and offers
    // Cancel, so a broken proposal cannot trap the user in the box.
    const ask = typeof proposer === 'function' ? proposer : async () => null;
    Promise.resolve()
      .then(() => ask(request, { base, customize }))
      .then((skin) => {
        if (done) return;
        state = { ...state, state: skin ? 'ready' : 'error', skin: skin || null };
        if (skin) {
          field.setValue(skin.name ?? '');
          // Only an editable box takes the focus; a customize box stays on the actions.
          if (editable) focus = FOCUS_NAME;
          index = 0;
        }
      })
      .catch((error) => {
        if (done) return;
        state = { ...state, state: 'error', error: error?.message ?? String(error) };
      })
      .finally(() => {
        stopWaiting();
        if (!done) paint();
      });

    if (widget) {
      // Exposed for the tests: drive the modal without a real terminal.
      widget.choose = (target = index) => {
        index = target;
        close(choice());
      };
      widget.cancel = () => close(null);
      widget.paint = paint;
      widget.state = () => ({ ...state, focus, index, actions: actions().map((a) => a.id) });
      widget.name = () => field.value;
      widget.slug = () => field.slug;
      widget.type = (text) => {
        for (const character of String(text)) field.insert(character);
        paint();
      };
      widget.tick = tick;
      widget.field = field;
      widget.isWaiting = () => spinnerTimer !== null;
    }
  });
}
