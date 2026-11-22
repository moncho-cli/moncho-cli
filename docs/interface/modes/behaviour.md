# Interface — the session's intent mode: Chat, Design, Work

Most CLI agents blur the line between *talking about* code and *mutating* code: a
casual "how would we refactor this?" can trigger file edits, while an approved item
on `task.md` needs to run on its own. The system keeps the two apart with
**two separate notions**:

| Notion | Values | Meaning |
| ------ | ------ | ------- |
| **Intent mode** | `chat`, `design`, `work` | what the session is *for* right now |
| **Execution state** | `work:off`, `work:on` | a **lock**, not a mode |

Implementation: `app/session-mode.js`. The machine is **pure and terminal-free**:
it answers the label, the colour and the state key, and whatever front end is
driving the session — a key binding in the TUI, a command in the registry
(`docs/interface/commands`), the line CLI — calls the same `cycle()`/`setMode()`.
The rules below therefore hold with or without a screen, and the module paints
nothing it cannot describe.

## The modes

- A **fresh session opens in `work`** (`DEFAULT_MODE`). The operator works *out of*
  `work`: the session starts able to execute the backlog, and the cycle is how a
  casual question is moved somewhere it cannot touch a file.
- `chat` offers **no tool that writes**: no writer is advertised to the provider and
  every writer call is refused by the gate. The one file a `chat` session still
  produces is its own session record, written by the host and not by a tool
  (`docs/runtime/session-store`): the transcript is saved after every turn in every
  mode, which is what `/sessions` and `/usage` resume from. "Read-only" here means
  *no tool touches the project tree*, never "nothing lands on disk".
- `design` may write **only** the two tracking files, `task.md` and
  `implementation_plan.md`: it is the mode that turns a discussion into a backlog,
  never the mode that turns the backlog into code. It writes them through its **own**
  two tools, `write_plan_md` / `edit_plan_md`, which take **no path at all** — see
  *Design writes through tools that name no path* below.
- Those two files live **only in the session folder** (`agent/sessions/<id>/`, see
  `docs/agent/task-tracking`), so `design` may write them there and nowhere else. That is
  a property of the tools rather than a check the policy performs: the location comes
  from `utils/tracking-store.js#trackingPaths()`, and `write_plan_md` has no argument
  through which another file could be named. The project root is not a place either file
  may appear, which `utils/tracking-fence.js#trackingLocationRefusal` still enforces for
  the generic `write_file` a `work` session may call.
- `work` executes the backlog: talk the work through and the agent acts on it. The
  `work:on` **lock** is an optional extra, not how a session normally works — see
  *The work lock* below.

The mode is a *policy*, and the policy has two halves — both are needed, and neither
substitutes for the other:

1. the **tool list advertised to the provider** is narrowed to what the mode allows,
   so the model is not invited to call a tool it may not use; and
2. every call still passes the **pre-dispatch gate**, so a call named from an older
   prompt is refused with a structured answer instead of touching anything.

Both halves are **one table** in `app/mode-policy.js`: `toolsForMode()` filters the
list and `gateForMode()` answers the gate, off the same families, so a rule can never
be enforced by one half and forgotten by the other. `app/tool-guard.js` turns the
gate's answer into a structured refusal (`guardToolCall()`, `TOOL_GUARD_REFUSAL`,
`formatGuardRefusal()`) and `docs/agent/tool-multicall` documents it. Neither half
needs a new seam: half 1 is the live `getTools()` the turn runner already calls once
per request (`app/turn-runner.js`) and half 2 is the `toolGate` option the manager
already forwards to the batch (`app/conversation-manager.js`).
Both halves are installed in `main.js`, and neither is a snapshot: the list and the
gate read the live session mode, so a `Tab` mid-turn tightens the very next call.

- A **shell is not a scoped writer**: `run_bash` / `run_npm` can write a file, rewrite
  one or install a package, so they can never be restricted to two paths. They are
  therefore refused in `chat` **and** `design`, and advertised in neither — treating
  them as read-only would make every other rule here decorative.
- The read-only set is `read_file`, `hint_file`, `blob`, `grep`, `read_capture`,
  `web_fetch` and `compact_context`. "Read-only"
  is a claim about the **project tree**, not about the session: `compact_context`
  replaces the live context window and may call the provider, so it changes the
  conversation without writing a file. It is offered in every mode because it can
  never name a path. `web_fetch` is the same kind of exception in the other
  direction — it is the one reader that leaves the machine, and it is still a
  reader: a GET, with no body and no upload (`docs/agent/web-fetch`), so it can
  change nothing on disk and belongs in the read-only set in every mode.
- **A delete is a writer, and the most final one**: `DESTRUCTIVE_TOOLS`
  (`delete_file`) is part of `WRITER_TOOLS`, so it is refused in `chat` and in
  `design` and advertised in neither. It is *not* a scoped writer: the path is only
  known once the call arrives, and unlike a write it cannot be corrected by writing
  again — so it never gets the two-file exception, and `design` refuses it exactly
  like the shell family.
- `design` writes its two files through `write_plan_md` / `edit_plan_md`, which take no
  `path` at all: the call names only *which* of the pair it means (`"task"` or `"plan"`),
  and `utils/tracking-store.js#trackingPaths()` answers where that is. A per-session
  target is therefore not something the policy has to accept or refuse — a tool that
  cannot name a file cannot name the wrong one, which is the whole reason the mode got
  its own writers. The generic `write_file` / `edit_file` are `work`-only: they touch
  any file, so a mode that owns two documents has no use for them, and offering them
  would re-open the path question the dedicated pair exists to close.

### Design writes through tools that name no path

The two tools a `design` session authors its documents with are
`DESIGN_WRITER_TOOLS` — `write_plan_md` and `edit_plan_md`, implemented over one shared
half in `utils/tracking-draft.js`. They are the *same two operations* the generic pair
performs, minus the argument that made them dangerous:

| operation | generic (work) | design |
| --------- | -------------- | ------ |
| author a document from a draft | `write_file` | `write_plan_md` |
| change one by literal search/replace | `edit_file` | `edit_plan_md` |

The decision is worth stating because it replaced a weaker one. `design` used to be
offered the generic writers, and the policy policed their `path` against
`agent/sessions/<id>/task.md` and `…/implementation_plan.md`. That is a rule the model is
asked to respect and the gate has to enforce, and it can only ever be as good as the path
normalisation behind it. A writer that takes **no** `path` has nothing to police: the
location is read from `utils/tracking-store.js#trackingPaths()`, the one place that
decides where a session's pair lives, so the scope is a property of the tool rather than a
check it performs.

The other half of the same decision is the list. The backlog asked for the tools the mode
may not call to be **removed from the array sent to the provider**, not merely refused when
named — a tool the mode cannot use still costs tokens in every request. `toolsForMode()`
is where that happens: `work` gets the whole list, `chat` the read-only set, and `design`
the read-only set plus `update_task` and its two writers. The generic writers, the shells
and `delete_file` are absent from a `design` list and absent from a `chat` one, so a mode
is never *invited* to call what it may not use; the gate is what still answers a model that
names one from an older prompt.

### The prompt never explains the mode

`config/prompt.md` is the system prompt of **every** call, in every mode, so it must say
nothing about which mode the session is in. The mode is *implicit in the tool list*: the
model discovers what it may do by what it is offered, and a sentence about "in a design
session…" is an instruction about a state the model cannot observe and was never asked to
reason about. It would also be wrong half the time — the same text is sent under all three
modes — so the model would be told to hold a distinction it has no way to check and would
have to ignore.

The rule follows from what the prompt is: a document that travels with **every** request.
Anything conditional on the mode belongs in the refusal the model actually receives
(`TOOL_REFUSED_BY_MODE`, `docs/agent/tool-refusal`) or in the tool description of the tool
that *is* offered — never in prose the model reads when the condition does not hold. This
is the same reason the prompt names no session path (`docs/agent/session-context`): a fact
the model cannot act on at the moment it reads it is text that costs tokens and teaches
nothing.

Two consequences worth naming, because both were bugs:

- the tracking writers are described by **what they do** (`write_plan_md` / `edit_plan_md`
  author the session's pair and take no path), never by *when* they are offered; and
- the refusal rule says what the model can act on — a refused call is policy, so say what
  you would need instead — without naming the mode or the gate that produced it.

Anything that is not one of the three names is `chat`. `normalizeMode()` is the single
place that says so, so a corrupt session file, an environment variable or a typo falls
back to the safe, read-only mode instead of granting write access.

**The default and the fallback are two different rules, deliberately.** A session with
no stored state *opens* in `work`; a session whose stored mode cannot be read lands in
`chat`. Collapsing the two would either make a typo grant write access or make every
session start read-only, and both are wrong.

## The cycle

- `nextMode()` walks **`chat -> design -> work -> chat`**, skipping nothing and in
  that order only. The mode is never derived from a prompt: the user picks it.
- `prevMode()` is the exact inverse, so `Shift+Tab` walks the **same ring backwards**
  (`chat -> work -> design`) without a second order to keep in step.
- `Tab` is bound in the TUI **pre-dispatch** (`app/tui-keys.js`): the key arrives on
  the program, before blessed can hand it to the focused input box, and key dispatch
  is locked for that one event. A plain screen-level binding would both fire *and*
  type a tab into the prompt, and the box would stop reading.
- The binding only reports a **direction**; `app/mode-controller.js` calls
  `cycle({ direction })` on the session's mode. A refused cycle is **news, not
  history**: `WORK_LOCK_NOTICE` goes to the transient notice bar in the TUI and to one
  plain line in the line CLI (`docs/interface/notice-overlay`) — never the transcript.
- Every accepted change is announced to the callers subscribed with
  `subscribe()`, so a view repaints the label exactly when the state moves — and
  never on a refused or idempotent move. A listener that throws is swallowed: a
  broken repaint must not cost the user their mode change.
- `setMode()` to the mode already current is a no-op (`changed: false`,
  `reason: 'same-mode'`): it does not notify and does not pretend something moved.

## The work lock

- `setWork(true)` pins the mode to `work` **and** engages the lock. `setWork(false)`
  releases it and falls back to **`design`**, never to `chat`: the `task.md` the user
  was writing stays writable, so the clean workflow is
  `work:off` -> Design -> `work:on`.
- While the lock is on, **both** `cycle()` and `setMode()` are refused with
  `{ changed: false, reason: 'work-on', notice: WORK_LOCK_NOTICE }`. `work:on` is a
  lock, never a sandbox: the session stays reachable, chat messages steer it, and
  hot-editing the tracking files remains an explicit senior escape hatch — but the
  *mode* cannot move behind the user's back.
- Turning the lock on when it is already on (or off when it is already off) is a
  no-op, so a doubling of the order is harmless.
- The lock is an **optional** switch, not the normal way to work: `work` mode already
  executes what the user talks through. With `work:on` the session additionally starts
  its **self-drive**: it takes its next prompt from its own `task.md` instead of the keyboard,
  so it walks the checklist one item at a time in the *same* conversation — one
  window, one transcript, one session file. Nothing runs in a second process and
  nothing is written to a second context: the work product is the tracking files on
  disk, which is the channel the main conversation already reads.
  `app/work-drive.js` is that driver, and it is a different `ask`, never a different
  application: `runSessionLoop()` still calls `nextPrompt()` once between two turns,
  so the sources of a prompt have exactly one priority order —
  - a **queued message wins** (it is drained before anyone is asked), which is what
    makes live steering work while the session runs on its own;
  - then the **next pending item** of `task.md`, phrased by `formatWorkPrompt()` and
    announced with one progress line naming how many items are left;
  - then the **keyboard**, once the drive is silent.
  The drive is bounded on purpose: after `WORK_DRIVE_MAX_ATTEMPTS` identical hand-outs
  of the same unchanged item it stands down with a line saying so, leaving the lock
  on and the keyboard in charge — a stuck item must not burn the budget in silence.
  A finished checklist stops the drive but **does not release the lock**: that is
  `/work off`'s job and nobody else's.
- The refusal that stops a mode change and the refusal that stops a tool call are the
  same idea at two levels: the mode answers *what this session is for*, and the gate
  answers *what this particular call may do*. A refused call comes back to the model
  as a structured `TOOL_REFUSED_BY_MODE` result naming the mode, and the **reader sees
  it too**: `handleToolBatch()` prints one `✖ Refused …` row where the call was
  announced, in the palette's own bright-red bold refusal kind (`docs/agent/tool-refusal`).

## The label and the colour

`describe()` returns the one state a view needs, and each state has exactly one
**bright** colour, so the mode is readable at a glance:

| key | label | colour |
| --- | ----- | ------ |
| `chat` | `Chat` | `green` |
| `design` | `Design` | `bright-cyan` |
| `work` | `Work` | `yellow` |
| `work:on` | `Work:on` | `bright-red` |

- `modeStateKey(mode, work)` is what makes the lock visible: the mode `work` with
  the lock on is the state `work:on`, which is why the locked session cannot be
  confused with a plain `Work` the cycle may leave.
- The interface paints that key as a coloured label at the **leftmost cell of the
  model row**, refreshed on every accepted change.

`app/session-mode-label.js` does that painting: `formatModeRow()` composes the tag
(the state's label in the state's bright colour) and the model identity after it,
and `createModeRow()` subscribes to the mode so a repaint happens on the accepted
changes alone — a refused change leaves the row showing the state the user is in.

## Persistence

`toJSON()` returns the plain, storable `{ mode, work }`; `createSessionMode()`
accepts the same two fields back, so a resumed session (`docs/runtime/session-store`)
keeps both its mode and its lock. A `work:on` state is restored as `mode: 'work'`
with the lock on, never as a plain `Work`.

The two fields sail with the conversation: the recorder reads them from the live mode
on **every** save, so the file always describes the state the user left the session in,
and `main.js` wires that reader once (`createSessionRecorder({ stateOf })` — never a
snapshot taken at startup).

- `restore(state)` is how `/sessions` brings the state back. It is deliberately
  **not** a mode change: `setMode()` is refused while the lock is on, so a resumed
  `work:on` session would otherwise open in the wrong state. Junk in the file lands in
  `chat` through `normalizeMode()` — the read-only fallback, never silently in `work` —
  and a file that stores no mode at all restores nothing, leaving the session in the
  state it opened with.

## Status

The **machine**, the **label**, the **gate**, the **`Tab` binding with its refusal
route** and the **per-mode policy** (`app/mode-policy.js`, both halves wired in
`main.js`) and the **`/work on|off` commands** (`app/work-command.js`) are built and
proven, and so is the **`work:on` self-drive** (`app/work-drive.js`, wired into
`app/session-loop.js`). That persistence has landed too: the recorder writes both fields
on every save and `app/session-mode.js#restore` brings them back on `/sessions`. A
behaviour above is only claimed here once it ships: this
spec describes what the code does, so a doc that outran the wiring would be the bug,
not the plan.

## See also

- Implementation: `app/session-mode.js`
- The label on screen: `app/session-mode-label.js`
- The key that walks the ring and the route a refusal takes: `app/tui-keys.js`,
  `app/mode-controller.js`, `docs/interface/notice-overlay`
- The policy table itself: `app/mode-policy.js`
- The two writers `design` authors its documents with: `tools/write_plan_md.js`,
  `tools/edit_plan_md.js`, over the shared half in `utils/tracking-draft.js`
- The gate every call passes: `app/tool-guard.js`, `docs/agent/tool-multicall`
- Commands that move the mode: `docs/interface/commands`
- The session file: `docs/runtime/session-store`
- Proof: `tests/session-mode.test.js`, `tests/session-mode-label.test.js`,
  `tests/mode-controller.test.js`, `tests/mode-policy.test.js`,
  `tests/design-writers.test.js` and
  `tests/work-command.test.js`, `tests/work-drive.test.js`
