import fs from 'node:fs';
import path from 'node:path';
import { CLIPBOARD_FILE_KEEP, normalizeClipboardKeep } from '../config/constants.js';

/**
 * Copying a selection to a **file in the workspace**.
 *
 * A terminal program cannot reach the clipboard the user pastes from when it runs in a
 * container: a Unix clipboard tool is a client of a display server, and the container has
 * none; the escape sequence (OSC 52) leaves the container as ordinary output and the
 * *host* terminal decides whether to honour it. Both were tried and both are a hope. A
 * file is not: it is written where the user already is, and picking it up is a command
 * they already know.
 *
 * So a copy lands at `<workspace>/.moncho.clipboard.HHMMSS` — the local time, because the
 * name is for the human reaching for it, not for the program. The workspace is the
 * process's own directory, which is `/app` in the container and the checkout's root on
 * the host, so the file appears in the same place either way.
 *
 * Four rules:
 *
 *  - **never overwrite.** A file is created with the `wx` flag, so a second copy in the
 *    same second gets its own name (`…-2`, `…-3`) instead of replacing the first. A copy
 *    that silently ate the previous one would be worse than one that says it failed.
 *  - **the text is written whole.** Unlike a terminal sequence there is no encoded-size
 *    ceiling to respect, so the selection is not trimmed — a file is the medium that
 *    makes a large selection safe.
 *  - **a failure is reported, never thrown.** A copy is a convenience, and losing it must
 *    not take the conversation down with it. An empty selection is not a copy at all.
 *  - **retention is one knob** (`CLIPBOARD_FILE_KEEP`). In `single` mode — the default —
 *    a new copy leaves exactly one file behind, pruning the older ones; in `all` mode
 *    every copy keeps its own timestamped name, so the workspace is a history of
 *    selections. The name still changes with the clock in both modes, because the
 *    host-side watcher (`bin/lib/clipboard-watch.sh`) picks a selection up when a *new*
 *    name appears; a fixed name would be seen once and never again.
 *
 * Pure apart from the injected writer and directory reader: the clock, the filesystem and
 * the retention mode are parameters, so every rule above is testable without touching a
 * real directory.
 */

/** The prefix every clipboard file carries, and the gitignore glob that matches them. */
export const CLIPBOARD_FILE_PREFIX = '.moncho.clipboard.';
export const CLIPBOARD_FILE_GLOB = '.moncho.clipboard.*';

/** How many names one copy may try before it gives up on a crowded second. */
export const CLIPBOARD_MAX_ATTEMPTS = 100;

/** Two digits, zero-padded, so a filename is always the same width. */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * The filename for a copy made at `now`: `.moncho.clipboard.HHMMSS`.
 *
 * Local time on purpose — the reader looking for the file is in the same timezone as the
 * clock that named it, and a UTC stamp would make them convert to find their own copy.
 */
export function clipboardFileName(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  return `${CLIPBOARD_FILE_PREFIX}${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
}

/** True for a basename a previous copy could have produced. */
function isClipboardName(name) {
  return typeof name === 'string' && name.startsWith(CLIPBOARD_FILE_PREFIX);
}

/**
 * The writer a selection holds. `write(text)` returns
 * `{ ok, file, path, bytes, error }` — the basename for the toast, the absolute path for
 * anything that needs it, and a reason when it did not land.
 *
 * @param {object} [options]
 * @param {string} [options.dir] the workspace a copy lands in
 * @param {Function} [options.now] the clock
 * @param {string} [options.keep] `single` (the default) or `all`; see `config/constants.js`
 * @param {Function} [options.writeFileSync] the file writer (injected for tests)
 * @param {Function} [options.readdirSync] the directory reader, used only in `single` mode
 * @param {Function} [options.unlinkSync] the pruner, used only in `single` mode
 */
export function createClipboardFile({
  dir = process.cwd(),
  now = () => new Date(),
  keep = CLIPBOARD_FILE_KEEP,
  writeFileSync = fs.writeFileSync,
  readdirSync = fs.readdirSync,
  unlinkSync = fs.unlinkSync,
} = {}) {
  const mode = normalizeClipboardKeep(keep);

  /**
   * Leave exactly one clipboard file: the one just written.
   *
   * Best-effort by construction — a prune that fails must never cost the user the copy
   * that succeeded, so every error is swallowed. Only files carrying the prefix are
   * touched, and never the copy being kept, so an unrelated file in the workspace can
   * never be deleted by a copy.
   */
  function pruneOthers(keepPath) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!isClipboardName(name)) continue;
      const target = path.join(dir, name);
      if (target === keepPath) continue;
      try {
        unlinkSync(target);
      } catch {
        // A file that vanished between the listing and the unlink is already gone; any
        // other failure leaves one stale scratch file, which is not worth a complaint.
      }
    }
  }

  return {
    dir,
    mode,
    write(text) {
      const source = text == null ? '' : String(text);
      // Nothing selected is nothing to save, and a file holding nothing would be a trap.
      if (source === '') {
        return { ok: false, file: null, path: null, bytes: 0, error: 'EMPTY' };
      }

      const base = clipboardFileName(now());
      for (let attempt = 1; attempt <= CLIPBOARD_MAX_ATTEMPTS; attempt += 1) {
        const name = attempt === 1 ? base : `${base}-${attempt}`;
        const target = path.join(dir, name);
        try {
          // `wx` is the whole rule: create, or fail — never truncate a file that is there.
          writeFileSync(target, source, { encoding: 'utf8', flag: 'wx' });
          // The copy landed, so `single` mode can safely drop what it replaces. Pruning
          // *after* the write is deliberate: a write that failed leaves the previous
          // selection untouched, which is exactly what a failed copy should do.
          if (mode === 'single') pruneOthers(target);
          return {
            ok: true,
            file: name,
            path: target,
            bytes: Buffer.byteLength(source, 'utf8'),
            error: null,
          };
        } catch (error) {
          if (error?.code === 'EEXIST') continue;
          return {
            ok: false,
            file: null,
            path: null,
            bytes: 0,
            error: error?.code || error?.message || 'WRITE_FAILED',
          };
        }
      }

      // Every name in this second is taken: say so rather than loop forever.
      return { ok: false, file: null, path: null, bytes: 0, error: 'TOO_MANY' };
    },
  };
}
