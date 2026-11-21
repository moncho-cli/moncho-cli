import test from 'node:test';
import assert from 'node:assert/strict';

import { createNoticeSink } from '../app/notice-sink.js';

/**
 * The transient surface (`docs/interface/notice-overlay`): where a recovered failure goes
 * and how the retry handle is taken down.
 *
 * The rule under test is the one `main.js` relies on: a screen means the floating overlay,
 * no screen means one plain line — the same information either way — and the retry handle
 * survives until the turn that finally succeeds dismisses it.
 */

/** A TUI stand-in that records what it was asked to paint. */
const fakeTui = () => {
  const shown = [];
  const dismissed = [];
  return {
    shown,
    dismissed,
    notice: (kind, text, options) => {
      const handle = { kind, text, options };
      shown.push(handle);
      return handle;
    },
    dismissNotice: (handle) => dismissed.push(handle),
  };
};

test('a notice goes to the floating overlay when there is a screen, and to a plain line when there is not', () => {
  const tui = fakeTui();
  const lines = [];
  const { notify } = createNoticeSink({ tui, log: (line) => lines.push(line) });

  const handle = notify('warn', 'Retrying in 2s…', { code: 'retry', ttl: 4000 });
  assert.deepEqual(tui.shown, [{ kind: 'warn', text: 'Retrying in 2s…', options: { code: 'retry', ttl: 4000 } }]);
  assert.equal(handle.kind, 'warn', 'the handle is the overlay\'s own');
  assert.deepEqual(lines, [], 'the overlay is used, so nothing is printed');

  // With no screen the same notice is one plain line and there is no handle to take down.
  const cliLines = [];
  const { notify: notifyCli } = createNoticeSink({ tui: null, log: (line) => cliLines.push(line) });
  assert.equal(notifyCli('warn', 'Retrying in 2s…', { code: 'retry' }), null);
  assert.deepEqual(cliLines, ['[warn] Retrying in 2s…']);
});

test('the retry handle is remembered so a landed turn can dismiss it, and dismissing twice is harmless', () => {
  const tui = fakeTui();
  const { notify, dismissRetry } = createNoticeSink({ tui });

  // A non-retry notice is not the retry handle: it must not be dismissed with the turn.
  notify('info', 'a plain notice');
  assert.equal(dismissRetry(), false, 'nothing to dismiss yet');
  assert.deepEqual(tui.dismissed, []);

  const retry = notify('warn', 'Retrying…', { code: 'retry' });
  assert.equal(dismissRetry(), true, 'the retry notice was taken down');
  assert.deepEqual(tui.dismissed, [retry]);

  // A second call is a no-op: the turn may land more than once, and the handle is gone.
  assert.equal(dismissRetry(), false);
  assert.deepEqual(tui.dismissed, [retry], 'the same handle is never dismissed twice');

  // A sink with no screen has no handle to dismiss, and still does not throw.
  const { notify: notifyCli, dismissRetry: dismissCli } = createNoticeSink({ tui: null, log: () => {} });
  notifyCli('warn', 'Retrying…', { code: 'retry' });
  assert.equal(dismissCli(), false);
});
