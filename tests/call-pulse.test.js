import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PULSE_LIMIT,
  PULSE_LIMIT_DEFAULT,
} from '../config/constants.js';
import {
  PULSE_MARKER,
  PULSE_RESET_REASONS,
  createTaskPulse,
  formatPulseLimitNotice,
  formatPulseText,
  normalizePulseLimit,
} from '../utils/task-pulse.js';

/**
 * The model-call pulse, as a pure value (task-backlog: "keep in the context an
 * incremental pulse on each model call, create a hard limit configurable defaulting
 * to 30, and instruct via prompt.md to honor this value. reset it to 0 after marking
 * an item as completed or running compaction").
 *
 * This file is the counter on its own: the line, the wording past the hard limit,
 * the single crossing report, and the reasons a reset records. How the loop and the
 * tools use it — the line riding every request, never becoming a chunk, the reset on
 * a completed item or a compaction — is proved against a stub provider in
 * tests/call-pulse-loop.test.js.
 */

test('normalizePulseLimit defaults to 30 and refuses what is not a positive integer', () => {
  assert.equal(PULSE_LIMIT, PULSE_LIMIT_DEFAULT, 'the env is unset, so the default holds');
  assert.equal(PULSE_LIMIT_DEFAULT, 30, 'the backlog asks for a default of 30');
  assert.equal(normalizePulseLimit(undefined), 30);
  assert.equal(normalizePulseLimit(''), 30);
  assert.equal(normalizePulseLimit('abc'), 30);
  assert.equal(normalizePulseLimit('0'), 30, '0 cannot disable the pulse');
  assert.equal(normalizePulseLimit('-5'), 30);
  assert.equal(normalizePulseLimit('7'), 7);
  assert.equal(normalizePulseLimit('7.9'), 7, 'a fractional limit is truncated, not rejected');
});

test('formatPulseText is one line, counts calls and names what resets it', () => {
  const line = formatPulseText({ count: 4, limit: 30 });
  assert.ok(line.startsWith(PULSE_MARKER), 'the marker lets the model recognise the line');
  assert.ok(!line.includes('\n'), 'the pulse is one line of context');
  assert.match(line, /model call 4 of 30/);
  assert.match(line, /26 left/);
  assert.match(line, /completing a task\.md item/);
  assert.match(line, /compaction/);
});

test('formatPulseText turns imperative once the hard limit is reached', () => {
  const atLimit = formatPulseText({ count: 30, limit: 30 });
  const past = formatPulseText({ count: 31, limit: 30 });
  assert.match(atLimit, /hard limit reached/);
  assert.match(atLimit, /Stop starting new work/);
  assert.match(past, /model call 31 of 30/);
  assert.match(past, /resets the pulse to 0/);
});

test('formatPulseLimitNotice says what happened and what to do about it', () => {
  const notice = formatPulseLimitNotice({ count: 31, limit: 30 });
  assert.match(notice, /passed its hard limit: call 31 of 30/);
  assert.match(notice, /Complete a task\.md item or run a compaction/);
});

test('createTaskPulse counts calls, reports the first crossing once, and resets with a reason', () => {
  const pulse = createTaskPulse({ limit: 2 });
  assert.equal(pulse.limit, 2);
  assert.equal(pulse.count, 0);

  // The call is counted before it is sent, so the line names the call it rides on.
  const first = pulse.tick();
  assert.equal(first.count, 1);
  assert.equal(first.crossed, false);
  assert.match(first.text, /model call 1 of 2/);

  assert.equal(pulse.tick().crossed, false, 'reaching the limit is not yet crossing it');
  const crossing = pulse.tick();
  assert.equal(crossing.count, 3);
  assert.equal(crossing.over, true);
  assert.equal(crossing.crossed, true, 'the first call past the cap is news');

  assert.equal(pulse.tick().crossed, false, 'the notice must not repeat on every later call');

  const reset = pulse.reset('compaction');
  assert.equal(reset.count, 0, 'a reset puts the counter back to 0');
  assert.equal(reset.reason, 'compaction');
  assert.equal(reset.resets, 1);
  assert.equal(pulse.tick().crossed, false, 'the crossing is announced once per stretch of work');

  assert.deepEqual(
    [...PULSE_RESET_REASONS].sort(),
    ['compaction', 'item-completed', 'manual', 'start'],
    'the two resets the backlog names are first-class reasons'
  );
});

test('the pulse message is a system message carrying the line', () => {
  const pulse = createTaskPulse({ limit: 5 });
  pulse.tick();
  const message = pulse.message();
  assert.equal(message.role, 'system');
  assert.match(message.content, /model call 1 of 5/);
  assert.equal(pulse.text(), message.content, 'text() and message() agree');
});
