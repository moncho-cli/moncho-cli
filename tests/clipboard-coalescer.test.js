import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaintCoalescer } from '../app/paint-coalescer.js';

/**
 * The paint coalescer (`app/paint-coalescer.js`): the one thing that stops a burst of drag
 * reports from repainting the whole conversation once per report, which is the lag a long
 * transcript shows (`docs/interface/clipboard-selection`).
 *
 * Driven with an injected scheduler, so the whole thing is exercised with no timers and no
 * screen: `schedule` records the callback and `cancelSchedule` forgets it, and the test
 * decides when the turn ends.
 */

/** A coalescer with a scheduler the test controls by hand. */
function makeCoalescer() {
  const scheduled = new Map();
  let nextId = 1;
  let paints = 0;
  const coalescer = createPaintCoalescer({
    paint: () => { paints += 1; },
    schedule: (fn) => { const id = nextId++; scheduled.set(id, fn); return id; },
    cancelSchedule: (id) => { scheduled.delete(id); },
  });
  return {
    coalescer,
    get paints() { return paints; },
    get pendingCount() { return scheduled.size; },
    /** End the current turn: run whatever the scheduler was handed. */
    tick() {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) fn();
    },
  };
}

test('request() coalesces a burst into one paint, and a second turn paints again', () => {
  const h = makeCoalescer();

  // A burst: every request in the same turn joins the one scheduled paint.
  assert.equal(h.coalescer.request(), true, 'the first request schedules');
  assert.equal(h.coalescer.request(), false, 'the second joins it rather than queueing');
  assert.equal(h.coalescer.request(), false);
  assert.equal(h.pendingCount, 1, 'exactly one paint is pending');
  assert.equal(h.paints, 0, 'nothing has painted yet');

  h.tick();
  assert.equal(h.paints, 1, 'the whole burst cost one paint');

  // The next turn is a fresh paint, so a drag that keeps moving keeps painting.
  assert.equal(h.coalescer.request(), true);
  h.tick();
  assert.equal(h.paints, 2, 'a later turn paints again');
  assert.equal(h.coalescer.pending, false, 'and nothing is left pending');
});

test('flush() paints at once and drops the pending paint, so nothing paints twice', () => {
  const h = makeCoalescer();

  h.coalescer.request();
  assert.equal(h.coalescer.pending, true);

  // The release edge: the band must leave the screen now, and the queued paint must not run
  // afterwards — it would redraw the band the release just cleared.
  h.coalescer.flush();
  assert.equal(h.paints, 1, 'flush painted immediately');
  assert.equal(h.pendingCount, 0, 'and the pending paint was dropped');
  assert.equal(h.coalescer.pending, false);

  h.tick();
  assert.equal(h.paints, 1, 'ending the turn did not paint a second time');
});

test('cancel() drops a pending paint without painting, and is idempotent', () => {
  const h = makeCoalescer();

  h.coalescer.request();
  assert.equal(h.coalescer.cancel(), true, 'a pending paint was dropped');
  h.tick();
  assert.equal(h.paints, 0, 'cancelling never paints');

  assert.equal(h.coalescer.cancel(), false, 'and it is harmless when nothing is pending');

  // A cancelled coalescer is still usable: the next request schedules fresh.
  h.coalescer.request();
  h.tick();
  assert.equal(h.paints, 1);
});
