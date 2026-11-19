import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommandRegistry, runCommand } from '../app/commands.js';
import { workCommand } from '../app/work-command.js';
import { createSessionMode, MODES } from '../app/session-mode.js';

/**
 * `/work on` and `/work off`: the execution lock from the command line.
 *
 * The state machine itself is proven in `tests/session-mode.test.js`; these cases fix
 * the *command* contract — the refusals that keep a lock from being engaged over an
 * empty checklist, and the two transitions the user can type.
 */

/**
 * A `task.md` body: one checkbox per argument, ticked when the argument is `true`.
 * `readTaskItems()` parses markdown, exactly like the file on disk, so the fixture is
 * markdown too.
 */
const items = (...done) => done
  .map((ticked, i) => `- [${ticked ? 'x' : ' '}] item ${i + 1}`)
  .join('\n');

/** A registry holding just /work, plus the mode it moves and the checklist it reads. */
function harness({ task = null, mode = createSessionMode({ mode: MODES.CHAT }) } = {}) {
  const registry = createCommandRegistry();
  registry.register(workCommand());
  const readTask = () => task;
  const run = (arg) => runCommand(registry, 'work', { arg, mode, readTask });
  return { registry, mode, run };
}

test('/work on refuses a session with no task.md, and the mode does not move', async () => {
  const { mode, run } = harness({ task: null });

  const result = await run('on');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_TASK_FILE');
  assert.match(result.message, /task\.md/);
  assert.equal(mode.work, false, 'a refused /work on must not engage the lock');
  assert.equal(mode.mode, MODES.CHAT, 'and must not move the mode either');
});

test('/work on refuses an empty checklist and one whose items are all done', async () => {
  const empty = harness({ task: items() });
  const emptyResult = await empty.run('on');
  assert.equal(emptyResult.code, 'NO_TASK_ITEMS');
  assert.equal(empty.mode.work, false);

  const done = harness({ task: items(true, true) });
  const doneResult = await done.run('on');
  assert.equal(doneResult.code, 'ALL_ITEMS_DONE');
  assert.match(doneResult.message, /2\/2/);
  assert.equal(done.mode.work, false, 'nothing left to drive means no lock');
});

test('/work on locks the session to Work and names the next item in line', async () => {
  const { mode, run } = harness({ task: items(true, false, false) });

  const result = await run('on');

  assert.equal(result.ok, true);
  assert.equal(result.code, 'WORK_ON');
  assert.equal(result.changed, true);
  assert.equal(mode.work, true, 'the lock is engaged');
  assert.equal(mode.mode, MODES.WORK, 'and the mode is pinned to Work');
  assert.equal(result.state.label, 'Work:on', 'the result carries the state the label paints');
  assert.match(result.message, /2 of 3 item\(s\) pending/);
  assert.deepEqual(result.lines, ['Next: item 2'], 'the next pending item is named');

  // A second /work on is a no-op, not an error and not a second engagement.
  const again = await run('on');
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.state.key, 'work:on');
});

test('/work off releases the lock and falls back to Design', async () => {
  const { mode, run } = harness({ task: items(false) });
  await run('on');
  assert.equal(mode.work, true);

  const result = await run('off');

  assert.equal(result.ok, true);
  assert.equal(result.code, 'WORK_OFF');
  assert.equal(result.changed, true);
  assert.equal(mode.work, false);
  assert.equal(mode.mode, MODES.DESIGN, 'releasing the lock lands on Design, never Chat');

  const again = await run('off');
  assert.equal(again.changed, false, 'a second /work off changes nothing');
  assert.equal(again.state.mode, MODES.DESIGN);
});

test('/work with no argument reports the state, and an unknown argument is refused', async () => {
  const { mode, run } = harness({ task: items(false) });

  const state = await run('');
  assert.equal(state.code, 'WORK_STATE');
  assert.equal(state.state.mode, mode.mode);
  assert.match(state.message, /\/work on or \/work off/);

  const junk = await run('maybe');
  assert.equal(junk.ok, false);
  assert.equal(junk.code, 'UNKNOWN_ARG');
  assert.equal(mode.work, false, 'a typo never engages the lock');
});

test('a front end with no session mode is refused instead of throwing', async () => {
  const registry = createCommandRegistry();
  registry.register(workCommand());

  const result = await runCommand(registry, 'work', { arg: 'on', readTask: () => '- [ ] ship it' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_SESSION_MODE');
  assert.match(result.message, /no session mode/);
});

test('/work reaches the live mode through the registry context', async () => {
  const mode = createSessionMode({ mode: MODES.CHAT });
  const registry = createCommandRegistry();
  registry.register(workCommand());
  const readTask = () => '- [ ] ship it\n';

  await runCommand(registry, 'work', { arg: 'on', mode, readTask });

  assert.equal(mode.work, true, 'the same object the gate reads was moved');
  assert.equal(mode.describe().label, 'Work:on');
});