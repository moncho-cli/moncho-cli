# Agent — a refused call is shown, not just answered

A tool call can be stopped **before it runs**: the pre-dispatch gate refuses what the
session mode does not allow (`docs/interface/modes`), and the batch refuses what lies
beyond `MAX_PARALLEL_TOOL_CALLS` (`docs/agent/tool-multicall`). Either way the call
gets one `tool` chunk carrying a structured refusal — that half always existed, and
it is what lets the *model* adapt instead of retrying the same call.

The reader had no such half. A gate refusal printed nothing at all: the call was
announced, then a result block appeared, and the only sign that no tool had run was
the JSON buried inside a collapsed body. The cap refusal did print a line, in the
plain tool yellow every other row uses, and worded differently from the JSON the
model was handed. This spec fixes the other half: **one row, its own colour, the
same words as the chunk.**

## One row, from both refusal sources

`app/refusal-line.js#formatRefusalLine` is the whole wording, and it is a leaf module
— it imports nothing — for two reasons that matter:

- `app/theme.js#classifyLine` needs to recognise the row, and the palette is the
  pure, terminal-free half of the transcript: importing a module that reaches
  `config/constants.js` would make the palette read the provider environment at load
  time. The leaf keeps the palette a renderer.
- `app/tool-batch.js` builds the row for the gate refusal and the cap refusal, so the
  two wordings cannot drift. `formatRefusalLine({ name, reason, mode })` writes:

```
  ✖ Refused write_file (design): the session is in Design, whose only writable
  files are task.md and implementation_plan.md
```

- `✖` (`REFUSAL_MARK`) and `Refused` (`REFUSAL_VERB`) are the row's whole signature,
  and `isRefusalLine()` / `REFUSAL_LINE_RE` are how the palette finds it.
- The **reason is the refusing layer's own**, never a phrase invented for display, and
  the **mode is named** when the gate knows it. A missing reason still says
  *"the current mode does not allow this call"*, so the row is never empty.
- The **cap refusal is worded from the same string it puts in the chunk**
  (`app/tool-batch.js#formatBatchRefusalReason`), which is why the row and the JSON
  can never disagree: one function, two readers.

## Its own colour: bright red, bold, and not an error

`CONVERSATION_COLORS.refusal` is `bright-red` and the row is `bold`
(`REFUSAL_COLOR`, `REFUSAL_BOLD`, `colorizeRefusal()`), which is deliberately not the
plain `red` of an `Error …` row: a refusal is a *decision*, not a failure, and the two
sit side by side in a real transcript. Bright red is also unused by every other kind
(`docs/interface/conversation-colors`), so the colour alone says "this was refused".
The batch cap's old yellow line is gone with it.

`colorizeRefusal()` is applied through the normal palette path
(`classifyLine()` then `colorizeLine()`), so the row reaches the terminal through
`formatTranscript()` like every other row, and the classification runs **before** the
`Error` rules — a refusal whose reason happens to mention an error is still a refusal.

Colour stays presentation only: the row is printed through `log()`, which is the
front end, and nothing here is a chunk. The model still reads its own structured
`[error]` body, exactly as before.

## Where the row appears

- A **gate refusal** prints after the call it belongs to, inside the result loop, so
  the reader sees the call, then why it did not run, in that order — the same order
  the chunk carries for the model.
- A **cap refusal** prints in the cap's own loop, where the *"Refused … beyond the
  batch"* line used to be.
- Both are presentation only, so a front end that never prints (a test, the line CLI)
  is unaffected: the refusal itself lives in the chunk, which is why this row can be
  added without touching the provider contract.

## See also

- Implementation: `app/refusal-line.js`, `app/tool-batch.js`, `app/theme.js`
- The structured refusal the model gets: `app/tool-guard.js`, `docs/agent/tool-multicall`
- The policy that refuses: `docs/interface/modes`
- The palette the row joins: `docs/interface/conversation-colors`
- Proof: `tests/tool-refusal.test.js`, `tests/tool-guard.test.js`,
  `tests/tool-batch.test.js`
