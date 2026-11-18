import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInputHint,
  formatLastPromptHint,
  HINT_COLOR,
  HINT_MAX_CHARS,
  LAST_PROMPT_LABEL,
} from '../app/input-hint.js';
import { withTui } from './support/tui-harness.js';

/**
 * The "Last prompt: …" hint over an empty input box (task-backlog: "if the input
 * box is empty, it should have a grayed italic text saying 'Last prompt: .......'").
 *
 * Two halves, both proven here:
 *  - the formatting and the value/content rule are pure (`app/input-hint.js`), and
 *  - the hint really appears on the box of the live TUI, disappears with the first
 *    keystroke and never becomes a submitted value.
 *
 * neo-blessed has no italic attribute, so the hint ships as the greyed part of
 * "grayed italic"; that is asserted rather than hidden.
 */

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Type `text` the way neo-blessed does and press Enter.
 *
 * `setValue()` is used rather than assigning `value`: neo-blessed's textarea
 * replaces its content through `setValue()` on every render, which is what keeps
 * `_value` in sync — and `setValue()` is a no-op while `value === _value`, so
 * skipping it would leave the box holding the old text after a submit.
 */
const typeAndEnter = async (tui, text) => {
  await flush();
  tui.inputBox.setValue(text);
  tui.inputBox.submit();
  await flush();
};

/** A stand-in for the blessed box: a value, a content and a style. */
function stubBox(value = '') {
  return {
    value,
    content: value,
    style: { fg: null },
    getValue() { return this.value; },
    setValue(next) { this.value = next; this.content = next; },
    clearValue() { this.setValue(''); },
    getContent() { return this.content; },
    setContent(text) { this.content = text; },
    on() {},
  };
}

test('formatLastPromptHint() labels the prompt and flattens it to one line', () => {
  assert.equal(LAST_PROMPT_LABEL, 'Last prompt: ');
  assert.equal(formatLastPromptHint('fix the parser'), 'Last prompt: fix the parser');

  // a multi-line prompt still fits on the one row the box has
  assert.equal(formatLastPromptHint('one\ntwo   three'), 'Last prompt: one two three');
  // control characters are stripped, like every other piece of text on screen
  assert.equal(formatLastPromptHint('a\x1b[31mb'), 'Last prompt: ab');

  // a long prompt is truncated with an ellipsis, never grown past the cap
  const long = formatLastPromptHint('x'.repeat(300));
  assert.equal(long.length, LAST_PROMPT_LABEL.length + HINT_MAX_CHARS);
  assert.equal(long.endsWith('…'), true);
  assert.equal(long, formatLastPromptHint('x'.repeat(300), HINT_MAX_CHARS));

  // nothing to remind: a blank or absent prompt shows no hint at all
  assert.equal(formatLastPromptHint(''), '');
  assert.equal(formatLastPromptHint('   \n  '), '');
  assert.equal(formatLastPromptHint(undefined), '');
});

test('createInputHint() paints over an empty box only, and never the value', () => {
  const box = stubBox('');
  const hint = createInputHint({ inputBox: box });

  // nothing was sent yet: an empty box shows nothing
  assert.equal(hint.apply(), null);
  assert.equal(box.getContent(), '');
  assert.equal(box.style.fg, null);

  // the first prompt settles: the hint takes the empty box, greyed
  assert.equal(hint.note('read the layout'), 'read the layout');
  assert.equal(box.getValue(), '', 'the hint is content, never the value');
  assert.equal(box.getContent(), 'Last prompt: read the layout');
  assert.equal(box.style.fg, HINT_COLOR);
  assert.equal(hint.hint, 'Last prompt: read the layout');

  // typing takes the hint down: the box shows its own text in its own colour
  box.setValue('next question');
  assert.equal(hint.apply(), null);
  assert.equal(box.getContent(), 'next question');
  assert.equal(box.style.fg, null, 'the normal colour is restored');
  assert.equal(hint.hint, null);

  // emptying the box brings the very same hint back
  box.clearValue();
  assert.match(hint.apply(), /^Last prompt: read the layout$/);
  assert.equal(box.style.fg, HINT_COLOR);

  // a blank prompt and the exit sentinel are not prompts: the hint stays put
  assert.equal(hint.note('   '), 'read the layout');
  assert.equal(hint.note('exit'), 'read the layout');
  assert.equal(hint.lastPrompt, 'read the layout');
  assert.equal(hint.note(undefined), 'read the layout');

  // ...while a real one replaces it
  hint.note('and now the tests');
  assert.equal(box.getContent(), 'Last prompt: and now the tests');
});

test('createInputHint() without a box is a harmless no-op', () => {
  const hint = createInputHint();
  assert.equal(hint.apply(), null);
  assert.equal(hint.text(), '');
  hint.note('still nothing to paint');
  assert.equal(hint.lastPrompt, 'still nothing to paint');
  assert.equal(hint.apply(), null);
});

test('an empty box shows the last prompt, and any keystroke replaces the hint', async () => {
  await withTui(async (tui) => {
    // nothing sent yet: an empty box is empty
    assert.equal(tui.inputBox.getValue(), '');
    assert.equal(tui.inputBox.getContent(), '');
    assert.equal(tui.hint, null);

    // the loop asks, the user answers: the box is empty again and now reminds
    const armed = tui.question('> ');
    await typeAndEnter(tui, 'explain the transcript scroll');
    assert.equal(await armed, 'explain the transcript scroll');
    await flush();

    assert.equal(tui.inputHint.lastPrompt, 'explain the transcript scroll');
    assert.equal(tui.hint, 'Last prompt: explain the transcript scroll');
    assert.equal(tui.inputBox.getContent(), 'Last prompt: explain the transcript scroll');
    assert.equal(tui.inputBox.getValue(), '', 'the hint is display only');
    assert.equal(tui.inputBox.style.fg, 'grey', 'the hint is greyed out');

    // the next question arms the box (the loop asks again), and the hint stays
    const next = tui.question('> ');
    await flush();
    assert.equal(tui.inputBox._reading, true, 'the box reads a keystroke again');
    assert.equal(tui.hint, 'Last prompt: explain the transcript scroll');

    // one keystroke and the hint is gone, the typed text is not
    tui.inputBox.emit('keypress', 'h', { name: 'h', full: 'h' });
    await flush();
    assert.equal(tui.hint, null);
    assert.equal(tui.inputBox.getValue(), 'h');
    assert.equal(tui.inputBox.getContent(), 'h');
    assert.equal(tui.inputBox.style.fg, null, 'the normal colour is back');

    // ...and emptying the box brings the reminder back
    tui.inputBox.clearValue();
    await flush();
    assert.equal(tui.hint, 'Last prompt: explain the transcript scroll');

    // the armed question still resolves with what was typed
    tui.inputBox.setValue('done');
    tui.inputBox.submit();
    assert.equal(await next, 'done');
  });
});

test('a prompt queued during a turn is not the last prompt until it is sent', async () => {
  await withTui(async (tui) => {
    tui.startSpinner();
    await flush();

    // a submission while a request is in flight is queued, so the box is empty
    // again straight away: it must not claim to be the last prompt yet
    await typeAndEnter(tui, 'while you were out');
    assert.equal(tui.queuedCount, 1);
    assert.equal(tui.hint, null, 'a queued message is not a sent prompt yet');

    // the loop drains it between turns; it becomes a prompt when it settles the
    // next question
    assert.equal(tui.dequeue(), 'while you were out');
    const armed = tui.question('> ');
    await flush();
    assert.equal(tui.hint, null);

    await typeAndEnter(tui, 'and this one');
    assert.equal(await armed, 'and this one');
    await flush();
    assert.equal(tui.hint, 'Last prompt: and this one');
  });
});
