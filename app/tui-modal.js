import blessed from 'neo-blessed';
import { createPicker, DEFAULT_PAGE_SIZE } from './picker.js';
import { activeTokens } from './theme.js';
import { fgTag } from './paint-tags.js';

/**
 * A modal picker for the TUI: a bordered box listing the items, a highlighted row,
 * arrow / j-k navigation and Enter to choose.
 *
 * While the modal is open the caller locks the screen's key dispatch (see
 * `onOpenChange`), so neither the focused input box nor the transcript bindings
 * see the keystrokes — the modal consumes them first, from a program-level
 * listener. Escape (or Ctrl+C) cancels, resolving with `null`.
 *
 * Returns a promise: the chosen item, or null when cancelled.
 */
export function createPickerModal({
  screen,
  items = [],
  title = 'Select',
  pageSize = DEFAULT_PAGE_SIZE,
  onOpenChange = null,
  render = null,
} = {}) {
  const picker = createPicker({ items, pageSize });
  const repaint = typeof render === 'function' ? render : () => screen.render();

  return new Promise((resolve) => {
    const box = blessed.box({
      parent: screen,
      label: ` ${title} `,
      top: 'center',
      left: 'center',
      width: '70%',
      height: Math.max(3, Math.min(items.length + 2, pageSize + 2)),
      border: { type: 'line' },
      tags: true,
      padding: { left: 1, right: 1 },
      // The border is a live token (`docs/interface/skins`), so a skin repaints it.
      style: { border: { fg: activeTokens().border } },
    });

    const previousLock = screen.lockKeys;
    let done = false;

    const paint = () => {
      const cursor = activeTokens().border;
      box.setContent(
        picker.lines().map((line) => line.replace(/^>/, fgTag(cursor, '>'))).join('\n'),
      );
      repaint();
    };

    const close = (value) => {
      if (done) return;
      done = true;
      screen.program.removeListener('keypress', onKey);
      screen.lockKeys = previousLock;
      box.destroy();
      if (typeof onOpenChange === 'function') onOpenChange(false);
      repaint();
      resolve(value);
    };

    function onKey(ch, key) {
      const name = key?.full || key?.name || '';
      if (name === 'escape' || name === 'C-c' || (key?.ctrl && name === 'c')) {
        close(null);
        return;
      }
      if (name === 'up' || name === 'k') picker.move(-1);
      else if (name === 'down' || name === 'j') picker.move(1);
      else if (name === 'home') picker.moveTo(0);
      else if (name === 'end') picker.moveToEnd();
      else if (name === 'pageup') picker.move(-picker.pageSize);
      else if (name === 'pagedown') picker.move(picker.pageSize);
      else if (name === 'enter' || name === 'return') {
        close(picker.current());
        return;
      } else {
        return;
      }
      paint();
    }

    screen.lockKeys = true;
    if (typeof onOpenChange === 'function') onOpenChange(true);
    // Prepended last, so it runs before the interrupt forwarder: the modal owns
    // the keyboard while it is open.
    screen.program.prependListener('keypress', onKey);
    paint();

    // Exposed for tests: settle the modal without a real terminal.
    box.choose = (value = picker.current()) => close(value);
    box.cancel = () => close(null);
    box.picker = picker;
    box.paint = paint;
  });
}

/**
 * Ask the user to pick one of `labels` in the modal.
 *
 * Resolves with the **index** of the choice (or null when cancelled), which is
 * the shape the command registry's `choose(labels, { title })` expects.
 */
export async function chooseLabel({
  screen,
  labels = [],
  title = 'Select',
  pageSize = DEFAULT_PAGE_SIZE,
  render = null,
  onOpenChange = null,
} = {}) {
  const items = [...labels];
  const chosen = await createPickerModal({ screen, items, title, pageSize, render, onOpenChange });
  if (chosen == null) return null;
  const index = items.indexOf(chosen);
  return index >= 0 ? index : null;
}

/**
 * The `choose(labels, { title })` surface the command registry expects, bound to
 * one screen and input box.
 *
 * Kept here rather than in app/tui.js so the orchestration module stays about the
 * loop-facing surface, and so the focus hand-back (the modal closes, the box gets
 * the focus and nothing else) lives next to the modal that took it away.
 */
export function createChooser({ screen, inputBox = null, render = null } = {}) {
  return async function choose(labels = [], { title = 'Select' } = {}) {
    return chooseLabel({
      screen,
      labels,
      title,
      render,
      onOpenChange: (open) => {
        if (!open && inputBox) inputBox.focus();
      },
    });
  };
}
