/**
 * The mouse gestures that make a selection: press, drag, and the release that copies.
 *
 * Kept apart from both halves it joins, because the *shape* it has to work with is
 * neo-blessed's and not a choice. Four facts decide it, and each one cost a working
 * version to learn:
 *
 *  1. **A drag arrives as repeated `mousedown`, never as `mousemove`.** blessed recognises
 *     motion only from the *no-button* report codes (`program.js#_bindMouse`:
 *     `b === 35 || b === 39 || b === 51 || b === 43`), and a drag carries the button bit —
 *     32 for the left button in the SGR encoding a modern terminal sends — so it falls
 *     through to `action = 'mousedown'` with the *new* coordinates. Every step of a drag
 *     therefore re-enters `mousedown`, and the handler must let the gesture **extend**
 *     rather than restart. (Holding Shift made the old build work only because Shift adds 4
 *     and 39 is in blessed's motion list — the workaround was the symptom.)
 *  2. **`mousemove` means a hover.** The one motion blessed reports this way is the pointer
 *     moving with no button held, so it must not select anything.
 *  3. **A report the pointer is not over never reaches the widget.** blessed hit-tests each
 *     report against every clickable element and emits the action **only to the one under
 *     the pointer** (`screen.js#_listenMouse`: the loop `break`s at the first hit), so a
 *     drag step or a release landing on the status bar, the input box or the brand line is
 *     answered by *that* element and the transcript never hears it. The screen, however,
 *     re-emits **every** report (`self.emit(data.action, data)`, same function) whether or
 *     not an element claimed it.
 *
 *     So the **release is bound on the screen** — releasing anywhere, including outside the
 *     pane, finishes the gesture — and a **drag step is taken on the screen too, but only
 *     while a gesture is already live**. That second half is what keeps a press *outside*
 *     the pane from starting a selection: the screen sees every press, including the ones
 *     aimed at the input box, and only a live gesture may answer one. Bound to the widget
 *     alone, a drag that left the pane stayed stuck as a held press; bound greedily to the
 *     screen, clicking the input box would have selected a line of the conversation.
 *  4. **`click` is emitted before `mouseup`** for the same report (also
 *     `screen.js#_listenMouse`), so both edges finish a gesture; `finish()` on an already
 *     finished one answers null, so a terminal that sends both copies exactly once.
 *
 * The binding is therefore:
 *
 *  - `mousedown` **on the widget** — the first press opens the gesture, later ones extend
 *    it; repaint each time so the band follows the pointer;
 *  - `mousedown` **on the screen** — a drag step that left the pane, honoured only while a
 *    gesture is live;
 *  - `mousemove` **on the widget** — extends a live gesture only, and is a no-op otherwise
 *    (the hover rule);
 *  - `mouseup` **on the screen** — finishes it, wherever the pointer happens to be, with the
 *    release point taken from the event itself and clamped into the drawn content, so
 *    releasing past the last line copies to the end of the passage the drag started in;
 *  - `click` — not bound here. The pane asks the selection first and only falls through to
 *    the block toggle when the gesture was a plain click, so one binding stays in charge of
 *    `click` and the two behaviours cannot race.
 *
 * A bare widget with no screen — a unit test, a pane built without one — keeps the widget
 * bindings, which still cover a press, a drag and a release inside the pane, and the
 * out-of-bounds edge simply does not exist there.
 *
 * `repaint` is called after every change so the reverse-video band tracks the pointer and
 * disappears on release; the gesture state itself lives in `app/transcript-select.js`,
 * which is pure.
 */
export function bindSelectionGestures({
  widget = null, screen = null, selection = null, repaint = () => {},
} = {}) {
  if (!widget || typeof widget.on !== 'function' || !selection) {
    return { dispose() {}, get bound() { return false; } };
  }

  const hasScreen = Boolean(screen && typeof screen.on === 'function');
  // Without a screen the widget takes the release itself; with one the screen is the only
  // place every report is guaranteed to arrive (fact 3).
  const releaseTarget = hasScreen ? screen : widget;

  /** A press, or a drag step: open the gesture, or extend it from where it is. */
  const press = (data) => {
    const before = selection.focus;
    const point = selection.start(data);
    if (!point) return;
    if (selection.dragging && point !== before) repaint();
  };

  const onDown = (data) => press(data);

  // A drag step that has left the pane. The screen sees these, and so does it see every
  // press aimed at another region: only a gesture already in flight may answer one, or
  // clicking the input box would start selecting the conversation.
  const onDragOutside = (data) => {
    if (!selection.dragging) return;
    press(data);
  };

  const onMove = (data) => {
    // A move with no gesture in flight is a hover: the pointer merely crossing the
    // conversation must not repaint it or select anything.
    if (!selection.dragging) return;
    if (selection.move(data)) repaint();
  };

  // The release copies. It ends the gesture from wherever the button came up.
  const onUp = (data) => {
    if (!selection.dragging) return;
    if (selection.finish(data)) repaint();
  };

  const listens = [
    [widget, 'mousedown', onDown],
    [widget, 'mousemove', onMove],
    [releaseTarget, 'mouseup', onUp],
  ];
  if (hasScreen) listens.push([screen, 'mousedown', onDragOutside]);

  for (const [target, event, handler] of listens) target.on(event, handler);

  return {
    get bound() {
      return true;
    },
    dispose() {
      for (const [target, event, handler] of listens) {
        if (typeof target.removeListener === 'function') target.removeListener(event, handler);
      }
      selection.cancel();
    },
  };
}