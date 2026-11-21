import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLIPBOARD_FILE_PREFIX,
  CLIPBOARD_FILE_GLOB,
  clipboardFileName,
  createClipboardFile,
} from '../app/clipboard-file.js';
import { normalizeClipboardKeep } from '../config/constants.js';

/**
 * The copy end (docs/interface/clipboard-selection): a selection is saved to a file in the
 * workspace, because a container has no clipboard to reach and the host terminal decides
 * whether to honour an escape sequence. The file is the honest answer.
 *
 * Retention is one knob (`CLIPBOARD_FILE_KEEP`): `single` leaves the last copy alone and
 * `all` keeps a timestamped history. The name changes with the clock in both modes — the
 * host watcher picks a selection up when a *new* name appears — so the modes differ in
 * what they leave behind, never in how a copy is announced.
 */

/** A scratch directory that is removed when the test finishes. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-clipboard-'));
  return dir;
}

test('clipboardFileName() names the file with the local time, zero-padded', () => {
  // 09:05:07 local — the padding is the whole point of the format.
  const at = new Date(2026, 0, 2, 9, 5, 7);
  assert.equal(clipboardFileName(at), '.moncho.clipboard.090507');
  assert.equal(CLIPBOARD_FILE_PREFIX, '.moncho.clipboard.');
  // The gitignore glob matches the prefix, so a saved file never appears in a diff.
  assert.equal(CLIPBOARD_FILE_GLOB, '.moncho.clipboard.*');
  assert.ok(clipboardFileName(at).startsWith(CLIPBOARD_FILE_PREFIX));
});

test('normalizeClipboardKeep() defaults to a single file and accepts the aliases', () => {
  // Anything unknown — including a misspelling — falls back to the mode that leaves
  // *fewer* files, which is the safe side of this knob.
  for (const raw of [undefined, null, '', 'single', ' ONE ', 'nonsense']) {
    assert.equal(normalizeClipboardKeep(raw), 'single', `${JSON.stringify(raw)} is single`);
  }
  for (const raw of ['all', 'timestamped', 'KEEP']) {
    assert.equal(normalizeClipboardKeep(raw), 'all', `${JSON.stringify(raw)} is all`);
  }
});

test('the selection is written to the workspace under its time name', () => {
  const dir = scratch();
  try {
    const clipboard = createClipboardFile({
      dir,
      now: () => new Date(2026, 0, 2, 14, 30, 15),
    });
    const report = clipboard.write('alpha\nbeta');

    assert.equal(report.ok, true);
    assert.equal(report.file, '.moncho.clipboard.143015');
    assert.equal(report.path, path.join(dir, '.moncho.clipboard.143015'));
    assert.equal(report.error, null);
    // The text is on disk, byte for byte, including the newline.
    assert.equal(fs.readFileSync(report.path, 'utf8'), 'alpha\nbeta');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single mode leaves exactly one file, the last copy', () => {
  const dir = scratch();
  try {
    // A fixed clock every second is the awkward case: the names collide, so the writer
    // has to disambiguate the second copy *and* then prune the first it wrote.
    const clipboard = createClipboardFile({ dir, now: () => new Date(2026, 0, 2, 10, 0, 0) });
    const first = clipboard.write('first selection');
    const second = clipboard.write('second selection');

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(clipboard.mode, 'single');
    // The second copy has a distinct name (never truncating), and the first is gone.
    assert.notEqual(second.file, first.file);
    assert.deepEqual(fs.readdirSync(dir), [second.file]);
    assert.equal(fs.readFileSync(second.path, 'utf8'), 'second selection');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single mode never touches a file that is not a clipboard file', () => {
  const dir = scratch();
  try {
    const keep = path.join(dir, 'notes.txt');
    fs.writeFileSync(keep, 'project content');
    const clipboard = createClipboardFile({ dir, now: () => new Date(2026, 0, 2, 10, 0, 0) });
    clipboard.write('a selection');
    clipboard.write('another selection');

    // Only the prefixed files are the writer's business; an ordinary file is left alone.
    assert.equal(fs.readFileSync(keep, 'utf8'), 'project content');
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(CLIPBOARD_FILE_PREFIX)).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all mode keeps a timestamped history, and never overwrites one copy with another', () => {
  const dir = scratch();
  try {
    const clipboard = createClipboardFile({
      dir,
      keep: 'all',
      now: () => new Date(2026, 0, 2, 10, 0, 0),
    });
    const first = clipboard.write('first selection');
    const second = clipboard.write('second selection');

    assert.equal(clipboard.mode, 'all');
    // The name is the same second, so the writer must find another — the first is never lost.
    assert.equal(first.file, '.moncho.clipboard.100000');
    assert.notEqual(second.file, first.file);
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'first selection');
    assert.equal(fs.readFileSync(second.path, 'utf8'), 'second selection');
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty selection is not a file, and a failure is reported not thrown', () => {
  const dir = scratch();
  try {
    const clipboard = createClipboardFile({ dir });
    assert.deepEqual(clipboard.write(''), { ok: false, file: null, path: null, bytes: 0, error: 'EMPTY' });
    assert.deepEqual(clipboard.write(null), { ok: false, file: null, path: null, bytes: 0, error: 'EMPTY' });
    // Nothing was written for an empty selection.
    assert.deepEqual(fs.readdirSync(dir), []);

    // A directory that does not exist is a reported failure, not a crash: a copy is a
    // convenience and must never take the conversation down with it.
    const nowhere = createClipboardFile({ dir: path.join(dir, 'missing') });
    const report = nowhere.write('alpha');
    assert.equal(report.ok, false);
    assert.equal(report.error, 'ENOENT');
    assert.equal(report.file, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed copy leaves the previous selection untouched in single mode', () => {
  const dir = scratch();
  try {
    const clipboard = createClipboardFile({
      dir,
      now: () => new Date(2026, 0, 2, 10, 0, 0),
    });
    const kept = clipboard.write('keep me');
    // Every name in the second is taken, so a third attempt gives up. The prune runs only
    // *after* a write lands, so the copy that is there survives the one that failed.
    const writer = createClipboardFile({
      dir,
      now: () => new Date(2026, 0, 2, 10, 0, 0),
      writeFileSync: () => { const error = new Error('exists'); error.code = 'EEXIST'; throw error; },
    });
    const failed = writer.write('this never lands');
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'TOO_MANY');
    assert.equal(fs.readFileSync(kept.path, 'utf8'), 'keep me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
