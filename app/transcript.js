import { withStamp } from './transcript-stamp.js';

/**
 * The transcript as a model, independent of any terminal widget.
 *
 * The conversation is an ordered list of *entries*: plain display lines (prose,
 * notices) and *blocks* (a tool result, collapsed into a single header line carrying
 * its "X char response" size, expandable on click). The display
 * lines are derived from the entries, so toggling a block never loses the payload
 * — the exact bytes stay in `block.body`.
 *
 * An entry may also carry a `stamp` (`HH:MM:SS`, app/transcript-stamp.js): the time
 * it was appended, shown at the head of its **first** display line, and a `role`
 * (`user` or `assistant`), which is the side of the dialogue the prose band is
 * painted from (`docs/interface/prose-bands`). Both are presentation only — the
 * payload, the display-line ranges and the click math are untouched by them, and
 * neither ever reaches the model.
 *
 * Pure: no neo-blessed, no screen, so every rule below is unit testable.
 */

/** Glyphs marking a collapsed / expanded block header. */
export const COLLAPSED_MARKER = '▸';
export const EXPANDED_MARKER = '▾';

/** The inline size label shown at the end of a block header. */
export function formatCharCount(chars) {
  return `${Number(chars) || 0} char response`;
}

/** The single display line of a block header, stamp and size label included. */
export function formatBlockHeader(block) {
  const marker = block.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER;
  const hint = block.collapsed ? 'click to expand' : 'click to collapse';
  // The stamp goes *before* the marker, so the fold glyph keeps the leftmost cell
  // and every header still starts at the same column.
  return withStamp(`${marker} ${block.header} — ${formatCharCount(block.chars)} (${hint})`, block.stamp);
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

  /**
   * Append one display-ready line.
   *
   * `stamp` (optional) is the `HH:MM:SS` mark shown at the head of the line; it is
   * stored on the entry, so a repaint — a toggle, a scroll-driven `setContent()` —
   * paints the very same mark instead of a new one. `role` (optional) names the
   * *side of the dialogue* the line belongs to (`user` or `assistant`), which is what
   * the prose band is painted from (app/transcript-view.js); it is stored on the entry
   * so a repaint paints the same band.
   */
  addLine(text, { stamp = null, role = null } = {}) {
    this.#entries.push({
      type: 'line',
      text: String(text ?? ''),
      stamp: stamp || null,
      role: role || null,
    });
    return this.#entries.length;
  }

  /**
   * Append a collapsible block.
   *
   * `header` is one display-ready line (the caller sanitises and escapes it),
   * `body` the raw payload whose length is reported, `bodyLines` the formatted
   * lines actually painted. **Every block starts collapsed**, whatever its size: tool
   * output is what a reader scans past, and a result — a one-word one included — is
   * opened by a click rather than painted into the conversation unasked. A caller that
   * really wants its payload visible (`collapsed: false`) is the exception, and it is
   * always an announcement rather than a tool result (a tracking block, a review).
   *
   * `stamp` marks the entry the way `addLine()` does, on the header line.
   */
  addBlock({
    header = '', body = '', bodyLines = null, collapsed = null, stamp = null, role = null,
    bodyColor = null,
  } = {}) {
    const source = String(body ?? '');
    const lines = Array.isArray(bodyLines) ? [...bodyLines] : source.split('\n');
    const block = {
      type: 'block',
      id: `block-${this.#nextId++}`,
      header: String(header ?? ''),
      body: source,
      // Stored **uncoloured**: the palette is applied at paint time, so a skin repaints a
      // block with the rest of the transcript (docs/interface/skins). The one colour a
      // caller asks for rides beside the payload, never inside it.
      bodyLines: lines,
      bodyColor: typeof bodyColor === 'string' && bodyColor ? bodyColor : null,
      chars: source.length,
      stamp: stamp || null,
      role: role || null,
      collapsed: collapsed == null ? true : Boolean(collapsed),
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

  /**
   * The display lines with the options each was built with, in order: `{ text, role,
   * stamp }`. The view paints from this (it needs the role and the width), while
   * `lines` below stays the plain string array every earlier caller expects.
   */
  lineRecords() {
    const out = [];
    const emit = (text, entry, stamp = null) => {
      out.push({
        text,
        role: entry.role || null,
        stamp: stamp ?? entry.stamp ?? null,
        // The one colour a block's caller asked for (a tracking payload), or null. The
        // view re-applies it on every paint, so a skin can never leave a block behind.
        color: entry.type === 'block' ? (entry.bodyColor || null) : null,
      });
    };

    for (const entry of this.#entries) {
      if (entry.type === 'line') {
        emit(withStamp(entry.text, entry.stamp), entry, entry.stamp);
        continue;
      }
      const rendered = blockLines(entry);
      // A block carries its marker on the header line only; the mark is part of the
      // header string (formatBlockHeader), so the records mirror `lines`
      // byte-for-byte. The body colour belongs to the *payload* rows, never the header:
      // the header is a `[Tracking]` row the palette paints on its own, and wrapping it
      // in the payload colour would cover the very label that identifies it.
      rendered.forEach((text, index) => {
        const record = emit(text, entry, index === 0 ? entry.stamp : null);
        if (index === 0) out[out.length - 1].color = null;
        return record;
      });
    }
    return out;
  }

  /** The display lines, derived from the entries (collapsed blocks show one). */
  get lines() {
    return this.lineRecords().map((record) => record.text);
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
