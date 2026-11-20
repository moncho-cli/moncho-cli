# The version bump a session owes

`package.json#version` is not decoration: it is the **single source of the release
tag**. `scripts/release.mjs` derives `v<version>` from it, the installer fetches
`archive/refs/tags/<ref>.tar.gz`, and `MONCHO_REF=v0.2.0` is only meaningful because
somebody bumped the manifest before tagging. A session that changes behaviour and
leaves the number alone quietly makes the next release carry more than its tag says.

## The rule

> A session that changes behaviour moves the version, and the move matches the change.
> **One step is enough even when the session changed many things.**

The second sentence is the whole point. A bump **marks the session**, it does not
*measure* it: three features and a fix in one session are still one release, and asking
the model to weigh them would turn a one-line habit into an argument. What the rule
refuses is the two things that are never right:

| Left behind | Verdict |
| ----------- | ------- |
| the same version | `VERSION_UNCHANGED` — the session changed behaviour and said nothing |
| an older version | `VERSION_BACKWARDS` — a published number is never reused |
| one step forward | `VERSION_BUMPED` — accepted, whatever the session's size |
| one step forward, understating the change | `VERSION_BUMPED`, with `understated: true` — a note, never a refusal |

`understated` is reported rather than enforced on purpose. Refusing a `patch` step for
a session that also shipped a feature would punish exactly the sessions the rule exists
to keep honest, and the maintainer can still see the recommendation in the verdict.

## The step each change deserves

`classifyChange()` maps the kinds a session reports to the distance it recommends, and
takes the **largest** one named:

| Kind | Distance |
| ---- | -------- |
| `breaking`, `removal`, `rename` | major |
| `feature`, `behaviour` | minor |
| `fix`, `refactor`, `docs`, `test`, `chore` | patch |

An unknown kind counts as a `patch`: the rule demands *a* step, and the recommendation
is only ever advice.

## The two files, and why they move together

`package-lock.json` records the root version **twice** — the top-level `version` and
`packages[""].version` — and npm reads both. A lockfile that disagrees with the
manifest is a broken install for whoever runs `npm ci`, so `scripts/bump-version.mjs`
rewrites the manifest and the lockfile in one call and verifies each write by reading
it back (`utils/file-io.js` does the same for the harness tools). Editing one without
the other is the mistake this script exists to make impossible.

```
node scripts/bump-version.mjs --minor     # 0.2.0 -> 0.3.0, manifest + lockfile
node scripts/bump-version.mjs --to 1.0.0  # an explicit version
node scripts/bump-version.mjs --check     # did this session move it past the tag?
```

`--check` compares the manifest with the **last release tag** rather than with a
remembered number, so there is no second place the version lives. With nothing tagged
it answers `NO_RELEASE_YET` and passes: the first release declares where it starts.

## How the rule is held to, and where it stays out

Two links, and neither is a promise:

- **`CONTRIBUTING.md`** states the rule as this project's own, next to the realm rule,
  and names the command that carries it out;
- **`scripts/release.mjs`** refuses a manifest that never moved past the last tag, so a
  forgotten bump surfaces at the release instead of in the tag's contents.

The bump is a **maintainer habit, not a runtime rule**: the session performs it when the
maintainer asks for it, not on its own initiative. `config/prompt.md` deliberately says
nothing about the version. That file is not a document of this repository but the system
prompt of every install — `scripts/install.sh` copies it into `~/.config/moncho-cli` and
`bin/lib/image.sh` bakes it into `moncho-agent` — so the session reading it usually
stands in a *user's* project. Telling that session to move `package.json#version` would
be advice about a tree it is not in; on a Node project it would edit a version that has
nothing to do with a release of this one.

## See also

- `utils/version-bump.js` — the arithmetic: `parseSemver()`, `bumpDistance()`,
  `nextVersion()`, `classifyChange()`, `evaluateBump()`.
- `scripts/bump-version.mjs` — the command that carries it out.
- `scripts/release.mjs` — the tag derived from the manifest, and the check that the
  documents name the repository the tag lives in.
- `tests/version-bump.test.js` — the proof.
