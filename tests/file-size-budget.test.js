import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

/**
 * The configurable file size budget.
 *
 * The backlog: "while we chose to develop with a hard limit of 300 lines, this must be
 * configurable, ......". The number is the one the *model* follows, so it has to reach
 * the model — which means it is rendered into the agent prompt. These cases prove:
 *
 *  - the value is **normalised** like every other knob (a broken environment variable
 *    can never disable the rule or invert it), and the ceiling is **derived** rather
 *    than configured separately;
 *  - the rendering puts the configured numbers into the prompt, replaces **every**
 *    occurrence, and leaves a prompt with no placeholder byte-for-byte unchanged;
 *  - a placeholder that **survived** the rendering is reported, because a prompt
 *    carrying a literal placeholder tells the model nothing;
 *  - the **shipped** prompt renders to the configured budget — the prompt file and the
 *    configuration cannot drift apart — and the provider is sent the rendered text.
 *
 * The environment is set **before** the first import, because `config/constants.js`
 * reads it at module load and the module cache would keep the first value. The file is
 * therefore imported dynamically below.
 */

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// The configured budget for this file: a value that is neither the default nor the
// number the prompt used to carry, so "the configured one wins" is provable.
const CONFIGURED = 450;
process.env.FILE_LINE_LIMIT = String(CONFIGURED);
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.OPENAI_MODEL = 'stub-model';

const {
  FILE_LINE_CEILING_PLACEHOLDER,
  FILE_LINE_LIMIT_PLACEHOLDER,
  FILE_LINE_PLACEHOLDERS,
  fileLineCeiling,
  fileLineNumbers,
  normalizeFileLineLimit,
  renderFileLineLimit,
  unresolvedPlaceholders,
} = await import('../utils/file-size-budget.js');
const { FILE_LINE_LIMIT, FILE_LINE_LIMIT_DEFAULT } = await import('../config/constants.js');
const { callOllama } = await import('../api/ollama.js');

test.after(() => server.close());

test('the budget is normalised, and a broken value falls back to the default', () => {
  // A positive integer is used as it is.
  assert.equal(normalizeFileLineLimit(600), 600);
  assert.equal(normalizeFileLineLimit('600'), 600);
  assert.equal(normalizeFileLineLimit('  450  '), 450);

  // Anything else falls back to the default: the rule can never be disabled or
  // inverted by a typo in an env file.
  for (const broken of ['', '   ', '0', '-1', 'many', 'NaN', null, undefined, {}]) {
    assert.equal(normalizeFileLineLimit(broken), 600, `${JSON.stringify(broken)} must fall back`);
  }

  // A fallback that is itself broken still lands on the default.
  assert.equal(normalizeFileLineLimit('broken', 'also broken'), 600);
  assert.equal(normalizeFileLineLimit('broken', 400), 400);
});

test('the ceiling is derived from the budget, never configured separately', () => {
  assert.equal(fileLineCeiling(600), 900);
  assert.equal(fileLineCeiling(300), 450);
  assert.equal(fileLineCeiling('broken'), 900);

  const numbers = fileLineNumbers(400);
  assert.equal(numbers.limit, 400);
  assert.equal(numbers.ceiling, 600);
});

test('the prompt carries the configured budget and ceiling', () => {
  const rendered = renderFileLineLimit(
    `stay under ${FILE_LINE_LIMIT_PLACEHOLDER} lines; ${FILE_LINE_CEILING_PLACEHOLDER} is the ceiling`,
    { limit: 600 },
  );
  assert.equal(rendered, 'stay under 600 lines; 900 is the ceiling');

  // The configured value, not the default, is what lands in the prompt.
  assert.equal(
    renderFileLineLimit(`under ${FILE_LINE_LIMIT_PLACEHOLDER}`, { limit: 250 }),
    'under 250',
  );
});

test('a prompt with no placeholder is returned unchanged', () => {
  const plain = '# A prompt\n\nNothing to render here.';
  assert.equal(renderFileLineLimit(plain, { limit: 600 }), plain);
  assert.equal(renderFileLineLimit('', { limit: 600 }), '');
  assert.equal(renderFileLineLimit(null, { limit: 600 }), '');
});

test('every occurrence of a placeholder is replaced', () => {
  const rendered = renderFileLineLimit(
    `${FILE_LINE_LIMIT_PLACEHOLDER} and again ${FILE_LINE_LIMIT_PLACEHOLDER}, ceiling ${FILE_LINE_CEILING_PLACEHOLDER}`,
    { limit: 600 },
  );
  assert.equal(rendered, '600 and again 600, ceiling 900');
  assert.deepEqual(unresolvedPlaceholders(rendered), []);
});

test('a placeholder that survived the rendering is reported', () => {
  // A placeholder the renderer does not know about is not ours to replace — but the
  // known ones must never reach the model.
  const half = `the budget is ${FILE_LINE_LIMIT_PLACEHOLDER}`;
  assert.deepEqual(unresolvedPlaceholders(half), [FILE_LINE_LIMIT_PLACEHOLDER]);
  assert.deepEqual(unresolvedPlaceholders(`nothing here`), []);
  assert.equal(FILE_LINE_PLACEHOLDERS.length, 2);
});

test('the shipped prompt renders to the configured budget, and the limit is 600', async () => {
  // The configured value wins over the default.
  assert.equal(FILE_LINE_LIMIT, CONFIGURED, 'the environment sets the budget');
  assert.equal(FILE_LINE_LIMIT_DEFAULT, 600, 'the default budget is 600');

  // ...and the default is what an unset (or broken) variable falls back to. A fresh
  // instance is needed: the module cache would keep the configured one.
  const previous = process.env.FILE_LINE_LIMIT;
  delete process.env.FILE_LINE_LIMIT;
  try {
    const { FILE_LINE_LIMIT: unset } = await import('../config/constants.js?unset-budget');
    assert.equal(unset, 600, 'an unset budget falls back to 600');
  } finally {
    if (previous === undefined) delete process.env.FILE_LINE_LIMIT;
    else process.env.FILE_LINE_LIMIT = previous;
  }

  const raw = fs.readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf-8');
  assert.ok(raw.includes(FILE_LINE_LIMIT_PLACEHOLDER), 'the shipped prompt carries the placeholder');

  const rendered = renderFileLineLimit(raw, { limit: FILE_LINE_LIMIT });
  assert.deepEqual(unresolvedPlaceholders(rendered), [], 'no placeholder may reach the model');
  assert.match(rendered, new RegExp(`stays under ${CONFIGURED} lines; 675 lines is the ceiling`));
  assert.ok(!rendered.includes('300 lines'), 'the old fixed number is gone from the rule');
  assert.ok(!rendered.includes('500 lines'), 'the old fixed ceiling is gone from the rule');
});

test('the provider sends the rendered prompt, not the placeholder', async () => {
  await callOllama([{ role: 'user', content: 'hello' }], [], false, null);

  const sent = requests.at(-1);
  const system = sent.messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, new RegExp(`stays under ${CONFIGURED} lines; 675 lines is the ceiling`));
  assert.ok(
    !system.content.includes(FILE_LINE_LIMIT_PLACEHOLDER),
    'the placeholder must never reach the provider',
  );
  assert.ok(
    !system.content.includes(FILE_LINE_CEILING_PLACEHOLDER),
    'the ceiling placeholder must never reach the provider',
  );
});
