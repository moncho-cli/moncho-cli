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

/**
 * The copy end (docs/interface/clipboard-selection): a selection is saved to a file in the
 * workspace, because a container has no clipboard to reach and the host terminal decides
 * whether to honour an escape sequence. The file is the honest answer.
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

test('a second copy in the same second does not overwrite the first', () => {
  const dir = scratch();
  try {
    const clipboard = createClipboardFile({ dir, now: () => new Date(2026, 0, 2, 10, 0, 0) });
    const first = clipboard.write('first selection');
    const second = clipboard.write('second selection');

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    // The name is the same, so the writer must find another — the first is never lost.
    assert.equal(first.file, '.moncho.clipboard.100000');
    assert.notEqual(second.file, first.file);
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'first selection');
    assert.equal(fs.readFileSync(second.path, 'utf8'), 'second selection');
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
