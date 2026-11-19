import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The install URL a reader copies is a promise, and a wrong one is a 404 on the first
 * command they run — not a documentation slip.
 *
 * Two facts have to hold together: the README quotes a complete URL with no placeholder
 * left in it, and the repository that URL names is the one `scripts/install.sh` defaults
 * to. If they drift, the two install paths fetch from different places and only one of
 * them is the repository the tag lives in.
 */

const root = process.cwd();
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const installer = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf-8');

const INSTALL_URL = /raw\.githubusercontent\.com\/([^/\s]+\/[^/\s]+)\/([^/\s]+)\/scripts\/install\.sh/;

test('the README quotes a complete install URL, with no placeholder left in it', () => {
  const lines = readme.split('\n').filter((line) => line.includes('raw.githubusercontent.com'));
  assert.ok(lines.length > 0, 'README.md must quote the install one-liner');
  for (const line of lines) {
    assert.match(line, INSTALL_URL, `incomplete install URL: ${line.trim()}`);
  }
  assert.doesNotMatch(readme, /<org>|<repo>/, 'README.md must not ship a placeholder repository');
});

test('the install URL names the repository the installer really downloads from', () => {
  const defaultRepo = installer.match(/REPO="\$\{MONCHO_REPO:-([^}]+)\}"/)?.[1];
  assert.ok(defaultRepo, 'scripts/install.sh must declare a default repository');

  const quoted = readme.match(INSTALL_URL)?.[1];
  assert.equal(
    quoted,
    defaultRepo,
    'the README install URL and the installer default must name the same repository'
  );
});

test('the installer header and its help text name the same repository', () => {
  const defaultRepo = installer.match(/REPO="\$\{MONCHO_REPO:-([^}]+)\}"/)?.[1];

  // The header example is the raw host; the help text is the plain slug. Both must agree
  // with the default, or a reader following the header lands on a different repository.
  assert.match(
    installer,
    new RegExp(`raw\\.githubusercontent\\.com/${defaultRepo}/`),
    'the header example must name the default repository'
  );
  assert.match(
    installer,
    new RegExp(`default: ${defaultRepo}`),
    'the help text must name the default repository'
  );
  assert.doesNotMatch(installer, /<org>|<repo>/, 'scripts/install.sh must not ship a placeholder');
});
