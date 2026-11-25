import blessed from 'neo-blessed';
import { setTerminalColorCount } from './terminal-capability.js';
import { nativeSelectionEnabled } from '../config/constants.js';

/**
 * The blessed screen itself, and the repaint latch that goes with it.
 *
 * Three decisions live here and nowhere else, all of them about how blessed is set up
 * rather than what the TUI draws:
 *
 *  - **`forceUnicode`.** `fullUnicode` alone is not enough: neo-blessed derives the flag
 *    from the **terminfo** entry it managed to parse (`screen.js#Screen`:
 *    `this.fullUnicode = this.options.fullUnicode && this._unicode`), so on a box whose
 *    entry it cannot read (no terminfo, an unknown `$TERM`) `_unicode` stays false and the
 *    widget replaces every double-width glyph with `??` (`element.js#Element.render`:
 *    `content.replace(unicode.chars.all, '??')`). That is what turned every emoji in the
 *    conversation into question marks. `forceUnicode` makes the screen trust the terminal
 *    rather than the terminfo entry.
 *  - **the repaint latch.** `stdout` is not a TTY when `./start.sh start` runs detached
 *    (no pty) and there is no screen to build at all; once there is one, every part of the
 *    wiring repaints through the same `refresh`, and a closed screen is never rendered
 *    again — a render after `destroy()` is what turns a clean exit into a stack trace.
 *  - **who owns the mouse**, which is `forceUnicode`'s problem one layer down: blessed
 *    picks the encoding from `$TERM` and enables reporting as a side effect of binding a
 *    listener. By default (`NATIVE_SELECTION_ENABLED`) the mouse is left to the terminal
 *    entirely; with the switch off, this module asks for SGR instead of blessed's ?1005
 *    (`docs/interface/clipboard-selection`).
 *
 * Extracted from `app/tui.js` to keep the wiring module inside the project's line budget;
 * it is the *setup* of the screen, not a region on it.
 */
export function createScreen({ input, output, nativeSelection = null } = {}) {
  if (!output?.isTTY) return null;

  // Resolved here when the caller did not decide (`app/tui.js` passes its own answer so the
  // choice is made once for the whole screen); `null` means "ask the environment".
  const terminalKeepsMouse = nativeSelection === null ? nativeSelectionEnabled() : Boolean(nativeSelection);

  const screen = blessed.screen({
    input,
    output,
    smartCSR: true,
    fullUnicode: true,
    forceUnicode: true,
    title: 'Moncho',
    warnings: false,
    autoPadding: true,
  });

  // The terminal's own colour capability, recorded once from the real screen: a bright
  // background is painted as its base colour on a terminal with fewer than sixteen colours,
  // and the skins command says so rather than letting the user think the colour was
  // ignored (`app/terminal-capability.js`).
  setTerminalColorCount(screen.tput?.colors ?? null);

  // --- who owns the mouse (`NATIVE_SELECTION_ENABLED`, opt-in) -----------------------------
  //
  // **The terminal's own selection is the default**, and the switch is here because this is
  // the **only** place that can honour it. blessed calls `program.enableMouse()` from
  // `screen.js#_listenMouse` — i.e. the moment *any* mouse listener is bound anywhere
  // (`this.program.on('mouse', ...)` is what arms it) — and it re-arms it from `Screen#resume`
  // (`screen.js#_resume`, `if (mouse) program.enableMouse()`). There is no option that says
  // "do not report the mouse": the negotiation happens as a side effect of binding a
  // listener, so turning the method into a no-op is what leaves the terminal owning its own
  // selection. The two are mutually exclusive on a bare drag: while a terminal reports the
  // mouse it sends drags to this program and keeps its own selection off.
  //
  // While the mouse is the terminal's, no `?1000`/`?1002`/`?1003`/`?1005`/`?1006` is ever
  // sent, so the terminal keeps its native drag-to-select and its copy key, and this program
  // receives no `mousedown`, `mousemove` or `mouseup` at all. The cost is real and deliberate:
  // the wheel, the click-to-expand block and the in-app selection all stop, because all three
  // are built on those reports (docs/interface/clipboard-selection). The alternate screen also
  // bounds the terminal's selection to what is *drawn*, never the scrollback.
  //
  // --- and the encoding, when this program does keep the mouse (`?1006` SGR) --------------
  //
  // With the switch off, the mouse is this program's, and the protocol matters: blessed
  // chooses it from `$TERM`, and on every xterm-like terminal asks for **?1005, the UTF-8
  // extended X10 encoding** (`node_modules/neo-blessed/lib/program.js#enableMouse`: the xterm
  // branch sets `utfMouse: true`). X10 has no room to express what this interface needs: its
  // button byte carries no *modifier on a release*, so a Shift release and a Shift hover
  // arrive as the **same byte** (35 + 4 = 39). blessed's own decoder admits it — "x10 and
  // urxvt have no way of telling which button mouseup used" — and it does `b -= 32` and then
  // tests `b === 3` for a release, so the plain release (35 − 32 = 3) decodes correctly while
  // the Shift release (39 − 32 = 7) falls through to `mousedown` with `button: 'unknown'`.
  //
  // That is not cosmetic. The selection gesture (`app/transcript-mouse.js`) *finishes* on
  // `mouseup`, so a release decoded as a press never finishes it: the reverse-video band stays
  // on screen and nothing is copied. Only *modified* releases are misdecoded, which is why a
  // plain drag always worked and why the wire suite, written in SGR, never saw it.
  //
  // SGR has the room X10 lacks: the button and the modifiers live in decimal parameters and
  // the edge is the final byte (`M` press, `m` release), so a Shift release (`7m`) is a
  // `mouseup` and a Shift hover (`39M`) is a `mousemove`. blessed already decodes that
  // correctly, so the whole fix is to *ask* for it — the same feature set blessed chose
  // (press/release, cell motion, all motion), in the one encoding that tells the edges apart.
  if (terminalKeepsMouse) {
    screen.program.enableMouse = function enableMouseNoop() {
      return false;
    };
  } else {
    screen.program.enableMouse = function enableMouseSgr() {
      return this.setMouse({
        sgrMouse: true,   // ?1006 — button + modifiers in parameters, M/m for the edge
        utfMouse: false,  // ?1005 — X10, which conflates a Shift release with a Shift hover
        vt200Mouse: true, // ?1000 — press and release
        cellMotion: true, // ?1002 — motion while a button is held
        allMotion: true,  // ?1003 — motion with no button (blessed's hover)
      }, true);
    };
  }

  let closed = false;

  return {
    screen,
    /** Repaint, unless the screen has already been torn down. */
    refresh() {
      if (!closed) screen.render();
    },
    /** True once `close()` has run, so no region repaints a destroyed screen. */
    isClosed() {
      return closed;
    },
    markClosed() {
      closed = true;
    },
  };
}