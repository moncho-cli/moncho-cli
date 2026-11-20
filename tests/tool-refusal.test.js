import test from 'node:test';
import assert from 'node:assert/strict';

import { REFUSAL_MARK, REFUSAL_VERB, formatRefusalLine, isRefusalLine } from '../app/refusal-line.js';
import {
  CONVERSATION_COLORS,
  REFUSAL_BOLD,
  REFUSAL_COLOR,
  classifyLine,
  colorizeLine,
  colorizeRefusal,
} from '../app/theme.js';
import { formatTranscript } from '../app/tui-render.js';
import { handleToolBatch } from '../app/tool-batch.js';

/**
 * A refused tool call is *news*: the model has always been told why through the
 * structured body of the call's own chunk (`docs/agent/tool-multicall`), and the
 * reader now gets the same news as one row where the call was announced.
 *
 * These cases prove the *presentation* half: the exact row, its own bright-red
 * bold colour, and that both front-end paths which colour anything (`theme.js`,
 * `formatTranscript()`) paint it. The *emission* half — a gate refusal and a cap
 * refusal each printing that row — is proven where the batch lives
 * (`tests/tool-guard.test.js`, `tests/tool-batch.test.js`).
 */

/** One OpenAI-shaped call, the shape the batch normalises. */
const call = (name, args = { intent: 'probe' }) => ({
  id: 'call_1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('the refusal row names the call, the mode and the reason', () => {
  assert.equal(REFUSAL_MARK, '✖');
  assert.equal(REFUSAL_VERB, 'Refused');

  const row = formatRefusalLine({
    name: 'write_file',
    reason: 'the session is in Design, whose only writable files are task.md and implementation_plan.md',
    mode: 'design',
  });

  assert.equal(
    row,
    '  ✖ Refused write_file (design): the session is in Design,'
      + ' whose only writable files are task.md and implementation_plan.md',
  );
  assert.equal(isRefusalLine(row), true);

  // A missing reason still says something, and a refusal without a mode is the
  // shape the batch cap produces: the call, then the reason.
  assert.match(formatRefusalLine({ name: 'run_bash' }), /^ {2}✖ Refused run_bash: /);
  assert.match(formatRefusalLine({ name: 'run_bash', reason: 'too many calls' }), /run_bash: too many calls$/);
  assert.equal(formatRefusalLine({}), '  ✖ Refused unknown_tool: the current mode does not allow this call');

  // The marker plus the verb is the whole signature: prose that merely mentions a
  // refusal, and a stray mark with no verb, are not rows.
  assert.equal(isRefusalLine('Refused to do that'), false);
  assert.equal(isRefusalLine('✖ but no verb'), false);
  assert.equal(isRefusalLine('  -> Calling write_file(path: a.txt)'), false);
});

test('a refusal is bright red and bold, and never a plain error', () => {
  const row = formatRefusalLine({ name: 'write_file', reason: 'Chat is read-only', mode: 'chat' });

  assert.equal(classifyLine(row), 'refusal');
  assert.equal(REFUSAL_COLOR, 'bright-red');
  assert.equal(REFUSAL_COLOR, CONVERSATION_COLORS.refusal);
  assert.equal(REFUSAL_BOLD, true);
  assert.notEqual(REFUSAL_COLOR, CONVERSATION_COLORS.error, 'a refusal is not a plain error');

  assert.equal(colorizeRefusal('x'), '{bright-red-fg}{bold}x{/bold}{/bright-red-fg}');
  assert.equal(colorizeLine(row), `{bright-red-fg}{bold}${row}{/bold}{/bright-red-fg}`);

  // An error row that happens to sit next to a refusal keeps its own plain red.
  assert.equal(classifyLine('Error calling Ollama: connect ECONNREFUSED'), 'error');
  assert.equal(colorizeLine('Error calling Ollama: x'), '{red-fg}Error calling Ollama: x{/red-fg}');

  // A reason that mentions an error must not repaint the row as one: the refusal
  // rule is checked before the `Error` rules for exactly this reason.
  const mentioning = formatRefusalLine({ name: 'run_bash', reason: 'Error: a shell is not scoped', mode: 'design' });
  assert.equal(classifyLine(mentioning), 'refusal');
  assert.match(colorizeLine(mentioning), /^\{bright-red-fg\}\{bold\}/);
});

test('the refusal reaches a rendered transcript, and the glyphs are untouched', () => {
  const row = formatRefusalLine({ name: 'write_file', reason: 'Chat is read-only', mode: 'chat' });
  const rendered = formatTranscript(row);

  assert.equal(rendered, `{bright-red-fg}{bold}${row}{/bold}{/bright-red-fg}`);
  assert.equal(rendered.replace(/\{[^}]+\}/g, ''), row, 'the row a reader sees is the row the batch printed');
  assert.doesNotMatch(rendered, /bright-red(?!-fg)/, 'the tag resolved instead of being printed');
});

test('the row is wired to the batch: a refused call prints it and still tells the model', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };
  const lines = [];
  const reason = 'Chat is strictly read-only';

  await handleToolBatch({
    toolCalls: [call('write_file')],
    window,
    log: (line) => lines.push(String(line)),
    toolFunctions: { write_file: async () => 'should not run' },
    gate: () => ({ reason, mode: 'chat' }),
  });

  const row = lines.find((line) => isRefusalLine(line));
  assert.ok(row, `the refused call is shown next to the call: ${JSON.stringify(lines)}`);
  assert.equal(row, formatRefusalLine({ name: 'write_file', reason, mode: 'chat' }));
  assert.equal(classifyLine(row), 'refusal', 'the printed row is the row the palette paints');

  // Both halves carry the same reason: the reader and the model are told once each,
  // and neither is left guessing.
  const toolChunk = window.chunks.find((chunk) => chunk.role === 'tool');
  assert.match(toolChunk.content, new RegExp(reason));
});
