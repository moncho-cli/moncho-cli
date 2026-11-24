import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contentModalSize, contentModalOrigin, nextDocumentIndex, clampScroll,
  documentLabel, contentHint, openContentModal, CONTENT_MODAL_MARGIN,
  CONTENT_MODAL_WIDTH_RATIO, visibleDocuments, documentsChanged,
} from '../app/content-modal.js';
import { taskCommand, parseTaskArg, readDocuments } from '../app/task-command.js';
import { createDefaultCommands } from '../app/commands.js';
import { registerSession, clearSession } from '../utils/host.js';
import { ensureTrackingFiles } from '../utils/tracking-store.js';
import { sessionDir } from '../utils/session-store.js';
import { withTui } from './support/tui-harness.js';

/**
 * `/task` (`docs/interface/task-viewer`): the session's tracking pair, shown read-only.
 *
 * The two halves are proven apart and together: the geometry and the key contract are
 * pure, so they are asserted without a terminal; the modal itself is driven through the
 * real TUI harness; and the command is checked for what it reads and what it refuses.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-task-viewer-'));
process.chdir(root);

const ID = '2026-03-01T09-00-00-000Z';
const FOLDER = sessionDir(ID, { dir: 'agent/sessions' });

const TASK = '# Task list\n\nstatus: in progress: one\n\n## Items\n\n- [ ] one\n- [x] two\n';
const PLAN = '# one\n\nstatus: in progress: one\n\n## Steps\n\n- [ ] write it\n';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const press = (screen, name) => screen.program.emit('keypress', null, { name });

test.afterEach(() => {
  clearSession();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

test('the box takes most of the width, and the height it always did', () => {
  const size = contentModalSize({ width: 100, height: 40 });
  assert.equal(size.width, 90, 'nine tenths of the columns');
  assert.equal(size.width, Math.round(100 * CONTENT_MODAL_WIDTH_RATIO));
  assert.equal(size.height, 40 - CONTENT_MODAL_MARGIN * 2);

  // The width never swallows the screen: a strip is left for the conversation.
  assert.ok(size.width < 100);

  // A tiny terminal still gets a box, clamped to the screen rather than overflowing it.
  const small = contentModalSize({ width: 20, height: 6 });
  assert.ok(small.width <= 20);
  assert.ok(small.height <= 6);

  // A nonsense size falls back to the default instead of producing a negative box.
  const fallback = contentModalSize({ width: Number.NaN, height: -5 });
  assert.ok(fallback.width > 0 && fallback.height > 0);
});

test('the box is anchored right and vertically centred, and never off the screen', () => {
  // The columns it does not take stay on the LEFT, where the conversation is: that strip is
  // the whole reason the box is anchored rather than centred.
  const origin = contentModalOrigin({ width: 90, height: 20 }, { width: 100, height: 40 });
  assert.equal(origin.left, 10);
  assert.equal(origin.top, 10);
  assert.equal(origin.left + 90, 100, 'the box ends exactly at the right edge');

  const clamped = contentModalOrigin({ width: 120, height: 50 }, { width: 100, height: 40 });
  assert.equal(clamped.left, 0);
  assert.equal(clamped.top, 0);
});

test('a re-read is a change only when the documents really differ', () => {
  const before = [{ name: 'task.md', text: 'one' }];
  // A fresh array with the same bytes is NOT a change — the caller rebuilds the list on every
  // tick, so identity would repaint the box three times a minute for nothing.
  assert.equal(documentsChanged(before, [{ name: 'task.md', text: 'one' }]), false);
  assert.equal(documentsChanged(before, [{ name: 'task.md', text: 'two' }]), true, 'an edit');
  assert.equal(documentsChanged(before, [{ name: 'plan.md', text: 'one' }]), true, 'a renamed file');
  assert.equal(documentsChanged(before, []), true, 'a document that went away');
  assert.equal(documentsChanged([], before), true, 'a document that appeared');

  // A document with no text is not shown, so it is not a change either.
  assert.equal(documentsChanged(before, [...before, { name: 'plan.md', text: null }]), false);
  assert.deepEqual(visibleDocuments([...before, { name: 'plan.md', text: null }]), before);
});

test('the document cursor wraps, and a single document stays put', () => {
  assert.equal(nextDocumentIndex(0, 2, 1), 1);
  assert.equal(nextDocumentIndex(1, 2, 1), 0);
  assert.equal(nextDocumentIndex(0, 2, -1), 1);
  assert.equal(nextDocumentIndex(0, 1, 1), 0, 'one document never moves');
  assert.equal(nextDocumentIndex(5, 2, 0), 1, 'an out-of-range index is clamped to the last');
});

test('the scroll offset is clamped to the lines that are really there', () => {
  assert.equal(clampScroll(0, 10, 4), 0);
  assert.equal(clampScroll(4, 10, 4), 4);
  assert.equal(clampScroll(99, 10, 4), 6, 'the last page starts at lines - visible');
  assert.equal(clampScroll(-3, 10, 4), 0, 'a negative offset is zero');
  assert.equal(clampScroll(2, 2, 4), 0, 'a document shorter than the box never scrolls');
});

test('the label names the document and its position, and the hint names the keys', () => {
  assert.equal(documentLabel({ name: 'task.md' }, 0), ' task.md ');
  assert.equal(documentLabel({ name: 'task.md' }, 0, 2), ' task.md (1/2) ');
  assert.equal(documentLabel({ name: 'plan.md' }, 1, 2), ' plan.md (2/2) ');

  assert.match(contentHint(1), /close/);
  assert.doesNotMatch(contentHint(1), /tab/i, 'no tab hint when there is one document');
  assert.match(contentHint(2), /tab/i);
});

test('the modal shows the document verbatim and closes on Escape', async () => {
  await withTui(async (tui) => {
    const text = '# Task list\n\n- [ ] a {braced} item\n';
    const opening = openContentModal({
      screen: tui.screen,
      documents: [{ name: 'task.md', text }],
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-2);
    assert.match(box.getContent(), /\{braced\}/, 'the text is not interpreted as tags');
    assert.equal(box._label?.content, ' task.md ', 'the label names the document');

    press(tui.screen, 'escape');
    const closed = await opening;
    assert.equal(closed.closed, 'escape');
    assert.equal(closed.document, 0);
  });
});

test('the modal cycles between documents and keeps the keyboard lease', async () => {
  await withTui(async (tui) => {
    const opening = openContentModal({
      screen: tui.screen,
      documents: [
        { name: 'task.md', text: 'first' },
        { name: 'implementation_plan.md', text: 'second' },
      ],
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-2);
    assert.match(box.getContent(), /first/);

    press(tui.screen, 'tab');
    assert.match(box.getContent(), /second/, 'tab moves to the next document');
    assert.match(box._label?.content ?? '', /2\/2/);

    press(tui.screen, 'enter');
    const closed = await opening;
    assert.equal(closed.closed, 'enter');
    assert.equal(closed.document, 1);
  });
});

test('the modal resolves null when there is nothing to show', async () => {
  const result = await openContentModal({ screen: null, documents: [] });
  assert.equal(result, null);
});

test('an open viewer follows the files, repainting only when the bytes change', async () => {
  await withTui(async (tui) => {
    // A clock the test drives by hand, so "every few seconds" is proved without waiting.
    const ticks = [];
    let live = { name: 'task.md', text: '- [ ] one\n' };
    const opening = openContentModal({
      screen: tui.screen,
      documents: [live],
      refresh: tui.refresh,
      reload: () => [live],
      refreshMs: 5,
      timer: { set: (fn) => { ticks.push(fn); return { unref() {} }; }, clear: () => {} },
    });
    await flush();

    const box = tui.screen.children.at(-2);
    assert.match(box.getContent(), /- \[ \] one/);
    assert.equal(ticks.length, 1, 'one timer was armed for the open viewer');

    // Same bytes: the box is not repainted for nothing.
    const painted = box.getContent();
    assert.equal(ticks[0](), false, 'a re-read with no change reports no change');
    assert.equal(box.getContent(), painted);

    // The file changes underneath: the next tick shows it.
    live = { name: 'task.md', text: '- [x] one\n- [ ] two\n' };
    assert.equal(ticks[0](), true, 'a real change is reported and repainted');
    assert.match(box.getContent(), /- \[x\] one/);
    assert.match(box.getContent(), /- \[ \] two/);

    press(tui.screen, 'escape');
    await opening;
  });
});

test('a drag inside the viewer copies the selected document text', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    const text = 'alpha bravo\ncharlie delta\necho foxtrot';
    const copied = [];
    const opening = openContentModal({
      screen: tui.screen,
      documents: [{ name: 'task.md', text }],
      refresh: tui.refresh,
      copy: (selection) => {
        copied.push(selection);
        return { ok: true, file: 'clip.txt' };
      },
      notify: () => {},
    });
    await flush();

    const box = tui.screen.children.at(-2);
    // The content is escaped for painting, so a selection is drawn from the box's own rows.
    // The document is verbatim: no brace was invented and the first line is intact.
    assert.match(box.getContent(), /^alpha bravo/, 'the document starts on its own first line');

    const x = box.lpos.xi + box.ileft;
    const y = box.lpos.yi + box.itop;
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    // Press on the first line, release partway along the second: the same gesture the
    // conversation answers (`docs/interface/clipboard-selection`).
    mouse('mousedown', x, y);
    mouse('mouseup', x + 4, y + 1);
    await flush();

    assert.equal(copied.length, 1, 'the release copied exactly once');
    const saved = copied[0].split('\n');
    assert.equal(saved[0], 'alpha bravo', 'the first line is copied whole');
    assert.ok(saved[1].startsWith('char'), `the second line is cut short, got ${JSON.stringify(saved[1])}`);
    assert.equal(saved.length, 2, 'the drag covered exactly two rows');
    assert.ok(clipboardDir, 'the harness gives the copy a directory to write into in the real TUI');

    press(tui.screen, 'escape');
    await opening;
  });
});

test('/task ships in the default registry, so the user can type it', () => {
  const registry = createDefaultCommands();
  assert.ok(registry.has('task'));
  assert.match(registry.get('task').description, /task\.md/);
});

test('/task reads the session pair through the same store the tools use', () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');
  fs.writeFileSync(path.join(root, FOLDER, 'implementation_plan.md'), PLAN, 'utf-8');

  const documents = readDocuments(['task', 'plan']);
  assert.equal(documents[0].text, TASK);
  assert.equal(documents[1].text, PLAN);
  assert.equal(documents[0].path, `${FOLDER}/task.md`);
});

test('/task opens the viewer with both documents and reports the close', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');
  fs.writeFileSync(path.join(root, FOLDER, 'implementation_plan.md'), PLAN, 'utf-8');

  let seen = null;
  const result = await taskCommand().run({
    arg: '',
    contentView: async (view) => {
      seen = view;
      return { closed: 'escape', document: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'VIEWED');
  assert.equal(result.closed, 'escape');
  assert.equal(seen.documents.length, 2);
  assert.equal(seen.documents[0].text, TASK);
  assert.equal(seen.documents[1].text, PLAN);
});

test('/task hands the viewer a live re-read of the same files', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');
  fs.writeFileSync(path.join(root, FOLDER, 'implementation_plan.md'), PLAN, 'utf-8');

  let seen = null;
  await taskCommand().run({
    arg: 'task',
    contentView: async (view) => { seen = view; return { closed: 'escape', document: 0 }; },
  });

  assert.equal(typeof seen.reload, 'function', 'the viewer is given something to re-read with');
  assert.equal(seen.reload()[0].text, TASK, 'the first re-read says what is on disk');
  assert.equal(seen.reload().length, 1, '/task task re-reads task.md alone');

  // The write happens *after* the box was opened, which is the case the reload exists for.
  const edited = TASK.replace('- [ ] one', '- [x] one');
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), edited, 'utf-8');
  assert.equal(seen.reload()[0].text, edited, 'the next re-read sees the write');
});

test('/task names a document, and refuses an unknown one', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  let seen = null;
  const one = await taskCommand().run({
    arg: 'task',
    contentView: async (view) => { seen = view; return { closed: 'enter', document: 0 }; },
  });
  assert.equal(one.ok, true);
  assert.equal(seen.documents.length, 1);
  assert.equal(seen.documents[0].name, 'task.md');

  const refused = await taskCommand().run({ arg: 'nonsense' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'UNKNOWN_ARG');
  assert.deepEqual(parseTaskArg('plan').kinds, ['plan']);
});

test('/task prints the documents when the front end has no screen', async () => {
  registerSession({ id: ID });
  ensureTrackingFiles();
  fs.writeFileSync(path.join(root, FOLDER, 'task.md'), TASK, 'utf-8');

  const result = await taskCommand().run({ arg: 'task' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'LISTED');
  assert.ok(result.lines.some((line) => line.includes('[task.md]')));
  assert.ok(result.lines.some((line) => line.includes('- [ ] one')));
});

test('/task refuses a session with no tracking files instead of seeding them', async () => {
  registerSession({ id: ID });
  const result = await taskCommand().run({ arg: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_TRACKING');
  // Reading must not create anything: the folder stays empty.
  assert.equal(fs.existsSync(path.join(root, FOLDER)), false);
});
