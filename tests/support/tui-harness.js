import { PassThrough } from 'node:stream';

import { createTui } from '../../app/tui.js';

/**
 * Shared harness for the TUI suites.
 *
 * There is no pty helper in this image (no `script`, no `tput`), so we fabricate
 * a TTY-like stream: a PassThrough with isTTY/columns/rows, which is exactly what
 * neo-blessed reads (program.js: `this.cols = this.output.columns || 1`).
 */
export function fakeTty({ isTTY = true, columns = 80, rows = 24 } = {}) {
  const stream = new PassThrough();
  stream.isTTY = isTTY;
  stream.columns = columns;
  stream.rows = rows;
  return stream;
}

export const DEFAULT_MODEL_LABEL = 'openrouter · test/model';

// VT100 alternate character set -> Unicode, as neo-blessed paints box drawing.
const ACS_MAP = {
  j: '┘', k: '┐', l: '┌', m: '└', n: '┼',
  q: '─', t: '├', u: '┤', v: '┴', w: '┬',
  x: '│', '~': '·',
};

/**
 * neo-blessed paints through the VT100 alternate character set: spaces come out
 * as cursor-forward escapes (\x1b[<n>C) and '·' as the ACS '~' glyph. Normalise a
 * raw frame back to plain text so assertions can match readable strings.
 */
export function plainText(frame) {
  return frame
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\(0([\s\S]*?)\x1b\(B/g, (_, acs) => acs.replace(/[jklmnqtuvwx~]/g, (c) => ACS_MAP[c]))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '');
}

/** Run `fn(tui, { input, output, chunks, painted })` against a fresh TUI. */
export async function withTui(fn, ttyOptions = {}) {
  const input = fakeTty(ttyOptions);
  const output = fakeTty(ttyOptions);
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));

  const tui = createTui({ input, output, modelLabel: ttyOptions.modelLabel ?? DEFAULT_MODEL_LABEL });
  // neo-blessed buffers writes; flush the first paint before asserting.
  await new Promise((resolve) => setImmediate(resolve));

  try {
    // painted is a live accessor so assertions always see the latest frame.
    return await fn(tui, { input, output, chunks, painted: () => chunks.join('') });
  } finally {
    if (tui) tui.close();
    input.destroy();
    output.destroy();
  }
}

/** Visible transcript text, with the blessed colour escapes stripped. */
export function visible(tui) {
  return tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
}

/** Visible status-bar row, with the blessed colour escapes stripped. */
export function statusRow(tui) {
  return tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
}
