status: done

# TUI conversation window: smooth scrolling and readable colours

Two unchecked items in `task-backlog.md` concern the same widget — the
**conversation window of the TUI**:

- `conversation scrolling is not smooth`
- `converstaion needs colors to be easier to read`

That widget is the `blessed.log` transcript built in `app/tui-layout.js`, driven by
the model in `app/transcript.js` and painted by `app/transcript-view.js` through the
pure renderers of `app/tui-render.js`. Both items are therefore closed the way the
three realms require (`docs/README.md`): a spec under `docs/interface/` registered in
`docs/index.yaml` fixes the behaviour, the code honours it, and a named case in
`tests/` proves it. `tests/docs-realm.test.js` fails when a source module has no
spec, when a spec names a symbol or a test case that does not exist, or when the
registry and the spec directories on disk drift apart.

Constraints that hold for both items:

- scroll position and colour are **presentation only**: no offset, tag or palette
  entry may reach the model context or the session file
  (`docs/interface/user-messages`, `docs/runtime/session-store`);
- the line CLI logs through `console.log` and never runs `formatTranscript()`, so
  every neo-blessed tag must stay in the TUI render path — otherwise it would print
  as literal `{cyan-fg}` text in the fallback chat;
- `sanitize()` strips raw ANSI before anything is painted, so colour must be
  expressed as blessed tags, never as escape sequences;
- every file stays under the 300-line budget (500 hard limit): extract a module
  rather than growing `app/tui-render.js` past it.

- [x] **conversation scrolling is smooth** — the gap was confirmed on the real widget (a wheel notch moved 0 rows: the transcript is `clickable: true` but not `mouse: true`, and neo-blessed binds `wheelup`/`wheeldown` only with `mouse: true`; page-up stepped a single row). The wheel now nudges 3 rows and page-up/page-down move a screenful minus one, both pure arithmetic in `app/transcript-view.js`, both clamping at the ends, and a scroll moves the viewport instead of rebuilding the content. Proven by `docs/interface/transcript-smooth-scroll` and `tests/transcript-smooth-scroll.test.js`; the follow/hold rule of `docs/interface/transcript-scroll` is unchanged.

- [x] **the conversation is coloured so the parts of a turn are distinguishable** — define the palette once (`app/theme.js`, pure and unit-testable), colour the `You:` echo header, the tool-call lines and their intents, the collapsible block headers, errors/warnings and `[Context]` notices while leaving the existing markdown colouring (fences, delimiters, quotes, headings, lists, inline code) intact, and prove it with a `docs/interface/conversation-colors` spec plus cases in `tests/conversation-colors.test.js`.

## Done when

- both specs exist, are registered in `docs/index.yaml`, and name real
  `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines.
