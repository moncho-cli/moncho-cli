import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The shipped Monchofile starters, checked for the failure that cannot be seen until
 * someone runs `moncho-cli` in a fresh project: a `COPY` whose source is not there.
 *
 * Docker fails a build when a COPY source matches nothing — a wildcard included, which
 * is what `COPY requirements*.txt ./` did to every Python project with no
 * requirements.txt (a pyproject.toml or setup.py project, both of which detect_kind()
 * routes to that starter). The build died at that step and the user had no way to know
 * which file was expected.
 *
 * The rule this file enforces: a starter may only COPY a path that exists in the
 * *minimal* project of its kind — the one file detection looks for — because that is the
 * smallest tree the starter is ever handed.
 */

const root = path.resolve(import.meta.dirname, '..');
const templateDir = path.join(root, 'templates');

/** The one marker `bin/lib/template.sh#detect_kind` needs to pick each starter. */
const MINIMAL_PROJECT = {
  'Monchofile.node': ['package.json'],
  // detect_kind() answers `python` for pyproject.toml, requirements.txt *or* setup.py,
  // so the smallest tree that reaches this starter is one file with no lockfile and no
  // requirements list — which is exactly the case `COPY requirements*.txt` used to break.
  'Monchofile.python': ['pyproject.toml'],
  'Monchofile.go': ['go.mod'],
  'Monchofile.minimal': [],
};

/** Every COPY in a Monchofile, with its sources, flags dropped. */
function copyInstructions(text) {
  const found = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line)) continue;
    // COPY --flag src... dest   ->  sources are everything between the flags and dest.
    const parts = line.replace(/^COPY\s+/i, '').split(/\s+/).filter((p) => !p.startsWith('--'));
    parts.pop();
    found.push(parts);
  }
  return found;
}

/** Whether a COPY source exists in a project holding exactly `files`. */
function sourceExists(source, files) {
  if (source === '.') return true;
  // A wildcard must match at least one file; Docker does not treat "no match" as empty.
  if (source.includes('*') || source.includes('?')) {
    const pattern = new RegExp(`^${source.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return files.some((file) => pattern.test(file));
  }
  return files.includes(source);
}

const templates = fs.readdirSync(templateDir).filter((name) => name.startsWith('Monchofile.'));

test('the starter templates are the ones detection knows about', () => {
  assert.deepEqual(
    templates.sort(),
    Object.keys(MINIMAL_PROJECT).sort(),
    'a template and its minimal-project entry must be added together'
  );
});

for (const name of templates) {
  const text = fs.readFileSync(path.join(templateDir, name), 'utf-8');
  const minimal = MINIMAL_PROJECT[name];

  test(`${name} copies nothing that the minimal project of its kind lacks`, () => {
    // Not every starter copies: `Monchofile.minimal` carries no toolchain and no
    // dependency install, because the runner bind-mounts the workspace over /app. What
    // is checked is only that a COPY it *does* declare can be satisfied.
    for (const group of copyInstructions(text)) {
      for (const source of group) {
        assert.ok(
          sourceExists(source, minimal),
          `${name}: COPY ${source} would fail for a project holding only ${JSON.stringify(minimal)}`
        );
      }
    }
  });

  test(`${name} honours the two rules: moncho-agent first, no ENTRYPOINT/CMD`, () => {
    const instructions = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    assert.match(instructions[0], /^FROM\s+moncho-agent\b/, 'the first instruction is the agent base');
    for (const line of instructions) {
      assert.doesNotMatch(line, /^ENTRYPOINT\b/i, 'moncho-cli appends the entrypoint');
      assert.doesNotMatch(line, /^CMD\b/i, 'a CMD would be handed to that entrypoint');
    }
  });
}