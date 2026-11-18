import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * The linking test for the three realms (docs/README.md).
 *
 * Docs are the contract, code is the truth, tests are the proof. This suite makes
 * the links between the three *enforced* rather than promised:
 *
 *  1. every spec directory holds exactly `behaviour.md` + `spec.yaml`;
 *  2. every declared spec exists, and no spec file is missing from the registry;
 *  3. a spec's `id` matches its directory, and its `domain` matches its first
 *     segment;
 *  4. every `code:` reference names a file that exists, and each symbol it lists
 *     is really declared or exported there;
 *  5. every `tests:` reference names a test file that exists, and each case name
 *     it lists really appears in that file;
 *  6. every source module is covered by at least one spec.
 */

const root = process.cwd();
const docsDir = path.join(root, 'docs');

const readYaml = (file) => parseYaml(fs.readFileSync(file, 'utf-8'));
const read = (file) => fs.readFileSync(file, 'utf-8');

const registry = readYaml(path.join(docsDir, 'index.yaml'));

/** Directories under docs/ that contain a spec.yaml, as docs-relative POSIX paths. */
function findSpecDirs() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'spec.yaml'))) {
        found.push(path.relative(docsDir, full).split(path.sep).join('/'));
      } else {
        walk(full);
      }
    }
  };
  walk(docsDir);
  return found.sort();
}

/**
 * Names declared or exported at the top level of a module: `export function`,
 * `export class`, `export const/let/var`, plain declarations, and every name in
 * an `export { … }` block (including `x as y` aliases).
 */
function declaredSymbols(source) {
  const names = new Set();
  const collect = (regex) => {
    for (const match of source.matchAll(regex)) names.add(match[1]);
  };

  collect(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g);
  collect(/export\s+class\s+([A-Za-z0-9_$]+)/g);
  collect(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g);
  collect(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm);
  collect(/^\s*class\s+([A-Za-z0-9_$]+)/gm);
  collect(/^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm);

  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const alias = part.trim().match(/^(?:[A-Za-z0-9_$]+\s+as\s+)?([A-Za-z0-9_$]+)$/);
      if (alias) names.add(alias[1]);
    }
  }
  return names;
}

/** True when a test file declares a case with exactly this name. */
function declaresCase(source, name) {
  return source.includes(`test('${name}'`) || source.includes(`test("${name}"`);
}

const specDirs = findSpecDirs();
const specs = specDirs.map((id) => {
  const dir = path.join(docsDir, id);
  return { id, dir, spec: readYaml(path.join(dir, 'spec.yaml')) };
});

test('every spec directory holds behaviour.md and spec.yaml, and is registered', () => {
  assert.ok(specDirs.length >= 5, `expected a populated docs tree, found ${specDirs.length}`);

  for (const id of specDirs) {
    assert.ok(fs.existsSync(path.join(docsDir, id, 'behaviour.md')), `${id} is missing behaviour.md`);
    assert.ok(fs.existsSync(path.join(docsDir, id, 'spec.yaml')), `${id} is missing spec.yaml`);
  }

  const registered = (registry.specs || []).map((entry) => String(entry)).sort();
  assert.deepEqual(registered, specDirs, 'docs/index.yaml and the spec files on disk must match');
});

test('a spec id matches its directory and its domain its first segment', () => {
  for (const { id, spec } of specs) {
    assert.equal(spec.id, id, `${id}/spec.yaml declares a different id`);
    assert.equal(spec.domain, id.split('/')[0], `${id} declares a different domain`);
    assert.ok(spec.title, `${id} needs a title`);
    assert.ok(spec.summary, `${id} needs a summary`);
    assert.ok(['active', 'draft', 'deprecated'].includes(spec.status), `${id} has an unknown status`);
  }
});

test('every code reference names a real file and really declares its symbols', () => {
  let checkedFiles = 0;
  let checkedSymbols = 0;

  for (const { id, spec } of specs) {
    assert.ok(Array.isArray(spec.code) && spec.code.length > 0, `${id} must reference at least one code file`);

    for (const reference of spec.code) {
      const target = path.join(root, reference.path);
      assert.ok(fs.existsSync(target), `${id} references a missing file: ${reference.path}`);
      checkedFiles += 1;

      const symbols = declaredSymbols(read(target));
      for (const symbol of reference.symbols || []) {
        assert.ok(
          symbols.has(symbol),
          `${id} references ${reference.path}#${symbol}, which the file does not declare`
        );
        checkedSymbols += 1;
      }
    }
  }

  assert.ok(checkedFiles >= 10, 'expected the specs to reference the codebase');
  assert.ok(checkedSymbols >= 30, 'expected the specs to name real symbols');
});

test('every test reference names a real file and a real case', () => {
  let checkedCases = 0;

  for (const { id, spec } of specs) {
    assert.ok(Array.isArray(spec.tests) && spec.tests.length > 0, `${id} must link at least one test file`);

    for (const reference of spec.tests) {
      const target = path.join(root, reference.path);
      assert.ok(fs.existsSync(target), `${id} references a missing test file: ${reference.path}`);

      const source = read(target);
      assert.ok(Array.isArray(reference.cases) && reference.cases.length > 0, `${id} must name test cases`);
      for (const name of reference.cases) {
        assert.ok(
          declaresCase(source, name),
          `${id} references the case ${JSON.stringify(name)}, which ${reference.path} does not declare`
        );
        checkedCases += 1;
      }
    }
  }

  assert.ok(checkedCases >= 40, `expected the specs to name the suite, found ${checkedCases} cases`);
});

test('every source module is covered by at least one spec', () => {
  const covered = new Set();
  for (const { spec } of specs) {
    for (const reference of spec.code) covered.add(reference.path);
  }

  const sourceFiles = [];
  for (const entry of registry.realms?.code || []) {
    const target = path.join(root, entry);
    assert.ok(fs.existsSync(target), `docs/index.yaml lists a missing code root: ${entry}`);
    if (fs.statSync(target).isFile()) {
      sourceFiles.push(entry);
      continue;
    }
    const walk = (dir) => {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, child.name);
        if (child.isDirectory()) walk(full);
        else if (child.name.endsWith('.js')) {
          sourceFiles.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(target);
  }

  assert.ok(sourceFiles.length >= 20, `expected a real source tree, found ${sourceFiles.length} modules`);

  const uncovered = sourceFiles.filter((file) => !covered.has(file));
  assert.deepEqual(uncovered, [], `these source modules have no spec: ${uncovered.join(', ')}`);
});
