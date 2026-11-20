import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptEditor } from '../app/prompt-editor.js';
import { createPromptHistory } from '../app/prompt-history.js';

/**
 * The input box as an editable line (docs/interface/prompt-editor).
 *
 * neo-blessed's textarea has no editing model — its directional keys are a `// TODO`
 * and its value only ever grows at the end — so the text and the caret belong to
 * `app/prompt-editor.js` and the recall of what was sent to `app/prompt-history.js`.
 * Both are pure, so every key's effect is proven here without a terminal; the seam
 * that binds them inside the widget is `tests/prompt-keys.test.js`.
 */

test('createPromptEditor() moves the caret through the text one cluster at a time', () => {
  const editor = createPromptEditor({ value: 'abc' });
  assert.equal(editor.caret, 3, 'a fresh editor leaves the caret after the text');
  assert.equal(editor.atEnd, true);

  assert.equal(editor.left(), true);
  assert.equal(editor.caret, 2);
  assert.equal(editor.right(), true);
  assert.equal(editor.right(), false, 'the caret cannot pass the end');
  assert.equal(editor.caret, 3);
  assert.equal(editor.right(), false);

  assert.equal(editor.home(), true);
  assert.equal(editor.caret, 0);
  assert.equal(editor.atStart, true);
  assert.equal(editor.left(), false, 'the caret cannot pass the start');
  assert.equal(editor.end(), true);
  assert.equal(editor.caret, 3);
});

test('createPromptEditor() types, deletes and backspaces at the caret', () => {
  const editor = createPromptEditor({ value: 'ac' });
  editor.home();
  editor.right();
  editor.insert('b');
  assert.equal(editor.value, 'abc');
  assert.equal(editor.caret, 2, 'typing lands the caret after what was typed');

  assert.equal(editor.backspace(), true);
  assert.equal(editor.value, 'ac');
  assert.equal(editor.deleteForward(), true);
  assert.equal(editor.value, 'a');
  assert.equal(editor.deleteForward(), false, 'nothing to delete past the end');
  assert.equal(editor.backspace(), true);
  assert.equal(editor.backspace(), false, 'nothing to delete before the start');
  assert.equal(editor.value, '');
  assert.equal(editor.isEmpty, true);
});

test('createPromptEditor() treats an emoji as one character in every operation', () => {
  const editor = createPromptEditor({ value: 'x😀y' });
  assert.equal(editor.length, 3, 'three clusters, not four code units');

  editor.home();
  editor.right();
  assert.equal(editor.caret, 1);
  // The caret's column is cells, so it sits past the two the emoji occupies.
  assert.equal(editor.caretCells(), 1);
  editor.right();
  assert.equal(editor.caretCells(), 3);

  // A backspace on a skin-toned emoji removes the whole modifier sequence.
  const emoji = createPromptEditor({ value: '👍🏽' });
  assert.equal(emoji.backspace(), true);
  assert.equal(emoji.value, '', 'the modifier was not left behind');
});

test('createPromptEditor() windows a long line so the caret stays in view', () => {
  const editor = createPromptEditor({ value: 'x'.repeat(20) });
  const roomy = editor.window(40);
  assert.equal(roomy.text, 'x'.repeat(20));
  assert.equal(roomy.caretCells, 20);
  assert.equal(roomy.offset, 0);

  // A narrow box keeps the cells ending at the caret and drops the left ones.
  const narrow = editor.window(8);
  assert.equal(narrow.caretCells, 8);
  assert.equal(narrow.text.length, 8);
  assert.equal(narrow.offset, 12, 'twelve clusters fell off the left');

  // Move the caret home and the window follows it back to the start.
  editor.home();
  const start = editor.window(8);
  assert.equal(start.caretCells, 0);
  assert.equal(start.text, 'x'.repeat(8));
  assert.equal(start.offset, 0);

  // The value itself is never the window: the bytes that are submitted stay whole.
  assert.equal(editor.value.length, 20);
});

test('createPromptHistory() walks the prompts sent and always gives the draft back', () => {
  const history = createPromptHistory();
  assert.equal(history.size, 0);
  assert.equal(history.prev('draft'), null, 'nothing to recall yet');

  history.record('one');
  history.record('two');
  assert.deepEqual(history.entries, ['one', 'two']);
  assert.equal(history.size, 2);

  // First up: the newest prompt, with the in-progress text kept as the draft.
  assert.equal(history.prev('half typed'), 'two');
  assert.equal(history.walking, true);
  assert.equal(history.draft, 'half typed');
  // Up again: further back. Up at the oldest entry stays there.
  assert.equal(history.prev(), 'one');
  assert.equal(history.prev(), 'one');
  // Down: forward again, and past the newest the draft comes back and the walk ends.
  assert.equal(history.next(), 'two');
  assert.equal(history.next(), 'half typed');
  assert.equal(history.walking, false);
  assert.equal(history.next(), null, 'the walk is over');
});

test('createPromptHistory() ignores blanks, the exit sentinel caller and repetitions', () => {
  const history = createPromptHistory();
  history.record('one');
  history.record('one');
  assert.deepEqual(history.entries, ['one'], 'a repeat is not stored twice');
  history.record('   ');
  history.record('');
  history.record(null);
  assert.deepEqual(history.entries, ['one'], 'a blank is not a prompt');

  // A record always ends a walk, so the box shows the draft again.
  history.record('two');
  history.prev('in progress');
  assert.equal(history.walking, true);
  history.record('three');
  assert.equal(history.walking, false);

  // The walk is bounded: the oldest entries fall off the end.
  const small = createPromptHistory({ limit: 2 });
  small.record('a');
  small.record('b');
  small.record('c');
  assert.deepEqual(small.entries, ['b', 'c']);
});
