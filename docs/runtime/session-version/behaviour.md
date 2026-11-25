# Which version is running, and which sessions it may open

A conversation is written by one build of the agent. Two builds are not interchangeable in
every direction: a newer runtime may read a record shape an older one cannot, and a tool
contract may have moved. So a session records **the version that last wrote it**, and the pin
is judged by **compatibility era** rather than by equality of the two strings
(`docs/runtime/session-compat`).

The one rule that must never break is the door's direction: a pin **newer** than the running
build is refused, always — there is no un-migration, because the newer build has already read
and written these bytes. Where equality was wrong is every other case: a patch release that
touched a prompt or a document refused the whole history on the disk for nothing. An **older**
pin now opens while nothing between the two versions declares a break, and is carried forward
by a declared migration where one exists — falling back to the refusal of yesterday where it
does not.

## The pin

The record carries it beside the metadata it already keeps per session (`model`, `skin`):

```json
{ "version": 1, "id": "2026-11-23T21-50-30-535Z",
  "monchoVersion": "0.28.3" }
```

`serializeSession()` stamps it on every save, so the pin is always the build that produced
the bytes on disk and never one that merely passed through. A resumed conversation keeps
writing under its own pin until an upgrade rewrites it.

An optional audit pair records a deliberate move:

```json
{ "monchoVersion": "0.28.3",
  "upgradedFrom": "0.28.2", "upgradedAt": "2026-11-24T09:12:00.000Z" }
```

## The answers

`sessionVerdict(session, version)` is the whole decision, and `canOpenSession()` is its one
question — does it read `refuse`? The gate in `/sessions` needs the middle answer as well: a
session that must be **migrated** opens only *after* its bytes are carried forward.

| The record | Answer | Why |
| --- | --- | --- |
| no `monchoVersion` | **open** | Nobody has claimed it; the next save stamps it |
| the running version | **open** | This is the build that owns it |
| older, no break between them | **open** | The releases did not break compatibility |
| older, across a declared break | **migrate** | The record can be carried forward |
| **newer** than this build | **refuse** | A build cannot read bytes a later one wrote |
| older, a break with no migration | **refuse** | Nothing can carry those bytes forward |

The first row is what keeps existing history usable. `null` and a refusal are deliberately
different answers: an unpinned record is not "some unknown other version", and treating it as
one would strand every session already on disk at every upgrade.

## Ordering first, the break list only relaxing it

The verdict compares semvers, so "newer is fine" never becomes true by accident: that row is
decided before the break list is read, and no entry can open it. What the era table adds is
the *other* direction — a version that moved forward without breaking compatibility stops
costing the user their history. The equivalence is exact: two versions share an era precisely
when no declared break stands between them.

## The refusal names the way in

`sessionVersionRefusal()` produces the message, and the last line is the point of it:

```
Session 2026-11-22T… was last written by Moncho 0.28.2; this is 0.28.3.
Open it with the version that owns it, then /upgrade to move it forward:
  moncho-cli --version 0.28.2
```

A pin **newer** than this build and a pin stranded across a break nobody has written a
migration for are different dead ends, so they get different sentences: the first is a build
this one cannot be, the second is a change this one cannot make. The way in is the same
command in both cases, because in both the version that owns the bytes is where the work has
to start.

## Where the running version comes from

`runningVersion(env)` reads `MONCHO_VERSION`, which the runner sets because it is the thing
that chose which installed payload to mount. Without it — a checkout run through
`./start.sh`, or a bare `node main.js` — the manifest's own version is the answer, since
that is what the checkout actually is.

## Upgrading is a rewrite of the claim

`upgradedPin()` builds the fields `/upgrade` writes. An upgrade does **not** bypass the
check: it moves the session to the new version, so the old one refuses it afterwards. That
asymmetry is the design, not an oversight — there is no downgrade verb, because the newer
build has already read and written the conversation.

### The flow, and why it takes four steps

```
moncho-cli --version 0.28.2     # 1. start the version that owns the session
/sessions                        # 2. open it
/upgrade                         # 3. move it to the newest version, then exit
moncho-cli --continue            # 4. open it at the new version
```

The running container **cannot become the new version**, so `/upgrade` ends the process
and says so. That is why step 3 has a step 4 at all, and why the message names the exact
command rather than leaving the user to work it out.

### What `/upgrade` does, in order

1. **Carries the record forward**, when the verdict is `migrate`
   (`utils/session-store.js#migrateStoredSession`). It runs before the pin moves: the folder
   must not claim a version while holding a shape that version's migration exists to fix.
   Opening a session already does this at the gate, so this is the belt for a caller that
   reached `/upgrade` without opening first.
2. **Renames the folder** to a current id (`utils/session-move.js#moveSession`). Sessions
   sort newest-first by id, so the fresh timestamp *is* "make this the latest" — which is
   what makes `--continue` find it. The whole folder moves, so the record, the conversation
   log, the chunkpaction captures and the tracking pair all come along; nothing is copied.
3. **Writes the pin** into the moved record, together with `upgradedFrom`/`upgradedAt`.
   The write carries the **new id**: `writeSession()` writes where the record says it
   lives, so spreading the moved record without it would leave a second copy at the old id.
4. **Asks the loop to end** (`close: true`), which the loop honours through the same
   `commit('exit')` path the `exit` sentinel uses — so the session is saved once, into its
   new folder, on the way out.

Order matters: migrate-then-rename-then-write means a crash leaves a session that is either
still in its old era or already in the new one, never a folder that claims a version whose
migration has not run.

### The three refusals

- **A session this build may not open is not upgraded.** Upgrading is a read *and* a write,
  so the build that may read the conversation is the only one that may do it. Under the era
  rule "may read" is wider than "wrote it": a pin in this build's era is upgradable, while a
  break nobody has migrated is refused with the way in.
- **A session this build cannot carry forward is not upgraded.** A record still in an older
  era has to be migrated before the pin moves, and a migration that fails refuses rather
  than renaming a folder onto bytes it could not fix.
- **A session already on this version is a no-op** (`ALREADY_CURRENT`): there is
  nothing to move, and a second rename would only scramble the ordering.

### `--continue`

`--continue` reopens the **newest session of the running version** — that is, the newest one
this build may open, including one the gate migrates on the way in. The runner only sets
`MONCHO_CONTINUE=1`; the agent decides, because it is the process that can read
`agent/sessions/` and judge the pins. A session another version wrote is **skipped**, not
refused: an older conversation is reached through `/sessions` once it has been upgraded, so
`--continue` never has to know about versions the user is not running.

## See also

- Where a session lives and how it is scanned: `docs/runtime/session-store`
- The record shape itself: `utils/session-format.js`
- The era table and the migrations that cross a break: `docs/runtime/session-compat`
- The versioned install that gives each version its own path: `docs/runtime/session-version`
  names the runner half (`bin/lib/common.sh#moncho_version`)
- The upgrade command and the restart it forces: `docs/interface/commands`
