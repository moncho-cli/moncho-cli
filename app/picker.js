/**
 * The selection model behind any picker (the `/sessions` modal included).
 *
 * Pure: it holds a list, a cursor and a page window, and answers "what does the
 * user see and what would they pick". No blessed, no screen, so the navigation
 * rules (wrapping, paging, empty lists) are unit testable.
 */

/** Rows visible in the picker window at once. */
export const DEFAULT_PAGE_SIZE = 8;

export function createPicker({ items = [], pageSize = DEFAULT_PAGE_SIZE, index = 0 } = {}) {
  const list = [...items];
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  let cursor = clamp(Number(index) || 0, 0, Math.max(0, list.length - 1));

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  const picker = {
    get items() {
      return list;
    },
    get length() {
      return list.length;
    },
    get pageSize() {
      return size;
    },
    get index() {
      return cursor;
    },
    /** The highlighted item, or null when the list is empty. */
    current() {
      return list[cursor] ?? null;
    },
    /** Move the cursor by `delta`, wrapping around the ends. */
    move(delta = 1) {
      if (list.length === 0) return null;
      const step = Number(delta) || 0;
      cursor = ((cursor + step) % list.length + list.length) % list.length;
      return picker.current();
    },
    /** Jump to an absolute index (clamped). */
    moveTo(target) {
      cursor = clamp(Number(target) || 0, 0, Math.max(0, list.length - 1));
      return picker.current();
    },
    /** Jump to the last item (the "newest" end of a session list). */
    moveToEnd() {
      return picker.moveTo(list.length - 1);
    },
    /**
     * The window of items currently visible, as `{ item, index, selected }` rows.
     * The cursor is kept inside the window, which is what makes a long session
     * list scroll rather than overflow.
     */
    window() {
      if (list.length === 0) return [];
      const start = clamp(cursor - Math.floor(size / 2), 0, Math.max(0, list.length - size));
      return list.slice(start, start + size).map((item, offset) => ({
        item,
        index: start + offset,
        selected: start + offset === cursor,
      }));
    },
    /** The display lines of the window, with a marker on the highlighted row. */
    lines({ marker = '>', empty = '(nothing to select)' } = {}) {
      const rows = picker.window();
      if (rows.length === 0) return [empty];
      return rows.map((row) => `${row.selected ? marker : ' '} ${row.item}`);
    },
  };

  return picker;
}
