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
 * This file is the counter on its own: the wording, the single crossing report and
 * the reasons a reset records. The **line is disabled right now** — a message
 * generated per call defeats provider prompt caching, which costs far more than the
 * pulse is worth — so the cases below pin the pause instead of the wording, and
 * re-enabling it has to be a deliberate change here. What the loop does with the
 * counter (ticking per agent call, never becoming a chunk, the two resets) is proved
 * against a stub provider in tests/call-pulse-loop.test.js.
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

test('formatPulseText is disabled so a request carries no extra line', () => {
  // Disabled on purpose: a per-call message defeats provider prompt caching. The
  // counter keeps counting (proved below), so re-enabling the line is a change to
  // this one function.
  assert.equal(formatPulseText({ count: 4, limit: 30 }), '');
  assert.equal(formatPulseText({ count: 0, limit: 30 }), '');
  assert.equal(formatPulseText(), '');
  assert.equal(typeof PULSE_MARKER, 'string', 'the marker stays exported for the re-enable');
  assert.ok(PULSE_MARKER.length > 0);
});

test('formatPulseText stays disabled past the hard limit as well', () => {
  // The imperative wording of a past-limit call is part of the paused behaviour: no
  // count, however large, may put a line back into the request.
  assert.equal(formatPulseText({ count: 30, limit: 30 }), '');
  assert.equal(formatPulseText({ count: 31, limit: 30 }), '');
});

test('formatPulseLimitNotice says what happened and what to do about it', () => {
  const notice = formatPulseLimitNotice({ count: 31, limit: 30 });
  assert.match(notice, /passed its hard limit: call 31 of 30/);
  assert.match(notice, /Complete a task\.md item to reset it/);
});

test('createTaskPulse counts calls, reports the first crossing once, and resets with a reason', () => {
  const pulse = createTaskPulse({ limit: 2 });
  assert.equal(pulse.limit, 2);
  assert.equal(pulse.count, 0);

  // The call is counted before it is sent, even though its line is not carried.
  const first = pulse.tick();
  assert.equal(first.count, 1);
  assert.equal(first.crossed, false);
  assert.equal(first.text, '', 'the tick report carries the disabled line, i.e. nothing');

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

test('the pulse message is null while the line is disabled, so no empty system message is sent', () => {
  const pulse = createTaskPulse({ limit: 5 });
  pulse.tick();

  assert.equal(pulse.text(), '', 'there is no line to send');
  // An empty `system` message is *not* the same as no message: it is still a role
  // marker the provider bills and the prompt cache hashes. Returning null is what
  // lets ContextWindow.request() drop it with its own filter(Boolean).
  assert.equal(pulse.message(), null);
  assert.equal(pulse.count, 1, 'the call was counted anyway');
});
