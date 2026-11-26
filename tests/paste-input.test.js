import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PASTE_THRESHOLD,
  PASTE_TOKEN_RE,
  stripBracketedPaste,
  hasLineBreak,
  pasteLines,
  pasteLineCount,
  isPasteChunk,
  formatPasteToken,
  nextPasteId,
  collapsePaste,
  expandPastes,
  pasteTokenIds,
} from '../app/paste-tags.js';
import { createPasteRegistry } from '../app/paste-registry.js';
import { createPasteIntake } from '../app/paste-intake.js';
import { createPromptEditor } from '../app/prompt-editor.js';
import { keyboardHeldBy, KEYBOARD_OWNER_PASTE } from '../app/keyboard-ownership.js';
import { withTui, fakeTty, visible } from './support/tui-harness.js';

/**
 * A pasted block is a **token in the box and bytes in a table** (`docs/interface/paste-input`).
 *
 * The bug this suite pins was reported twice and both halves matter: a terminal delivers a
 * paste as a burst of keypresses, the widget strips every `\n` from its own value and reads a
 * `\r` as Enter, so a multi-line paste lost its lines and a CRLF paste submitted halfway
 * through. The fix catches the paste where its bytes are still whole — the program's `data`
 * chunk — swallows the keystrokes it would have become, and puts a token in the box instead.
 *
 * The three properties proven here are the three a user can feel: the box keeps reading after
 * a paste, a token is one unit under the caret, and what reaches the model is the bytes that
 * were pasted.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The one armed question of a fresh TUI, whose answer is read later. */
async function withArmedTui(fn) {
  return withTui(async (tui) => {
    const armed = tui.question('> ');
    armed.then(() => {}, () => {});
    await flush();
    return fn(tui, armed);
  });
}

test('isPasteChunk() tells a paste from a keystroke: a break plus something besides it', () => {
  // A line break is the whole signal, and a lone Enter/Ctrl+J is not a paste.
  assert.equal(isPasteChunk('a\nb'), true, 'two lines are a paste');
  assert.equal(isPasteChunk('one line\n'), true, 'one line ending in a break is a paste too');
  assert.equal(isPasteChunk('a\r\nb'), true, 'CRLF is a paste');
  assert.equal(isPasteChunk('a\rb'), true, 'a lone CR is a paste when it has content');

  assert.equal(isPasteChunk('\r'), false, 'Enter is a keypress');
  assert.equal(isPasteChunk('\n'), false, 'Ctrl+J is a keypress');
  assert.equal(isPasteChunk('\r\n'), false, 'a bare CRLF carries nothing');
  assert.equal(isPasteChunk('just one line'), false, 'no break, no paste');
  assert.equal(isPasteChunk(''), false, 'nothing at all');
  assert.equal(isPasteChunk(null), false, 'junk is not a paste');

  // The threshold is a knob, and the shipped one collapses a single broken line.
  assert.equal(PASTE_THRESHOLD, 1);
  assert.equal(isPasteChunk('a\nb', 3), false, 'a raised threshold keeps a two-line block literal');
});

test('pasteLines() counts content lines and drops exactly one trailing break', () => {
  assert.equal(pasteLineCount('a\nb\nc'), 3);
  assert.equal(pasteLineCount('a\nb\nc\n'), 3, 'the trailing break is not a line');
  assert.equal(pasteLineCount('a\nb\nc\n\n'), 4, 'a deliberate blank line is one');
  assert.equal(pasteLineCount('a\r\nb\r\n'), 2, 'CRLF counts the same');
  assert.equal(pasteLineCount('a\rb\r'), 2, 'a lone CR counts the same');
  assert.equal(pasteLineCount(''), 0);
  assert.deepEqual(pasteLines('a\nb'), ['a', 'b']);
});

test('stripBracketedPaste() removes the transport wrapper, never content', () => {
  assert.equal(stripBracketedPaste('\x1b[200~a\nb\x1b[201~'), 'a\nb');
  assert.equal(stripBracketedPaste('plain'), 'plain', 'a chunk without markers is untouched');
  // A half-open wrapper (a paste split across two reads) is still transport.
  assert.equal(stripBracketedPaste('\x1b[200~a\nb'), 'a\nb');
  assert.equal(hasLineBreak('a\nb'), true);
  assert.equal(hasLineBreak('ab'), false);
});

test('collapsePaste() gives a token and expandPastes() restores the bytes exactly', () => {
  const original = 'line 1\nline 2\nline 3';
  const collapsed = collapsePaste(original);
  assert.equal(collapsed.text, '[pasted 3 lines #0]');
  assert.equal(collapsed.collapsed, true);
  assert.equal(collapsed.id, 0);
  assert.equal(collapsed.lines, 3);
  assert.deepEqual(collapsed.entries, [{ id: 0, text: original }]);
  assert.equal(expandPastes(collapsed.text, collapsed.entries), original);

  // Every line-ending shape survives the round trip, bytes and all.
  for (const sample of ['a\nb', 'a\r\nb\r\n', 'a\rb\r', 'a\nb\n\n', 'trailing spaces  \nend']) {
    const round = collapsePaste(sample);
    assert.equal(expandPastes(round.text, round.entries), sample, `round trip lost bytes for ${JSON.stringify(sample)}`);
  }

  // Not a paste: the text is handed straight back and nothing is recorded.
  const plain = collapsePaste('one line');
  assert.equal(plain.text, 'one line');
  assert.equal(plain.collapsed, false);
  assert.equal(plain.id, null);
  assert.deepEqual(plain.entries, []);

  // A token whose id is unknown is left as written — text the user typed by hand.
  assert.equal(expandPastes('[pasted 9 lines #42]', []), '[pasted 9 lines #42]');
});

test('collapsePaste() gives each paste its own id, and never reuses a freed one', () => {
  const first = collapsePaste('a\nb');
  const second = collapsePaste('c\nd', PASTE_THRESHOLD, first.entries);
  assert.equal(first.text, '[pasted 2 lines #0]');
  assert.equal(second.text, '[pasted 2 lines #1]', 'the ids are distinct');
  assert.equal(nextPasteId([]), 0);
  assert.equal(nextPasteId([{ id: 7, text: 'x' }]), 8, 'one past the highest live id');

  // Monotonic: dropping the highest entry does not hand its id to the next paste.
  assert.equal(nextPasteId([{ id: 3, text: 'x' }, { id: 9, text: 'y' }]), 10);
  assert.equal(nextPasteId([{ id: 9, text: 'y' }, { id: 3, text: 'x' }]), 10, 'order does not matter');
});

test('formatPasteToken() spells the count out, singular included', () => {
  assert.equal(formatPasteToken(1, 0), '[pasted 1 line #0]');
  assert.equal(formatPasteToken(3, 2), '[pasted 3 lines #2]');
  assert.equal(formatPasteToken(0, 5), '[pasted 0 lines #5]');
  // The pattern the editor and the expander share reads back what the formatter wrote.
  assert.deepEqual(pasteTokenIds('[pasted 2 lines #4] and [pasted 1 line #9]'), [4, 9]);
  assert.match('[pasted 2 lines #4]', PASTE_TOKEN_RE);
});

test('createPasteRegistry() keeps the table, restores bytes, and shrinks with the box', () => {
  const pastes = createPasteRegistry();
  const original = 'a\nb\nc';

  const collapsed = pastes.collapse(original);
  assert.equal(collapsed.text, '[pasted 3 lines #0]');
  assert.equal(collapsed.collapsed, true);
  assert.equal(pastes.expand(collapsed.text), original);
  assert.deepEqual(pastes.all, [{ id: 0, text: original }]);

  // A second paste coexists with the first.
  const second = pastes.collapse('x\ny');
  assert.equal(second.text, '[pasted 2 lines #1]');
  assert.equal(pastes.expand('[pasted 3 lines #0] + [pasted 2 lines #1]'), `${original} + x\ny`);

  // Plain text is not a paste: nothing recorded.
  assert.equal(pastes.collapse('one line').collapsed, false);
  assert.equal(pastes.all.length, 2);

  // Removing a token from the box shrinks the table, and the freed id is not reused.
  assert.deepEqual(pastes.prune('[pasted 3 lines #0]'), [1]);
  assert.deepEqual(pastes.all, [{ id: 0, text: original }]);
  assert.equal(pastes.collapse('p\nq').id, 2, 'a new paste takes a fresh id');
  assert.equal(pastes.forget(0), true, 'a single entry can be dropped by id');
  assert.deepEqual(pastes.all, [{ id: 2, text: 'p\nq' }]);
  assert.equal(pastes.forget(99), false, 'an unknown id is not an error');
});

test('createPasteIntake() swallows the chunk it collapses, and leaves other chunks alone', () => {
  const listeners = new Map();
  const program = {
    on: (type, handler) => listeners.set(type, handler),
    removeListener: (type) => listeners.delete(type),
  };
  const screen = { lockKeys: false, on() {} };
  const seen = [];
  const intake = createPasteIntake({ program, screen, onPaste: (text) => seen.push(text) });

  assert.equal(intake.enabled, true);
  assert.equal(intake.attached, true);

  // Ordinary typing is not a paste: no callback, and no keyboard lock taken.
  listeners.get('data')('hello');
  assert.deepEqual(seen, []);
  assert.equal(screen.lockKeys, false, 'ordinary typing never locks the keyboard');

  // A paste is handed over stripped of its transport markers, and the keyboard is leased
  // for the chunk so the burst it would become never reaches the box.
  listeners.get('data')('\x1b[200~a\nb\x1b[201~');
  assert.deepEqual(seen, ['a\nb']);
  assert.equal(screen.lockKeys, true, 'the chunk is swallowed by a keyboard lease');
  assert.equal(keyboardHeldBy(KEYBOARD_OWNER_PASTE), true);

  // The lease is a one-chunk lease: it goes on the microtask, after the burst is gated.
  return flush().then(() => {
    assert.equal(screen.lockKeys, false, 'the lease is released at the end of the event');
    assert.equal(keyboardHeldBy(KEYBOARD_OWNER_PASTE), false);

    // close() detaches, and a detached catcher sees nothing more.
    assert.equal(intake.close(), true);
    assert.equal(intake.close(), false, 'closing twice is a no-op');
    assert.equal(intake.attached, false);
  });
});

test('createPasteIntake() without a program or a callback is a harmless no-op', () => {
  const inert = createPasteIntake({});
  assert.equal(inert.enabled, false);
  assert.equal(inert.attach(), false);
  assert.equal(inert.close(), false);
  assert.doesNotThrow(() => createPasteIntake({ program: { on() {} }, onPaste: null }).close());
});

test('a paste token is one unit under the caret, so it is crossed and deleted whole', () => {
  const editor = createPromptEditor({ value: 'see [pasted 3 lines #0] end' });
  const spans = editor.tokens();
  assert.equal(spans.length, 1);
  assert.deepEqual({ start: spans[0].start, end: spans[0].end }, { start: 4, end: 23 });

  // left() crosses the whole token rather than stepping through its characters.
  editor.moveTo(spans[0].end);
  editor.left();
  assert.equal(editor.caret, 4, 'the caret jumped to the token start');
  editor.right();
  assert.equal(editor.caret, 23, 'and forward to its end');

  // A backspace at the token's end removes the whole token, never one character of it.
  editor.moveTo(23);
  assert.equal(editor.backspace(), true);
  assert.equal(editor.value, 'see  end', 'the whole token went, not one character');
  assert.equal(editor.tokens().length, 0);

  // deleteForward at the token's start does the same.
  const forward = createPromptEditor({ value: 'a [pasted 2 lines #1] b' });
  forward.moveTo(2);
  assert.equal(forward.deleteForward(), true);
  assert.equal(forward.value, 'a  b');
});

test('a multi-line paste lands as a token and the box keeps reading, on a real TUI', async () => {
  await withArmedTui(async (tui, armed) => {
    const pasted = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;';
    tui.inputBox.screen.program.input.write(pasted);
    await flush();

    assert.equal(tui.inputBox.getValue(), '[pasted 5 lines #0]', 'the box shows a token, not the bytes');
    assert.equal(tui.promptInput.isReading, true, 'the box is still reading after the paste');
    assert.equal(tui.promptInput.isArmed, true, 'and the question is still armed');
    assert.deepEqual(tui.pastes, [{ id: 0, text: pasted }], 'the bytes are kept verbatim');
    assert.match(visible(tui), /pasted 5 lines/, 'the notice reached the transcript');

    // Typing continues where the caret is: the paste is not the end of the message.
    tui.inputBox.screen.program.input.write('review this');
    await flush();
    assert.equal(tui.inputBox.getValue(), '[pasted 5 lines #0]review this');

    // Submitting expands the token back to the exact bytes.
    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await armed, `${pasted}review this`, 'the model receives the bytes that were pasted');

    armed.then(() => {}, () => {});
  });
});

test('a CRLF or CR-only paste never submits halfway through, on a real TUI', async () => {
  await withArmedTui(async (tui, armed) => {
    // The reported defect: a Windows-copied block carries \r\n, and the \r used to be read
    // as Enter, sending the first line alone while the rest was lost.
    tui.inputBox.screen.program.input.write('a\r\nb\r\nc\r\n');
    await flush();
    assert.equal(tui.inputBox.getValue(), '[pasted 3 lines #0]');
    assert.equal(tui.promptInput.isArmed, true, 'the message was not sent on the first line');

    // A lone-CR paste is the same shape.
    tui.inputBox.screen.program.input.write('x\ry\rz\r');
    await flush();
    assert.equal(tui.inputBox.getValue(), '[pasted 3 lines #0][pasted 3 lines #1]');
    assert.equal(tui.promptInput.isArmed, true);
    assert.equal(tui.pastes.length, 2, 'both pastes are held');

    // Deleting the second token shrinks the table to the one still in the box.
    const keys = tui.promptInput.keys;
    keys.editor.setValue('[pasted 3 lines #0]');
    keys.publish();
    await flush();
    assert.deepEqual(tui.pastes, [{ id: 0, text: 'a\r\nb\r\nc\r\n' }], 'the deleted token dropped its bytes');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await armed, 'a\r\nb\r\nc\r\n', 'the surviving paste crosses byte-for-byte');
    armed.then(() => {}, () => {});
  });
});

test('a paste arrives mid-turn as a token too, and the queued text is the bytes', async () => {
  await withTui(async (tui) => {
    tui.startSpinner();
    await flush();

    tui.inputBox.screen.program.input.write('first\nsecond\nthird');
    await flush();
    assert.equal(tui.inputBox.getValue(), '[pasted 3 lines #0]');
    assert.equal(tui.promptInput.isReading, true, 'a paste mid-turn does not end the read cycle');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    await flush();
    assert.equal(tui.queuedCount, 1);
    assert.equal(tui.queued[0].text, 'first\nsecond\nthird', 'the queue holds the pasted bytes');
    tui.stopSpinner();
  });
});

test('the intake is silent when the box is not armed, and never eats ordinary keys', async () => {
  const input = fakeTty();
  const output = fakeTty();
  const { createTui } = await import('../app/tui.js');
  const tui = createTui({ input, output, clipboardDir: '/tmp', modelLabel: 'paste-probe' });
  await flush();

  // With no armed question and no turn in flight the box is not reading, so a paste has
  // nowhere to land: the intake still swallows it rather than corrupting a widget nobody
  // is listening to, and typing afterwards is unaffected.
  input.write('a\nb\n');
  await flush();
  assert.equal(tui.pastes.length, 0, 'nothing is recorded when the box is not reading');

  input.write('plain text');
  await flush();
  assert.equal(tui.inputBox.getValue(), '', 'the ordinary keys were never eaten by the catcher');
  assert.equal(tui.pasteIntake.attached, true);

  tui.close();
  assert.equal(tui.pasteIntake.attached, false, 'close() detaches the catcher');
  input.destroy();
  output.destroy();
});
