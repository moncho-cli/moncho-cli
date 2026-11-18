import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveWindow,
  windowLines,
  splitOutputLines,
  yamlScalar,
  renderYamlHeader,
  renderCommandOutput,
  OutputRangeError,
  OUTPUT_DELIMITER,
  EMPTY_OUTPUT
} from '../utils/command-output.js';
import { execute as runBashExecute } from '../tools/run_bash.js';

/**
 * task-backlog: "the stdout on bash commands, formatted inside a json, cannot be
 * properly truncated as one would use pipe + head/tail. so maybe bash responses should be
 * a yaml header and the stdout after, and it be possible to pass head/tail parameters to
 * let the model choose that".
 *
 * These cases prove the document shape (YAML header, delimiter, stdout), the head/tail
 * window, and the fact that a failing command still answers a structured envelope.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-output-test-'));
process.chdir(root);

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

/** Split a success document into its header fields, its delimiter line and its body. */
function parseDocument(text) {
  const lines = String(text).split('\n');
  const delimiter = lines.indexOf(OUTPUT_DELIMITER);
  const fields = {};
  for (const line of lines.slice(0, delimiter)) {
    const match = line.match(/^([a-z_]+): (.*)$/);
    if (match) fields[match[1]] = match[2];
  }
  return { fields, delimiterLine: lines[delimiter], body: lines.slice(delimiter + 1).join('\n') };
}

// ---------------------------------------------------------------------------
// The window arithmetic
// ---------------------------------------------------------------------------

test('resolveWindow selects the whole output, a head or a tail', () => {
  assert.deepEqual(resolveWindow({ total: 10 }), {
    mode: 'all', start: 0, end: 10, shown: 10, total: 10, truncated: false, count: null
  });
  assert.deepEqual(resolveWindow({ head: 3, total: 10 }), {
    mode: 'head', start: 0, end: 3, shown: 3, total: 10, truncated: true, count: 3
  });
  assert.deepEqual(resolveWindow({ tail: 3, total: 10 }), {
    mode: 'tail', start: 7, end: 10, shown: 3, total: 10, truncated: true, count: 3
  });
});

test('resolveWindow never reports a truncation it did not make', () => {
  assert.equal(resolveWindow({ head: 10, total: 10 }).truncated, false);
  assert.equal(resolveWindow({ head: 99, total: 10 }).shown, 10);
  assert.equal(resolveWindow({ tail: 99, total: 10 }).shown, 10);
  assert.equal(resolveWindow({ tail: 4, total: 0 }).shown, 0);
  assert.equal(resolveWindow({ total: 0 }).truncated, false);
});

test('resolveWindow refuses both ends at once and a nonsense count', () => {
  assert.throws(() => resolveWindow({ head: 2, tail: 2, total: 10 }), (error) => {
    assert.ok(error instanceof OutputRangeError);
    assert.equal(error.code, 'INVALID_RANGE');
    return true;
  });
  assert.throws(() => resolveWindow({ head: 0, total: 10 }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => resolveWindow({ tail: -1, total: 10 }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => resolveWindow({ head: 2.5, total: 10 }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => resolveWindow({ tail: 'many', total: 10 }), (e) => e.code === 'INVALID_RANGE');
});

test('windowLines slices the text, ignoring a single trailing newline', () => {
  assert.deepEqual(splitOutputLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitOutputLines(''), []);
  assert.deepEqual(splitOutputLines('a\nb'), ['a', 'b']);

  const head = windowLines(`${TEN}\n`, { head: 2 });
  assert.equal(head.text, 'line 1\nline 2');
  assert.equal(head.total, 10);
  assert.equal(head.truncated, true);

  const tail = windowLines(TEN, { tail: 2 });
  assert.equal(tail.text, 'line 9\nline 10');
  assert.equal(tail.mode, 'tail');

  const all = windowLines(TEN, {});
  assert.equal(all.text, TEN);
  assert.equal(all.truncated, false);
});

// ---------------------------------------------------------------------------
// The YAML header
// ---------------------------------------------------------------------------

test('yamlScalar leaves plain values plain and quotes the ambiguous ones', () => {
  assert.equal(yamlScalar('head'), 'head');
  assert.equal(yamlScalar('.'), '.');
  assert.equal(yamlScalar('src/utils'), 'src/utils');
  assert.equal(yamlScalar('/tmp/x'), '/tmp/x');
  assert.equal(yamlScalar(12), '12');
  assert.equal(yamlScalar(true), 'true');

  assert.equal(yamlScalar(''), '""');
  assert.equal(yamlScalar('42'), '"42"', 'a numeric-looking string must stay a string');
  assert.equal(yamlScalar('no'), '"no"', 'a YAML keyword must stay a string');
  assert.equal(yamlScalar('a: b'), '"a: b"', 'a colon would change the parse');
  assert.equal(yamlScalar('line\nbreak'), '"line\\nbreak"');
});

test('renderYamlHeader is one key per line, in the order given', () => {
  const header = renderYamlHeader({ status: 'success', command: 'ls', exit_code: 0, empty: '' });
  assert.equal(header, 'status: success\ncommand: ls\nexit_code: 0\nempty: ""');
  assert.equal(renderYamlHeader({ a: 'x', skipped: undefined, b: null }), 'a: x');
});

test('renderCommandOutput lays out the header, the delimiter and the stdout', () => {
  const doc = renderCommandOutput({
    command: 'cat big.txt', cwd: '.', exitCode: 0,
    stdout: 'line 1\nline 2', total: 40, shown: 2, truncated: true, mode: 'head', head: 2
  });

  const { fields, delimiterLine, body } = parseDocument(doc);
  assert.equal(delimiterLine, OUTPUT_DELIMITER, 'the header is closed by a --- line');
  assert.deepEqual(fields, {
    status: 'success',
    command: 'cat big.txt',
    cwd: '.',
    exit_code: '0',
    lines: '40',
    shown: '2',
    truncated: 'true',
    mode: 'head',
    head: '2'
  });
  assert.equal(body, 'line 1\nline 2');

  const empty = parseDocument(renderCommandOutput({ command: 'true', cwd: '.', stdout: '', total: 0, shown: 0 }));
  assert.equal(empty.body, EMPTY_OUTPUT);
  assert.equal(empty.fields.mode, 'all');
});

// ---------------------------------------------------------------------------
// The tool: a success is a document, a failure keeps its envelope
// ---------------------------------------------------------------------------

test('run_bash answers a success as a YAML header and the stdout after it', async () => {
  fs.writeFileSync('big.txt', `${TEN}\n`);

  const doc = parseDocument(await runBashExecute({ command: 'cat big.txt', intent: 'read the fixture' }));
  assert.equal(doc.fields.status, 'success');
  assert.equal(doc.fields.command, 'cat big.txt');
  assert.equal(doc.fields.cwd, '.');
  assert.equal(doc.fields.exit_code, '0');
  assert.equal(doc.fields.lines, '10');
  assert.equal(doc.fields.shown, '10');
  assert.equal(doc.fields.truncated, 'false');
  assert.equal(doc.fields.mode, 'all');
  assert.equal(doc.body, TEN);
});

test('run_bash head/tail window the stdout without a pipe', async () => {
  fs.writeFileSync('big.txt', `${TEN}\n`);

  const head = parseDocument(await runBashExecute({ command: 'cat big.txt', head: 3, intent: 'read the top' }));
  assert.equal(head.fields.mode, 'head');
  assert.equal(head.fields.head, '3');
  assert.equal(head.fields.lines, '10');
  assert.equal(head.fields.shown, '3');
  assert.equal(head.fields.truncated, 'true');
  assert.equal(head.body, 'line 1\nline 2\nline 3');

  const tail = parseDocument(await runBashExecute({ command: 'cat big.txt', tail: 2, intent: 'read the end' }));
  assert.equal(tail.fields.mode, 'tail');
  assert.equal(tail.fields.tail, '2');
  assert.equal(tail.fields.shown, '2');
  assert.equal(tail.body, 'line 9\nline 10');
});

test('run_bash refuses head and tail together, and never runs the command', async () => {
  const both = JSON.parse(await runBashExecute({ command: 'cat big.txt', head: 1, tail: 1, intent: 'x' }));
  assert.equal(both.status, 'error');
  assert.equal(both.code, 'INVALID_RANGE');

  const nonsense = JSON.parse(await runBashExecute({ command: 'cat big.txt', head: 0, intent: 'x' }));
  assert.equal(nonsense.code, 'INVALID_RANGE');
});

test('run_bash reports an empty output as (no output) inside the document', async () => {
  fs.writeFileSync('empty.txt', '');
  const doc = parseDocument(await runBashExecute({ command: 'cat empty.txt', intent: 'read nothing' }));
  assert.equal(doc.fields.status, 'success');
  assert.equal(doc.fields.lines, '0');
  assert.equal(doc.fields.shown, '0');
  assert.equal(doc.body, EMPTY_OUTPUT);
});

test('a failing command keeps its structured envelope, with a windowed stdout', async () => {
  fs.writeFileSync('big.txt', `${TEN}\n`);
  // A tiny script rather than `node -e`: the sandbox has no shell, so the failure is
  // produced by a file the command runs.
  fs.writeFileSync('fail.js', 'process.stdout.write(require("fs").readFileSync("big.txt", "utf8"));\nprocess.exit(3);\n');

  const failure = JSON.parse(await runBashExecute({
    command: 'node fail.js',
    tail: 2,
    intent: 'fail on purpose'
  }));

  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.equal(failure.mode, 'tail');
  assert.equal(failure.stdoutLines, 10);
  assert.equal(failure.stdoutShown, 2);
  assert.equal(failure.stdoutTruncated, true);
  assert.equal(failure.stdout, 'line 9\nline 10');
  assert.ok(failure.message.includes('exit code 3'));
});

test('run_bash keeps its shell-free refusal codes and its timeout contract', async () => {
  const blocked = JSON.parse(await runBashExecute({ command: 'ls; whoami' }));
  assert.equal(blocked.code, 'SHELL_METACHARACTER');

  const notAllowed = JSON.parse(await runBashExecute({ command: 'rm -rf /' }));
  assert.equal(notAllowed.code, 'COMMAND_NOT_ALLOWED');

  fs.writeFileSync('hang.js', 'setTimeout(() => {}, 5000);\n');
  const timedOut = JSON.parse(await runBashExecute({
    command: 'node hang.js',
    timeoutMs: 200,
    intent: 'time out on purpose'
  }));
  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.code, 'TIMEOUT');
  assert.equal(timedOut.mode, 'all');
});

test('run_bash runs an approved command from a relative cwd and reports it', async () => {
  fs.mkdirSync('nested', { recursive: true });
  fs.writeFileSync('nested/marker.txt', 'x');

  const doc = parseDocument(await runBashExecute({ command: 'ls', cwd: 'nested', intent: 'list the subdirectory' }));
  assert.equal(doc.fields.cwd, path.join(process.cwd(), 'nested'));
  assert.equal(doc.body, 'marker.txt');
});
