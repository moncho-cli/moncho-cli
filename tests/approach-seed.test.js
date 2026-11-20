import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  APPROACH_REFUSAL_CODE,
  approachRefusal,
  formatApproachRefusalLine,
  isApproachAnnouncement,
  needsApproach,
} from '../app/approach-gate.js';
import { isRefusalLine } from '../app/refusal-line.js';
import { classifyLine } from '../app/theme.js';

/**
 * The seed as a *policy* (docs/agent/approach-gate): what counts as the stated approach,
 * the refusal a turn with no seed gets, and the bound that keeps a model which never
 * writes one from deadlocking the turn.
 *
 * These are pure values, so they are proven without a provider. What the turn loop *does*
 * with them — latching the seed, refusing a seedless batch whole, asking the model again —
 * is proved against a stub in `tests/approach-gate.test.js`.
 *
 * The last case is about the prose itself: it reads the shipped prompt and fails if the
 * rule is stated as something the model cannot act on.
 */

test('only real prose is the whole test, and the reason is one string', () => {
  assert.equal(isApproachAnnouncement('I will read the fixture first.'), true);
  assert.equal(isApproachAnnouncement('   '), false);
  assert.equal(isApproachAnnouncement(''), false);
  // The provider's bare-call shape: the model named a tool without saying anything.
  assert.equal(isApproachAnnouncement(null), false);
  assert.equal(isApproachAnnouncement(undefined), false);

  const refusal = approachRefusal();
  assert.equal(refusal.code, APPROACH_REFUSAL_CODE);
  assert.match(refusal.reason, /no stated approach/i);
  assert.match(refusal.guidance, /same message as the calls/i);

  // The reader's row is the palette's own refusal kind, and names the call.
  const row = formatApproachRefusalLine({ name: 'read_file' });
  assert.equal(isRefusalLine(row), true);
  assert.equal(classifyLine(row), 'refusal');
  assert.match(row, /read_file/);
  assert.match(row, /no stated approach/i);
});

test('the bound re-asks a finite number of times and then lets the batch through', () => {
  // Seedless: refused while refusals < max, allowed once the bound is spent.
  assert.equal(needsApproach({ announced: false, refusals: 0, max: 2 }), true);
  assert.equal(needsApproach({ announced: false, refusals: 1, max: 2 }), true);
  assert.equal(needsApproach({ announced: false, refusals: 2, max: 2 }), false);
  // Seeded, or with no bound declared at all: nothing is policed.
  assert.equal(needsApproach({ announced: true, refusals: 0, max: 2 }), false);
  assert.equal(needsApproach({ announced: false, refusals: 0, max: 0 }), false);
  assert.equal(needsApproach(), false);
});

test('the rule names the seed the turn grows from, without an order the model cannot see', () => {
  // Two defects this wording has to avoid. A model cannot tell a first answer from a later
  // one, so "your first answer must … before any tool runs" asks it to police a boundary it
  // cannot observe; and a rule that reads as a duty on *every* tool call turns one
  // statement of intent into a ritual repeated on each batch. The prompt states the seed
  // instead: written once, on the message that carries the calls it introduces, with the
  // rest of the turn growing from it.
  const prompt = fs.readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf-8');
  const section = prompt.slice(prompt.indexOf('#### 2.1'), prompt.indexOf('### 3.'));

  assert.ok(section.length > 0, 'the prompt still carries the rule');
  assert.match(section, /seed/i, 'it names the seed the turn grows from');
  assert.match(section, /grows from it/i, 'and says the rest of the turn grows from it');
  assert.match(section, /same\*{0,2} assistant message/i, 'it names the one message the test reads');
  assert.match(section, /TOOL_REFUSED_BEFORE_APPROACH/, 'and the refusal a seedless message gets');
  for (const dejix of [/first answer/i, /before any tool runs/i, /your first/i]) {
    assert.doesNotMatch(section, dejix, `the rule is not phrased as ${dejix}`);
  }

  const refusal = approachRefusal();
  assert.match(refusal.reason, /no stated approach/i, 'the refusal names the missing seed');
  assert.doesNotMatch(refusal.reason, /first answer|has not been addressed/);
  assert.match(refusal.guidance, /does not repeat it/i, 'and says the seed is written once');
});
