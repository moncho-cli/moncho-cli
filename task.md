status: done

# Model-call pulse: an incremental counter carried by every request, under a hard limit

The backlog item:

> keep in the context an incremental pulse on each model call, create a hard limit
> configurable defaulting to 30, and instruct via prompt.md to honor this value.
> reset it to 0 after marking an item as completed or running compaction

- [x] keep in the context an incremental pulse on each model call, create a hard limit configurable defaulting to 30, and instruct via prompt.md to honor this value. reset it to 0 after marking an item as completed or running compaction

## What the pulse is

One line, generated fresh for every **agent** model call and sent as the second
message of the request — right after the agent system prompt, before the
conversation:

```
[pulse] model call 4 of 30 — 26 left. Reset to 0 by completing a task.md item (update_task) or by a compaction.
```

Three decisions worth stating up front:

| Decision | Why |
| -------- | ----------------------------------------------------------------------- |
| It is generated per call, **not stored as a window chunk** | N calls then cost one line of context instead of N chunks, the recorded session stays the conversation, and the line can never land between an assistant `tool_calls` message and its `tool` results |
| The limit is **instructive, not enforced** | The backlog asks prompt.md to make the model honour it; the model can only reset the pulse by calling a tool, so refusing the call would turn a nudge into a deadlock |
| It resets on a **completed item** or a **compaction** only | Those are the two moments the backlog names, and they are exactly where a budget of calls should start again |

## Done when — verified

- [x] every agent model call carries the line, the count climbs by exactly one per
      call, and the whole turn adds one line of context, not one chunk per call.
- [x] `PULSE_LIMIT` is configurable, defaults to 30, and reaches the container
      (`start.sh`, `.env.example`, `README.md`).
- [x] crossing the limit is announced once (a transient notice) and the line tells
      the model the budget is spent.
- [x] the count resets to 0 after `update_task` marks an item done and after a
      compaction that actually ran; the summariser call itself does not tick.
- [x] `prompt.md` instructs the model to honour the value (§9).
- [x] `docs/context/call-pulse` states the contract and `docs/index.yaml`
      registers it, so `tests/docs-realm.test.js` passes.
- [x] `npm test` is green (334 tests, 0 failing) and every touched file stays under
      300 lines.

## Files

| Action | Path |
| ------ | ---- |
| added | `utils/task-pulse.js`, `app/compaction-runner.js`, `tests/call-pulse.test.js`, `tests/call-pulse-loop.test.js`, `docs/context/call-pulse/*` |
| edited | `config/constants.js`, `app/conversation-manager.js`, `app/context-window.js`, `utils/host.js`, `tools/update_task.js`, `prompt.md`, `README.md`, `.env.example`, `start.sh`, `docs/index.yaml`, `docs/README.md`, `docs/context/compaction/spec.yaml`, `tests/README.md` |

## Notes

- The two pulse suites are split along the same seam as the code: `call-pulse.test.js`
  proves the pure counter and its wording, `call-pulse-loop.test.js` proves the
  wiring against a stub provider (position in the request, never a chunk, the
  summariser not ticking, and both resets).
- `app/compaction-runner.js` was extracted from `app/conversation-manager.js` while
  wiring the compaction reset, to keep the manager under the 300-line budget; the
  behaviour is unchanged, and the module is covered by `docs/context/compaction`.
