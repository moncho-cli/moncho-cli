status: done

# Implementation plan

All items of `task.md` are done and verified: the model-call pulse is implemented,
linked in the docs realm, and `npm test` is green (334 tests, 0 failing).

## Verified steps

- [x] Write the pure counter `utils/task-pulse.js` (the line, the limit validation,
      the one-shot crossing report, the reset reasons) and prove it in
      `tests/call-pulse.test.js`.
- [x] Make `PULSE_LIMIT` a configurable constant defaulting to 30
      (`config/constants.js`) and thread it through `start.sh`, `.env.example` and
      `README.md`.
- [x] Carry the line on every agent request: tick in
      `ConversationManager.beginModelCall`, pass the prelude through
      `ContextWindow.request`, and raise the single `pulse-limit` notice on the
      first crossing.
- [x] Extract `app/compaction-runner.js` from the manager and reset the pulse with
      the reason `compaction` whenever a compaction really rewrote the window.
- [x] Reset the pulse from `tools/update_task.js` on `action: "complete"` through
      `utils/host.js#resetTaskPulse`, and report `pulseReset` in the tool result.
- [x] Instruct the model via `prompt.md` §9 and prove the loop-level behaviour in
      `tests/call-pulse-loop.test.js`.
- [x] Write `docs/context/call-pulse/{behaviour.md,spec.yaml}`, register it in
      `docs/index.yaml`, cover `app/compaction-runner.js`, and list both suites in
      `tests/README.md`.
- [x] Run the full suite and the line budget: `npm test` → 334 pass, 0 fail; every
      touched file under 300 lines.
