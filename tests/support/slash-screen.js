import { createTui } from '../../app/tui.js';
import { fakeTty } from './tui-harness.js';

/**
 * The harness the slash-popup suites share for the **real screen** cases.
 *
 * There is nothing to decide here: a TUI is built on a fabricated TTY (`fakeTty()`), the
 * input box is armed, and the caller drives it with `type()` exactly as a reader would.
 * It lives on its own because two suites need it and neither should own the other's
 * helper.
 */

/** A TUI with a command source and an armed box, handed to `fn` and torn down after. */
export async function withScreen(fn, commands = []) {
  const input = fakeTty({ columns: 80, rows: 30 });
  const output = fakeTty({ columns: 80, rows: 30 });
  const tui = createTui({ input, output, modelLabel: 'test/model', commands: () => commands });
  await tick();
  try {
    tui.inputBox.focus();
    tui.inputBox.readInput();
    await tick();
    return await fn(tui);
  } finally {
    tui.close();
    input.destroy();
    output.destroy();
  }
}

/** Type into the real box, one keystroke at a time, and let each land. */
export async function type(tui, text) {
  for (const ch of text) {
    tui.inputBox.emit('keypress', ch, { name: ch });
    await tick();
  }
}

/** Let blessed flush its paint before an assertion looks at the frame. */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}