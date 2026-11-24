import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  shouldReviewDesign,
  formatDesignReview,
  createDesignReview,
} from '../app/design-review.js';
import { TRACKING_COLOR, classifyLine } from '../app/theme.js';
import { createSessionMode } from '../app/session-mode.js';
import { runSessionLoop } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';
import { registerSession, clearSession } from '../utils/host.js';
import { ensureTrackingFiles } from '../utils/tracking-store.js';
import { sessionDir } from '../utils/session-store.js';

/**
 * The `design` checklist review (`docs/interface/design-review`).
 *
 * Proven in two halves: the decision and the block are pure, so they are asserted without a
 * terminal or a session; and the reviewer is driven through a real session folder, so the
 * rule that it reads `task.md` and shows it only in `design` is exercised end to end.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-design-review-'));
process.chdir(root);

const ID = '2026-04-02T10-00-00-000Z';
const FOLDER = sessionDir(ID, { dir: 'agent/sessions' });
const TASK = '# Task list\n\nstatus: in progress: one\n\n## Items\n\n- [ ] one\n';

/** A block sink that collects whatever it is handed. */
function collector() {
  const blocks = [];
  const logBlock = (block) => blocks.push(block);
  return { blocks, logBlock };
}

test.afterEach(() => {
  clearSession();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

test('the review belongs to design alone, and the lock is covered by the mode', () => {
  assert.equal(shouldReviewDesign({ mode: 'design' }), true);
  assert.equal(shouldReviewDesign({ mode: 'chat' }), false);
  assert.equal(shouldReviewDesign({ mode: 'work' }), false);
  // `work:on` pins the mode to work, so the locked state can never read as design.
  const mode = createSessionMode({ mode: 'design' });
  assert.equal(shouldReviewDesign(mode), true);
  mode.setWork(true);
  assert.equal(mode.mode, 'work');
  assert.equal(shouldReviewDesign(mode), false);
  // Nothing to read a mode off means nothing to review.
  assert.equal(shouldReviewDesign(null), false);
  assert.equal(shouldReviewDesign({}), false);
});

test('the block is titled, carries the checklist verbatim, and paints in the tracking colour', () => {
  const block = formatDesignReview({ content: TASK, path: `${FOLDER}/task.md` });
  assert.match(block.header, /task\.md/);
  assert.match(block.header, /design review/);
  assert.match(block.header, /7 lines/, 'the header counts the lines it carries');
  assert.equal(block.body, TASK, 'the checklist is shown byte for byte');
  assert.equal(block.bodyColor, TRACKING_COLOR, 'the review reads as a tracking milestone');
  assert.equal(block.collapsed, false, 'shown, never folded');
  // The `[Tracking]` marker is what the palette recognises, so the header paints like one.
  assert.equal(classifyLine(block.header), 'tracking');

  // With no path the header simply names the file.
  assert.doesNotMatch(formatDesignReview({ content: TASK }).header, /\(/);
  // An empty checklist is still information rather than a blank box.
  assert.equal(formatDesignReview({ content: '' }).body, '(empty)');
});

test('a design turn shows the checklist, and a repeated one does not', () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  const { blocks, logBlock } = collector();
  const mode = createSessionMode({ mode: 'design' });
  const review = createDesignReview({ mode, logBlock });

  assert.equal(review.maybeShow(), true, 'the first review is shown');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].body, TASK);

  // The same bytes again: silence, so a turn that touched nothing is not re-dumped.
  assert.equal(review.maybeShow(), false, 'an unchanged checklist is not repeated');
  assert.equal(blocks.length, 1);

  // The file moves: the next turn shows it again.
  const edited = TASK.replace('- [ ] one', '- [x] one\n- [ ] two');
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), edited, 'utf-8');
  assert.equal(review.maybeShow(), true, 'a changed checklist is reviewed again');
  assert.equal(blocks[1].body, edited);
  assert.deepEqual(review.describe(), { shown: 2, hasShown: true });

  review.reset();
  assert.equal(review.maybeShow(), true, 'reset forgets what was shown');
});

test('chat and work show nothing, and a missing checklist is silence', () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  const { blocks, logBlock } = collector();
  assert.equal(createDesignReview({ mode: { mode: 'chat' }, logBlock }).maybeShow(), false);
  assert.equal(createDesignReview({ mode: { mode: 'work' }, logBlock }).maybeShow(), false);
  assert.equal(blocks.length, 0, 'only design reviews anything');

  // A front end with no block sink (the line CLI) has nowhere to put a block.
  assert.equal(createDesignReview({ mode: { mode: 'design' }, logBlock: null }).maybeShow(), false);

  // A session with no task.md has nothing to review — and reading must not create it.
  fs.rmSync(path.join(root, FOLDER), { recursive: true, force: true });
  clearSession();
  registerSession({ id: ID });
  assert.equal(createDesignReview({ mode: { mode: 'design' }, logBlock }).maybeShow(), false);
  assert.equal(fs.existsSync(path.join(root, FOLDER)), false, 'reading seeds nothing');
  assert.equal(blocks.length, 0);
});

test('a reader that throws costs the turn nothing', () => {
  const { blocks, logBlock } = collector();
  const review = createDesignReview({
    mode: { mode: 'design' },
    logBlock,
    readTask: () => { throw new Error('task.md is locked'); },
  });
  assert.equal(review.maybeShow(), false, 'the failure is contained, never thrown');
  assert.equal(blocks.length, 0);
});

test('the review is presentation only: it never touches the model context', async () => {
  // The block goes to the transcript's own sink and nowhere else, so nothing about it can
  // reach a request or a session file — the same rule the tracking block follows. Proven by
  // the shape of the call rather than by inspecting a provider: the reviewer is given a
  // *block sink*, and the module imports no context window, session store or provider.
  const source = fs.readFileSync(new URL('../app/design-review.js', import.meta.url), 'utf-8');
  // The claim is about what the module can *reach*, so it is read off its imports: a module
  // that cannot import the window, the manager or a provider cannot write into any of them,
  // whatever its comments say about them.
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /context-window|conversation-manager|ollama|provider/i,
    'the reviewer imports no route to the model or the window');
  assert.match(imports, /tracking-store/, 'it reads the checklist through the tracking store');
  assert.match(source, /logBlock/, 'it reaches the transcript through the block sink alone');
});

/** A front end that answers with a fixed script and never blocks. */
function scriptedCli(script) {
  const asked = [];
  const queue = [...script];
  return {
    asked,
    question: async () => {
      const next = queue.length ? queue.shift() : 'exit';
      asked.push(next);
      return next;
    },
    exit: async () => {},
  };
}

test('the loop reviews the checklist when a design turn lands, and not in chat', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  const { blocks, logBlock } = collector();
  const mode = createSessionMode({ mode: 'design' });
  const review = createDesignReview({ mode, logBlock });

  await runSessionLoop({
    cli: scriptedCli(['keep working']),
    log: () => {},
    manager: { processInput: async () => {} },
    commands: createCommandRegistry(),
    mode,
    designReview: review,
    saveSession: () => null,
  });

  assert.equal(blocks.length, 1, 'the turn landed and the checklist came back on screen');
  assert.equal(blocks[0].body, TASK);

  // The very same loop in `chat` shows nothing: the behaviour belongs to `design`.
  const chat = createDesignReview({ mode: createSessionMode({ mode: 'chat' }), logBlock });
  await runSessionLoop({
    cli: scriptedCli(['just a question']),
    log: () => {},
    manager: { processInput: async () => {} },
    commands: createCommandRegistry(),
    mode: createSessionMode({ mode: 'chat' }),
    designReview: chat,
    saveSession: () => null,
  });
  assert.equal(blocks.length, 1, 'chat added no review');
});

test('an aborted design turn still reviews, and a failure does not', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  const { blocks, logBlock } = collector();
  const aborted = createDesignReview({ mode: { mode: 'design' }, logBlock });
  await runSessionLoop({
    cli: scriptedCli(['start something']),
    log: () => {},
    manager: {
      processInput: async () => {
        throw Object.assign(new Error('Request was aborted'), { name: 'AbortError' });
      },
    },
    commands: createCommandRegistry(),
    mode: createSessionMode({ mode: 'design' }),
    designReview: aborted,
    saveSession: () => null,
  });
  // Thinking stopped and the session is waiting for a person again, which is the moment the
  // review belongs to — an abort is not a failure of the session, it is the user stopping it.
  assert.equal(blocks.length, 1, 'an aborted turn still hands the checklist back');

  // A real failure escapes the loop, and the process is on its way out: no review.
  const failing = createDesignReview({ mode: { mode: 'design' }, logBlock });
  await assert.rejects(runSessionLoop({
    cli: scriptedCli(['boom']),
    log: () => {},
    manager: { processInput: async () => { throw new Error('provider exploded'); } },
    commands: createCommandRegistry(),
    mode: createSessionMode({ mode: 'design' }),
    designReview: failing,
    saveSession: () => null,
  }), /provider exploded/);
  assert.equal(blocks.length, 1, 'a failing turn showed no review');
});
