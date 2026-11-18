# Interface — pretty-printed JSON results

Tools and commands answer in JSON. A single-line JSON blob is technically correct
and practically unreadable, so the host **re-indents** it for display. The
formatting is presentation only: the model still receives the raw tool result and
a session file keeps the exact bytes (`docs/runtime/session-store`).

## What gets formatted

- A tool result that parses as a JSON object or array is pretty-printed with two
  spaces per level, then shown as usual — a collapsible block in the TUI
  (`docs/interface/transcript-blocks`), plain lines in the line CLI
  (`docs/interface/line-cli`).
- A JSON *scalar* (`42`, `"ok"`, `true`) and plain prose are left exactly as they
  are: only structure is worth indenting, and a formatter must never swallow a
  result it does not understand.
- A payload that does not parse is returned unchanged, so a broken tool result
  stays visible instead of being dropped.

## Command results

Commands return a plain object (`{ ok, code, lines?, message?, ... }`). The host
renders it in this order:

1. `lines` — already display-ready strings, each expanded if it is JSON;
2. `message` — the human summary;
3. nothing else, unless the result carries **only** payload (no `lines`, no
   `message`), in which case the payload is printed as pretty JSON.

The `ok`/`code`/`message`/`lines` keys are presentation; every other key is
payload. That keeps a summary readable while the data stays available to callers
and to tests.

## See also

- Implementation: `app/json-display.js`, `main.js`
- Spec of the commands whose results are formatted: `docs/interface/commands`
- Proof: `tests/json-display.test.js`
