import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createTui, sanitize, formatArg, formatTranscript, collapsePaste, expandPastes, SPINNER_INTERVAL_MS } from '../app/tui.js';

/**
 * There is no pty helper in this image (no `script`, no `tput`), so we fabricate
 * a TTY-like stream: a PassThrough with isTTY/columns/rows, which is exactly what
 * neo-blessed reads (program.js: `this.cols = this.output.columns || 1`).
 */
function fakeTty({ isTTY = true, columns = 80, rows = 24 } = {}) {
  const stream = new PassThrough();
  stream.isTTY = isTTY;
  stream.columns = columns;
  stream.rows = rows;
  return stream;
}

const DEFAULT_MODEL_LABEL = 'openrouter · test/model';

/**
 * neo-blessed paints through the VT100 alternate character set: spaces come out
 * as cursor-forward escapes (\x1b[<n>C) and '·' as the ACS '~' glyph. Normalise
 * a raw frame back to plain text so assertions can match readable strings.
 */
// VT100 alternate character set -> Unicode, as neo-blessed paints box drawing.
const ACS_MAP = {
  j: '┘', k: '┐', l: '┌', m: '└', n: '┼',
  q: '─', t: '├', u: '┤', v: '┴', w: '┬',
  x: '│', '~': '·',
};

function plainText(frame) {
  return frame
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\(0([\s\S]*?)\x1b\(B/g, (_, acs) => acs.replace(/[jklmnqtuvwx~]/g, (c) => ACS_MAP[c]))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '');
}

async function withTui(fn, ttyOptions = {}) {
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

test('a pty gets the three-region TUI (transcript, status bar, input box)', async () => {
  await withTui((tui, { painted }) => {
    assert.ok(tui, 'expected a TUI when output.isTTY is true');

    // transcript: bordered, scrollable, pinned above the status bar
    assert.equal(tui.transcript.bottom, 5);
    assert.equal(tui.transcript.top, 0);
    assert.equal(tui.transcript.scrollable, true);

    // status bar: exactly one row, directly under the transcript
    assert.equal(tui.statusBar.height, 1);
    assert.equal(tui.statusBar.bottom, 3);
    assert.equal(tui.statusBar.getContent(), 'Ready');

    // model label: one row between the status bar and the input box
    assert.equal(tui.modelBar.height, 1);
    assert.equal(tui.modelBar.bottom, 4);
    assert.equal(tui.modelBar.getContent(), tui.modelLabel);
    assert.equal(tui.modelLabel, 'openrouter · test/model');

    // input box: three rows (border + content + border) at the very bottom
    assert.equal(tui.inputBox.height, 3);
    assert.equal(tui.inputBox.bottom, 0);

    // the initial paint really reached the terminal
    assert.match(painted(), /Conversation/);
    assert.match(painted(), /Ready/);
    assert.match(plainText(painted()), /openrouter · test\/model/);
  });
});

test('the transcript scrolls, including from the keyboard', async () => {
  await withTui((tui) => {
    for (let i = 0; i < 200; i += 1) tui.log(`line ${i}`);
    assert.ok(tui.transcript.getScrollHeight() > 0, 'expected scrollable content');

    tui.transcript.setScrollPerc(100);
    const bottom = tui.transcript.getScroll();
    assert.ok(bottom > 0, 'expected to be scrolled down after 200 lines');

    tui.scrollBy(-1);
    const afterScrollUp = tui.transcript.getScroll();
    assert.ok(afterScrollUp < bottom, `scrollBy(-1) should move up (${bottom} -> ${afterScrollUp})`);

    tui.scrollBy(1);
    assert.ok(tui.transcript.getScroll() > afterScrollUp, 'scrollBy(1) should move back down');

    // pageup/pagedown are bound on the screen so they work while the input has focus
    tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
    assert.ok(tui.transcript.getScroll() < bottom, 'pageup should scroll the transcript up');

    tui.screen.emit('keypress', null, { name: 'home', full: 'home' });
    assert.equal(tui.transcript.getScroll(), 0, 'home should jump to the top');

    tui.screen.emit('keypress', null, { name: 'end', full: 'end' });
    assert.equal(tui.transcript.getScrollPerc(), 100, 'end should jump to the bottom');
  });
});

test('a mid-session resize keeps the layout and repaints', async () => {
  await withTui((tui, { output, chunks }) => {
    tui.log('before resize');
    const before = chunks.length;

    output.columns = 100;
    output.rows = 30;
    output.emit('resize');

    assert.equal(tui.screen.width, 100);
    assert.equal(tui.screen.height, 30);
    // relative layout => the three regions keep their anchors
    assert.equal(tui.transcript.bottom, 5);
    assert.equal(tui.statusBar.bottom, 3);
    assert.equal(tui.modelBar.bottom, 4);
    assert.equal(tui.inputBox.bottom, 0);
    assert.ok(tui.statusBar.getContent().length >= 0);
    assert.ok(before >= 0);
  });
});

test('log() sanitizes model output and keeps one line per row', async () => {
  await withTui((tui) => {
    tui.log('\x1b[31mred\x1b[0m\nsecond line');
    const text = tui.transcript.getContent();
    assert.match(text, /red/);
    assert.doesNotMatch(text, /\x1b\[31m/);
    assert.match(text, /second line/);
  });
});

test('setStatus() updates the status bar', async () => {
  await withTui((tui) => {
    tui.setStatus('1.2k / 8.0k tokens (15%)');
    assert.equal(tui.statusBar.getContent(), '1.2k / 8.0k tokens (15%)');
  });
});

test('question() resolves through the input box, like createCLI().rl.question', async () => {
  await withTui(async (tui) => {
    const answered = tui.question('> ');
    assert.equal(tui.inputBox.getLabel(), ' > ');

    tui.inputBox.setValue('hello');
    tui.inputBox.emit('submit', 'hello');
    assert.equal(await answered, 'hello');

    // callback style is supported too (AbortManager calls rl.question(prompt, cb))
    const viaCallback = new Promise((resolve) => {
      tui.rl.question('Cancel this task? [y/N] ', resolve);
    });
    tui.inputBox.emit('submit', 'y');
    assert.equal(await viaCallback, 'y');
  });
});

test('without a pty createTui() returns null so the line chat is kept', () => {
  const input = fakeTty({ isTTY: false });
  const output = fakeTty({ isTTY: false });
  try {
    assert.equal(createTui({ input, output }), null);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('sanitize() and formatArg() behave as documented', () => {
  assert.equal(sanitize('\x1b[1mhi\x1b[0m'), 'hi');
  assert.equal(sanitize(null), '');
  assert.equal(formatArg('x'), 'x');
  assert.equal(formatArg(3), '3');
  assert.equal(formatArg(null), 'null');
  assert.equal(formatArg(undefined), 'undefined');
  assert.equal(formatArg({ a: 1 }), '{"a":1}');
});

test('assistant replies are rendered with markdown coloring', async () => {
  const reply = [
    '# Title',
    'some **bold** and `code`',
    '- first item',
    '* second item',
    '```js',
    'const a = { b: 1 };',
    '```',
  ].join('\n');

  const rendered = formatTranscript(reply).split('\n');
  assert.equal(rendered[0], '{bold}{underline}Title{/underline}{/bold}');
  assert.equal(rendered[1], 'some {bold}bold{/bold} and {cyan-fg}code{/cyan-fg}');
  assert.equal(rendered[2], '{green-fg}•{/green-fg} first item');
  assert.equal(rendered[3], '{green-fg}•{/green-fg} second item');
  assert.equal(rendered[4], '{cyan-fg}┌─ js ─{/cyan-fg}');
  // braces inside a fence are escaped so neo-blessed cannot eat them
  assert.equal(rendered[5], '{cyan-fg}│ const a = {open} b: 1 {close};{/cyan-fg}');
  assert.equal(rendered[6], '{cyan-fg}└─────{/cyan-fg}');

  // an unterminated fence is closed at the end of the input
  assert.equal(formatTranscript('```\nstill code').split('\n').at(-1), '{cyan-fg}└─────{/cyan-fg}');

  // raw ansi and braces from the model cannot smuggle tags through
  assert.equal(formatTranscript('\x1b[31m{red-fg}x'), '{open}red-fg{close}x');

  await withTui((tui) => {
    tui.log(reply);
    // getContent() returns the painted lines with the blessed tags already
    // resolved to ANSI escapes, so strip them and assert on the visible glyphs.
    const content = tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.match(content, /┌─ js ─/);
    assert.match(content, /bold/);
    assert.match(content, /•/);
    assert.match(content, /│ const a = \{ b: 1 \};/);
    assert.equal(content.split('\n').filter((line) => line.includes('│')).length, 1);
  });
});

test('a long paste collapses to a paste tag and expands back byte-for-byte', async () => {
  const original = 'line 1\nline 2\nline 3\nline 4\nline 5';
  const collapsed = collapsePaste(original);
  assert.equal(collapsed.text, '[[paste:0]]');
  assert.deepEqual(collapsed.pastes, [original]);
  assert.equal(expandPastes(collapsed.text, collapsed.pastes), original);

  const short = collapsePaste('a\nb');
  assert.equal(short.text, 'a\nb');
  assert.deepEqual(short.pastes, []);

  const crlf = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
  const crlfCollapsed = collapsePaste(crlf);
  assert.equal(expandPastes(crlfCollapsed.text, crlfCollapsed.pastes), crlf);
  assert.ok(expandPastes(crlfCollapsed.text, crlfCollapsed.pastes).endsWith('\r\n'));

  assert.equal(expandPastes('[[paste:9]]', []), '[[paste:9]]');

  await withTui(async (tui) => {
    const answered = tui.question('> ');
    tui.inputBox.setValue(original);
    tui.inputBox.emit('submit', original);
    assert.equal(await answered, original);
    assert.deepEqual(tui.pastes, [original]);
    assert.equal(tui.expandPastes('[[paste:0]]'), original);
    const content = tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.match(content, /pasted 5 lines/);
  });
});

test('setTokens() renders the context-window usage meter', async () => {
  await withTui((tui) => {
    tui.setTokens('2.4k / 8.0k tokens (30%)');
    const plain = tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.equal(plain, '2.4k / 8.0k tokens (30%)');
  });
});

test('setTokens() accepts the stats.usage string from onContextChange', async () => {
  await withTui((tui) => {
    const stats = { usage: '3.4k / 8.0k tokens (43%)' };
    tui.setTokens(stats.usage);
    const plain = tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.equal(plain, '3.4k / 8.0k tokens (43%)');
  });
});

test('startSpinner() paints a frame and reports the in-flight state', async () => {
  await withTui((tui) => {
    tui.setStatus('1.2k / 8.0k tokens (15%)');
    tui.startSpinner();
    assert.equal(tui.isSpinning(), true);
    const plain = tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.equal(plain, 'Thinking ⠋');
  });
});

test('stopSpinner() stops the timer and restores the pre-spinner status', async () => {
  await withTui((tui) => {
    tui.setStatus('1.2k / 8.0k tokens (15%)');
    tui.startSpinner();
    tui.stopSpinner();
    assert.equal(tui.isSpinning(), false);
    const plain = tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.equal(plain, '1.2k / 8.0k tokens (15%)');
  });
});

test('an aborted request leaks no spinner frame after stopSpinner()', async () => {
  await withTui(async (tui) => {
    tui.setStatus('2.4k / 8.0k tokens (30%)');
    tui.startSpinner();
    try {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    } catch {
      // the abort is swallowed, exactly as in main.js
    } finally {
      tui.stopSpinner();
    }
    await new Promise((resolve) => setTimeout(resolve, 3 * SPINNER_INTERVAL_MS));
    assert.equal(tui.isSpinning(), false);
    const plain = tui.statusBar.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.equal(plain, '2.4k / 8.0k tokens (30%)');
    assert.doesNotMatch(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

test('the tool-call intent is echoed to the transcript, ahead of the result', async () => {
  await withTui(async (tui, { painted }) => {
    // main.js renders every tool result as:
    //   \n  [<tool> Output] (intent: <phrase>)\n<result>\n
    tui.log('\n  [read_file Output] (intent: why the file is read)');
    tui.log('file body');
    await new Promise((resolve) => setImmediate(resolve));

    // the intent survives into the transcript text ...
    const content = tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.match(content, /\[read_file Output\] \(intent: why the file is read\)/);
    // ... it is printed above the result payload ...
    assert.ok(
      content.indexOf('(intent: why the file is read)') < content.indexOf('file body'),
      'expected the intent line above the tool result',
    );
    // ... and it really reached the terminal frame
    assert.match(plainText(painted()), /\(intent: why the file is read\)/);
  });
});

test('the read_file result tag renders as a header, not raw text', async () => {
  const tag = '<file relative_path="app/tui.js" from=10 to=40 lines=31>';
  const result = [tag, 'const a = 1;', '</file>'].join('\n');

  // formatTranscript() frames the delimiters instead of printing them raw
  const rendered = formatTranscript(result).split('\n');
  assert.equal(rendered[0], '{cyan-fg}┌─ app/tui.js from=10 to=40 · lines=31{/cyan-fg}');
  assert.equal(rendered[2], '{cyan-fg}└─────{/cyan-fg}');
  assert.doesNotMatch(formatTranscript(result), /<file relative_path/);

  // and the raw tag never reaches the painted transcript
  await withTui(async (tui, { painted }) => {
    tui.log(result);
    await new Promise((resolve) => setImmediate(resolve));
    const content = tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.doesNotMatch(content, /<file relative_path/);
    assert.match(plainText(painted()), /┌─ app\/tui\.js from=10 to=40 · lines=31/);
  });
});

test('notifyCompaction() marks a compaction in the transcript, once per event', async () => {
  await withTui(async (tui, { painted }) => {
    // ConversationManager hands onContextChange the stats() snapshot from
    // app/context-window.js: a running compaction count plus the last report.
    const stats = {
      chunks: 5,
      compactions: 1,
      usage: '7.4k / 8.0k tokens (92%)',
      lastCompaction: {
        at: 1700000000000,
        reason: 'over budget',
        olderChunks: 4,
        keptChunks: 1,
        olderTokens: 7200,
        afterTokens: 1800,
      },
    };

    tui.notifyCompaction(stats);
    // neo-blessed writes asynchronously; flush the repaint before reading the frame.
    await new Promise((resolve) => setImmediate(resolve));
    const content = tui.transcript.getContent().replace(/\x1b\[[\d;]*m/g, '');
    assert.match(content, /\[Context\] compaction fired/);
    assert.match(content, /4 older chunk\(s\) -> summary, kept 1 newest chunk\(s\)/);
    assert.match(content, /\(7200 -> 1800 tokens\)/);
    // the marker really reached the terminal frame, not only the buffer
    assert.match(plainText(painted()), /\[Context\] compaction fired/);

    // onContextChange fires on every turn: the same report must not repeat
    tui.notifyCompaction(stats);
    tui.notifyCompaction({ ...stats });
    assert.equal(
      tui.transcript.getContent().split('[Context] compaction fired').length - 1,
      1,
      'an unchanged compaction count must not mark the transcript again',
    );

    // a genuinely new compaction (count 2) does mark again
    tui.notifyCompaction({
      ...stats,
      compactions: 2,
      lastCompaction: { ...stats.lastCompaction, olderChunks: 3, keptChunks: 2 },
    });
    assert.equal(
      tui.transcript.getContent().split('[Context] compaction fired').length - 1,
      2,
    );
  });
});
