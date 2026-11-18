status: done

# Token usage is recorded per model and kept with the session

Token use is, today, only a *view*: the status bar shows how full the context
window is, and the number dies with the process. Nothing on disk says **which
model** consumed how many tokens, so the question the user actually asks —
"is model A cheaper/faster per turn than model B?" — cannot be answered after a
single run, and never across runs.

This task makes usage an accounting record instead of a label: every provider
call is counted against the model that answered it, the table is saved in the
session file, and `/usage` reports it.

## Where the numbers come from

| Source | What it gives us |
| ------ | ---------------- |
| the provider response | exact `prompt`/`completion` counters (OpenAI `usage.*`, Ollama `prompt_eval_count`/`eval_count`) |
| the window estimate (`utils/tokens.js`) | a fallback for a provider that reports no usage, flagged as estimated |
| the recording step | one entry per model: requests, prompt tokens, completion tokens, total tokens, how many of those were estimates |

## Constraints

- One normalisation point: `normalizeUsage()` in the provider layer is the only
  place that knows the provider's spelling; everything downstream sees
  `{ promptTokens, completionTokens, totalTokens }`.
- One accounting module (`utils/usage-stats.js`): the meter, the per-call event
  and the table normaliser are pure functions, so the maths is unit testable
  without a provider and the session store can validate the table it reads back.
- Estimates never masquerade as exact: a call the provider did not report is
  counted **and** flagged, so a comparison never silently mixes the two.
- The session file stays readable by the existing readers: `usage` is optional,
  an older file without it loads with an empty table.
- `/usage` is a command, not a repaint: the status bar keeps showing the window,
  and the per-model table is printed on demand.
- Every file stays under the 300-line budget; extract rather than grow.

- [x] **count and persist token usage per model** — `normalizeUsage()` surfaces the provider's counters (null when it reports none), `utils/usage-stats.js` holds the per-call event with its estimation fallback plus the per-model table, `ConversationManager` records every call it makes (the summariser included), the session file stores the table and reads it back, resuming seeds the meter, and `/usage` prints the breakdown.
- [x] **document and prove the per-model usage accounting** — a `docs/context/model-usage` spec (registered in `docs/index.yaml`) states the recording rule, the estimate flag and the persistence, the session-store and commands specs are updated, and `tests/model-usage.test.js` proves normalisation from both provider shapes, the table maths, the estimate fallback, the round-trip through a session file and the `/usage` output.

## Done when

- the spec exists, is registered, and names real `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines;
- a scratch probe under `agent/utils/` confirmed the numbers before the tests were written, and is deleted afterwards.