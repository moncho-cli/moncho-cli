import { normalizeSkin, DEFAULT_SKIN, PALETTE_KEYS, PRESENTATION_KEYS } from '../utils/skins-store.js';
import {
  BLESSED_COLORS, BLESSED_BACKGROUNDS, isColorName, isBackgroundColorName,
} from '../utils/color-names.js';
import { BACKGROUND_KEYS } from '../utils/skins-store.js';
/**
 * The **prompt** half of `/skins prompt` (`docs/interface/skins`): turning a
 * natural-language request ("a warm sunset, easier on the eyes") into a skin the
 * command can apply.
 *
 * It is pure in the sense that matters: the model call is **injected**
 * (`createSkinProposer({ callModel })`), so the prompt, the parsing and the
 * normalisation are unit tested with a stub and no network — exactly the shape
 * `app/compaction-runner.js` uses for the summariser.
 *
 * Three decisions:
 *
 *  - **one call, strict JSON.** The proposal is a single provider call whose answer is
 *    a JSON object. The system text names every key and every accepted value, because
 *    a colour is a *blessed colour name* a character-cell terminal knows
 *    (`bright-blue`, `cyan`, `grey`) and a hex code is not one.
 *  - **the parser is forgiving, the normaliser is strict.** A model wraps its JSON in
 *    prose or a fence often enough that `parseSkinProposal` finds the first `{` to the
 *    last `}` instead of demanding a bare object; but whatever it returns is folded
 *    through `normalizeSkin()`, so an invented key is dropped and a bad colour
 *    degrades to the shipped one rather than painting a broken tag.
 *  - **the base skin is the floor.** The request is answered *from the skin in force*,
 *    so "make it warmer" keeps everything it did not mention.
 */

/** Every colour key a proposal may carry, palette first then tokens. */
export const SKIN_COLOR_KEYS = Object.freeze([
  ...PALETTE_KEYS,
  'border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg',
]);

// The vocabulary a proposal may name: exactly the colours a blessed tag really paints
// (`utils/color-names.js`). A hex code or a name blessed does not know would be printed
// literally by the widget, so the model is told the closed list rather than a pattern.
const COLOR_VOCABULARY = BLESSED_COLORS;

/** The system text: what a skin is, and the exact shape of the answer. */
/**
 * The example object the system text shows, built from the real key lists so the wording can
 * never drift from the store: a key the model is not told about is a key it can never move.
 */
function shapeExample() {
  const palette = PALETTE_KEYS.map((key) => `"${key}":"<c>"`).join(',');
  const tokens = ['border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg']
    .map((key) => `"${key}":"<c>"`).join(',');
  return `{"name":"<slug>","palette":{${palette}},${tokens},"boldIntent":true,"boldTracking":true}`;
}

/**
 * The one paragraph explaining what each group of keys actually paints, so the model's
 * choice is informed rather than guessed at.
 *
 * It is spelled out because the omission had a cost: the prompt used to name only the eight
 * row kinds and five look tokens, so the chrome keys (`frame`, `table`, `code`, `quote`,
 * `bullet`, `heading`), the three tool families and the two prose **backgrounds** did not
 * exist as far as the model was concerned. A request for "green background for user
 * messages" then had no key to land on, so the model moved the nearest foreground and
 * reported success while the band never changed — the reported bug.
 */
function keyGuide() {
  return [
    'The palette keys, and what each one paints:',
    '  user, tool, intent, context, error, notice, tracking, refusal — one colour per kind of conversation row.',
    '  frame, table, code, quote, bullet, heading — the chrome the renderer paints (a fence and tool delimiter, a table frame, inline code, a quote, a list bullet, a heading).',
    '  toolRead, toolWrite, toolBash — the three tool families (looking, changing, running a command).',
    'The tokens beside the palette:',
    '  border, brand, hint — the modal border, the brand line and the input hint.',
    '  selected, selectedFg — the band behind the highlighted slash-command row, and the text on it.',
    '  userBg, assistantBg — the BACKGROUND band behind, respectively, the user\'s echoed prompt and the model\'s prose.',
    '  boldIntent, boldTracking — true or false.',
    'A request for a BACKGROUND ("user messages on green", "the model prose in blue") is',
    'userBg or assistantBg and is a background colour. Changing `user` or `intent` instead',
    'changes only the text colour and leaves the band as it was, which is not what was asked.',
  ].join('\n');
}

/** The rules that apply to both prompts. */
function commonRules() {
  return [
    `Every "<c>" is a blessed colour name, one of: ${COLOR_VOCABULARY.join(', ')}.`,
    `For the three BACKGROUND tokens (selected, userBg, assistantBg) use one of: ${BLESSED_BACKGROUNDS.join(', ')}.`,
    'Never use a hex code or an rgb() value: a character-cell terminal addresses named colours.',
    'Keep the parts of the conversation distinguishable: the user echo, the tool rows, the',
    'intent, the context notices, the errors, the tracking milestones and the refusals must',
    'not share a colour.',
  ];
}

export function skinSystemPrompt() {
  return [
    'You design terminal colour skins for Moncho, a coding agent.',
    'Answer with ONE JSON object and nothing else. No prose, no code fence.',
    'Shape:',
    shapeExample(),
    keyGuide(),
    ...commonRules(),
    'A value you omit keeps the colour it has now.',
  ].join('\n');
}

/**
 * The system text for a **customize** request: the same skin, updated in place.
 *
 * The difference matters to the model. A proposal invents a look, so its name is part of
 * the answer; a customize request edits the look already in force, so the name is fixed
 * and the answer is the *changed* colours only. Asking for a name would invite the model
 * to rename the skin the user is trying to adjust.
 */
export function skinCustomizeSystemPrompt() {
  return [
    'You adjust the terminal colour skin Moncho is already using.',
    'Answer with ONE JSON object and nothing else. No prose, no code fence.',
    'Do NOT include a name: the skin being adjusted keeps its name.',
    'Shape:',
    '{"palette":{"<palette-key>":"<c>"},"<token>":"<c>","boldIntent":true}',
    keyGuide(),
    ...commonRules(),
    'Return ONLY the keys the request asks you to change. Omit every other key, and the',
    'whole palette if the request does not touch a row colour: a key you omit keeps the',
    'colour it has now, which is what makes a small request a small change. Do not send the',
    'whole palette back unless the request asks for the whole look to change.',
  ].join('\n');
}

/** The user text: the request, plus the palette in force so "warmer" has a floor. */
export function skinUserPrompt(request, { base = DEFAULT_SKIN } = {}) {
  const current = normalizeSkin(base);
  const palette = SKIN_COLOR_KEYS
    .map((key) => `${key}=${current.palette?.[key] ?? current[key] ?? '?'}`)
    .join(', ');
  return `Request: ${String(request ?? '').trim()}\nCurrent colours: ${palette}`;
}

/** The `messages` one proposal call sends, built from the request and the base skin. */
export function buildSkinMessages(request, { base = DEFAULT_SKIN, customize = false } = {}) {
  return [
    { role: 'system', content: customize ? skinCustomizeSystemPrompt() : skinSystemPrompt() },
    { role: 'user', content: skinUserPrompt(request, { base }) },
  ];
}

/**
 * The JSON object in a model answer, or `null`.
 *
 * Forgiving on purpose: a fenced block or a sentence in front of the object is common,
 * so the slice runs from the first `{` to the last `}`. Anything that does not parse
 * answers `null`, and the command then leaves the look untouched — a proposal is a
 * proposal, and a bad one must never repaint the session.
 */
export function parseSkinProposal(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The problems in a proposal, as sentences, or an empty list when it is usable.
 *
 * `normalizeSkin()` degrades silently on purpose — it is the right rule for a *corrupt
 * file*, where the session must stay readable. It is the wrong rule for a **model
 * answer**: a proposal full of hex codes folded through the normaliser becomes the shipped
 * palette, so the command reports "applied" while the screen does not change by one cell.
 * That is exactly the report this validation exists to answer, so an invalid colour, an
 * unknown key or a non-boolean is *named* and the proposal is refused.
 *
 * Colour names are checked against the closed vocabulary (`utils/color-names.js`):
 * `orange` is refused too, because blessed prints a tag it cannot resolve literally.
 *
 * @param {object} proposal the parsed model answer
 * @returns {string[]} one sentence per problem, empty when the proposal is usable
 */
export function validateProposal(proposal) {
  const problems = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return ['The answer was not a JSON object.'];
  }

  const known = new Set([...SKIN_COLOR_KEYS, 'boldIntent', 'boldTracking', 'name', 'palette']);
  for (const key of Object.keys(proposal)) {
    if (!known.has(key)) problems.push(`"${key}" is not part of a skin.`);
  }

  const palette = proposal.palette;
  if (palette !== undefined && (typeof palette !== 'object' || palette === null || Array.isArray(palette))) {
    problems.push('"palette" must be an object.');
  }
  if (palette && typeof palette === 'object' && !Array.isArray(palette)) {
    for (const [key, value] of Object.entries(palette)) {
      if (!PALETTE_KEYS.includes(key)) {
        problems.push(`"${key}" is not a palette key.`);
        continue;
      }
      if (!isColorName(value)) problems.push(`palette.${key}=${JSON.stringify(value)} is not a colour this terminal can paint.`);
    }
  }

  // The colour tokens, the two prose bands (`userBg`/`assistantBg`) included: an answer that
  // names a band is a real answer now, so it is checked rather than refused as unknown.
  for (const key of ['border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg']) {
    if (proposal[key] === undefined) continue;
    // A background token goes through the background vocabulary, which holds the same names
    // as the foreground one: blessed paints a bright background as well as a bright
    // foreground (`utils/color-names.js#BLESSED_BACKGROUNDS`). A name it cannot paint at
    // all is refused by name, so the modal shows the reason beside the request.
    if (BACKGROUND_KEYS.includes(key)) {
      if (isBackgroundColorName(proposal[key])) continue;
      problems.push(`${key}=${JSON.stringify(proposal[key])} is not a colour this terminal can paint as a background.`);
      continue;
    }
    if (isColorName(proposal[key])) continue;
    problems.push(`${key}=${JSON.stringify(proposal[key])} is not a colour this terminal can paint.`);
  }

  for (const key of ['boldIntent', 'boldTracking']) {
    if (proposal[key] !== undefined && typeof proposal[key] !== 'boolean') {
      problems.push(`${key} must be true or false, not ${JSON.stringify(proposal[key])}.`);
    }
  }

  return problems;
}

/**
 * Fold a proposal into a canonical skin on top of `base`. *
 * The palette and the token colours are merged key by key — a key the proposal named
 * wins, everything else keeps the base — and the whole thing is normalised, so an
 * invalid colour falls back to the shipped one. A proposal with no `name` keeps the
 * base's, so "make it warmer" over the `warm` skin stays `warm`.
 */
export function mergeProposal(proposal, { base = DEFAULT_SKIN } = {}) {
  const floor = normalizeSkin(base);
  const raw = proposal && typeof proposal === 'object' ? proposal : {};
  const palette = { ...floor.palette };
  const given = raw.palette && typeof raw.palette === 'object' ? raw.palette : {};
  for (const key of PALETTE_KEYS) {
    if (given[key] !== undefined) palette[key] = given[key];
  }
  const merged = { ...floor, ...raw, name: raw.name ?? floor.name, palette };
  for (const key of ['border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg']) {
    if (raw[key] === undefined) merged[key] = floor[key];
  }
  for (const key of ['boldIntent', 'boldTracking']) {
    if (raw[key] === undefined) merged[key] = floor[key];
  }
  return normalizeSkin(merged);
}

/**
 * The proposer the command and the modal use.
 *
 * `callModel(messages)` is the provider call (`api/ollama.js#callOllama` shaped, its
 * `message.content` read out); it is injected so the tests drive the whole path with a
 * stub. The returned function answers the proposed skin, or `null` when the model said
 * nothing usable — never an exception, because a session must not break on a bad mood.
 */
export function createSkinProposer({ callModel } = {}) {
  return async function propose(request, { base = DEFAULT_SKIN, signal = null, customize = false } = {}) {
    if (typeof callModel !== 'function') return null;
    const messages = buildSkinMessages(request, { base, customize });
    const response = await callModel(messages, { signal, systemPrompt: false });
    const content = typeof response === 'string' ? response : response?.message?.content;
    const proposal = parseSkinProposal(content);
    if (!proposal) return null;
    // The answer is checked before it is merged: an invalid colour or key is refused
    // with the reason instead of being degraded to the shipped palette by
    // `normalizeSkin()`, which would report "applied" while the screen did not change.
    const problems = validateProposal(proposal);
    if (problems.length) throw new Error(problems.join(' '));    // A customize answer must not rename the skin it is adjusting: the name is dropped
    // before the merge so the base's name is the one that survives.
    const merged = mergeProposal(customize ? { ...proposal, name: undefined } : proposal, { base });
    return merged;
  };
}

/** True when a skin really is the shipped default (so a proposal changed nothing). */
export function isDefaultSkin(skin) {
  const norm = normalizeSkin(skin);
  return PRESENTATION_KEYS.every((key) => norm[key] === DEFAULT_SKIN[key])
    && PALETTE_KEYS.every((key) => norm.palette[key] === DEFAULT_SKIN.palette[key]);
}
