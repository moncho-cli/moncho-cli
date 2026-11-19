# context/call-pulse — a model-call pulse on every agent request

## What it is

The host **counts** the agent model calls the current stretch of work has cost,
against a configurable hard limit. The counter lives in
`utils/task-pulse.js#createTaskPulse` and is ticked in
`app/conversation-manager.js#ConversationManager.beginModelCall`, i.e. immediately
before a call goes out.

The backlog entry this implements:
> keep in the context an incremental pulse on each model call, create a hard limit
> configurable defaulting to 30, and instruct via prompt.md to honor this value.
> reset it to 0 after marking an item as completed or running compaction

## The line is paused

The original design put **one extra line** at the head of every request, right after
the agent system prompt (`api/ollama.js#callOllama` prepends `prompt.md`, then
`app/context-window.js#ContextWindow.request` lays out the prelude and the
conversation):

```
[pulse] model call 4 of 30 — 26 left. Reset to 0 by completing a task.md item (update_task).
```

That line is **disabled right now**, and the reason is worth recording because it is
a property of the change, not a taste:

- a message generated *per call* changes the request bytes on every call, which
  **defeats provider prompt caching** — the cache cannot be hit on a prefix that is
  rewritten each time, and the cost of that is far larger than the pulse is worth;
- `formatPulseText()` therefore answers the empty string, and
  `createTaskPulse().message()` answers **`null`** rather than an empty `system`
  message. An empty message is not the same as no message: it is still a role marker
  the provider bills and the cache hashes;
- `ContextWindow.request()` keeps its `filter(Boolean)`, so a `null` prelude
  contributes nothing and the request is the agent prompt followed by the
  conversation.

The pause is what buys the cache back, and it is worth stating as an invariant
rather than as "the line is off": **with no prelude, call N+1 of a stretch repeats
call N byte-for-byte and only appends.** The agent prompt is read once and cached in
`api/ollama.js`, the chunks only grow, and a summary chunk carries `content` and
metadata — no clock, no counter — so nothing a provider hashes changes under it. A
prefix that only ever grows is the prefix a prompt cache can hit; the position was
the problem, not the token count, which is why a less volatile line at the head
(a bar that changes every fifth call) would still invalidate the conversation
behind it.

Everything else about the pulse is unchanged and still tested: the counter runs, the
hard limit is reported, the crossing is announced once, and both resets work. Turning
the line back on is a deliberate change to `formatPulseText()` plus the two cases in
`tests/call-pulse.test.js` that pin the pause.

## The hard limit

`PULSE_LIMIT` (`config/constants.js`) is the hard limit, **30** by default and
configurable through the environment; `normalizePulseLimit()` falls back to 30 for
anything that is not a positive integer, so a broken variable can neither disable nor
invert the pulse. A limit is a limit on *actions* — the budget exists so a window is
not spent on probes, retries and small steps.

## Why the counter is host state, not a window chunk

Three reasons, and they are the reason the design is what it is:

1. **N calls must cost one line of context at most.** A chunk per call would leave
   every call's count in the window forever, growing the context instead of measuring
   it.
2. **A chunk could break the tool-call pairing.** A message inserted between an
   assistant `tool_calls` message and the `tool` results answering it is invalid for
   most providers. The prelude is assembled per request, so it cannot land there.
3. **The recorded session stays the conversation itself**
   (`docs/runtime/session-store`): the pulse is state of the *host*, not a message
   the user or the model ever wrote, so it is not part of the chunks a session
   stores.

## Why the limit is instructive, not enforcing

The host never refuses a call for being past the limit: the model is only able to
reset the pulse *by calling a tool* (`update_task`), so refusing the call would
deadlock the turn. Instead the host raises **one** transient notice the first time a
call goes beyond the cap (`formatPulseLimitNotice`, shown through
`app/notice-overlay.js`), because the crossing is news and repeating it on every
later call would drown the overlay.

## The two resets

The counter follows the **work**, not the process. It goes back to 0 in exactly two
situations:

| Reset reason | Where |
| ------------ | ----- |
| `item-completed` | `tools/update_task.js` with `action: "complete"` — an item was marked done and verified, so the next stretch of work starts with a fresh budget. The reset reaches the live counter through the host registry (`utils/host.js#resetTaskPulse`), and the tool result reports `pulseReset: true`. |
| `compaction` | A compaction rewrote the window (`app/conversation-manager.js#ConversationManager.maybeCompact`), which is the second moment the backlog names. |

Other actions are deliberately **not** resets: `action: "status"` is a metadata edit
and `action: "step"` ticks a step of the item still in flight — the item is not
finished, so the budget that is paying for it has not been refilled.

## The count is of agent calls only

The summariser call behind a compaction is an *internal* call: it opts out of the
agent system prompt (`systemPrompt: false`) and it does not carry the pulse, nor tick
the counter. A count of four means four calls the agent spent, not four HTTP requests
that happened to be made.

## Wording

`formatPulseText()` is the one function that decides what the line says — the marker
`[pulse]`, the count against the limit, how many calls are left (or that the limit is
reached), and what clears the counter — and today it says nothing. The disabled
wording is kept in the module as the behaviour to restore, and `PULSE_MARKER` stays
exported so the re-enable is a one-function change. `formatPulseLimitNotice()` is
unchanged and still announces the crossing.

`prompt.md` follows the pause: its pulse section no longer asks the agent to watch a
number it cannot see. It asks for the property the limit was there to protect — do not
loop over insignificant research, lock in `task.md` and `implementation_plan.md` early,
never re-read what is already held — and to treat the one crossing notice as the signal
to stop exploring and finish the item in flight.

Its advice names `update_task` as the reset, not `compact_context`: compaction is a host decision the agent does not operate (`docs/context/compaction`), so the prompt no longer mentions it. The counter itself still resets on a compaction.

<!--
implementation: utils/task-pulse.js, app/conversation-manager.js,
app/context-window.js, app/compaction-runner.js, utils/host.js, tools/update_task.js,
config/constants.js, prompt.md
-->
