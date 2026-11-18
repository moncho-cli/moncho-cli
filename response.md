All four `task.md` items are complete. Summary of the work:

## 1. Removed the `response.md` concept ✅
- Deleted `response.md` and the `RESPONSE_FILE` constant.
- `app/conversation-manager.js` no longer writes the file (the reply is still stored in the context window and printed); `app/cli.js` / `app/tui.js` dropped their dead `saveResponse()`/`fs` surface.
- Dropped the stale assertion from the manager test. **105 → 110 tests, 0 fail.**

## 2. File-size hard rule in the system prompt ✅
- Added `prompt.md` §3.1: every file stays **under 300 lines**, **500 is a hard limit**, with the split/flag-later guidance.
- Measured offenders (`tests/harness-tools.test.js` 488, `app/tui.js` 463, `tests/tui.test.js` 415) — all under 500, noted as future split candidates rather than silently growing them.

## 3. The three realms (code / docs / tests) ✅
- Created `docs/<domain>/<capability>/{behaviour.md,spec.yaml}` — 13 specs across `agent/`, `context/`, `interface/`, `runtime/`, plus `docs/index.yaml` and `docs/README.md`.
- Specs state behaviour and **reference** code as `path#symbol` (no duplication).
- Renamed `test/` → `tests/` (the proof realm) with a `tests/README.md`, and updated `package.json`.
- Added `tests/docs-realm.test.js`, which **enforces** the links: spec presence/registry, id↔path↔domain, code symbols really exist, named test cases really exist, and every source module is covered. Documented in `prompt.md` §6.1.

## 4. Ad-hoc scripts in gitignored `agent/utils/` ✅
- `.gitignore`/`.dockerignore` now exclude `agent/`; added `agent/README.md` with the keep-only-if-reusable rule (also `prompt.md` §3.2).
- Kept 3 factually reusable scripts (interrupt cancel-then-exit probe, live context-size probe, streaming smoke test) with fixed relative imports; deleted the 9 one-off probes plus dead root junk (`test.js`, `patch.file`, `temp.txt`, `test1`). Verified the kept probe still runs green.

The repo root is now clean, `node --check` is clean on touched files, and `npm test` reports **110 pass / 0 fail** (including the new linking suite).