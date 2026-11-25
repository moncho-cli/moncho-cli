import globals from 'globals';

/**
 * The static half of the quality gate, and the one hole `npm test` cannot close.
 *
 * Every other check in this repository is a runtime test, and a runtime test can
 * only fail on a path it happens to execute. The bug this config exists for was
 * exactly that shape: `main.js` passed `skinSubchat` into the mid-turn command
 * runner as a shorthand property inside a closure, but only ever bound the name as
 * an *object property* elsewhere — so the identifier was never declared, every
 * mid-turn command threw, and no suite noticed, because every mid-turn test injects
 * its own stand-in `run` and never evaluates the host's closure. An undeclared
 * identifier is statically knowable, so it should never have reached a user.
 *
 * **Two rules, deliberately, and not a preset.** The split between them is the design:
 *
 *  - `no-undef` is an **error**. It answers "is this name declared?", a question with
 *    one right answer and no style judgement behind it — a tree with an undeclared
 *    name is broken, not untidy. It is affordable at error strength because the tree
 *    already satisfies it: the measurement that chose this config found **zero** hits
 *    across 349 files, so adopting it rewrote nothing.
 *  - `no-unused-vars` is a **warning**: the inverse question, and a much weaker one.
 *    A deliberate re-export barrel and a test's convenience import are both "unused"
 *    to a static reader, which is why the tree carries dozens and why this one must
 *    never block a build. It is still worth seeing, so it prints.
 *
 * `js.configs.recommended` was measured and left out, with the numbers, because
 * "recommended" here means a mass rewrite rather than a check: it adds 81 errors to
 * this tree. Most are `no-control-regex` on the `\x1b` escape bytes the TUI suites
 * match on purpose — the byte *is* what they are testing — and silencing a rule that
 * often is how a config becomes noise. The rest are six real findings
 * (`no-useless-assignment` in `tools/update_task.js`, `utils/chunk-meta.js`,
 * `utils/chunkpaction-store.js`, `utils/conversation-log-store.js`,
 * `utils/edit-miss.js`, `utils/patch_lib.js`, and `no-unreachable` in
 * `utils/task-pulse.js`) that deserve their own change with their own tests, not a
 * ride along with a linter. Adding those rules is the obvious next step; it is
 * deliberately not this one.
 *
 * The globals come from `globals.node` rather than a hand-written list, because a
 * hand-written list is a second place to forget `process` after `Buffer`. And
 * `node --check` stays the cheap per-file parse: this config answers the questions a
 * single-file syntax check cannot, and it needs the dependency installed to do it.
 */
export default [
  {
    // `agent/` is scratch and gitignored; `vendor/` is a second copy of a published
    // package, not this project's source. Linting either measures something that is
    // not ours and buries what is.
    ignores: ['agent/**', 'vendor/**', 'build/**', 'node_modules/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The reason this file exists: an undeclared identifier fails the gate.
      'no-undef': 'error',
      // The inverse, kept visible and never blocking (see the note above).
      'no-unused-vars': 'warn',
    },
  },
];