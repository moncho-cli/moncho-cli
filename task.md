status: done — the three interface-polish items are implemented, spec'd and proven

# Interface polish: bright intent text, a last-prompt hint, and self-hiding notices

Three *easy* items picked from `task-backlog.md`:

> the color of the intent text should be a brightish blue so is easier to find within
> the text, and bold

> if the input box is empty, it should have a grayed italic text saying "Last prompt:
> ......."

> clean up failed attempts, i got a 502 error then it worked but the error text was
> still there. this info should also be displayed in some kind of overlay near the top
> of the screen and auto hide after some minutes

They are one coherent pass over the interface: **what the agent is doing** (the intent
of a tool call), **what you asked last** (the hint under an empty box) and **what went
wrong once** (a transient notice instead of a scar in the transcript).

## What each item must do

| Item | Behaviour |
| ---- | --------- |
| intent | the `intent:` line and the `(intent: …)` span of a tool header are painted **bright blue and bold**, so the reason for a call is findable at a glance inside the yellow tool block |
| hint | an input box with **no text** shows a greyed `Last prompt: …` hint — the last prompt the box settled, flattened to one line — and any typed character replaces it; the hint is display only, never the box value |
| notice | a failed provider attempt (a 502, an empty response) is announced as a **transient notice**: it never stays in the transcript, it shows in a small overlay near the top of the screen, and it hides by itself after a few minutes — sooner still when the turn it belonged to lands |

## Constraints

- **No new dependency.** The intent style is a blessed tag (`bright-blue`, `bold`); the
  hint is the box content while the box is empty; the notice is a pure model plus one
  blessed overlay box.
- **Pure where it matters.** The hint's text/shape and the notice's lifetime are pure
  (`app/input-hint.js`, `app/notice-overlay.js`) so both are unit tested without a pty.
- **Presentation only.** No tag, no hint and no notice ever reaches the model context or
  a session file, and the line CLI (which prints through `console.log`) keeps its plain
  behaviour: a notice there is a plain `[<kind>] <text>` line.
- **blessed has no italic.** Its tag vocabulary is bold/underline/blink/inverse/
  invisible (`node_modules/neo-blessed/lib/program.js#_attr`), so the "grayed italic"
  hint is rendered in the dimmest named colour (`grey`). That deviation is stated in the
  spec, not hidden.
- Every file touched stays **under 300 lines**; the specs under `docs/` and the suites
  under `tests/` are updated in the same pass (`tests/docs-realm.test.js` enforces the
  links).

## Steps

- [x] **bright blue, bold intent text** — `app/theme.js` gains an `intent` kind
  (`bright-blue`, bold) that owns the standalone `intent: …` row and the `(intent: …)`
  span inside a tool header; `tests/conversation-colors.test.js` and
  `docs/interface/conversation-colors` follow the new palette.
- [x] **the last-prompt hint in an empty box** — `app/input-hint.js` remembers the
  prompt the box settled and paints `Last prompt: …` (grey, sanitised, display only)
  over an empty box, reacting to the box's own content changes so it can never be
  submitted; `docs/interface/tui` names the behaviour and the cases that prove it.
- [x] **transient notices in a self-hiding overlay** — `app/notice-overlay.js` (pure:
  the TTL, the rows, the kinds, the dedupe) and `app/notice-bar.js` (the blessed overlay
  at `top: 1`, hidden while empty and hidden by one timer armed for the earliest expiry),
  surfaced through `app/tui-surface.js`; `api/ollama.js` reports a retried attempt
  through an injected `onRetry` hook and `app/conversation-manager.js` routes recovered
  failures to `onNotice` instead of the transcript, keeping a transcript line only for
  the failure that ends the task; `main.js` binds the hook and dismisses the retry notice
  the moment the turn lands; `docs/interface/notice-overlay` states the rule and is
  registered in `docs/index.yaml`.

## Done when

- the three behaviours are in the code, each with a spec under `docs/` naming real
  `path#symbol` references and the exact test cases that prove it;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines;
- the backlog items are ticked and any scratch probe under `agent/utils/` is deleted.
