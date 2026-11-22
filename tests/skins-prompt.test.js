import test from 'node:test';
import assert from 'node:assert/strict';

import { PALETTE_KEYS } from '../utils/skins-store.js';
import { liveProfile } from '../app/skins-prompt-action.js';
import { setPalette, setTokens, resetTheme } from '../app/theme.js';
import {
  parseSkinProposal, mergeProposal, createSkinProposer, buildSkinMessages, validateProposal,
} from '../app/skin-prompt.js';

/**
 * `/skins prompt` (`docs/interface/skins`), the **proposal** half: how a natural-language
 * request becomes a skin — the forgiving parse, the strict validation and the merge over
 * the skin in force.
 *
 * The model call is a stub, so no network is needed. The modal that confirms the proposal
 * lives in `tests/skins-modal.test.js` (its confirm flow) and
 * `tests/skins-modal-keys.test.js` (its keyboard contract); the store half is proved in
 * `tests/skins.test.js` and the command in `tests/skins-command.test.js`.
 */

test('parseSkinProposal() finds the JSON in a chatty answer and rejects a non-object', () => {
  const body = JSON.stringify({ name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.deepEqual(parseSkinProposal(`sure! ${body} done`), { name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.deepEqual(parseSkinProposal('```json\n' + body + '\n```'), { name: 'warm', palette: { intent: 'bright-yellow' } });
  assert.equal(parseSkinProposal('no json here'), null);
  assert.equal(parseSkinProposal('{not json'), null);
  assert.equal(parseSkinProposal('[1,2,3]'), null, 'an array is not a skin');
});

test('the system prompts name every key a skin can move, the two bands and the chrome included', () => {
  // The reported bug: the prompt named the eight row kinds and five look tokens, so the
  // chrome and the two prose *backgrounds* did not exist for the model. A request for "a
  // green background" had no key to land on, so the model moved the nearest foreground and
  // reported success while the band stayed exactly as it was.
  const prompt = buildSkinMessages('make it warm').find((m) => m.role === 'system').content;
  for (const key of PALETTE_KEYS) assert.match(prompt, new RegExp(`"?${key}"?`), `the palette key ${key} is named`);
  assert.match(prompt, /userBg/, 'the user prose background is named');
  assert.match(prompt, /assistantBg/, 'the model prose background is named');
  assert.match(prompt, /background/i, 'and a background request is said to mean one');

  const customize = buildSkinMessages('make it warm', { customize: true })
    .find((m) => m.role === 'system').content;
  assert.match(customize, /userBg/);
  assert.match(customize, /assistantBg/);
  assert.match(customize, /Do NOT include a name/, 'a customize answer never renames the skin');
  assert.match(customize, /ONLY the keys the request asks/i, 'and changes only what was asked');
});

test('validateProposal() accepts the two band tokens, and refuses an unpaintable one', () => {
  assert.deepEqual(validateProposal({ userBg: 'green', assistantBg: 'blue' }), [],
    'a request for a background is a real answer now');
  const bad = validateProposal({ userBg: 'orange' });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /userBg/, 'and a band named with an unpaintable colour is refused by name');
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

test('mergeProposal() moves the prose band a proposal named and keeps the one it did not', () => {
  const base = { name: 'warm', palette: {}, userBg: 'blue', assistantBg: 'red' };
  const merged = mergeProposal({ userBg: 'green' }, { base });
  assert.equal(merged.userBg, 'green', 'the named band moves');
  assert.equal(merged.assistantBg, 'red', 'and the band the answer did not mention is kept');
});

test('liveProfile() is the look on screen, not the file, so customize adjusts what the user sees', () => {
  // An unsaved `/skins <name> token=…` moves the screen without writing anything, so the
  // model has to be told the colours actually in force — otherwise "keep everything I did
  // not mention" keeps colours the user already changed away from.
  try {
    resetTheme();
    setPalette({ intent: 'bright-yellow' });
    setTokens({ userBg: 'green', assistantBg: 'blue' });

    const onScreen = liveProfile({ name: 'azul', palette: { intent: 'bright-blue', user: 'cyan' } });
    assert.equal(onScreen.name, 'azul', 'the identity comes from the active skin');
    assert.equal(onScreen.palette.intent, 'bright-yellow', 'the live colour wins over the file');
    assert.equal(onScreen.palette.user, 'cyan', 'an untouched file colour is kept');
    assert.equal(onScreen.userBg, 'green', 'and the live bands travel with it');
    assert.equal(onScreen.assistantBg, 'blue');

    // No active skin (the built-in default) still answers a canonical profile.
    const builtin = liveProfile(null);
    assert.equal(builtin.name, 'default');
    assert.equal(builtin.palette.intent, 'bright-yellow', 'still the live profile');
  } finally {
    resetTheme();
  }
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

test('createSkinProposer() in customize mode asks for the change and keeps the base name', async () => {
  let sent = null;
  const customize = createSkinProposer({
    callModel: async (messages) => {
      sent = messages;
      return { message: { content: JSON.stringify({ name: 'renamed', palette: { intent: 'bright-red' } }) } };
    },
  });
  const updated = await customize('make it red', { base: { name: 'warm', palette: { intent: 'bright-blue' } }, customize: true });
  assert.match(sent[0].content, /Do NOT include a name/, 'the customize system text says the name is fixed');
  assert.match(sent[0].content, /adjust/i, 'and that the skin is being adjusted');
  assert.equal(updated.name, 'warm', 'a name the model invented is dropped');
  assert.equal(updated.palette.intent, 'bright-red', 'the change landed');

  // The proposal path still asks for a name and accepts one.
  const propose = createSkinProposer({
    callModel: async () => ({ message: { content: JSON.stringify({ name: 'sunset', palette: { intent: 'bright-yellow' } }) } }),
  });
  const proposed = await propose('make it warm', { base: { name: 'warm' } });
  assert.equal(proposed.name, 'sunset', 'a proposal may rename the skin');
});
