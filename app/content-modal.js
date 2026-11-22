import blessed from 'neo-blessed';
import { activeTokens } from './theme.js';
import { claimKeyboard, releaseKeyboardLater, KEYBOARD_OWNER_MODAL } from './keyboard-ownership.js';

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
 *  - **the text is verbatim.** The box is built with `tags: false`, so a document's
 *    braces, brackets and asterisks are painted as the bytes they are. A markdown
 *    renderer here would be a second, silently different view of the file the user is
 *    checking — and the whole point of `/task` is to see what is really on disk.
 *  - **the box takes most of the screen, never all of it.** The size is computed from
 *    the live terminal and leaves a margin on every side, so the user can still see that
 *    a conversation is behind the modal (`contentModalSize()`).
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

/** How much of the terminal the box leaves free on each side. */
export const CONTENT_MODAL_MARGIN = 2;

/** The smallest box worth drawing, so a tiny terminal still shows something. */
export const CONTENT_MODAL_MIN_WIDTH = 20;
export const CONTENT_MODAL_MIN_HEIGHT = 5;

/**
 * The size of the box for a terminal of `width` × `height`.
 *
 * Most of the screen, never all of it: the margin is what tells the user the modal is an
 * overlay rather than the whole interface. A terminal smaller than the minimums gets the
 * minimums clamped to the terminal, so the box is never bigger than the screen.
 *
 * @param {{width?: number, height?: number}} [size]
 * @returns {{width: number, height: number}}
 */
export function contentModalSize({ width = 80, height = 24 } = {}) {
  const cols = Math.max(1, Math.floor(Number(width) || 80));
  const rows = Math.max(1, Math.floor(Number(height) || 24));
  const wanted = {
    width: Math.max(CONTENT_MODAL_MIN_WIDTH, cols - CONTENT_MODAL_MARGIN * 2),
    height: Math.max(CONTENT_MODAL_MIN_HEIGHT, rows - CONTENT_MODAL_MARGIN * 2),
  };
  return {
    width: Math.min(wanted.width, cols),
    height: Math.min(wanted.height, rows),
  };
}

/**
 * Where the box sits: centred, and never off the screen.
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
    left: Math.max(0, Math.floor((cols - boxWidth) / 2)),
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
 * @returns {Promise<{closed: string, document: number}|null>}
 */
export function openContentModal({
  screen = null,
  documents = [],
  title = 'Content',
  refresh = null,
  onOpenChange = null,
} = {}) {
  const docs = (Array.isArray(documents) ? documents : [])
    .filter((doc) => doc && typeof doc.text === 'string');
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
      // Verbatim: the document's own braces and brackets are not markup.
      tags: false,
      scrollable: true,
      alwaysScroll: true,
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

    const docAt = (at) => docs[Math.min(docs.length - 1, Math.max(0, at))];

    const paint = () => {
      const doc = docAt(index);
      const text = String(doc?.text ?? '');
      const lines = text.split('\n');
      scroll = clampScroll(scroll, lines.length, size.height - 2);
      box.setLabel(documentLabel(doc, index, docs.length));
      box.setContent(text);
      box.scrollTo(scroll);
      hint.setContent(contentHint(docs.length));
      repaint();
    };

    function close(reason) {
      if (done) return;
      done = true;
      screen?.program?.removeListener?.('keypress', onKey);
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
