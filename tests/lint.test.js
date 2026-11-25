import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ESLint } from 'eslint';

/**
 * The static gate (`docs/maintainer/lint`).
 *
 * The rule under test is the one no runtime suite could ever enforce: an
 * *undeclared identifier*. The bug that motivated it was `skinSubchat` in `main.js`
 * — a name passed as a shorthand property inside a closure, bound nowhere as an
 * identifier, throwing on every mid-turn command while every suite passed, because
 * each mid-turn test injects its own stand-in `run` and never evaluates the host's
 * closure. A name that is used and never declared is knowable without running
 * anything, so the proof here is that the config says so.
 *
 * The suite lints *text*, not files, for the two properties that matter: the failing
 * shape and its declared twin. The third case proves the globals really reach the
 * rules, and the last proves the tree the realm roots name is clean today — which is
 * the whole reason `no-undef` can be an error without a mass rewrite.
 */

const root = process.cwd();

/** The real shipped config, found the way `npm run lint` finds it. */
const eslint = new ESLint({ cwd: root });

/** Severity of the first message a rule raises, or null when it raises none. */
function severityOf(results, ruleId) {
  const message = results.flatMap((r) => r.messages).find((m) => m.ruleId === ruleId);
  return message ? message.severity : null;
}

test('an undeclared identifier is an error, which is the defect no suite could see', async () => {
  // The `skinSubchat` shape, reduced: a name a closure references that the file never
  // binds. `run` is declared, so the only thing wrong is the identifier itself.
  const source = `
    function runSessionLoop(handlers) {
      return () => handlers.run({ skinSubchat });
    }
    export { runSessionLoop };
  `;

  const results = await eslint.lintText(source, { filePath: path.join(root, 'app', 'probe.js') });

  assert.equal(severityOf(results, 'no-undef'), 2, 'an undeclared identifier must be an error, not a warning');
  const message = results[0].messages.find((m) => m.ruleId === 'no-undef');
  assert.match(message.message, /skinSubchat/, 'the error must name the identifier that is not declared');
});

test('the declared version of that same code passes, so the rule is not blanket refusal', async () => {
  const source = `
    const skinSubchat = () => {};
    function runSessionLoop(handlers) {
      return () => handlers.run({ skinSubchat });
    }
    export { runSessionLoop };
  `;

  const results = await eslint.lintText(source, { filePath: path.join(root, 'app', 'probe.js') });

  assert.equal(severityOf(results, 'no-undef'), null, 'a declared name must raise nothing');
  assert.deepEqual(results[0].messages, [], 'the declared twin is clean, not merely quieter');
});

test('the node globals are declared, so the check is not a hand-written list', async () => {
  // A hand-written global list is a second place to forget `process` after `Buffer`;
  // this case pins that the environment comes from `globals.node`.
  const source = `
    export function stamp() {
      process.exitCode = 0;
      return Buffer.from(String(setTimeout)).length;
    }
  `;

  const results = await eslint.lintText(source, { filePath: path.join(root, 'utils', 'probe.js') });

  assert.equal(severityOf(results, 'no-undef'), null, 'process, Buffer and setTimeout are node globals');
});

test('no-unused-vars is a warning, so an unused import never blocks a build', async () => {
  // Deliberate re-export barrels and a test's convenience import are both "unused" to
  // a static reader, which is why the tree carries dozens and this must not fail it.
  const source = `
    import { sliceCells } from '../app/cell-width.js';
    export const answer = 42;
  `;

  const results = await eslint.lintText(source, { filePath: path.join(root, 'tests', 'probe.test.js') });

  assert.equal(severityOf(results, 'no-unused-vars'), 1, 'an unused name is a warning, never an error');
});

test('the shipped tree the realm roots name lints with zero errors', async () => {
  // The measurement that let `no-undef` ship at error strength: 349 files, no hits.
  // Warnings are expected and deliberately not asserted to zero.
  const results = await eslint.lintFiles(['app', 'api', 'config', 'tools', 'utils', 'main.js', 'tests', 'scripts']);

  const errors = results.flatMap((r) => r.messages).filter((m) => m.severity === 2);
  assert.deepEqual(
    errors.map((m) => `${m.ruleId} at ${m.line}:${m.column} — ${m.message}`),
    [],
    'the tree must lint clean, or the gate is not adoptable'
  );
  assert.ok(results.length >= 100, `expected the real tree, linted ${results.length} files`);
});