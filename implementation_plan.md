# Interface polish — all three items done and verified

status: done — `npm test` 280 tests, 280 pass, 0 fail

## Items

- [x] **bright blue, bold intent text** — `app/theme.js` gained an `intent` kind
  (`bright-blue` + `bold`); the standalone `intent: …` row and the `(intent: …)` span of
  a tool header are painted with it. Proven by
  `tests/conversation-colors.test.js` ("the intent gets its own bright-blue, bold style",
  "the intent is bright blue and bold inside the row that carries it").
- [x] **the last-prompt hint in an empty box** — `app/input-hint.js` remembers the prompt
  the box settled and paints `Last prompt: …` (grey, sanitised, **content only, never the
  value**) over an empty box, reacting to the box's own `set content` event. Proven by
  `tests/input-hint.test.js` (5 cases).
- [x] **transient notices in a self-hiding overlay** — `app/notice-overlay.js` (pure
  model: kinds, TTL, dedupe, cap, injectable clock), `app/notice-bar.js` (the blessed
  overlay at `top: 1`, hidden while empty, one timer armed for the earliest expiry),
  surfaced by `app/tui-surface.js`; `api/ollama.js` reports a retried attempt through an
  injected `onRetry` hook; `app/conversation-manager.js` routes a recovered failure to
  `onNotice` instead of the transcript and keeps a transcript line only for the failure
  that ends the task; `main.js` binds the hook and dismisses the retry notice the moment
  the turn lands. Proven by `tests/notice-overlay.test.js` (9 cases),
  `tests/conversation-manager.test.js` ("a recovered provider failure becomes a notice,
  never a transcript line") and `tests/ollama-provider.test.js` (the two retry cases).

## Steps

- [x] Write app/notice-overlay.js: a pure, terminal-free model of transient notices
  (kinds, TTL, expiry, dedupe, cap) plus the row formatting an overlay paints.
- [x] Write app/notice-bar.js: the blessed overlay near the top of the screen, driven by
  the overlay model and an injectable clock, auto-hiding after the TTL.
- [x] Wire it in app/tui.js through the extracted app/tui-surface.js: create the overlay
  and expose `notice()`/`dismissNotice()`/`notices()` on the TUI surface, every file
  under 300 lines.
- [x] Route provider failures through an injected hook (api/ollama.js `onRetry`,
  app/conversation-manager.js `onNotice` instead of the transcript, main.js binding) so a
  recovered 502 clears instead of lingering.
- [x] Add docs/interface/notice-overlay (behaviour.md + spec.yaml), register it in
  docs/index.yaml, and add tests/notice-overlay.test.js covering every named case.
- [x] Run `node --check` on every touched file, `npm test` green, delete the agent/utils
  probes, tick the backlog line.

## Verified

- `npm test` → **280 tests, 280 pass, 0 fail**, `tests/docs-realm.test.js` included.
- `node --check` clean on every touched file.
- Largest touched file: `tests/conversation-colors.test.js` at 299 lines — all under the
  300-line budget.
- The one-off probes and patch scripts written for this pass are deleted; only the
  pre-existing `agent/utils/` scripts remain.
