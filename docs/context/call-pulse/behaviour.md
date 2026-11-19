# context/call-pulse — a model-call pulse on every agent request

## What it is

Every provider call the agent makes carries **one extra line** at the head of the
request, and that line counts the calls the current stretch of work has cost:

```
[pulse] model call 4 of 30 — 26 left. Reset to 0 by completing a task.md item (update_task) or by a compaction.
```

The line is generated fresh for each call by `utils/task-pulse.js#createTaskPulse`
and rides the request as the message **right after the agent system prompt**
(`api/ollama.js#callOllama` prepends `prompt.md`, then
`app/context-window.js#ContextWindow.request` lays out the pulse, the summary of
anything compacted, and the conversation). The count is ticked in
`app/conversation-manager.js#ConversationManager.beginModelCall`, i.e. immediately
before the call goes out — so the line names the very call it rides on.

The backlog entry this implements:
> keep in the context an incremental pulse on each model call, create a hard limit
> configurable defaulting to 30, and instruct via prompt.md to honor this value.
> reset it to 0 after marking an item as completed or running compaction

## The hard limit

`PULSE_LIMIT` (`config/constants.js`) is the hard limit, **30** by default and
configurable through the environment; `normalizePulseLimit()` falls back to 30 for
anything that is not a positive integer, so a broken variable can neither disable nor
invert the pulse. A limit is a limit on *actions* — the budget exists so a window is
not spent on probes, retries and small steps.

## Why it is a per-call line and not a window chunk

Three reasons, and they are the reason the design is what it is:

1. **N calls must cost one line of context.** A chunk per call would leave every
   call's count in the window forever, growing the context instead of measuring it.
2. **A chunk could break the tool-call pairing.** A message inserted between an
   assistant `tool_calls` message and the `tool` results answering it is invalid for
   most providers. The line is assembled per request, so it cannot land there.
3. **The recorded session stays the conversation itself**
   (`docs/runtime/session-store`): the pulse is state of the *host*, not a message
   the user or the model ever wrote, so it is not part of the chunks a session
   stores.

## Why the limit is instructive, not enforcing

`prompt.md` §9 tells the model what the line means and to honour the value. The host
never refuses a call for being past the limit: the model is only able to reset the
pulse *by calling a tool* (`update_task`), so refusing the call would deadlock the
turn. Instead:

- while calls remain, the line simply reports the count;
- at and past the limit the wording turns imperative ("stop starting new work …"),
  and the host raises **one** transient notice the first time a call goes beyond the
  cap (`formatPulseLimitNotice`, shown through `app/notice-overlay.js`), because the
  crossing is news and repeating it on every later call would drown the overlay.

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
the counter. "Model call 4 of 30" means four calls the agent spent, not four HTTP
requests happened to be made.

## Wording

`formatPulseText()` keeps the line plain, single-line and self-describing: the marker
`[pulse]`, the count against the limit, how many calls are left (or that the limit is
reached), and what clears the counter. `formatPulseLimitNotice()` is the one-shot
notice text. Both are pure and are unit tested without a provider or a terminal.

<!--
implementation: utils/task-pulse.js, app/conversation-manager.js,
app/context-window.js, app/compaction-runner.js, utils/host.js, tools/update_task.js,
config/constants.js, prompt.md
-->
