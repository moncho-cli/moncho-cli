import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fitToClipboard,
  osc52,
  createClipboard,
  multiplexerOf,
  CLIPBOARD_MAX_BYTES,
} from '../app/clipboard.js';
import { clipboardText } from './support/clipboard-text.js';

/**
 * The copy end (docs/interface/clipboard-selection): the text becomes an OSC 52 sequence,
 * bounded and wrapped for the multiplexer, and a failure is *reported* rather than thrown.
 */

test('fitToClipboard() bounds the encoded payload and says it truncated', () => {
  const short = fitToClipboard('hello');
  assert.equal(short.text, 'hello');
  assert.equal(short.truncated, false);
  assert.equal(short.bytes, Buffer.from('hello').toString('base64').length);

  // The budget is on the *encoded* size, because that is what the terminal counts.
  const long = fitToClipboard('x'.repeat(1000), 40);
  assert.equal(long.truncated, true);
  assert.ok(long.bytes <= 40, `encoded payload stayed within the budget, was ${long.bytes}`);
  assert.match(long.text, /…$/, 'the cut is marked');

  // The cut is between clusters, so an emoji is copied whole or not at all.
  const emoji = fitToClipboard('👍🏽'.repeat(50), 40);
  assert.equal(emoji.truncated, true);
  for (const cluster of emoji.text.replace('…', '')) {
    assert.ok(cluster.codePointAt(0) !== 0xde00, 'never half a surrogate pair');
  }
  assert.equal(Buffer.from(emoji.text, 'utf8').toString('base64').length, emoji.bytes);

  // Nothing to copy is nothing to copy — not an empty sequence.
  assert.deepEqual(fitToClipboard(''), { text: '', truncated: false, bytes: 0 });
  assert.deepEqual(fitToClipboard(null), { text: '', truncated: false, bytes: 0 });
  assert.ok(CLIPBOARD_MAX_BYTES >= 4096, 'the ceiling is a real terminal ceiling');
});

test('osc52() encodes the text and wraps it for tmux and screen', () => {
  const plain = osc52('hi', { env: {} });
  assert.equal(clipboardText(plain), 'hi');
  assert.ok(plain.startsWith('\x1b]52;c;'), 'OSC 52 targeting the system clipboard');
  assert.ok(plain.endsWith('\x07'), 'BEL terminates it');

  // UTF-8 survives the trip: an emoji comes back as itself.
  assert.equal(clipboardText(osc52('héllo 👍🏽', { env: {} })), 'héllo 👍🏽');

  // A multiplexer swallows a bare sequence, so it gets its own envelope.
  const tmux = osc52('hi', { env: { TMUX: '/tmp/tmux-1000/default,123,0' } });
  assert.ok(tmux.startsWith('\x1bPtmux;\x1b\x1b]52;'), 'tmux DCS passthrough with the escape doubled');
  assert.ok(tmux.endsWith('\x1b\\'), 'ST ends the passthrough');
  assert.equal(clipboardText(tmux), 'hi');

  const screen = osc52('hi', { env: { STY: '1234.pts-0.host' } });
  assert.ok(screen.startsWith('\x1bP\x1b]52;'));
  assert.equal(clipboardText(screen), 'hi');

  assert.equal(multiplexerOf({ TMUX: 'x' }), 'tmux');
  assert.equal(multiplexerOf({ STY: 'x' }), 'screen');
  assert.equal(multiplexerOf({}), null);

  // An empty selection is silence, not a sequence that would clear the clipboard.
  assert.equal(osc52('', { env: {} }), null);
  // A whitespace-only selection is still text: it is copied, never mistaken for nothing.
  assert.equal(clipboardText(osc52('   ', { env: {} })), '   ');
});

test('createClipboard() reports a missing or throwing writer instead of throwing', () => {
  const written = [];
  const ok = createClipboard({ write: (text) => written.push(text), env: {} });
  const report = ok.copy('copied text');
  assert.equal(report.ok, true);
  assert.equal(report.error, null);
  assert.equal(report.truncated, false);
  assert.equal(report.chars, 11);
  assert.equal(written.length, 1);
  assert.equal(clipboardText(written[0]), 'copied text');

  // No writer is a report, not a crash — the conversation keeps running.
  const none = createClipboard({ env: {} });
  assert.equal(none.copy('text').ok, false);
  assert.equal(none.copy('text').error, 'NO_WRITER');

  // A writer that throws is contained the same way.
  const broken = createClipboard({ write: () => { throw new Error('EPIPE'); }, env: {} });
  assert.deepEqual(
    { ok: broken.copy('text').ok, error: broken.copy('text').error },
    { ok: false, error: 'EPIPE' },
  );

  // Nothing selected: nothing is written, and it is not reported as a failure to copy.
  assert.equal(ok.copy('').error, 'EMPTY');
  assert.equal(written.length, 1, 'an empty selection writes nothing');

  // The sequence can be inspected without writing it.
  assert.equal(clipboardText(ok.sequence('preview')), 'preview');
});
