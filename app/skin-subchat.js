import { openSkinModal } from './skin-modal.js';

/**
 * The `skinSubchat(request, { base })` surface `/skins prompt` calls, bound to a screen
 * (`docs/interface/skins`).
 *
 * Split out of `app/skin-modal.js` so the widget stays under the file budget: the modal
 * owns the box and the keyboard, this module owns *how the command reaches it*. The
 * difference matters — the modal is opened with a screen and a proposer, and this is the
 * one place that binds both to a request and refocuses the transcript input afterwards.
 *
 * The **whole** choice is returned — `{ skin, save }`, the edited name included — because
 * returning only the skin made "Apply and save" behave like "Apply for this session".
 *
 * @param {object} options
 * @param {object} options.screen the blessed screen
 * @param {Function} options.proposer the model call
 * @param {object} [options.inputBox] the transcript input, refocused when the modal closes
 * @param {Function} [options.refresh] repaint hook
 * @param {boolean} [options.editable] false when the name is settled (customize)
 * @param {boolean} [options.customize] true to offer the update-only action list
 * The defaults above are what `/skins prompt` gets. A call may override them per request —
 * `/skins customize` passes `{ customize: true, editable: false }` — so one bound surface
 * serves both commands without a second factory.
 *
 * @returns {Function} `(request, { base, customize, editable }) => Promise<{skin, save}|null>`
 */
export function createSkinSubchat({
  screen, proposer, inputBox = null, refresh = null, editable = true, customize = false,
} = {}) {
  return async function skinSubchat(request, { base = null, customize: perCall = null, editable: perCallEditable = null } = {}) {
    return openSkinModal({
      screen,
      proposer,
      request,
      base,
      refresh,
      editable: perCallEditable ?? editable,
      customize: perCall ?? customize,
      onOpenChange: (open) => {
        if (!open && inputBox) inputBox.focus();
      },
    });
  };
}
