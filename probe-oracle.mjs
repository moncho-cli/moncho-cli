import { createRequire } from 'module';
import { applyPatchToString } from './utils/patch_lib.js';

const require = createRequire(import.meta.url);
const jsdiff = require('/tmp/oracle-deps/node_modules/diff');

function diff(relativePath, oldStart, oldLen, newStart, newLen, body) {
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`,
    ...body
  ].join('\n');
}

const cases = [];

cases.push({
  name: 'consecutive adds',
  source: 'alpha\nold\nomega\n',
  patch: diff('order.js', 1, 3, 1, 4, [' alpha', '-old', '+NEW_A', '+NEW_B', ' omega'])
});

const multi = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
cases.push({
  name: 'multiple hunks',
  source: multi,
  patch: [
    '--- a/multi.txt',
    '+++ b/multi.txt',
    '@@ -1,3 +1,3 @@',
    ' l1', '-l2', '+L2', ' l3',
    '@@ -8,3 +8,3 @@',
    ' l8', '-l9', '+L9', ' l10'
  ].join('\n')
});

cases.push({
  name: 'blank context w/o space',
  source: 'const fs = require("fs");\nconst process = require("process");\n\nconst model = "llama3";\n',
  patch: diff('blank.js', 1, 4, 1, 5, [
    ' const fs = require("fs");',
    '+const readline = require("readline");',
    ' const process = require("process");',
    '',
    ' const model = "llama3";'
  ])
});

cases.push({
  name: 'new file /dev/null',
  source: '',
  patch: ['--- /dev/null', '+++ b/new.js', '@@ -0,0 +1,3 @@', '+line1', '+line2', '+line3'].join('\n')
});

cases.push({
  name: 'append at eof',
  source: 'a\nb\n',
  patch: diff('append.txt', 2, 0, 3, 1, ['+c'])
});

cases.push({
  name: 'deletion only',
  source: 'a\nb\nc\n',
  patch: diff('delete.txt', 1, 3, 1, 2, [' a', '-b', ' c'])
});

cases.push({
  name: 'crlf',
  source: 'a\r\nb\r\n',
  patch: diff('crlf.txt', 1, 2, 1, 3, [' a', ' b', '+c'])
});

cases.push({
  name: 'no newline at eof',
  source: 'a\nb',
  patch: ['--- a/nonl.txt', '+++ b/nonl.txt', '@@ -2 +2 @@', '-b', '+B', '\\ No newline at end of file'].join('\n')
});

const drift = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
cases.push({
  name: 'drift +7',
  source: drift,
  patch: diff('drift.txt', 4, 3, 4, 3, [' l11', '-l12', '+L12', ' l13'])
});

for (const c of cases) {
  let ours;
  let oursErr = null;
  try {
    ours = applyPatchToString(c.source, c.patch);
  } catch (e) {
    oursErr = `${e.code}: ${e.message}`;
  }

  let theirs;
  let theirsErr = null;
  try {
    const parsed = jsdiff.parsePatch(c.patch);
    const res = jsdiff.applyPatch(c.source, parsed[0], { fuzzFactor: 2 });
    theirs = res;
  } catch (e) {
    theirsErr = `${e.name}: ${e.message}`;
  }

  const agrees = typeof theirs === 'string' && typeof ours === 'string' && theirs === ours;
  console.log(
    JSON.stringify({
      case: c.name,
      oursErr,
      theirsErr,
      theirsIsFalse: theirs === false,
      agrees,
      ours: oursErr ? null : JSON.stringify(ours),
      theirs: typeof theirs === 'string' ? JSON.stringify(theirs) : theirs
    })
  );
}
