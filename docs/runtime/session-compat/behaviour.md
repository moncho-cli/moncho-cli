# The compatibility era, and the migrations that cross a break

A session records the version that last wrote it (`docs/runtime/session-version`), and the
rule used to be strict equality of the two strings. Equality was right about the one thing
that must never happen — an **older** build opening bytes a newer one wrote, then saving
them in a shape the older build can no longer read — and wrong about everything else: a
patch release that touched a prompt or a document refused the whole history on the disk for
nothing at all. That friction is what this spec removes, without reopening the door.

## The two halves of the rule

Ordering decides, and a table relaxes it:

| The pin | Answer | Why |
| --- | --- | --- |
| no `monchoVersion` | **open** | Nobody has claimed it; the next save stamps it |
| the running version | **open** | This is the build that owns it |
| **newer** than the running build | **refuse** | A build cannot read bytes a later one wrote |
| older, no break between them | **open** | The releases did not break compatibility |
| older, across a declared break with a migration | **migrate**, then open | The record is carried forward, then this build owns it |
| older, across a break with no migration | **refuse** | The refusal of yesterday: nothing can carry those bytes forward |
| not a semver | **refuse** | Ordering is the rule, so a version nobody can order is not assumed to be fine |

`compatVerdict(pinned, version)` answers with one of three verdicts — `open`, `migrate`,
`refuse` — and the reason that produced it. Both the equality of the first two rows and the
era comparison below are answers about the **same** rule, so the strict case is not special:
a version equals itself and is therefore in its own era.

The table can only ever **widen** what opens. No entry makes a newer pin openable, because
that row is decided by ordering before the break list is read. That is the property the
relaxation must not lose, and it is why the era is not simply "the version moved forward".

## A break is one line, and the list is append-only

```js
export const COMPAT_BREAKS = [
  { version: '0.40.0', note: 'the stamps moved beside the chunks', migrate: 'stampsBecomeAList' },
];
```

`COMPAT_BREAKS` (`utils/session-compat.js`) names the releases that **really** made older
bytes unreadable, oldest first. An entry is added in the session that makes a record, tool
or prompt contract change a previous build cannot read — never for a fix, a document or a
new feature. Declaring a break is not free: it refuses the sessions that cannot take it, so
it is worth three lines of thought before it is worth one entry.

`compatEra(version)` is `FIRST_ERA` plus **every break at or below** that version — inclusive
of its own version, because a break is *landed* at the release that carries it, so a session
written by that release is already in the new era. The list is therefore **append-only and
ascending**, and `validateCompatBreaks()` reports a list that is not: an insert in the middle
would silently re-label every session on the disk.

`compatEraBreaks(from, to)` is the breaks strictly after `from` and at or before `to`, in
order — the steps a session pinned at `from` must cross to be read by `to`. It is empty
exactly when the two versions share an era, which is `compatEra()` stated the other way.

**Empty on purpose.** With no break declared, every session on the disk opens again in the
build that un-strands it, and the list starts recording breaks from here on. A break with no
migration falls back to the refusal of yesterday, so adding this rule never regressed a
session that was openable before it.

## A migration is a pure function

```js
export const MIGRATIONS = {
  stampsBecomeAList: (record) => ({ ...record, stamps: record.stamps ?? [] }),
};
```

A break names one by name, so the break stays data. `migrateRecord(record, steps)` runs the
steps in order and is **all-or-nothing**: a step whose migration is missing or throws stops
the walk and answers `ok: false` with the step that blocked it. A record carried *half* way
forward is worse than one left alone — it would claim an era it does not have — so the input
record is handed back when nothing ran, which is what makes a failed migration safe to
ignore. The pin is deliberately **not** touched here: rewriting the claim, with the audit
line, is the caller's write (`utils/session-version.js#upgradedPin`).

A migration must tolerate a record that lacks the field it is fixing — it may have been
written many releases before the break, or never have carried that field at all. Answering
the record unchanged is a valid migration; throwing is not.

## The write that carries a session forward

`migrateStoredSession(id)` (`utils/session-store.js`) is the only writer:

1. it reads the record as **raw JSON**, before `parseSession()` — a future record whose
   `version` is bumped would throw `UNSUPPORTED_VERSION` at validation, and the migration is
   exactly the thing that has to run before that check rather than after it;
2. it asks for the verdict, and if it is not `migrate` it writes nothing and answers
   `UP_TO_DATE` or `VERSION_LOCKED`;
3. it runs the migrations, re-stamps the pin with `upgradedPin()` and writes the folder
   record, retiring a flat file left by the older layout exactly as `writeSession()` does.

A failed migration answers `migrated: false` and leaves the session byte-for-byte as it was,
so the refusal can report it: nothing is written half way.

## Where the verdict is read

- `app/commands.js#sessionsCommand` — the gate. It asks for the verdict **before** the
  record is loaded and before the context window is replaced, so a refused session leaves
  the conversation you are in exactly as it was. A `migrate` verdict is carried out first
  and the session opens as the build's own; a migration that fails falls back to the refusal
  rather than to a half-migrated record.
- `utils/session-store.js#describeSession` — the picker line. Three answers, three rows: a
  locked row says `locked (…)`, a row that will be carried forward says `upgrade (…)`, and a
  row this build owns carries no mark. A row is **marked, never hidden**.
- `app/upgrade-command.js#upgradeCommand` — `/upgrade`. "May open" is wider than "wrote it",
  so a pin this build may read (including one it migrates) is upgradable, and the migration
  runs **before** the pin moves: the folder must not claim a version while holding a shape
  that version's migration exists to fix.
- `main.js` — `--continue` picks the newest session this build may open, so a session it can
  migrate is reached through the same gate rather than skipped.

## See also

- Which version is running, and the pin itself: `docs/runtime/session-version`
- Where a session lives and how it is written: `docs/runtime/session-store`
- The semver arithmetic the ordering reuses: `utils/version-bump.js`
