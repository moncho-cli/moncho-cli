import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptKeys } from '../app/prompt-keys.js';
import { withTui } from './support/tui-harness.js';

/**
 * The seam that binds the editing model inside the input box
 * (docs/interface/prompt-editor).
 *
 * neo-blessed reads the widget's key listener off the **instance**
 * (`readInput()` binds `self.__listener = self._listener.bind(self)`) and keeps its own
 * on the prototype, which is exactly what this seam uses: it replaces the instance's
 * `_listener`, handles the arrows itself and hands every other key — Enter above all —
 * back to the widget's own listener. The cases below prove that split, the caret it
 * paints, the delegation to the history, and finally drive the real escape sequences
 * through blessed so "the arrows work" is proven end to end.
 */

/**
 * A stand-in for a blessed textbox: value, content, the read flag and a caret log.
 *
 * The widget's own key listener lives on the **prototype** in blessed
 * (`Textbox.prototype._listener`), and the seam borrows it from there to delegate the
 * keys it does not handle, so the stand-in carries one in the same place. It counts
 * the calls, which is what the delegation cases read.
 */
function fakeBox({ width = 40 } = {}) {
  const listeners = new Map();
  const caret = [];
  const box = {
    value: '',
    _value: '',
    content: '',
    width,
    iwidth: 2,
    itop: 1,
    ileft: 2,
    _reading: true,
    screen: {
      focused: null,
      program: {
        cup: (y, x) => caret.push({ y, x }),
      },
    },
    _getCoords: () => ({ yi: 10, xi: 0 }),
    getValue() { return box.value; },
    setContent(text) {
      box.content = String(text);
      for (const handler of listeners.get('set content') || []) handler();
    },
    on(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
    },
    emit(type, ...args) {
      for (const handler of listeners.get(type) || []) handler(...args);
    },
    _updateCursor() { caret.push({ y: -1, x: -1 }); },
  };
  box.screen.focused = box;
  Object.setPrototypeOf(box, {
    _listener() { this.delegated = (this.delegated || 0) + 1; },
  });
  return { box, caret };
}

test('createPromptKeys() binds the arrows inside the box and leaves other keys alone', () => {
  const { box, caret } = fakeBox({ width: 20 });
  const keys = createPromptKeys({ inputBox: box, refresh: () => {} });

  keys.editor.insert('abc');
  keys.publish();
  assert.equal(box.value, 'abc');
  assert.equal(box._value, 'abc', 'the widget private copy follows the editor');
  assert.equal(box.content, 'abc');

  // Left moves the caret and does not touch the text.
  box._listener(undefined, { name: 'left' });
  assert.equal(box.value, 'abc');
  assert.equal(keys.caret, 2);
  // Typing lands where the caret is, not at the end.
  box._listener('X', { name: 'x' });
  assert.equal(box.value, 'abXc');
  // Backspace deletes the character before the caret.
  box._listener(undefined, { name: 'backspace' });
  assert.equal(box.value, 'abc');
  // Home and end reach the edges, and delete removes what is under the caret.
  box._listener(undefined, { name: 'home' });
  assert.equal(keys.caret, 0);
  box._listener(undefined, { name: 'delete' });
  assert.equal(box.value, 'bc');
  box._listener(undefined, { name: 'end' });
  assert.equal(keys.caret, 2);

  // The caret is painted at its real column, not at the end of the content.
  box._listener(undefined, { name: 'home' });
  assert.deepEqual(caret[caret.length - 1], { y: 11, x: 2 }, 'yi + itop rows, xi + ileft + 0 cells');
  box._listener(undefined, { name: 'right' });
  assert.deepEqual(caret[caret.length - 1], { y: 11, x: 3 });

  // A key the seam does not handle goes to the widget's own listener untouched:
  // Enter is the important one, and it must not be swallowed.
  box._listener(null, { name: 'enter' });
  assert.equal(box.delegated, 1, 'Enter is delegated to blessed');
  // So is Escape.
  box._listener('\x1b', { name: 'escape' });
  assert.equal(box.delegated, 2);
});

test('createPromptKeys() gives up and down to the history, and back to the box when empty', () => {
  const { box } = fakeBox();
  const recalls = [];
  const keys = createPromptKeys({ inputBox: box, onRecall: (text) => recalls.push(text) });

  // With nothing sent yet the arrows are not ours: the widget keeps its behaviour.
  box._listener(undefined, { name: 'up' });
  assert.equal(box.delegated, 1, 'an empty history leaves the key alone');

  keys.record('first prompt');
  keys.record('second prompt');
  keys.editor.insert('half typed');
  keys.publish();

  box._listener(undefined, { name: 'up' });
  assert.equal(box.value, 'second prompt', 'up recalls the newest prompt');
  assert.equal(box.value, keys.editor.value);
  box._listener(undefined, { name: 'up' });
  assert.equal(box.value, 'first prompt');
  box._listener(undefined, { name: 'up' });
  assert.equal(box.value, 'first prompt', 'up at the oldest entry stays there');
  box._listener(undefined, { name: 'down' });
  assert.equal(box.value, 'second prompt');
  box._listener(undefined, { name: 'down' });
  assert.equal(box.value, 'half typed', 'the draft the user was typing comes back');
  assert.equal(keys.isWalkingHistory, false);
  assert.deepEqual(recalls, ['second prompt', 'first prompt', 'first prompt', 'second prompt', 'half typed']);
});

test('createPromptKeys() adopts a value written from outside and survives a close', () => {
  const { box } = fakeBox();
  const keys = createPromptKeys({ inputBox: box });

  // clearValue()/setValue() from outside is adopted, never silently undone.
  box.value = 'from outside';
  keys.sync();
  assert.equal(keys.value, 'from outside');
  assert.equal(box.content, 'from outside');

  // reset() empties both halves.
  keys.reset();
  assert.equal(box.value, '');
  assert.equal(keys.value, '');
  assert.equal(keys.caret, 0);

  // After close(), every key is delegated again: no handler outlives the screen.
  keys.close();
  box._listener('a', { name: 'a' });
  assert.equal(box.delegated, 1);
  assert.equal(keys.sync(), false);
});

test('createPromptKeys() without a widget is a harmless no-op', () => {
  const keys = createPromptKeys();
  assert.equal(keys.value, '');
  assert.equal(keys.caret, 0);
  assert.equal(keys.record('x'), null);
  assert.deepEqual(keys.windows, []);
  assert.doesNotThrow(() => keys.close());
  assert.doesNotThrow(() => keys.reset());
});

test('the arrow keys edit the prompt and recall history in the real TUI', async () => {
  await withTui(async (tui) => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const arm = tui.question(' > ');
    await tick();

    // Typing goes through blessed's own decoder, as the terminal delivers it.
    tui.inputBox.emit('keypress', 'a', { name: 'a', full: 'a' });
    tui.inputBox.emit('keypress', 'c', { name: 'c', full: 'c' });
    assert.equal(tui.inputBox.getValue(), 'ac');

    // Left moves the caret, so the next character lands in the middle.
    tui.inputBox.emit('keypress', undefined, { name: 'left', full: 'left' });
    assert.equal(tui.promptCaret, 1);
    tui.inputBox.emit('keypress', 'b', { name: 'b', full: 'b' });
    assert.equal(tui.inputBox.getValue(), 'abc', 'the caret decides where typing goes');

    // Home and end reach the edges of the text.
    tui.inputBox.emit('keypress', undefined, { name: 'home', full: 'home' });
    assert.equal(tui.promptCaret, 0);
    tui.inputBox.emit('keypress', undefined, { name: 'end', full: 'end' });
    assert.equal(tui.promptCaret, 3);

    // Enter still submits, and the submitted text is exactly what is in the box.
    const answered = tui.question(' > ', () => {});
    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await answered, 'abc');
    assert.equal(tui.inputBox.getValue(), '', 'the box is emptied through the editor');
    assert.deepEqual(tui.promptHistory, ['abc'], 'what was sent is recallable');

    // Up recalls it; down gives back the draft that was in progress.
    tui.inputBox.emit('keypress', undefined, { name: 'up', full: 'up' });
    assert.equal(tui.inputBox.getValue(), 'abc');
    tui.inputBox.emit('keypress', undefined, { name: 'down', full: 'down' });
    assert.equal(tui.inputBox.getValue(), '');

    arm.then(() => {}, () => {});
  });
});
