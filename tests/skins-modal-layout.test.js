import test from 'node:test';
import assert from 'node:assert/strict';

import { openSkinModal } from '../app/skin-modal.js';
import {
  modalBoxSize, modalInterior, fitModalRows, fitRow, visibleWidth,
} from '../app/skin-modal-layout.js';
import {
  claimKeyboard, releaseKeyboard, releaseKeyboardLater, keyboardHeld,
  keyboardHeldBy, KEYBOARD_OWNER_MODAL, KEYBOARD_OWNER_EVENT,
} from '../app/keyboard-ownership.js';
import { withTui, fakeTty } from './support/tui-harness.js';

/**
 * `/skins prompt` (`docs/interface/skins`), the **layout** half of the modal: the box
 * fits the terminal it is on, the body is refitted when the terminal changes, and the
 * actions are never pushed off the bottom of the box.
 *
 * The defect this pins: the modal was `width: '80%'`, `height: '60%'` and its body
 * was wrapped **by width only**. The body is taller than 60% of an ordinary terminal,
 * so blessed clipped the overflow and the **action list was pushed off the bottom of
 * the box** — a picker whose actions cannot be seen is a picker that cannot be used,
 * however well the arrow keys behave. The keyboard half (the lease) lives in
 * `tests/skins-modal-ownership.test.js`.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A proposal with the whole palette, so the preview is as tall as it ever gets. */
const fullSkin = {
  name: 'sunset',
  palette: {
    user: 'bright-cyan', tool: 'yellow', intent: 'bright-blue', context: 'magenta',
    error: 'red', notice: 'grey', tracking: 'bright-green', refusal: 'bright-red',
    frame: 'cyan', table: 'cyan', code: 'bright-cyan', quote: 'bright-white',
    bullet: 'green', heading: 'default', toolRead: 'bright-cyan', toolWrite: 'green',
    toolBash: 'yellow',
  },
};

/** The rows of the painted body, with the colour escapes stripped. */
const plainRows = (box) => box.getContent().replace(/\x1b\[[\d;]*m/g, '').split('\n');

test('the box is sized to the terminal, and never wider or taller than it', () => {
  // The rule the percentages broke: the size comes from the live screen.
  assert.deepEqual(modalBoxSize({ columns: 80, rows: 24 }), { width: 64, height: 14 });
  assert.deepEqual(modalBoxSize({ columns: 120, rows: 40 }), { width: 96, height: 24 });

  // A terminal too small for the fraction still gets a usable box, and the box is
  // never larger than the terminal that holds it.
  for (const [columns, rows] of [[80, 24], [60, 20], [40, 12], [30, 8], [20, 5]]) {
    const size = modalBoxSize({ columns, rows });
    assert.ok(size.width <= columns, `the box is wider than the terminal: ${size.width} > ${columns}`);
    assert.ok(size.height <= rows, `the box is taller than the terminal: ${size.height} > ${rows}`);
  }

  // The interior is what the content actually has: the border and the padding are
  // not content.
  assert.deepEqual(modalInterior({ width: 64, height: 14 }), { rows: 12, columns: 60 });
});

test('the actions are reserved, and the preview is what gets cut', () => {
  const body = [
    'request: a warm sunset',
    'skin: sunset',
    'palette   user:bright-cyan  tool:yellow',
    'palette   intent:bright-blue  context:magenta',
    'tokens    border:?  brand:?  hint:?',
    '',
    'name: sunset',
    'type to rename',
  ];
  const actions = ['> Apply for this session', '  Apply and save', '  Cancel'];

  // Everything fits: nothing is cut.
  const roomy = fitModalRows({ body, actions, room: 20 });
  assert.deepEqual(roomy, [...body, ...actions]);

  // A short box: the actions survive whole, the request survives, and the preview is
  // the part that goes — with a row that says how much went.
  const tight = fitModalRows({ body, actions, room: 8 });
  assert.ok(tight.length <= 8, 'the body fits the room it was given');
  assert.equal(tight.filter((row) => row.includes('Apply')).length, 2, 'both apply rows survive');
  assert.ok(tight.some((row) => row.includes('Cancel')), 'Cancel survives');
  assert.ok(tight.some((row) => row.startsWith('request:')), 'the request survives');
  assert.ok(tight.some((row) => row.includes('name: sunset')), 'the name survives');
  assert.ok(tight.some((row) => row.startsWith('…')), 'and the cut is announced');

  // A box with no room for the actions at all keeps the first ones: they are the
  // ones a user reaches for.
  const tiny = fitModalRows({ body, actions, room: 2 });
  assert.equal(tiny.length, 2);
});

test('a row is cut to the width, between graphemes, and its tags are closed', () => {
  // A tag costs no cells, so the row is measured by its text.
  assert.equal(visibleWidth('{cyan-fg}hello{/cyan-fg}'), 5);
  assert.equal(visibleWidth('hello'), 5);

  // A row that fits is left alone, tags and all.
  assert.equal(fitRow('{cyan-fg}hello{/cyan-fg}', 10), '{cyan-fg}hello{/cyan-fg}');

  // A row that does not fit is cut, and the ellipsis is charged to the budget.
  const cut = fitRow('abcdefghij', 5);
  assert.equal(visibleWidth(cut), 5, 'the cut row is exactly as wide as the room');

  // A tag that was open when the cut fell is closed, so the colour does not run on.
  const tagged = fitRow('{cyan-fg}abcdefghij{/cyan-fg}', 5);
  assert.ok(tagged.endsWith('{/cyan-fg}'), `the open tag was not closed: ${tagged}`);
  assert.equal(visibleWidth(tagged), 5);
});

test('the actions are on the screen, at every terminal size', async () => {
  // The defect this pins: the action list was clipped off the bottom of the box at
  // most sizes, so the user could not see what the modal was offering them.
  for (const [columns, rows] of [[80, 24], [120, 40], [60, 20], [40, 12]]) {
    const input = fakeTty({ columns, rows });
    const output = fakeTty({ columns, rows });
    const chunks = [];
    output.on('data', (chunk) => chunks.push(chunk.toString()));
    const blessed = (await import('neo-blessed')).default;
    const screen = blessed.screen({ input, output, smartCSR: false, fullUnicode: true });

    try {
      openSkinModal({
        screen,
        proposer: async () => fullSkin,
        request: 'a warm sunset',
        refresh: () => screen.render(),
      });
      await flush();
      await flush();
      screen.render();
      await flush();

      const box = screen.children.at(-1);
      const painted = plainRows(box);
      assert.ok(
        painted.length <= box.height - 2,
        `at ${columns}x${rows} the body is ${painted.length} rows in a box of ${box.height - 2}`,
      );
      assert.ok(
        painted.some((row) => row.includes('Apply for this session')),
        `at ${columns}x${rows} the actions are not on the screen`,
      );
      assert.ok(
        painted.some((row) => row.includes('Cancel')),
        `at ${columns}x${rows} Cancel is not on the screen`,
      );
    } finally {
      screen.destroy();
      input.destroy();
      output.destroy();
    }
  }
});

test('a resize refits the box and the body to the new terminal', async () => {
  // The defect this pins: the box was a percentage of the screen, so it kept the
  // size of the terminal it was opened on, and the body was never re-wrapped — the
  // preview ran past the edge and the actions could be pushed out of a box that had
  // become shorter.
  const input = fakeTty({ columns: 120, rows: 40 });
  const output = fakeTty({ columns: 120, rows: 40 });
  const blessed = (await import('neo-blessed')).default;
  const screen = blessed.screen({ input, output, smartCSR: false, fullUnicode: true });

  try {
    openSkinModal({
      screen,
      proposer: async () => fullSkin,
      request: 'a warm sunset',
      refresh: () => screen.render(),
    });
    await flush();
    await flush();

    const box = screen.children.at(-1);
    const wide = box.width;
    assert.ok(wide > 60, `the box opened wide: ${wide}`);

    // The terminal gets much smaller.
    screen.program.cols = 60;
    screen.program.rows = 20;
    screen.emit('resize');
    await flush();
    await flush();

    assert.ok(box.width < wide, `the box followed the terminal: ${box.width} is not below ${wide}`);
    assert.equal(box.width, modalBoxSize({ columns: 60, rows: 20 }).width);
    assert.equal(box.height, modalBoxSize({ columns: 60, rows: 20 }).height);

    const painted = plainRows(box);
    assert.ok(painted.length <= box.height - 2, 'the body fits the box it was refitted to');
    assert.ok(painted.some((row) => row.includes('Apply for this session')), 'the actions are still there');
    for (const row of painted) {
      assert.ok(
        visibleWidth(row) <= box.width - 4,
        `a row is wider than the box: ${row}`,
      );
    }
  } finally {
    screen.destroy();
    input.destroy();
    output.destroy();
  }
});

test('the modal owns the keyboard, and the host stands down for it', async () => {
  // The defect this pins: the modal locked blessed's own dispatch, but the host's
  // program-level listener (app/tui-keys.js) answered Escape and Tab on the very
  // same keys. So Escape cancelled the modal *and* aborted the running turn, and
  // Tab moved the modal's focus *and* cycled the session mode.
  let interrupts = 0;
  let cycles = 0;
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();
    await flush();

    assert.equal(keyboardHeldBy(KEYBOARD_OWNER_MODAL), true, 'the modal holds the keyboard');
    assert.equal(tui.screen.lockKeys, true, 'and the screen dispatch is locked');

    // Tab is the modal's: it moves the focus and the host does not hear it.
    tui.screen.program.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    assert.equal(cycles, 0, 'Tab did not cycle the session mode');
    assert.equal(tui.screen.children.at(-1).state().focus, 'actions', 'Tab moved the modal focus');

    // Escape is the modal's: it cancels the modal and the host does not hear it.
    tui.screen.program.emit('keypress', '\x1b', { name: 'escape', full: 'escape' });
    await flush();
    assert.equal(interrupts, 0, 'Escape did not abort the turn');
    assert.equal(await answer, null, 'and the modal was cancelled');

    // The lease is gone once the event is over, so the host may take the keyboard again.
    await flush();
    assert.equal(keyboardHeldBy(KEYBOARD_OWNER_MODAL), false, 'the modal let go of the keyboard');
  }, {
    onInterrupt: () => { interrupts += 1; },
    onCycleMode: () => { cycles += 1; },
  });
});

test('a lease is released at the end of the event, not in the middle of it', () => {
  // The rule that makes the ownership total: the key that closed the modal is still
  // travelling through the program's listeners, and the modal is still its owner
  // until they have all seen it.
  const screen = { lockKeys: false };
  const lease = claimKeyboard({ screen, label: KEYBOARD_OWNER_MODAL });
  assert.equal(screen.lockKeys, true, 'the lease locks the screen');
  assert.equal(keyboardHeld(), true);

  let released = false;
  releaseKeyboardLater(lease, { defer: (fn) => { released = true; fn(); } });
  assert.equal(released, true, 'the release was scheduled');
  assert.equal(screen.lockKeys, false, 'and the lock went with it');
  assert.equal(keyboardHeld(), false);

  // A lease that is released twice is ignored: the ledger never goes negative.
  assert.equal(releaseKeyboard(lease), false);
});

test('two screens hold their own keyboard leases', () => {
  // The ledger is per screen: one screen's lock must never restore another's.
  const first = { lockKeys: false };
  const second = { lockKeys: false };
  const a = claimKeyboard({ screen: first, label: KEYBOARD_OWNER_MODAL });
  const b = claimKeyboard({ screen: second, label: KEYBOARD_OWNER_EVENT });

  assert.equal(first.lockKeys, true);
  assert.equal(second.lockKeys, true);

  releaseKeyboard(a);
  assert.equal(first.lockKeys, false, 'the first screen was released');
  assert.equal(second.lockKeys, true, 'and the second one was left alone');

  releaseKeyboard(b);
  assert.equal(second.lockKeys, false);
  assert.equal(keyboardHeld(), false);
});
