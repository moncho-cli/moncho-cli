import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The read-before-edit precondition as the *model* is told it (docs/agent/line-edits).
 *
 * `edit_file` matches its search against the file's bytes, so a search can only be composed
 * from the file's bytes — everything else a model might copy it from is a paraphrase. The
 * engine enforces the consequence (`SEARCH_NOT_FOUND`, `NO_CHANGES`), and `tests/edit.test.js`
 * proves that; what is left is the rule the model reads *before* it composes anything.
 *
 * That rule is prose in `config/prompt.md`, which is not a document of this repository but
 * the system prompt of every install, so it cannot be linked as code. This suite is how the
 * contract is held instead: it reads the section and fails if it stops naming the tools the
 * model can actually reach or the refusals it can actually receive, because a rule phrased
 * around something the model cannot do is a rule it will not follow.
 */

const PROMPT_PATH = new URL('../config/prompt.md', import.meta.url);

/** The section of the prompt that carries the rule, or '' when it is gone. */
function readRule(prompt) {
  const start = prompt.indexOf('#### 3.4');
  if (start === -1) return '';
  return prompt.slice(start, prompt.indexOf('### 4.', start));
}

test('the shipped prompt makes an exact read the precondition of an edit', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
  const section = readRule(prompt);

  assert.ok(section.length > 0, 'the prompt still carries the read-before-edit rule');
  assert.match(section, /read the exact bytes/i, 'it names the act the rule is about');
  assert.match(section, /read_file/, 'it names the one tool that shows the bytes');
  assert.match(section, /hint_file/, 'and warns about the paraphrase a sketch is');
  assert.match(section, /blob/, 'and the one a multi-file fetch is');
  assert.match(section, /grep/, 'and the one a match line is');
  assert.match(section, /SEARCH_NOT_FOUND/, 'it names the refusal a guessed search gets');
  assert.match(section, /NO_CHANGES/, 'and the one an identical search/replace gets');
  assert.match(section, /write_file/, 'a whole-file rewrite is offered as the way out');
});

test('the rule is stated as something the model can act on and check', () => {
  const section = readRule(fs.readFileSync(PROMPT_PATH, 'utf-8'));

  // It must be a rule about the bytes in hand, not about remembering a position: a line
  // number is stale the moment the file changes, and the model cannot see the difference.
  assert.match(section, /just read|you have just read/i, 'the read is the precondition');
  assert.match(
    section,
    /not\*{0,2}\s+the bytes|are \*\*not\*\* the bytes/i,
    'it says outright which sources are not a read',
  );
  // And it must name the recovery, so a refusal is a step rather than a dead end.
  assert.match(section, /re-read|read the region again/i, 'the way out of a miss is named');
  assert.match(section, /node --check/, 'the syntax gate stays part of the change');
});
