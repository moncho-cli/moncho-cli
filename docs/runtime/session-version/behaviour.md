# Which version is running, and which sessions it may open

A conversation is written by one build of the agent. Two builds are not interchangeable in
practice: a newer runtime may read a record shape an older one cannot, and a tool contract
may have moved. So a session records **the version that last wrote it**, and a runtime
refuses to open a session that belongs to another version.

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

## The three answers

`canOpenSession(session, version)` is a decision, not a comparison:

| The record | Answer | Why |
| --- | --- | --- |
| no `monchoVersion` | **open** | Nobody has claimed it; the next save stamps it |
| pins the running version | **open** | This is the build that owns it |
| pins anything else | **refuse** | Another build wrote these bytes |

The first row is what keeps existing history usable. `null` and a mismatch are deliberately
different answers: an unpinned record is not "some unknown other version", and treating it
as one would strand every session already on disk at every upgrade.

## Strict equality, never ordering

The rule is `pinned === version`, not a semver comparison. "Newer is fine" would let a newer
runtime open an older session and write it back in a shape the older build cannot read — a
one-way door that silently closes behind the user. A refusal they can act on is better than
a file that only works in one direction.

## The refusal names the way in

`sessionVersionRefusal()` produces the message, and the last line is the point of it:

```
Session 2026-11-22T… was last written by Moncho 0.28.2; this is 0.28.3.
Open it with the version that owns it, then /upgrade to move it forward:
  moncho-cli --version 0.28.2
```

A refusal that only says "wrong version" leaves the user to find the version and invent the
invocation. Naming both turns a dead end into one line to paste.

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

1. **Renames the folder** to a current id (`utils/session-move.js#moveSession`). Sessions
   sort newest-first by id, so the fresh timestamp *is* "make this the latest" — which is
   what makes `--continue` find it. The whole folder moves, so the record, the conversation
   log, the chunkpaction captures and the tracking pair all come along; nothing is copied.
2. **Writes the pin** into the moved record, together with `upgradedFrom`/`upgradedAt`.
   The write carries the **new id**: `writeSession()` writes where the record says it
   lives, so spreading the moved record without it would leave a second copy at the old id.
3. **Asks the loop to end** (`close: true`), which the loop honours through the same
   `commit('exit')` path the `exit` sentinel uses — so the session is saved once, into its
   new folder, on the way out.

Order matters: rename-then-write means a crash between the two leaves a session at its new
id with its old pin (still openable by the version that owns it), never the reverse.

### The two refusals

- **A session this build may not open is not upgraded.** Upgrading is a read *and* a write,
  so the build that owns the conversation is the only one that may do it. `/upgrade` is
  therefore a command you run *inside* the owning version, which is exactly the flow above.
- **A session already on the newest version is a no-op** (`ALREADY_CURRENT`): there is
  nothing to move, and a second rename would only scramble the ordering.

### `--continue`

`--continue` reopens the **newest session of the running version**. The runner only sets
`MONCHO_CONTINUE=1`; the agent decides, because it is the process that can read
`agent/sessions/` and judge the pins. A session another version wrote is **skipped**, not
refused: an older conversation is reached through `/sessions` once it has been upgraded, so
`--continue` never has to know about versions the user is not running.

## See also

- Where a session lives and how it is scanned: `docs/runtime/session-store`
- The record shape itself: `utils/session-format.js`
- The versioned install that gives each version its own path: `docs/runtime/session-version`
  names the runner half (`bin/lib/common.sh#moncho_version`)
- The upgrade command and the restart it forces: `docs/interface/commands`