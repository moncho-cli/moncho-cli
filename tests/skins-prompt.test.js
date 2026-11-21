import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSkin } from '../utils/skins-store.js';
import {
  parseSkinProposal, mergeProposal, createSkinProposer, buildSkinMessages, validateProposal,
} from '../app/skin-prompt.js';import {
  openSkinModal, formatSkinPreview, formatSkinBody, SKIN_ACTIONS,
} from '../app/skin-modal.js';
import { formatSkinWaiting } from '../app/skin-preview.js';
import { withTui } from './support/tui-harness.js';

/**
 * `/skins prompt` (`docs/interface/skins`), the **proposal and modal** half: how a
 * natural-language request becomes a skin (one injected model call, a forgiving parse and
 * a merge over the skin in force), and the modal subchat where the user confirms it.
 *
 * The model call is a stub, so no network is needed, and the modal runs on the real TUI
 * harness, so the key ownership is the one the terminal gets. The store half is proved in
 * `tests/skins.test.js` and the command in `tests/skins-command.test.js`.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));
function press(tui, name, extra = {}) {
  tui.screen.program.emit('keypress', null, { name, full: name, ...extra });
}

test('parseSkinProposal() finds the JSON in a chatty answer and rejects a non-object', () => {
  const body = JSON.stringify({ name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.deepEqual(parseSkinProposal(`sure! ${body} done`), { name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.deepEqual(parseSkinProposal('```json\n' + body + '\n```'), { name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.equal(parseSkinProposal('no json here'), null);
  assert.equal(parseSkinProposal('{not json'), null);
  assert.equal(parseSkinProposal('[1,2,3]'), null, 'an array is not a skin');
});

test('mergeProposal() keeps the base for what the proposal did not name', () => {
  const base = { name: 'warm', palette: { user: 'red', tool: 'green' } };
  const merged = mergeProposal({ palette: { intent: 'bright-yellow', bogus: 'x' } }, { base });
  assert.equal(merged.name, 'warm', 'the base name is kept');
  assert.equal(merged.palette.user, 'red', 'an unnamed base colour survives');
  assert.equal(merged.palette.intent, 'bright-yellow', 'the proposal wins where it named one');
  assert.equal(merged.palette.tool, 'green');
  assert.equal(merged.bogus, undefined);
});

test('validateProposal() refuses an invalid colour, an unknown key and a bad boolean', () => {
  // The regression this pins: `normalizeSkin()` *degrades* a bad colour to the shipped
  // one, so a model answer full of hex codes applied "successfully" and changed nothing on
  // screen. The validator names the problem instead.
  assert.deepEqual(validateProposal({
    name: 'warm',
    palette: { user: 'red', intent: 'bright-blue' },
    border: 'cyan',
    boldIntent: true,
  }), [], 'a valid answer passes');

  const hex = validateProposal({ palette: { intent: '#ff0000' } });
  assert.equal(hex.length, 1);
  assert.match(hex[0], /palette\.intent/, 'the key is named');
  assert.match(hex[0], /#ff0000/, 'the value is named');

  // A name blessed cannot paint is refused too: it would land on screen as literal text.
  assert.match(validateProposal({ palette: { intent: 'orange' } })[0], /orange/);

  assert.match(validateProposal({ bogus: 'x' })[0], /"bogus" is not part of a skin/);
  assert.match(validateProposal({ palette: { nope: 'red' } })[0], /"nope" is not a palette key/);
  assert.match(validateProposal({ boldIntent: 'yes' })[0], /boldIntent must be true or false/);
  assert.match(validateProposal({ border: 'chartreuse' })[0], /border=/);

  assert.deepEqual(validateProposal(null), ['The answer was not a JSON object.']);
  assert.deepEqual(validateProposal([]), ['The answer was not a JSON object.']);
});

test('createSkinProposer() refuses an invalid proposal instead of applying the default', async () => {
  const proposer = createSkinProposer({
    callModel: async () => ({ message: { content: JSON.stringify({ name: 'x', palette: { intent: '#ff0000' } }) } }),
  });
  await assert.rejects(() => proposer('make it red'), /#ff0000/, 'the reason reaches the caller');
});

test('createSkinProposer() answers a skin from an injected model call, and null from junk', async () => {
  const messages = buildSkinMessages('make it warm', { base: { name: 'warm' } });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /blessed colour name/, 'the prompt names the vocabulary');
  assert.match(messages[1].content, /warm/, 'the current colours ride the user turn');

  const good = createSkinProposer({
    callModel: async () => ({ message: { content: JSON.stringify({ name: 'sunset', palette: { intent: 'bright-yellow' } }) } }),
  });
  const skin = await good('make it warm', { base: { name: 'warm' } });
  assert.equal(skin.name, 'sunset');
  assert.equal(skin.palette.intent, 'bright-yellow');

  const junk = createSkinProposer({ callModel: async () => ({ message: { content: 'nothing useful' } }) });
  assert.equal(await junk('x'), null, 'an unusable answer is null, never a throw');

  assert.equal(await createSkinProposer({})('x'), null, 'no callModel means no proposal');
});

test('openSkinModal() offers only Cancel while the skin is being prepared', async () => {
  await withTui(async (tui) => {
    let resolveProposal = null;
    const proposer = () => new Promise((resolve) => { resolveProposal = resolve; });
    const answer = openSkinModal({
      screen: tui.screen,
      proposer,
      request: 'a warm sunset',
      base: { name: 'warm' },
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    // The waiting state is on screen before the model answers, and the only action offered
    // is Cancel: an apply action is not merely refused, it is not on the list.
    assert.match(box.getContent(), /asking the model for a skin/);
    assert.deepEqual(box.state().actions, ['cancel'], 'no apply action exists yet');
    assert.match(box.getContent(), /still being prepared/);
    assert.equal(tui.screen.lockKeys, true, 'the modal owns the keyboard');

    // Enter while waiting cancels instead of applying a skin that does not exist.
    press(tui, 'enter');
    assert.equal(await answer, null);

    resolveProposal({ name: 'sunset', palette: { intent: 'bright-yellow' } });
    await flush();
    assert.notEqual(tui.screen.lockKeys, true, 'the lock is restored');
  });
});

test('openSkinModal() shows the proposal with an editable name and resolves the edited choice', async () => {
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      base: { name: 'warm' },
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    const content = box.getContent();
    assert.match(content, /a warm sunset/, 'the request is shown');
    assert.match(content, /skin: sunset/, 'the proposal is shown');
    assert.match(content, /name: sunset/, 'the name field is prefilled with the proposal');
    assert.deepEqual(box.state().actions, ['apply', 'save', 'cancel'], 'the actions are offered once ready');

    // The name field has the focus: Enter moves to the actions, it does not apply.
    press(tui, 'enter');
    assert.equal(box.state().focus, 'actions');
    press(tui, 'down');
    press(tui, 'enter');
    const choice = await answer;
    assert.deepEqual(choice, { skin: { name: 'sunset', palette: { intent: 'bright-yellow' } }, save: true });
    assert.notEqual(tui.screen.lockKeys, true, 'the lock is restored');

    // Escape cancels.
    const cancelled = openSkinModal({ screen: tui.screen, proposer: async () => ({ name: 'x' }), request: 'r', refresh: tui.refresh });
    await flush();
    press(tui, 'escape');
    assert.equal(await cancelled, null);
  });
});

test('the name in the field is the name the skin is saved under', async () => {
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    // Clear the proposal and type a name the user prefers.
    for (let i = 0; i < 'sunset'.length; i += 1) press(tui, 'backspace');
    box.type('Warm Sunset');
    await flush();
    assert.match(box.getContent(), /name: Warm Sunset/, 'the typed name is what the field shows');
    assert.equal(box.slug(), 'warm-sunset', 'the saved name is the slug of what was typed');

    press(tui, 'enter'); // name -> actions
    press(tui, 'enter'); // apply the first action
    const choice = await answer;
    assert.equal(choice.skin.name, 'warm-sunset', 'the edited name travels with the choice');
    assert.equal(choice.skin.palette.intent, 'bright-yellow', 'the colours are the proposal\'s');
    assert.equal(choice.save, false);
  });
});

test('the apply actions are unavailable while the name is unusable', async () => {
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'r',
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    // Empty the name: there is nothing to save the skin as, so the apply actions go away.
    for (let i = 0; i < 'sunset'.length; i += 1) press(tui, 'backspace');
    await flush();
    assert.deepEqual(box.state().actions, ['cancel'], 'no apply action without a name');
    assert.match(box.getContent(), /give the skin a name/, 'and the field says why');

    press(tui, 'enter'); // name -> actions
    press(tui, 'enter'); // the only action is Cancel
    assert.equal(await answer, null);
  });
});

test('openSkinModal() in customize mode offers only the update action and no name field', async () => {
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'warm', palette: { intent: 'bright-red' } }),
      request: 'make the intent brighter',
      base: { name: 'warm' },
      refresh: tui.refresh,
      customize: true,
      editable: false,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    const content = box.getContent();
    assert.deepEqual(box.state().actions, ['apply', 'cancel'], 'the update-only list, not the proposal one');
    assert.doesNotMatch(content, /^name:/m, 'the name is settled, so there is no field to edit');
    assert.match(content, /Update the active skin/, 'the action says what it does');
    assert.match(content, /Enter applies/, 'and the hint says Enter applies, with no Tab to offer');

    // Enter applies straight away: there is no name field to move through first.
    press(tui, 'enter');
    const choice = await answer;
    assert.equal(choice.skin.name, 'warm', 'the name did not move');
    assert.equal(choice.skin.palette.intent, 'bright-red', 'the change travelled');
    assert.equal(choice.save, false, 'customize updates the file in place, it does not save a new default');
    assert.notEqual(tui.screen.lockKeys, true, 'the lock is restored');
  });
});

test('createSkinProposer() in customize mode asks for the change and keeps the base name', async () => {
  let sent = null;
  const customize = createSkinProposer({
    callModel: async (messages) => {
      sent = messages;
      return { message: { content: JSON.stringify({ name: 'renamed', palette: { intent: 'red' } }) } };
    },
  });
  const updated = await customize('make it red', { base: { name: 'warm', palette: { intent: 'bright-yellow' } }, customize: true });
  assert.match(sent[0].content, /Do NOT include a name/, 'the customize system text says the name is fixed');
  assert.match(sent[0].content, /adjust/i, 'and that the skin is being adjusted');
  assert.equal(updated.name, 'warm', 'a name the model invented is dropped: the base name survives');
  assert.equal(updated.palette.intent, 'red', 'the requested change landed');

  // The proposal path still asks for a name and accepts one.
  const propose = createSkinProposer({
    callModel: async () => ({ message: { content: JSON.stringify({ name: 'sunset', palette: { intent: 'bright-yellow' } }) } }),
  });
  const proposed = await propose('make it warm', { base: { name: 'warm' } });
  assert.equal(proposed.name, 'sunset', 'a proposal may rename the skin');
});

test('formatSkinPreview() wraps a long palette on the colour boundaries', () => {
  const skin = normalizeSkin({ name: 'warm', palette: { intent: 'bright-yellow' } });
  const lines = formatSkinPreview(skin, { width: 30 });
  assert.equal(lines[0], 'skin: warm');
  // No row is longer than the room, and no row splits a colour name in half: every token
  // is the group's label or a whole `key:colour` pair, and the wrap happens on a token
  // boundary (a continuation row carries entries only, which is correct).
  const labels = new Set(['palette', 'tokens']);
  for (const line of lines.slice(1)) {
    assert.ok(line.length <= 30, `row too long: ${line}`);
    for (const token of line.split(/\s+/).filter(Boolean)) {
      if (labels.has(token)) continue;
      assert.match(token, /^[A-Za-z]+:[a-z-]+$/, `a token was cut: ${token}`);
    }
  }
  assert.match(formatSkinBody({ request: 'r', state: 'waiting' }).join('\n'), /asking the model/);
  assert.match(formatSkinBody({ request: 'r', state: 'error' }).join('\n'), /no skin came back/);
});

test('the waiting state is live: the frame moves and the seconds climb while the call runs', async () => {
  // The defect this pins: the modal used to paint `asking the model for a skin…` once and
  // repaint only when the call settled, so a multi-second call left it frozen — which reads
  // as a hang. The frame and the elapsed time now move, and the clock is injected so the
  // whole thing is provable without waiting on a real interval.
  const first = formatSkinWaiting({ frame: 0, elapsedMs: 0 });
  const next = formatSkinWaiting({ frame: 1, elapsedMs: 1200 });
  assert.match(first, /asking the model for a skin/);
  assert.notEqual(first, next, 'a later frame and a later time are a different line');
  assert.match(next, /1s/, 'the elapsed time is spelled by formatDuration()');
  assert.notEqual(
    formatSkinWaiting({ frame: 0 }).split(' ').at(-2),
    formatSkinWaiting({ frame: 1 }).split(' ').at(-2),
    'the spinner glyph advances with the frame',
  );

  await withTui(async (tui) => {
    let clock = 0;
    let resolveProposal = null;
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: () => new Promise((resolve) => { resolveProposal = resolve; }),
      request: 'a warm sunset',
      refresh: tui.refresh,
      now: () => clock,
      intervalMs: 1_000_000, // the timer never fires; the test drives the frames
    });
    await flush();
    const widget = tui.screen.children.at(-1);

    const before = widget.getContent();
    assert.match(before, /asking the model for a skin… \S+ 0s/, 'the first frame is painted');
    assert.equal(widget.isWaiting(), true, 'the waiting timer is running while the call is in flight');

    clock = 2000;
    widget.tick();
    widget.tick();
    const after = widget.getContent();
    assert.notEqual(after, before, 'the waiting line changed between frames');
    assert.match(after, /2s/, 'the seconds followed the clock, not the tick count');

    resolveProposal({ name: 'sunset', palette: { intent: 'bright-yellow' } });
    await flush();
    assert.equal(widget.isWaiting(), false, 'the timer is released the moment the call settles');
    assert.match(widget.getContent(), /skin: sunset/, 'the proposal replaces the waiting line');

    widget.cancel();
    assert.equal(await answer, null);
  });
});
