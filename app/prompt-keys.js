import { createPromptEditor } from './prompt-editor.js';
import { createPromptHistory } from './prompt-history.js';
import { claimMenuKey, completeMenuKey } from './prompt-menu-keys.js';
import { EXIT_SENTINEL } from './input-hint.js';

/**
 * The arrow keys of the input box: left/right move the caret through the text, up/down
 * walk the prompts already sent (task-backlog: "be able to use arrow keys left and
 * right to move through the text, and up/down to navigate messages history").
 *
 * neo-blessed cannot do either, and it says so: its `Textarea#_listener` carries a
 * literal `// TODO: Handle directional keys.` whose body is an empty statement, so the
 * arrows arrive and change nothing, and the value is only ever built by appending every
 * printable byte at the *end* (`lib/widgets/textarea.js`). The editing model therefore
 * lives in `app/prompt-editor.js` (pure: one string, one caret, grapheme-aware) and the
 * history in `app/prompt-history.js`, and this module is the seam that puts them
 * **inside** the widget, in three contained moves:
 *
 *  - the box's own key listener (`_listener`) is replaced on the *instance*. That is
 *    the only place blessed reads it from — `readInput()` does
 *    `self.__listener = self._listener.bind(self)`, an instance lookup — so the
 *    replacement is picked up by every later read cycle without patching the library.
 *    Every key this module does not handle is handed straight back to the widget's own
 *    listener, so Enter, Escape and the control bytes keep exactly the behaviour they
 *    had.
 *  - the box's value and `_value` are kept in step with the editor, which is what stops
 *    the widget's own `setValue()` (called from its `render()`) from painting its crude
 *    `value.slice(-(width - 2))` window over the caret-aware one.
 *  - the caret is painted here (`_updateCursor` is replaced the same way), because
 *    blessed places it at the end of its content rather than at the caret's real column.
 *
 * The bytes are never altered: the box holds the editor's text verbatim, so Enter, a
 * queued submission and `getValue()` all carry exactly what the user typed.
 */

/** The room a one-line window may use: the widget's interior width, less the caret. */
function interiorWidth(inputBox) {
  const width = Number(inputBox?.width) || 0;
  const chrome = Number(inputBox?.iwidth) || 0;
  return Math.max(1, width - chrome - 1);
}

/**
 * @param {object} options
 * @param {object} options.inputBox the blessed textbox
 * @param {Function} [options.refresh] repaint hook
 * @param {Function} [options.onRecall] called with the text an up/down recall put in
 *   the box, so the caller can repaint a hint that is no longer accurate
 * @param {number} [options.historyLimit] how many prompts the walk keeps
 * @param {object} [options.menu] the slash-command popup (app/slash-menu.js): while it
 *   is open the arrows move its cursor and Enter accepts its row instead of submitting
 *   the line — the whole difference between a menu and a history
 * @param {Function} [options.onMenuChange] called with the box's text after every
 *   keystroke, so the popup can follow it (it decides whether it is open)
 * @param {Function} [options.onAccept] called with the text an accepted row stands for,
 *   which the wiring submits exactly as Enter on the line would
 * @param {Function} [options.onChange] called with the box's text after **every** write
 *   to it, keystroke or not, so a caller can follow what the box holds (the paste table
 *   shrinks from this: a token removed from the box takes its bytes with it)
 */
export function createPromptKeys({
  inputBox = null,
  refresh = () => {},
  onRecall = null,
  historyLimit = undefined,
  menu = null,
  onMenuChange = null,
  onAccept = null,
  onChange = null,
} = {}) {
  if (!inputBox) {
    // No widget (the line CLI, a pure unit test): every entry point is a harmless no-op.
    const inert = () => null;
    return {
      editor: createPromptEditor(),
      history: createPromptHistory(),
      attach: inert,
      publish: inert,
      sync: inert,
      record: inert,
      reset: inert,
      write: inert,
      value: '',
      caret: 0,
      caretColumn: 0,
      windows: [],
      isWalkingHistory: false,
      close() {},
    };
  }

  const editor = createPromptEditor();
  const history = createPromptHistory(historyLimit === undefined ? {} : { limit: historyLimit });
  // The widget's own listener, borrowed rather than reimplemented: Enter, Escape and
  // every control byte must keep behaving exactly as blessed made them. It lives on the
  // widget's prototype (`Textbox.prototype._listener`), which is what blessed reads.
  const delegate = Object.getPrototypeOf(inputBox)?._listener;
  let closed = false;
  let caretCells = 0;
  let painting = false;
  // The exact text this seam last put into the box. It is what tells a write from
  // *outside* (a `clearValue()`, a test, the picker) apart from our own published value.
  // It starts as whatever the box already held, so a seam built on an armed box adopts
  // that text once and never mistakes the editor's first change for an outside write.
  let lastWritten = String(inputBox.getValue?.() ?? inputBox.value ?? '');
  editor.setValue(lastWritten);
  const recalls = [];

  /** Leave the empty box's content to the last-prompt hint: only the caret is ours. */
  const paintCaret = () => {
    if (closed || painting) return false;
    if (inputBox._reading !== true) return false;
    if (inputBox.screen && inputBox.screen.focused !== inputBox) return false;
    const lpos = typeof inputBox._getCoords === 'function' ? inputBox._getCoords() : null;
    if (!lpos) return false;
    const program = inputBox.screen?.program;
    if (!program || typeof program.cup !== 'function') return false;
    program.cup(lpos.yi + inputBox.itop, lpos.xi + inputBox.ileft + caretCells);
    return true;
  };

  /**
   * Publish the editor into the box: the value verbatim, the caret-aware window as the
   * content, and the caret at the server's real column. The editor is the source of
   * truth here — `sync()` is the other direction, for a write that came from outside.
   */
  const publish = () => {
    if (closed) return false;
    const text = editor.value;
    inputBox.value = text;
    // `_value` too: the widget's own setValue() compares against it and would otherwise
    // repaint its own window over ours on the next render.
    inputBox._value = text;
    lastWritten = text;

    const shown = editor.window(interiorWidth(inputBox));
    caretCells = shown.caretCells;

    if (text !== '') {
      painting = true;
      try {
        inputBox.setContent(shown.text);
        // The last-prompt hint owns the content while the box is empty and rewrites it
        // when it steps aside (`app/input-hint.js`); the window is the truth, so it is
        // re-asserted once. The hint's own write cannot recurse, so this converges.
        if (inputBox.content !== shown.text) inputBox.setContent(shown.text);
      } finally {
        painting = false;
      }
    }

    paintCaret();
    // Every change of the text reaches the popup through here, so the two can never
    // fall out of step: `publish()` is the one path a keystroke takes into the box.
    if (typeof onMenuChange === 'function') onMenuChange(text);
    // And every write — keystroke or not — reaches a caller that follows the box's text
    // (the paste table prunes itself from here: a deleted token drops its bytes).
    if (typeof onChange === 'function') onChange(text);
    refresh();
    return true;
  };

  /**
   * Adopt the widget's value when something else wrote it, then publish: the editor
   * follows the box, never the other way round, so a write from outside is never
   * silently undone. A value that is still exactly the one this seam wrote is **not**
   * an outside write, which is what lets `publish()` stand on its own.
   */
  const sync = () => {
    if (closed) return false;
    const current = typeof inputBox.getValue === 'function' ? String(inputBox.getValue() ?? '') : '';
    if (current !== lastWritten) editor.setValue(current);
    return publish();
  };

  /** A printable character carries a byte and no control code. */
  const isPrintable = (ch) => typeof ch === 'string' && ch.length > 0 && !/^[\x00-\x1f\x7f]$/.test(ch);

  /**
   * The replacement key listener: handled keys mutate the editor and repaint, every
   * other key — Enter above all — goes to the widget's own listener unchanged.
   *
   * **The popup is asked first, and only while it is open**, which is what lets the two
   * share the same keys: up/down recall a prompt from the history when no menu is up and
   * move the menu's cursor when one is, and Enter submits the line or takes the
   * highlighted command. That arbitration lives in `app/prompt-menu-keys.js`; the menu is
   * asked live rather than consulted from a cache, because a keystroke is exactly what
   * opens and closes it.
   */
  const onKey = (ch, key) => {
    if (closed) return delegate?.call(inputBox, ch, key);
    const name = key?.name;
    let handled = true;

    if (claimMenuKey({ menu, name, refresh, accept: onAccept })) return undefined;

    if (name === 'left') editor.left();
    else if (name === 'right') editor.right();
    else if (name === 'home') editor.home();
    else if (name === 'end') editor.end();
    else if (name === 'backspace') editor.backspace();
    else if (name === 'delete') editor.deleteForward();
    else if (name === 'up' || name === 'down') {
      // A recall happens only when there is one to make; with an empty history the key
      // falls through, so the box behaves exactly as it did before.
      const recalled = name === 'up' ? history.prev(editor.value) : history.next();
      if (recalled === null) handled = false;
      else {
        editor.setValue(recalled);
        recalls.push(recalled);
        if (typeof onRecall === 'function') onRecall(recalled);
      }
    } else if (isPrintable(ch)) editor.insert(ch);
    else handled = false;

    if (!handled) return typeof delegate === 'function' ? delegate.call(inputBox, ch, key) : undefined;
    publish();
    return undefined;
  };

  const attach = () => {
    if (closed) return false;
    inputBox._listener = onKey;
    // The caret is blessed's to place and it places it at the end of the content: the
    // editor's column is the one that is right, so the placement is ours too. Both names
    // are replaced because the widget looks `_updateCursor` up on the instance
    // (`setValue`, `render`, `move`) while its constructor bound a `__updateCursor` once
    // and its own `resize` handler calls *that*, so the bound copy has to follow.
    const place = () => { paintCaret(); };
    inputBox._updateCursor = place;
    inputBox.__updateCursor = place;
    // The widget also rebuilds `value`/`content` from `_value` when it resizes; ours is
    // the window, so a resize republishes it instead.
    if (typeof inputBox.on === 'function') inputBox.on('resize', () => { publish(); });
    return true;
  };

  attach();

  return {
    editor,
    history,
    attach,
    /** Publish the editor into the box (the editor is the source here). */
    publish,
    /** Adopt a write that came from outside, then publish (the box is the source). */
    sync,
    /**
     * Write `text` into the box at the caret, through the editor and out through
     * `publish()`, so the caret, the window, the hint and the popup all learn about it
     * exactly as they would from a keystroke. This is how a paste token lands in the box:
     * the intake hands over the bytes, the caller collapses them to a token, and the token
     * is written here — never appended to the widget's value directly, which would leave
     * the editor holding different text than the box.
     */
    write(text) {
      if (closed) return false;
      editor.insert(text);
      publish();
      return true;
    },
    /**
     * Tab while the popup is open: complete the highlighted command's name into the box
     * and leave the caret after the space it adds, so arguments can be typed next.
     * Returns true when it took the key, which is what tells `app/tui-keys.js` not to
     * move the mode ring. False when there is no popup — Tab then means what it did.
     */
    complete() {
      if (closed) return false;
      // The write goes through the editor and out through `publish()`, so the box, the
      // caret and the popup all learn about the completed name exactly as they would from
      // a keystroke (app/prompt-menu-keys.js#completeMenuKey).
      const took = completeMenuKey({
        menu,
        write: (text) => {
          editor.setValue(text);
          publish();
        },
      });
      return took;
    },
    /** The popup, when this seam was given one (null otherwise). */
    get menu() {
      return menu;
    },
    /**
     * Remember one prompt (a submission that was really sent). The `exit` sentinel and
     * a blank submission are not prompts, exactly as the last-prompt hint treats them.
     */
    record(text) {
      const value = String(text ?? '');
      if (value === EXIT_SENTINEL) return history.size;
      return history.record(value);
    },
    /** Empty the box and the editor (a settled submission, a queued one, teardown). */
    reset() {
      editor.setValue('');
      history.reset();
      lastWritten = '';
      inputBox.value = '';
      inputBox._value = '';
      caretCells = 0;
      // The box is empty, so nothing is being completed: the popup goes with the text it
      // was offering. Announced through the same hook a keystroke uses, so there is one
      // way the popup learns about the box.
      if (typeof onMenuChange === 'function') onMenuChange('');
      paintCaret();
      return true;
    },
    /** The text in the box, verbatim. */
    get value() {
      return editor.value;
    },
    /** The caret, in grapheme clusters from the start of the text. */
    get caret() {
      return editor.caret;
    },
    /** The caret's column, in display cells. */
    get caretColumn() {
      return caretCells;
    },
    /** The texts the up/down walk has shown this session, in the order they appeared. */
    get windows() {
      return recalls.slice();
    },
    /** True while the up/down walk is in progress. */
    get isWalkingHistory() {
      return history.walking;
    },
    close() {
      closed = true;
      return true;
    },
  };
}

export { createPromptEditor, createPromptHistory };
