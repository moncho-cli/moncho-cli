import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_RULES_CHARS,
  RULES_FILE,
  RULES_MARKER,
  forgetRulesCache,
  formatRulesBlock,
  projectRulesMessage,
} from '../utils/project-rules.js';

/**
 * Proof for the project's own rule book (docs/agent/project-rules): the block's wording,
 * the user-flow gate, the size bound, and the fact that an edit lands on the next request.
 *
 * The module is exercised through its own options (`root`, `enabled`) rather than the
 * process working directory, because the suite runs inside this repository — where a real
 * `AGENTS.md` may exist and where `MONCHO_MAINTAINER` is ambient.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-rules-test-'));

/** Write the project's rule book in the temp project. */
function writeRules(text) {
  fs.writeFileSync(path.join(root, RULES_FILE), text, 'utf-8');
  forgetRulesCache();
}

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('the block carries the file as written and settles who wins', () => {
  const block = formatRulesBlock({ text: '  Use tabs, never spaces.\n' });
  assert.ok(block.startsWith(`${RULES_MARKER} ${RULES_FILE} is this project's own rule book`));
  assert.ok(block.includes('Use tabs, never spaces.'), 'the rules arrive verbatim');
  assert.ok(block.includes('the project wins'), 'the agent knows the order of authority');
  assert.ok(
    block.includes('code, the artefacts and the tasks stay in the project\'s own'),
    'the conversation may follow the user\'s language while the artefacts do not'
  );
});

test('a file with nothing in it renders no block at all', () => {
  assert.equal(formatRulesBlock({ text: '' }), '');
  assert.equal(formatRulesBlock({ text: '   \n\n\t ' }), '', 'whitespace is not a rule');
});

test('an over-long rule book is cut and says so instead of truncating silently', () => {
  const long = 'x'.repeat(MAX_RULES_CHARS + 500);
  const block = formatRulesBlock({ text: long.slice(0, MAX_RULES_CHARS), truncated: true });
  assert.ok(block.includes('the rest is not included'));
  assert.ok(block.includes(RULES_FILE), 'the model is told where to read the remainder');
  assert.ok(!block.includes('x'.repeat(MAX_RULES_CHARS + 1)), 'the budget is not exceeded');
});

test('the project rules ride a request as one system message in the user flow', () => {
  writeRules('This project uses two-space indentation.');
  const message = projectRulesMessage({ root, enabled: true });
  assert.equal(message.role, 'system');
  assert.ok(message.content.includes('two-space indentation'));
});

test('the maintainer checkout sends no project block, because its prompt is the rule book', () => {
  writeRules('This project uses two-space indentation.');
  assert.equal(projectRulesMessage({ root, enabled: false }), null);
  // The default reads the live switch rather than an argument.
  assert.equal(projectRulesMessage({ root }), projectRulesMessage({ root, enabled: false }));
});

test('a project with no rule book is unchanged: no message, no error', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-rules-bare-'));
  try {
    assert.equal(projectRulesMessage({ root: bare, enabled: true }), null);
    fs.writeFileSync(path.join(bare, RULES_FILE), '', 'utf-8');
    assert.equal(projectRulesMessage({ root: bare, enabled: true }), null, 'an empty file is no rules');
    fs.mkdirSync(path.join(bare, 'dir-' + RULES_FILE));
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('an edit to the rule book lands on the very next request', () => {
  writeRules('Rule one: the first wording.');
  assert.ok(projectRulesMessage({ root, enabled: true }).content.includes('the first wording'));

  // Same size and a changed body is the case a cache keyed on length alone would miss.
  writeRules('Rule one: the other wording.');
  const after = projectRulesMessage({ root, enabled: true });
  assert.ok(after.content.includes('the other wording'), 'the new bytes are sent');
  assert.ok(!after.content.includes('the first wording'), 'the old bytes are gone');
});

test('an unchanged rule book is read once, and a change is not missed', () => {
  writeRules('Rule A.');
  const first = projectRulesMessage({ root, enabled: true });
  assert.ok(first.content.includes('Rule A.'));
  // The cached read answers the same bytes without touching the file again: replacing the
  // content while keeping size and mtime is the only way to prove the cache is keyed on
  // the facts that matter rather than on "have I ever read this".
  const target = path.join(root, RULES_FILE);
  const stat = fs.statSync(target);
  fs.writeFileSync(target, 'Rule B.');
  assert.ok(projectRulesMessage({ root, enabled: true }).content.includes('Rule B.'));
  fs.utimesSync(target, stat.atime, stat.mtime);
  assert.ok(projectRulesMessage({ root, enabled: true }).content.includes('Rule B.'), 'size/mtime moved');
});