# Interface — the time a stored block was written

Opening a session replays its transcript (`docs/interface/session-replay`), but those
rows came from a past run: the live marks are switched off, so the reader could not
tell whether two blocks were written a second or a day apart. This spec fixes the
times a reloaded conversation shows. The implementation is linked below.

## Where a time comes from

Each chunk's append time is recorded **when it is added to the window**
(`app/context-window.js#ContextWindow`) and stored in the session record beside the
chunks it belongs to (`docs/runtime/session-store`). Replay reads them back and paints
them; it never takes a fresh reading of the clock, because that would state the time
the file was reopened.

- The mark is a stored ISO instant, rendered in **local** time: the reader is looking
  at their own clock, and a transcript that disagreed with it by a timezone offset
  would be worse than no mark at all.
- Junk — a record with no times, a hand-edited non-date — is **no mark** for that row,
  never a wrong one. A session written before the field existed still replays, with
  its rows unmarked exactly as before.

## Why the times are not on the chunk

They live in a parallel array (`stamps`), index-aligned with the chunks, and never as a
field on a chunk itself. A chunk is the message the provider is sent **verbatim**
(`app/context-window.js#ContextWindow.request`): an unknown key can be rejected by a
strict OpenAI-compatible endpoint and would break the promise that the record holds the
conversation byte-for-byte. `utils/chunk-stamps.js` owns the alignment rules:

- **one entry per chunk**, always — a short list is padded with `null` rather than
  shifting marks onto the wrong rows;
- **a compaction rebuilds** the list by chunk identity, so the summary chunk takes the
  moment of the compaction while the carried user message and the kept tail keep the
  times they were written;
- an absent field stays absent when the record is written, so a conversation without
  marks serialises to the bytes it always did.

## What a reloaded transcript shows

Two marks, both from the same stored instant:

| Row | Mark |
| --- | ---- |
| the first entry of each calendar day | a divider, `--- 2026-11-20, Thursday ---` |
| an entry itself | the usual `HH:MM:SS` at the head of its first line |

The divider is what makes the clock unambiguous across days, and it appears **only
where the day changes** — a conversation inside one day shows no divider at all. It
opens with a rule on purpose: the palette paints a rule as chrome
(`app/theme.js#classifyLine`), so a divider can never be mistaken for prose the model
wrote, and the reply delimiters are untouched.

The mark itself keeps every rule the live one has (`docs/interface/conversation-timestamps`):
one per entry, on the first non-blank line, in front of a block's fold glyph, and part
of the display line so the block-click math is unchanged.

## Who shows it

The **TUI** does: `renderReplay` hands each op's mark to the route that paints its row,
and the transcript view paints it instead of reading its clock. A front end that does
not mark its own entries — the **line CLI**, whose `log` is `console.log` — receives the
text and nothing else, so it prints exactly the lines it always printed and never an
options object. The divider is a plain log op and therefore reaches both.

## See also

- Implementation: `utils/chunk-stamps.js`, `utils/session-time.js`,
  `app/context-window.js`, `app/session-replay.js`, `app/transcript-view.js`,
  `utils/session-format.js`, `app/session-recorder.js`
- The live mark this reproduces: `docs/interface/conversation-timestamps`
- The reload it rides on: `docs/interface/session-replay`
- The record it is stored in: `docs/runtime/session-store`
- Proof: `tests/session-stamps.test.js`