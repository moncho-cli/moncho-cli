status: in progress: interface: Tab cycles Chat -> Design -> Work in the TUI and is refused while work:on, with a notice explaining the lock

# Stateful mode isolation: Chat / Design / Work, under a session-scoped execution lock

The backlog item (`agent/tmp/mode-isolation.md`):

> Most CLI agents blur the line between talking about code and mutating code — a
> casual question like *"how would we refactor this?"* can accidentally trigger file
> edits. To prevent this while still supporting autonomous background execution, the
> system separates **Intent Modes** (`Chat` and `Design`) from **Execution State**
> (`Work:on` / `Work:off`).

## The model to build

| Concept | Meaning |
| ------- | ------- |
| **Intent mode** | `Chat` (strictly read-only), `Design` (authors `task.md`), `Work` (executes it) |
| **Execution state** | `work:on` / `work:off` — a *lock*, not a mode: while `work:on` the intent mode cannot change |
| **Session scope** | every session carries its own mode; a session in `Chat` creates no files at all |

The contract, restated so each item below can be judged against it:

- `Tab` moves `Chat -> Design -> Work`; the move is **blocked while `work:on`**.
- `/work on` needs a `task.md` with at least one pending item; it locks the session to
  `Work` and keeps a background agent alive. `/work off` stops it and falls back to
  `Design`.
- The current state is a **coloured label at the leftmost cell of the model row**, one
  bright colour per state.
- While `work:on` the session stays reachable: chat messages steer it, and hot-editing
  `task.md` is an explicit senior escape hatch, never a guarantee.
- The main agent answers questions about progress by reading `task.md` /
  `implementation_plan.md`; a deterministic timer watches those files and injects
  progress updates into the main conversation.
- `Alt+1` is the main agent, `Alt+2` the work subagent (more subagents later).

## Items — refactors first, then the feature, then the proof

- [x] refactor: extract the host turn loop out of main.js into app/session-loop.js, so main.js stays a wiring module under the size budget
- [x] refactor: split app/conversation-manager.js by moving one-turn execution (request, tool batch, final response) into app/turn-runner.js
- [x] refactor: trim app/tui.js by extracting teardown and the resize repaint into app/tui-teardown.js, leaving room for the mode wiring
- [x] refactor: give app/tool-batch.js a pre-dispatch call gate, extracted into app/tool-guard.js so the batch stays under the size budget
- [x] app/session-mode.js: the pure Chat/Design/Work state machine — cycle order, the work lock rules, the label text and the per-state colours
- [x] interface: paint the current mode as a coloured label at the leftmost of the model row, refreshed on every mode change
- [ ] interface: Tab cycles Chat -> Design -> Work in the TUI and is refused while work:on, with a notice explaining the lock
- [ ] interface: /work on and /work off gate on a task.md with a pending item, auto-switch Work/Design and spawn or stop the background agent
- [ ] agent: mode-gated tool exposure — Chat advertises and runs read-only tools, Design can only write task.md and implementation_plan.md, Work is unrestricted
- [ ] agent: a refused mutating call in Chat or Design comes back as a structured refusal naming the mode, instead of touching a file
- [ ] agent: app/work-agent.js, the background agent that walks task.md one item at a time and keeps implementation_plan.md moving
- [ ] agent: app/work-watch.js, the timer that reads the two tracking files deterministically and injects progress updates into the main conversation
- [ ] sessions: persist the mode with the session file and restore it on /sessions, so a resumed conversation keeps its state
- [ ] interface: Alt+1 / Alt+2 switch the session view between the main agent and the work subagent transcript
- [ ] docs: docs/interface/modes and docs/runtime/work-agent specs, index.yaml, tests/README rows and the prompt.md section, so the realms stay linked
- [ ] verify: npm test green, every touched file under 300 lines, and the whole flow rehearsed once end to end

## Done when — acceptance criteria

- [ ] `Chat` provably cannot write: with the mode on Chat, no mutating tool is offered
      to the provider and a mutating call the model still makes is refused by code.
- [ ] `Design`'s only writes are `task.md` and `implementation_plan.md`.
- [ ] `Tab` walks the three intent modes, the label changes colour with it, and
      neither Tab nor `/work off` can leave the Work lock without `work:off`.
- [ ] `/work on` refuses a session with no `task.md` or with every item already done.
- [ ] The background agent works one item at a time; the main agent reports status
      from the tracking files; the watcher injects deterministic progress lines.
- [ ] Every touched file stays under 300 lines and `npm test` is green.

## Notes

- The five refactor items come first on purpose: `main.js` (249 lines),
  `app/conversation-manager.js` (287), `app/tui.js` (289) and `app/tool-batch.js` (254)
  all sit close to the 300-line budget, and the mode wiring is what would push them
  over. Each refactor is behaviour-preserving and is verified by the existing suite.
- The mode state machine is pure and lives outside the TUI, so both front ends share
  it; the line CLI (no `Tab`, no coloured label) still honours the gating rules.
- `work:on` is a lock, never a sandbox: live steaming and hot-edits stay available by
  design, and the clean workflow remains `work:off` -> Design -> `work:on`.
