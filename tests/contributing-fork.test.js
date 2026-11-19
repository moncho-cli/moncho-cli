import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The fork path `CONTRIBUTING.md` describes has to be real.
 *
 * Pull requests are closed, so forking is not a consolation prize — it is *the* channel,
 * and a contribution guide that points at a knob that does not exist sends people down a
 * dead end quietly. These cases couple the document to the code it describes: the install
 * environment variable it names is one `scripts/install.sh` really reads, the commands it
 * tells you to run are the ones the manifest really declares, every local link resolves,
 * and the realm rule is stated as this project's own rather than as a rule for your fork.
 */

const root = process.cwd();
const guide = path.join(root, 'CONTRIBUTING.md');

// The guide is a document of this repository, not a build input: a checkout without it
// (a distribution payload, a stripped tree) must not fail the suite. The cases skip
// instead, and every one of them runs again the moment the file is there.
const skip = fs.existsSync(guide) ? false : 'CONTRIBUTING.md is not present in this checkout';
const contributing = skip ? '' : fs.readFileSync(guide, 'utf-8');
const installer = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf-8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

test('the install knob the fork guide names is one the installer really reads', { skip }, () => {
  // `MONCHO_REPO=<you>/repo ./scripts/install.sh` is only a working fork install if the
  // script reads that name. Renaming the variable there must break this, not just the doc.
  assert.match(contributing, /MONCHO_REPO=/, 'the guide must name the variable it relies on');
  assert.match(contributing, /MONCHO_REF/, 'and the ref override beside it');
  assert.match(
    installer,
    /REPO="\$\{MONCHO_REPO:-/,
    'scripts/install.sh must read MONCHO_REPO, or the guide describes an install that cannot work'
  );
  assert.match(installer, /REF="\$\{MONCHO_REF:-/, 'scripts/install.sh must read MONCHO_REF');

  // The URL a fork is fetched from is built from those two, and from nothing hard-coded.
  assert.match(installer, /github\.com\/%s\/archive/, 'the tarball URL must come from REPO');
});

test('the commands the fork guide gives are the ones the manifest declares', { skip }, () => {
  assert.equal(manifest.main, 'main.js', 'the guide tells a reader to run main.js');
  assert.equal(manifest.scripts.start, `node ${manifest.main}`, 'and node main.js as the start script');
  assert.match(manifest.scripts.test, /node --test/, 'and npm test as the suite');
  assert.match(contributing, /node main\.js/, 'the guide must name the entry point');
  assert.match(contributing, /npm test/, 'and the suite');
  // The package is `"type": "module"`, which is why a bare `node main.js` works at all.
  assert.equal(manifest.type, 'module');
});

test('every local link in the fork guide resolves to a real file', { skip }, () => {
  // docs-assets.test.js guards images; a plain Markdown link is just as easy to get wrong
  // and lands the reader on a 404 rather than a broken picture.
  const links = [...contributing.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const local = links.filter((l) => !/^(?:https?:)?\/\//.test(l) && !l.startsWith('#'));

  assert.ok(local.length >= 3, `expected several local links, found ${local.length}`);
  for (const link of local) {
    const target = link.split('#')[0];
    if (target === '') continue;
    assert.ok(
      fs.existsSync(path.resolve(root, target)),
      `CONTRIBUTING.md links to ${link}, which does not exist`
    );
  }
});

test('the fork guide states the realm rule as this project\'s own, not a rule for a fork', { skip }, () => {
  assert.match(contributing, /Moncho's own, for its own repository/);
  assert.match(
    contributing,
    /it is not a requirement for your fork/,
    'the guide must say plainly that a fork may drop the convention'
  );
});

test('the container loop needs Docker, not Node.js on the host', { skip }, () => {
  // The claim used to be false in three places: the maintainer flow was described as
  // needing "Node 22+ and npm" when the agent actually runs inside the image. These
  // assertions couple the documents to the two files that make the claim true, so a
  // changed base image or a changed in-container command breaks the guide instead of
  // leaving it quietly wrong.
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf-8');
  const start = fs.readFileSync(path.join(root, 'start.sh'), 'utf-8');
  const requirements = fs.readFileSync(path.join(root, 'REQUIREMENTS.md'), 'utf-8');
  const usage = fs.readFileSync(path.join(root, 'USAGE.md'), 'utf-8');

  // The runtime lives in the image, so the host does not need Node.
  assert.match(dockerfile, /^FROM node:22-alpine$/m, 'the image is what supplies Node');
  assert.match(start, /docker run[\s\S]*node main\.js/, 'start.sh runs the agent in the container');
  assert.doesNotMatch(start, /^\s*npm (install|ci)\s/m, 'start.sh must not install on the host');

  // Every document that describes the maintainer flow says so.
  assert.match(contributing, /needs Docker, not\s+Node\.js/);
  assert.match(requirements, /does \*\*not\*\* need Node\.js on the host/);
  assert.match(usage, /the host needs Docker and not Node\.js/);

  // And the old false sentence is gone, in the document that carried it.
  assert.doesNotMatch(
    contributing,
    /The checkout flow needs Node 22\+/,
    'the container loop does not need Node 22+ on the host'
  );

  // The container loop is the recommended one, not a fallback.
  assert.match(contributing, /That is the recommended loop/);
  assert.match(usage, /That is the loop to prefer/);
});

test('the suite runs in the container too, so the host needs no Node.js at all', { skip }, () => {
  // The suite used to be listed as a *host-side* command, which quietly made Node a
  // requirement of the maintainer flow. It is not: the image installs dev dependencies
  // so `npm test` runs in there, and `/app/node_modules` is a volume seeded from the
  // image. A host run is the opt-out, and the documents must say so in that order.
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf-8');
  const start = fs.readFileSync(path.join(root, 'start.sh'), 'utf-8');
  const contributing = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf-8');
  const usage = fs.readFileSync(path.join(root, 'USAGE.md'), 'utf-8');
  const requirements = fs.readFileSync(path.join(root, 'REQUIREMENTS.md'), 'utf-8');

  // The image really does install what the suite needs, and seeds the volume with it.
  assert.match(
    dockerfile,
    /npm ci --no-audit --no-fund/,
    'the image must install dependencies, or the suite cannot run inside it'
  );
  assert.match(dockerfile, /Dev dependencies are installed so `npm test`/);
  assert.match(start, /-v \/app\/node_modules/, 'start.sh seeds /app/node_modules from the image');

  // Both documents hand the reader the in-container command, and call the host the opt-out.
  for (const [name, doc] of [['CONTRIBUTING.md', contributing], ['USAGE.md', usage]]) {
    assert.match(doc, /moncho npm test/, `${name} must give the in-container suite command`);
    assert.match(doc, /is the opt-out, not the flow/, `${name} must call the host run the opt-out`);
  }
  assert.match(requirements, /the suite runs there too/);

  // The sentence that made Node a requirement of the flow is gone, in both documents.
  for (const [name, doc] of [['CONTRIBUTING.md', contributing], ['USAGE.md', usage]]) {
    assert.doesNotMatch(
      doc,
      /host-side commands are the only ones that need Node/,
      `${name} must not list the suite as a host-side command`
    );
  }
});

