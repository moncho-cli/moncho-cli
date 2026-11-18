/**
 * The transcript as a model, independent of any terminal widget.
 *
 * The conversation is an ordered list of *entries*: plain display lines (prose,
 * notices) and *blocks* (a tool result, collapsed by default into a single header
 * line carrying its "X char response" size, expandable on click). The display
 * lines are derived from the entries, so toggling a block never loses the payload
 * — the exact bytes stay in `block.body`.
 *
 * Pure: no neo-blessed, no screen, so every rule below is unit testable.
 */

/** Results longer than this many chars start collapsed. */
export const COLLAPSE_THRESHOLD_CHARS = 60;

/** Glyphs marking a collapsed / expanded block header. */
export const COLLAPSED_MARKER = '▸';
export const EXPANDED_MARKER = '▾';

/** The inline size label shown at the end of a block header. */
export function formatCharCount(chars) {
  return `${Number(chars) || 0} char response`;
}

/** The single display line of a block header, marker and size label included. */
export function formatBlockHeader(block) {
  const marker = block.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER;
  const hint = block.collapsed ? 'click to expand' : 'click to collapse';
  return `${marker} ${block.header} — ${formatCharCount(block.chars)} (${hint})`;
}

/** Display lines of one block: the header, plus the body when expanded. */
export function blockLines(block) {
  const header = formatBlockHeader(block);
  return block.collapsed ? [header] : [header, ...block.bodyLines];
}

/**
 * Map a click inside a scrollable widget to the index of the line under the
 * cursor: `data.y` is a screen row, `pos` the widget's painted coordinates,
 * `childBase` the current scroll offset and `itop` the border plus padding above
 * the content.
 *
 * Pure and defensive: a click outside the widget yields -1.
 */
export function clickRow({ pos, data, childBase = 0, itop = 0 } = {}) {
  if (!pos || !data) return -1;
  const row = Number(data.y) - Number(pos.yi) - (Number(itop) || 0);
  if (!Number.isFinite(row) || row < 0) return -1;
  return Math.max(0, Number(childBase) || 0) + row;
}

/**
 * Resolve a click to the block under the cursor.
 *
 * A scrollable widget paints *wrapped* lines, so the row under the cursor is
 * mapped back through the widget's fake->real map (`rtof`, which blessed builds
 * in `_wrapContent`) before asking the model. Pure: the caller passes the widget
 * numbers, so the whole click path is unit testable without a terminal.
 */
export function blockAtClick({ model, data, pos, childBase = 0, itop = 0, rtof = null } = {}) {
  const row = clickRow({ pos, data, childBase, itop });
  if (row < 0 || !model) return null;
  const real = Array.isArray(rtof) && row < rtof.length ? rtof[row] : row;
  return model.blockAtLine(real);
}

export class TranscriptModel {
  #entries = [];
  #nextId = 1;

  get entries() {
    return this.#entries;
  }

  /** Append one display-ready line. */
  addLine(text) {
    this.#entries.push({ type: 'line', text: String(text ?? '') });
    return this.#entries.length;
  }

  /**
   * Append a collapsible block.
   *
   * `header` is one display-ready line (the caller sanitises and escapes it),
   * `body` the raw payload whose length is reported, `bodyLines` the formatted
   * lines actually painted. Anything spanning several lines — or longer than
   * COLLAPSE_THRESHOLD_CHARS — starts collapsed, so tool output is hidden behind
   * a click "most of the times" while a one-word result stays readable inline.
   */
  addBlock({ header = '', body = '', bodyLines = null, collapsed = null } = {}) {
    const source = String(body ?? '');
    const lines = Array.isArray(bodyLines) ? [...bodyLines] : source.split('\n');
    const block = {
      type: 'block',
      id: `block-${this.#nextId++}`,
      header: String(header ?? ''),
      body: source,
      bodyLines: lines,
      chars: source.length,
      collapsed: collapsed == null
        ? lines.length > 1 || source.length > COLLAPSE_THRESHOLD_CHARS
        : Boolean(collapsed),
    };
    this.#entries.push(block);
    return block;
  }

  get blocks() {
    return this.#entries.filter((entry) => entry.type === 'block');
  }

  findBlock(id) {
    return this.blocks.find((block) => block.id === id) || null;
  }

  /** Flip a block between collapsed and expanded; null when the id is unknown. */
  toggleBlock(id) {
    const block = this.findBlock(id);
    if (!block) return null;
    block.collapsed = !block.collapsed;
    return block;
  }

  expandBlock(id) {
    const block = this.findBlock(id);
    if (!block) return null;
    block.collapsed = false;
    return block;
  }

  collapseBlock(id) {
    const block = this.findBlock(id);
    if (!block) return null;
    block.collapsed = true;
    return block;
  }

  /** The display lines, derived from the entries (collapsed blocks show one). */
  get lines() {
    const out = [];
    for (const entry of this.#entries) {
      if (entry.type === 'line') out.push(entry.text);
      else out.push(...blockLines(entry));
    }
    return out;
  }

  get content() {
    return this.lines.join('\n');
  }

  /** Half-open [start, end) display-line range of a block, or null. */
  rangeOf(block) {
    let index = 0;
    for (const entry of this.#entries) {
      const length = entry.type === 'line' ? 1 : blockLines(entry).length;
      if (entry === block) return { start: index, end: index + length };
      index += length;
    }
    return null;
  }

  /** The block whose display lines cover `index` (a display line number). */
  blockAtLine(index) {
    const line = Number(index);
    if (!Number.isFinite(line) || line < 0) return null;
    for (const block of this.blocks) {
      const range = this.rangeOf(block);
      if (range && line >= range.start && line < range.end) return block;
    }
    return null;
  }

  clear() {
    this.#entries = [];
  }
}
