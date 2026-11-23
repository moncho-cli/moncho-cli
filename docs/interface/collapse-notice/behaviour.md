# Interface — the collapse notice

A collapse replaces a solved item's whole section with one deterministic summary and keeps
its raw chunks in a chunkpaction capture (`docs/context/item-collapse`,
`docs/context/chunkpaction`). The window therefore *shrinks* mid-conversation — and until
this existed only the **model** was told: the report rides back in `update_task`'s JSON
reply, which never reaches the transcript. The user, who watches the conversation, saw the
window get smaller with no explanation.

So a collapse prints one line:

```
[Context] Collapsed the solved section of "wire the reader" (3 chunks) — raw chunks: read_chunkpaction({ capture: 2 }).
```

## One line, not a start/end pair

The obvious symmetry to reach for is the compaction's, which announces itself **twice**
(`app/compaction-runner.js`): `Compaction process started...` and then
`Compacted N older chunk(s) into a summary…`. That first line exists for a real reason —
the summariser call takes *seconds*, so the thread must not go quiet while the window is
being rewritten.

A collapse is a **synchronous array rewrite**. It takes microseconds, so there is no gap
for a start line to fill and announcing one would be noise about nothing — the same reason
a tool call does not announce itself twice. The end line alone carries everything a reader
needs: that it happened, what it replaced, and where the detail went.

## What the line says, and why

| part | why it is there |
| ---- | --------------- |
| the item, quoted | which section was solved; quoting flattens newlines so a row cannot break |
| the chunk count | how much window came back |
| `read_chunkpaction({ capture: N })` | where the raw chunks went — the same pointer the summary carries, so the receipt and the recovery are the same string |

The capture id is the one the summary names, so a human can hand it straight back to the
agent ("read capture 2") and land on the same chunks the model would.

## When it prints

- **After** the rewrite, never before: only a collapse that really happened is worth a
  line, and a run the guards refused (not completed, too short, would not shrink, would cut
  a tool batch) shows nothing — which is also the honest report.
- **One line per collapsed item**, in the order they were collapsed.
- **Through the registry** (`utils/host.js#notifyCollapse`), like the tracking
  announcements: the collapse happens inside a tool call, so a registry sink bound to the
  front end is the only way to reach the transcript. With no sink registered — a bare tool
  call, the tool-level suites — it is a silent no-op.

Presentation only: the line is **not a chunk**, so it never reaches the model context or a
session file. It reuses the `[Context]` prefix the compaction lines already carry, so
`app/theme.js#classifyLine` colours it with no new rule and the two context events read as
one family.

## See also

- What is collapsed, and the guards: `docs/context/item-collapse`
- Where the raw chunks go: `docs/context/chunkpaction`
- The announcement it is modelled on: `docs/context/compaction`
- The sibling visible announcement: `docs/interface/tracking-notice`
- Implementation: `app/collapse-notice.js`, `app/item-collapse-runner.js`,
  `utils/host.js`, `main.js`
- Proof: `tests/collapse-notice.test.js`
