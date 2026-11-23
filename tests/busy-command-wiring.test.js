import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createBusyCommandRunner } from '../app/busy-command.js';
import { createDefaultCommands } from '../app/commands.js';

/**
 * The mid-turn command must fail *visibly and honestly*, and the host wiring must not
 * reach an identifier that does not exist.
 *
 * Why this file exists: a mid-turn `/task` reported
 *
 *     /task failed: skinSubchat is not defined
 *
 * in a red notice. The command was fine. `main.js` passed `skinSubchat` to
 * `runSessionLoop()` as an object **property**, and then also named it as a bare
 * identifier inside the `run` closure installed on the input box — where no such binding
 * existed. Every existing test injected a stand-in `run`, so none of them ever evaluated
 * that closure: the whole class of defect is invisible to a test that passes its own
 * `run`. A `ReferenceError` from an undeclared name is statically knowable, so it is
 * checked here by scope instead of by execution.
 */

/** The identifiers a JavaScript source declares at its top level. */
function declaredNames(source) {
  const names = new Set();
  // `import ... from`, `import { a as b }`
  for (const match of source.matchAll(/^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?/gm)) {
    if (match[1]) names.add(match[1]);
    if (match[2]) {
      for (const part of match[2].split(',')) {
        const alias = part.split(/\s+as\s+/).pop()?.trim();
        if (alias) names.add(alias);
      }
    }
  }
  // `const/let/var x`, destructuring is ignored: the wiring uses plain declarations.
  for (const match of source.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  // `function name(`, `class Name`, and `function* name(`
  for (const match of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  // Function parameters and object-destructured keys are not collected: the check below
  // only looks at identifiers named where a host *variable* is referenced.
  return names;
}

/** The identifier a `run:` closure hands to `handleCommand`, if it names one. */
function referencedHostNames(source) {
  const call = /run:\s*\([^)]*\)\s*=>\s*handleCommand\(([^,]+),\s*\{([^}]*)\}/.exec(source);
  if (!call) return null;
  const facts = new Set();
  // A bare identifier in the context object is a *shorthand property*: it resolves
  // against the enclosing scope, so it must be declared there.
  for (const match of call[2].matchAll(/(?:^|,)\s*(?:([\w$]+)\s*:)?\s*([A-Za-z_$][\w$]*)\s*(?=,|$)/g)) {
    if (!match[1]) facts.add(match[2]);
  }
  return facts;
}

test('the mid-turn command runner reports a throwing command as a red notice', async () => {
  const notices = [];
  const busySubmit = createBusyCommandRunner({
    registry: createDefaultCommands(),
    run: () => { throw new ReferenceError('skinSubchat is not defined'); },
    notify: (kind, text) => notices.push({ kind, text }),
  });

  // Consumed synchronously, so the keystroke never reaches the queue.
  assert.equal(busySubmit('/task'), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notices.length, 1, 'a failure is reported exactly once');
  assert.equal(notices[0].kind, 'error', 'and it is an error, which is what the bar paints red');
  assert.match(notices[0].text, /^\/task failed: skinSubchat is not defined$/);
});

test('main.js never names a host variable it has not declared in the mid-turn runner', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf-8');

  // Guard the shape first: if the wiring changes so this test can no longer find the
  // closure, it must fail loudly rather than pass on a pattern that no longer matches.
  const referenced = referencedHostNames(source);
  assert.ok(referenced, 'the mid-turn runner still calls handleCommand(input, {...})');

  const declared = declaredNames(source);
  const missing = [...referenced].filter((name) => !declared.has(name));
  assert.deepEqual(
    missing,
    [],
    `main.js hands handleCommand an undeclared identifier: ${missing.join(', ')} `
    + '— a shorthand property resolves against the enclosing scope, so it must be a real binding',
  );
});

test('the wiring declares the subchat before both closures that use it', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf-8');
  const declaredAt = source.indexOf('const skinSubchat');
  const runnerAt = source.indexOf('setBusySubmit');
  const loopAt = source.indexOf('await runSessionLoop({');
  assert.ok(declaredAt > 0, 'skinSubchat is declared');
  assert.ok(runnerAt > declaredAt, 'the mid-turn runner sees the declaration');
  assert.ok(loopAt > declaredAt, 'and so does the loop context');
});