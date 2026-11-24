import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { maintainerGuidance } from '../api/ollama.js';
import { maintainerMode, hostFenceEnabled } from '../config/constants.js';

/**
 * The maintainer flow's own rules (`docs/maintainer/git-rule`).
 *
 * `config/prompt.md` is the system prompt of **every** install, so it is read by a session
 * standing in a user's project. A rule about *this* tree — "do not commit, do not stage" —
 * is advice about a repository the session is not in, which is the same reason the
 * version-bump bookkeeping stays out of it (`docs/maintainer/version-bump`, proved in
 * `tests/version-bump.test.js`). So the rule lives in its own fragment and is concatenated
 * at the end of the prompt only when the tree is the maintainer's own.
 *
 * The split is what this suite is about: the rule **reaches the maintainer** and **never
 * reaches a user**, and it is a fragment the maintainer can read and edit as prose.
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf-8');

const FRAGMENT = 'config/maintainer-prompt.md';

test('the fragment is appended in the maintainer flow and is silence otherwise', () => {
  const on = maintainerGuidance(true);
  const off = maintainerGuidance(false);

  assert.ok(on.startsWith('\n\n'), 'the fragment is introduced by a blank line, so it cannot run into the prompt');
  assert.ok(on.length > 100, 'the fragment carries the rule, not a stub');
  assert.equal(off, '', 'outside the maintainer flow there is nothing to append');
});

test('the shipped prompt never carries the rule, so a user flow is unaffected', () => {
  // The whole point of the fragment: `config/prompt.md` travels to every install
  // (`scripts/install.sh`, `bin/lib/image.sh`), so a rule about the maintainer's own tree
  // must not be in it. A user who wants the rule states it in their own `AGENTS.md`.
  const prompt = read('config/prompt.md');
  assert.doesNotMatch(prompt, /git stash/i, 'the shipped prompt stays out of the maintainer\'s git rule');
  assert.doesNotMatch(prompt, /do not commit/i, 'including the commit rule itself');
  assert.doesNotMatch(prompt, /maintainer/i, 'and never explains the split to a user');
});

test('the fragment states the rule, and names what is still allowed', () => {
  const fragment = read(FRAGMENT);

  // The prohibition, both halves: no commit and no stage.
  assert.match(fragment, /do not commit/i);
  assert.match(fragment, /do not stage/i);

  // The permission, because a rule that only forbids teaches the model to stop reading
  // the repository — and reading is how it checks its own work.
  assert.match(fragment, /git status/);
  assert.match(fragment, /git diff/);

  // The one mutation allowed, with the condition that makes it safe.
  assert.match(fragment, /git stash/);
  assert.match(fragment, /put the tree\s+back/i);

  // And who commits instead.
  assert.match(fragment, /maintainer/i);
});

test('absence is silence: an unreadable fragment appends nothing', () => {
  // Same contract as `utils/project-rules.js`: the request goes out exactly as it did
  // before the fragment existed, so an install that lost the file degrades to "no extra
  // rule" rather than to "no prompt". Proved against a path that really does not exist —
  // deleting the shipped fragment to observe this would leave the tree broken if the test
  // were interrupted between the delete and the restore.
  const missing = path.join(os.tmpdir(), `no-such-fragment-${process.pid}.md`);
  assert.equal(maintainerGuidance(true, { path: missing }), '', 'a missing fragment adds nothing');

  const empty = path.join(os.tmpdir(), `empty-fragment-${process.pid}.md`);
  fs.writeFileSync(empty, '   \n\n', 'utf-8');
  try {
    assert.equal(maintainerGuidance(true, { path: empty }), '', 'and neither does an empty one');
  } finally {
    fs.rmSync(empty, { force: true });
  }
});

test('maintainer mode and the host fence are the two readings of one switch', () => {
  // They are inverses by construction, and named separately so each call site says which
  // question it is asking: "whose checkout is this?" against "should the host fence apply?".
  const previous = process.env.MONCHO_MAINTAINER;
  try {
    process.env.MONCHO_MAINTAINER = '1';
    assert.equal(maintainerMode(), true);
    assert.equal(hostFenceEnabled(), false);

    process.env.MONCHO_MAINTAINER = '0';
    assert.equal(maintainerMode(), false);
    assert.equal(hostFenceEnabled(), true);

    delete process.env.MONCHO_MAINTAINER;
    assert.equal(maintainerMode(), false);
    assert.equal(hostFenceEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.MONCHO_MAINTAINER;
    else process.env.MONCHO_MAINTAINER = previous;
  }
});

test('the fragment is read at call time, so the switch is not frozen at import', () => {
  // The suite runs *inside* the maintainer's container, where MONCHO_MAINTAINER=1 is
  // ambient — the reason `hostFenceEnabled` reads late. A fragment decided at import
  // would make the two sides of this suite unreachable.
  assert.equal(maintainerGuidance(false), '');
  assert.notEqual(maintainerGuidance(true), '');
});
