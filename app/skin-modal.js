import blessed from 'neo-blessed';
import { activeTokens } from './theme.js';
import { fgTag } from './paint-tags.js';
import {
  SKIN_ACTIONS, availableActions, actionAt, moveIndex, clampIndex, decideKey,
} from './skin-actions.js';
import { createSkinNameField } from './skin-name-field.js';
import {
  modalBoxSize, modalInterior, fitModalRows, fitRow, visibleWidth,
} from './skin-modal-layout.js';
import {
  claimKeyboard, releaseKeyboardLater, KEYBOARD_OWNER_MODAL,
} from './keyboard-ownership.js';

// The body text lives in its own module (`app/skin-preview.js`) so the wording is
// available without a terminal; these are re-exported because the modal is where callers
// and tests reach for them.
export {
  formatSkinPreview, formatSkinWaiting, formatSkinBody, formatSkinHint,
} from './skin-preview.js';
import { formatSkinBody, formatSkinHint, formatSkinName } from './skin-preview.js';

// The action list and the key contract moved to `app/skin-actions.js`; re-exported so the
// modal stays the one place a caller imports the widget from.
export { SKIN_ACTIONS, availableActions, clampIndex } from './skin-actions.js';

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
 *    sees the keystrokes (`app/tui-modal.js` does the same). The claim is a **lease**
 *    (`app/keyboard-ownership.js`), not a boolean: the host asks who holds the keyboard
 *    before it answers Escape or Tab, so a key the modal has already taken is not also
 *    handed to the host — Escape cancels the modal *without* aborting the running turn,
 *    and Tab moves the modal's focus *without* cycling the session mode.
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
 * the waiting state, the keyboard lease, the structural gate — is the same code.
 *
 * **The box fits the terminal.** The size is computed from the live screen
 * (`app/skin-modal-layout.js`), not taken as a percentage of it, and the body is fitted
 * to the box with the **actions reserved**: they are what the user has to be able to
 * read to answer the modal, and they used to be pushed off the bottom of the box and
 * clipped away. A resize refits the box and repaints the body against the new size.
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
    // The size of the box is read off the **live** screen, so it is right on the
    // terminal it was opened on and is recomputed when that terminal is resized.
    const screenSize = () => ({
      columns: Number(screen?.width) || 0,
      rows: Number(screen?.height) || 0,
    });
    const boxSize = () => modalBoxSize(screenSize());
    const interior = () => modalInterior(boxSize());

    const widget = screen
      ? blessed.box({
        parent: screen,
        label: ` ${title} `,
        top: 'center',
        left: 'center',
        // A **number**, not a percentage: a percentage is resolved against the screen
        // once, when the box is created, so the box would keep the size of the
        // terminal it was opened on after the terminal changed.
        width: boxSize().width,
        height: boxSize().height,
        border: { type: 'line' },
        tags: true,
        padding: { left: 1, right: 1 },
        // The border is a live token (`docs/interface/skins`), so a skin repaints it.
        style: { border: { fg: activeTokens().border } },
      })
      : null;

    let done = false;
    let spinnerTimer = null;
    // The keyboard lease: taken when the modal opens, released when it closes. The
    // host asks who holds the keyboard before it answers Escape or Tab, so a key the
    // modal has taken is never also handed to the host (`app/keyboard-ownership.js`).
    let lease = null;

    const tick = () => {
      frame += 1;
      if (!widget) return;
      paint();
    };

    /** The action rows, with the cursor on the highlighted one. */
    const actionRows = () => {
      const list = actions();
      // The list can shrink under the cursor (emptying the name drops the apply actions),
      // so the cursor is settled against it before the rows are built: every paint shows
      // a highlighted action, never a list with none.
      index = clampIndex(index, list.length);
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
      const room = interior();
      const nameRow = ready && editable ? field.row({ focused: focus === FOCUS_NAME }) : '';
      const nameError = ready && editable ? field.errorRow() : '';
      const hint = formatSkinHint({
        state: state.state, nameError: ready && editable ? field.error : '', focus, editable,
      });
      const body = formatSkinBody({
        ...state,
        width: room.columns,
        frame,
        elapsedMs: now() - startedAt,
        nameRow,
        nameError,
        hint,
      });
      // The row that says **what** is proposed is kept on screen too: the preview is
      // the first thing to go when the box is small, and a proposal whose name has
      // been cut away is a proposal the user cannot confirm.
      const proposalRow = ready ? formatSkinName(state.skin) : '';
      // The body is fitted to the box with the **actions reserved**: the rows that
      // answer the modal are never the ones cut away, and neither are the request,
      // the name or the hint (`app/skin-modal-layout.js`). The preview is what goes.
      const rows = fitModalRows({
        body,
        actions: actionRows(),
        room: room.rows,
        keep: [proposalRow, nameRow, nameError, hint],
      });
      widget.setContent(rows.map((row) => fitRow(row, room.columns)).join('\n'));
      repaint();
    };

    const close = (value) => {
      if (done) return;
      done = true;
      stopWaiting();
      if (screen) {
        screen.program?.removeListener('keypress', onKey);
        // The lease goes at the **end of the event**, not in the middle of it: the key
        // that closed the modal is still travelling through the program's listeners,
        // and the modal is still its owner until they have all seen it. Releasing it
        // here instead would let the host answer that same Escape — aborting the very
        // turn the modal was a part of.
        //
        // The token is passed **by value** to the release: the lease variable is
        // cleared right after, and a release that read it later would find nothing
        // to release — the modal would keep the keyboard for ever.
        releaseKeyboardLater(lease);
      }
      lease = null;
      widget?.destroy();
      if (typeof onOpenChange === 'function') onOpenChange(false);
      repaint();
      resolve(value);
    };

    /**
     * Refit the box to the screen it is on, and repaint the body against the new size.
     *
     * Blessed relayouts the box on a resize, but the **body** was wrapped for the width
     * the box had before, so the preview ran past the edge and the actions could be
     * pushed out of a box that had become shorter. Both are recomputed here.
     */
    const refit = () => {
      if (!widget || done) return;
      const size = boxSize();
      if (widget.width !== size.width) widget.width = size.width;
      if (widget.height !== size.height) widget.height = size.height;
      paint();
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
          // An arrow means "I am choosing now": the cursor moves *and* the focus joins it
          // in the list, so Enter applies what is highlighted instead of going to the
          // actions — the two-step that made the arrows feel dead (`app/skin-actions.js`).
          focus = FOCUS_ACTIONS;
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
      // The lease is taken before the lock is written, so the lock and the claim are
      // one thing: the screen's dispatch is locked while a modal holds the keyboard.
      lease = claimKeyboard({ screen, label: KEYBOARD_OWNER_MODAL });
      if (typeof onOpenChange === 'function') onOpenChange(true);
      screen.program?.prependListener('keypress', onKey);
      // A resize refits the box and the body: the size is read off the live screen, so
      // the modal follows the terminal it is on instead of keeping the old one's shape.
      screen.on?.('resize', refit);
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
      widget.refit = refit;
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
      // The rows the box can show, for the tests that assert on the **visible** screen.
      widget.visibleRows = () => widget.getContent().split('\n');
      widget.room = () => interior();
    }
  });
}
