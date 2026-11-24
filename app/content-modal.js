import blessed from 'neo-blessed';
import { activeTokens } from './theme.js';
import { claimKeyboard, releaseKeyboardLater, unlockMouse, KEYBOARD_OWNER_MODAL } from './keyboard-ownership.js';
import { escapeTags } from './tui-render.js';
import { createTextSelection } from './transcript-select.js';
import { bindSelectionGestures } from './transcript-mouse.js';
import { highlightRows, wrapWidthOf } from './transcript-highlight.js';

/**
 * A **read-only** content modal: a bordered box that shows documents exactly as they
 * are, one at a time, and gives the keyboard back when it closes.
 *
 * It is the sibling of the picker modal (`app/tui-modal.js`) and the skin subchat
 * (`app/skin-modal.js`), and it exists because both of those *choose* something. This
 * one chooses nothing: the user asked to look at a file, so the modal must not offer an
 * action that could change it. Enter and Escape both close it, and nothing else does
 * anything to the document.
 *
 * Four decisions:
 *
 *  - **the text is verbatim.** A document's braces, brackets and asterisks are painted as
 *    the bytes they are: a markdown renderer here would be a second, silently different
 *    view of the file the user is checking — and the whole point of `/task` is to see what
 *    is really on disk. The bytes reach the widget through `escapeTags()`, which is the
 *    *paint* escaping every untrusted string needs in a tag-parsing box (a literal brace
 *    would otherwise be read as a colour tag); what is drawn is therefore the document
 *    itself, character for character. The one difference from a `tags: false` box is that
 *    braces travel as `{open}`/`{close}`, which the renderer paints as the brace and which
 *    `contentRows()` strips nothing from — that escaping exists only so the **selection
 *    band** can be inserted into a line, which a `tags: false` box cannot do at all
 *    (`docs/interface/clipboard-selection`).
 *  - **the box takes most of the width, anchored right.** The size is computed from the
 *    live terminal (`contentModalSize()`) and the origin pins the box to the right edge
 *    (`contentModalOrigin()`), so a strip of the conversation stays visible on the left
 *    and the user can watch a turn land while they read the checklist.
 *  - **it re-reads itself while it is open.** The caller hands over a `reload()` that
 *    reads the files again; a timer calls it every `refreshMs` and repaints only when the
 *    bytes really changed, so a viewer left open shows the pair being written rather than a
 *    snapshot taken when it was opened.
 *  - **the keyboard is a lease.** The screen's dispatch is locked and a program-level
 *    listener is prepended, exactly as the other modals do it
 *    (`app/keyboard-ownership.js`), so the transcript and the input box never see the
 *    keys the modal answered. The lease is released at the end of the event, so the key
 *    that closed the modal is not also answered by the host.
 *  - **several documents, one box.** A session owns two files and the user asked for
 *    both, so the modal cycles between them (`tab` / `n`) and its label says which one
 *    is on screen and how many there are. Opening two boxes would fight over the screen.
 *
 * Resolves with `{ closed: 'escape' | 'enter' | 'q' | 'cancelled', document: <index> }`
 * when the user closes it, or `null` when there was nothing to show.
 */

/** How much of the terminal's *height* the box leaves free on each side. */
export const CONTENT_MODAL_MARGIN = 2;

/**
 * How much of the terminal's width the box takes. The rest stays visible on the left,
 * which is the whole point of anchoring the box right rather than centring it.
 */
export const CONTENT_MODAL_WIDTH_RATIO = 0.9;

/** How often an open viewer re-reads the files it was given. */
export const CONTENT_MODAL_REFRESH_MS = 3000;

/** The smallest box worth drawing, so a tiny terminal still shows something. */
export const CONTENT_MODAL_MIN_WIDTH = 20;
export const CONTENT_MODAL_MIN_HEIGHT = 5;

/**
 * The size of the box for a terminal of `width` × `height`.
 *
 * Most of the width, never all of it: the box takes `CONTENT_MODAL_WIDTH_RATIO` of the
 * columns, so the conversation stays visible in the strip that is left (`contentModalOrigin()`
 * pins the box to the right edge, which is where that strip comes from). The height leaves a
 * margin on each side, the way it always did. A terminal smaller than the minimums gets the
 * minimums clamped to the terminal, so the box is never bigger than the screen.
 *
 * @param {{width?: number, height?: number}} [size]
 * @returns {{width: number, height: number}}
 */
export function contentModalSize({ width = 80, height = 24 } = {}) {
  const cols = Math.max(1, Math.floor(Number(width) || 80));
  const rows = Math.max(1, Math.floor(Number(height) || 24));
  const wanted = {
    width: Math.max(CONTENT_MODAL_MIN_WIDTH, Math.round(cols * CONTENT_MODAL_WIDTH_RATIO)),
    height: Math.max(CONTENT_MODAL_MIN_HEIGHT, rows - CONTENT_MODAL_MARGIN * 2),
  };
  return {
    width: Math.min(wanted.width, cols),
    height: Math.min(wanted.height, rows),
  };
}

/**
 * Where the box sits: vertically centred, anchored to the right edge, and never off screen.
 *
 * The right anchor is deliberate rather than cosmetic: the columns the box does not take
 * stay on the **left**, where the conversation is, so an open `/task` leaves a live strip of
 * the transcript visible instead of a centred box with two useless slivers.
 *
 * @param {{width: number, height: number}} size the box size
 * @param {{width: number, height: number}} screen the terminal size
 * @returns {{top: number, left: number}}
 */
export function contentModalOrigin(size, screen) {
  const cols = Math.max(1, Number(screen?.width) || 80);
  const rows = Math.max(1, Number(screen?.height) || 24);
  const boxWidth = Math.min(Number(size?.width) || cols, cols);
  const boxHeight = Math.min(Number(size?.height) || rows, rows);
  return {
    top: Math.max(0, Math.floor((rows - boxHeight) / 2)),
    left: Math.max(0, Math.floor(cols - boxWidth)),
  };
}

/**
 * The next document index, wrapping at both ends.
 *
 * `step` is signed, so the same function serves "next" and "previous"; a document count
 * of zero or one always answers 0, so a single document cannot be cycled away from.
 *
 * @param {number} index the current index
 * @param {number} count how many documents there are
 * @param {number} [step] +1 for the next, -1 for the previous
 * @returns {number}
 */
export function nextDocumentIndex(index, count, step = 1) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (total <= 1) return 0;
  const current = Math.min(total - 1, Math.max(0, Math.floor(Number(index) || 0)));
  const moved = current + (Number(step) || 0);
  return ((moved % total) + total) % total;
}

/**
 * A scroll offset clamped to the content that is actually there.
 *
 * @param {number} offset the requested offset
 * @param {number} lineCount how many lines the document has
 * @param {number} height how many lines the box can show
 * @returns {number} the largest offset that still shows content
 */
export function clampScroll(offset, lineCount, height) {
  const lines = Math.max(0, Math.floor(Number(lineCount) || 0));
  const visible = Math.max(1, Math.floor(Number(height) || 0));
  const last = Math.max(0, lines - visible);
  const wanted = Math.floor(Number(offset) || 0);
  return Math.min(last, Math.max(0, wanted));
}

/** The label of the box: which document, and how many there are. */
export function documentLabel(doc, index, count) {
  const name = doc?.name || doc?.path || 'document';
  const total = Math.max(1, Math.floor(Number(count) || 1));
  if (total <= 1) return ` ${name} `;
  const at = Math.min(total, Math.max(1, Math.floor(Number(index) || 0) + 1));
  return ` ${name} (${at}/${total}) `;
}

/**
 * The documents a viewer can really show: the ones carrying text, in the order given.
 *
 * One rule, used twice — when the viewer opens and on every re-read — so a file that has
 * since been deleted is dropped by the same code that filtered the first list rather than
 * by a second, subtly different one.
 *
 * @param {Array<object>} documents
 * @returns {Array<object>}
 */
export function visibleDocuments(documents = []) {
  return (Array.isArray(documents) ? documents : [])
    .filter((doc) => doc && typeof doc.text === 'string');
}

/**
 * Whether two document lists say different things.
 *
 * Compared on the **bytes of the documents** and never on object identity, because the caller
 * builds a fresh array on every re-read: identity would report a change on every tick and
 * repaint the box three times a minute for nothing. A document that appears, disappears or is
 * edited is a change; a re-read that finds the same text is not.
 *
 * @param {Array<object>} before
 * @param {Array<object>} after
 * @returns {boolean}
 */
export function documentsChanged(before = [], after = []) {
  const a = visibleDocuments(before);
  const b = visibleDocuments(after);
  if (a.length !== b.length) return true;
  return a.some((doc, i) => doc.text !== b[i].text || (doc.name ?? '') !== (b[i].name ?? ''));
}

/** The footer hint, naming the keys that actually work. */
export function contentHint(count = 1) {
  const base = '↑↓ scroll · PgUp/PgDn page · Home/End · Enter/Esc close';
  return Math.max(1, Math.floor(Number(count) || 1)) > 1
    ? `Tab next document · ${base}`
    : base;
}

/**
 * Open the read-only viewer.
 *
 * @param {object} options
 * @param {object} options.screen the blessed screen
 * @param {Array<{name?: string, path?: string, text?: string}>} options.documents the files
 * @param {string} [options.title] the box's outer title
 * @param {Function} [options.refresh] repaint hook
 * @param {Function} [options.onOpenChange] told when the modal opens and closes
 * @param {Function} [options.reload] re-reads the documents; a viewer with one follows the
 *   files while it is open instead of showing the snapshot it was opened with
 * @param {number} [options.refreshMs] how often `reload` runs
 * @param {{set: Function, clear: Function}} [options.timer] the interval, injectable
 * @param {Function} [options.copy] `(text) => report` — the clipboard writer
 *   (`app/tui-clipboard.js`); absent leaves the modal readable but not copyable
 * @param {Function} [options.notify] `(report, text)` — told what the copy did
 * @returns {Promise<{closed: string, document: number}|null>}
 */
export function openContentModal({
  screen = null,
  documents = [],
  title = 'Content',
  refresh = null,
  onOpenChange = null,
  copy = null,
  notify = null,
  reload = null,
  refreshMs = CONTENT_MODAL_REFRESH_MS,
  timer = { set: setInterval, clear: clearInterval },
} = {}) {
  let docs = visibleDocuments(documents);
  if (docs.length === 0) return Promise.resolve(null);

  const repaint = typeof refresh === 'function' ? refresh : () => screen?.render?.();
  const size = contentModalSize({ width: screen?.width, height: screen?.height });
  const origin = contentModalOrigin(size, { width: screen?.width, height: screen?.height });

  return new Promise((resolve) => {
    let index = 0;
    let scroll = 0;
    let done = false;

    const box = blessed.box({
      parent: screen,
      label: documentLabel(docs[0], 0, docs.length),
      top: origin.top,
      left: origin.left,
      width: size.width,
      height: size.height,
      border: { type: 'line' },
      // The box parses tags so the selection band can be inserted into a line. The
      // document itself is escaped (`escapeTags`) before it is written, so no brace of the
      // file is ever read as markup and what is drawn is the file itself.
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      // Clickable so blessed hit-tests the pointer against this box — a selection is a drag
      // (docs/interface/clipboard-selection). `autoFocus` stays off: the modal owns the
      // keyboard through its own lease, never through the widget's focus.
      clickable: true,
      autoFocus: false,
      padding: { left: 1, right: 1 },
      style: { border: { fg: activeTokens().border } },
    });

    // The hint sits on the row just under the box, so the document itself stays verbatim.
    const hint = blessed.box({
      parent: screen,
      top: Math.min(origin.top + size.height, Math.max(0, (Number(screen?.height) || 24) - 1)),
      left: origin.left,
      width: size.width,
      height: 1,
      tags: false,
      style: { fg: activeTokens().border },
    });

    const lease = claimKeyboard({ screen, label: KEYBOARD_OWNER_MODAL });

    // The keyboard stays the modal's, but the **mouse is given back**: blessed returns early
    // from its mouse dispatcher for the same `lockKeys` flag the keyboard uses, so a modal
    // that kept it would be a viewer nothing can be selected in. The regions behind the modal
    // are safe under the pointer — each already opts out of focus and answers no drag — and
    // this box is the one widget that acts on it (`app/keyboard-ownership.js#unlockMouse`).
    const releaseMouse = () => unlockMouse({ screen });
    releaseMouse();

    // Selecting text in the document (`docs/interface/clipboard-selection`) is the same
    // machine the conversation uses, and deliberately the same one: a reader who knows how
    // to copy a transcript row already knows how to copy a line of `task.md`. Two things
    // make it work here that a `tags: false` box could not: the content is written escaped
    // so a band can be spliced in (`highlightRows`), and the box is `clickable` so blessed
    // hit-tests the pointer against it.
    const selection = createTextSelection({
      widget: box,
      copy,
      notify,
      repaint: () => paint(),
    });
    const gestures = bindSelectionGestures({
      widget: box,
      screen,
      selection,
      repaint: () => paint(),
    });

    /** The document as display lines, escaped so it is painted verbatim under a band. */
    const displayLines = (text) => String(text ?? '').split('\n').map((line) => escapeTags(line));

    /** The lines to hand the widget: the document, with the live selection marked. */
    const decorated = (text) => {
      const lines = displayLines(text);
      return highlightRows({
        lines,
        anchor: selection.anchor,
        focus: selection.focus,
        ftor: box?._clines?.ftor ?? null,
        width: wrapWidthOf(box),
      }).join('\n');
    };

    const docAt = (at) => docs[Math.min(docs.length - 1, Math.max(0, at))];

    const paint = () => {
      const doc = docAt(index);
      const text = String(doc?.text ?? '');
      const lines = text.split('\n');
      scroll = clampScroll(scroll, lines.length, size.height - 2);
      box.setLabel(documentLabel(doc, index, docs.length));
      box.setContent(decorated(text));
      box.scrollTo(scroll);
      hint.setContent(contentHint(docs.length));
      repaint();
    };

    /**
     * Take a re-read of the files and repaint **only when something really changed**.
     *
     * Four rules keep a viewer left open cheap and honest:
     *
     *  - a caller with no `reload` (a bare call, the unit tests) never re-reads, so the timer
     *    is not even armed;
     *  - a re-read that throws — a file deleted between the read and the paint — is not news
     *    the viewer can act on: the documents already on screen stay, and the next tick retries;
     *  - the documents that actually arrived replace the ones on screen and the document index
     *    is clamped to them, because a file can disappear while the box is open (`paint()`
     *    clamps the scroll offset itself, so a file that shrinks cannot leave an empty box);
     *  - a re-read that says nothing new repaints nothing: the pair is read every
     *    `refreshMs` for as long as the box is open, and blinking the screen each time would
     *    be worse than the staleness it fixes.
     */
    const refreshNow = () => {
      if (done || typeof reload !== 'function') return false;
      let next = null;
      try {
        next = reload();
      } catch {
        return false;
      }
      if (!documentsChanged(docs, next)) return false;
      const arrived = visibleDocuments(next);
      // Everything gone: keep showing what was there rather than an empty box.
      if (arrived.length === 0) return false;
      docs = arrived;
      index = Math.min(index, docs.length - 1);
      paint();
      return true;
    };

    let refreshHandle = null;
    if (typeof reload === 'function') {
      refreshHandle = timer.set(() => refreshNow(), refreshMs);
      // An interval would otherwise hold the process open for as long as the viewer is up.
      refreshHandle?.unref?.();
    }

    function close(reason) {
      if (done) return;
      done = true;
      if (refreshHandle) {
        timer.clear(refreshHandle);
        refreshHandle = null;
      }
      screen?.program?.removeListener?.('keypress', onKey);
      // The gesture bindings outlive no one: disposed before the box they were made for.
      gestures.dispose();
      box.destroy();
      hint.destroy();
      // The lease goes at the end of the event: the key that closed the modal is still
      // travelling, and the host must not answer it too.
      releaseKeyboardLater(lease);
      if (typeof onOpenChange === 'function') onOpenChange(false);
      repaint();
      resolve({ closed: reason, document: index });
    }

    function onKey(ch, key) {
      const name = key?.full || key?.name || '';
      if (name === 'escape' || name === 'enter' || name === 'return' || name === 'q'
        || name === 'C-c' || (key?.ctrl && name === 'c')) {
        close(name === 'escape' || name === 'C-c' || (key?.ctrl && name === 'c') ? 'escape' : name === 'q' ? 'q' : 'enter');
        return;
      }
      if (name === 'tab' || name === 'n') {
        index = nextDocumentIndex(index, docs.length, 1);
        scroll = 0;
        paint();
        return;
      }
      if (name === 'up' || name === 'k') {
        scroll = clampScroll(scroll - 1, docAt(index).text.split('\n').length, size.height - 2);
        paint();
        return;
      }
      if (name === 'down' || name === 'j') {
        scroll = clampScroll(scroll + 1, docAt(index).text.split('\n').length, size.height - 2);
        paint();
        return;
      }
      if (name === 'pageup') {
        scroll = clampScroll(scroll - size.height, docAt(index).text.split('\n').length, size.height - 2);
        paint();
        return;
      }
      if (name === 'pagedown') {
        scroll = clampScroll(scroll + size.height, docAt(index).text.split('\n').length, size.height - 2);
        paint();
        return;
      }
      if (name === 'home') {
        scroll = 0;
        paint();
        return;
      }
      if (name === 'end') {
        scroll = clampScroll(Number.MAX_SAFE_INTEGER, docAt(index).text.split('\n').length, size.height - 2);
        paint();
      }
    }

    screen?.program?.prependListener?.('keypress', onKey);
    if (typeof onOpenChange === 'function') onOpenChange(true);
    paint();

    // Exposed for tests: settle the modal without a real terminal.
    box.contentModal = true;
    box.state = () => ({ document: index, scroll, count: docs.length, title });
    box.close = (reason = 'cancelled') => close(reason);
    box.chooseDocument = (at) => { index = nextDocumentIndex(at, docs.length, 0); scroll = 0; paint(); };
  });
}
