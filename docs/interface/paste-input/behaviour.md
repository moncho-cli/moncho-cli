# A pasted block as a token in the input box

A terminal does not tell a program that the user pasted. With bracketed paste off — which
is how most terminals reach this program — a paste arrives as ordinary input, and the only
moment its bytes are still intact is the raw chunk the input stream hands over. A moment
later node's key parser has turned that chunk into a burst of `keypress` events, and by
then the block cannot be recovered:

- neo-blessed's textarea appends every printable byte to the **end** of its value, so a
  paste lands wherever the caret is not;
- `Textbox.setValue()` strips every `\n` (`value.replace(/\n/g, '')`), so a multi-line
  paste silently loses its line breaks;
- a `\r` is read as Enter, so a Windows-copied (`\r\n`) block **submits the message on its
  first line** and the rest is lost.

That is the reported defect, twice: the lines vanished, and the message sent itself.

## The shape of the fix

A pasted block is caught at intake and carried as two things: **a token in the box** and
**the bytes in a table**.

- **Intake.** `app/paste-intake.js#createPasteIntake` listens on the program's `data`
  event, which is the earliest point that has the paste whole. It decides whether the chunk
  is a paste (`app/paste-tags.js#isPasteChunk`: a line break **and** something besides it —
  a bare `\r`/`\n` is the Enter key, not a paste) and, when it is, takes a keyboard lease
  (`app/keyboard-ownership.js#KEYBOARD_OWNER_PASTE`) before blessed parses the chunk. The
  lease raises `screen.lockKeys`, which gates blessed's own dispatch to the focused widget,
  and is released on the microtask — after the burst has been emitted — so the box receives
  none of the keystrokes. The bytes are handed over stripped of the bracketed-paste markers
  (`stripBracketedPaste`), which are transport and never content.
- **The token.** The box shows `[pasted N lines #id]` (`formatPasteToken`), never the
  bytes. The line count is for the reader; the id is for the code, so several pastes in one
  box stay tellable apart.
- **The table.** `app/paste-registry.js#createPasteRegistry` owns the id → text map.
  Expanding a token (`expandPastes`) returns exactly what was pasted, line endings and
  trailing whitespace included — the round trip is byte-for-byte.

## The token is one unit

`app/prompt-editor.js` reads the tokens out of the value it holds (`tokens()`), and the
caret treats one as a single thing: `left()`/`right()` cross it whole, and
`backspace()`/`deleteForward()` remove it whole. A pasted block therefore behaves as the
single object it looks like, rather than as twenty characters the user would have to pick
apart one at a time.

## Removing a token shrinks the table

The table follows the box. `createPasteRegistry#prune(text)` takes the box's text and drops
every entry whose token no longer appears in it, so deleting a token from the box takes its
bytes with it — no caller has to track deletions. `app/tui-input-stack.js` drives it from
the key seam's `onChange`, which fires after **every** write to the box, keystroke or not.

Ids are **monotonic and never reused**: the registry remembers the highest id it ever handed
out (`nextPasteId(entries, floor)`), because the live entries alone cannot say which ids are
free once the table has shrunk. A reused id would make a new paste indistinguishable from
the one just removed, and an old token still in the box would silently point at the new
bytes.

## What is deliberately not caught

Two gates keep this a paste catcher rather than a keystroke filter:

- **A chunk that is not a paste is untouched.** Ordinary typing, a lone Enter and an arrow
  key produce no lease, no lock and no callback, and travel the path they always did.
- **A paste is only taken while the box is its destination.** The gate
  (`app/paste-intake.js#pasteBelongsToBox`) asks that the box is inside its read cycle and
  that no modal holds the keyboard (`KEYBOARD_OWNER_MODAL`). A paste into a modal's own
  field belongs to the modal, and a paste with no armed box has nowhere to land; in both
  cases the keys take the path they always did.

## Submitting

`app/prompt-input.js#createPromptInput` expands the tokens back to their bytes at
submission, so what reaches the model, the queue and the transcript is what was pasted.
Collapsing happens at **intake** now, not at submit: the box never held the raw bytes in the
first place. One notice (`[pasted N lines …]`, painted in the `notice` colour,
`docs/interface/conversation-colors`) announces each collapsed paste.

## See also

- Implementation: `app/paste-tags.js` (the pure rules and the round trip),
  `app/paste-intake.js` (the chunk catcher), `app/paste-registry.js` (the table),
  `app/prompt-editor.js` (the atomic token), `app/prompt-keys.js` (the write and change
  seams), `app/prompt-input.js` (intake and expansion), `app/tui-input-stack.js` (the
  wiring), `app/keyboard-ownership.js` (the lease).
- Spec of the box this happens in: `docs/interface/tui`
- Spec of the queue a mid-turn paste lands in: `docs/interface/message-queue`
- Spec of the caret and history: `docs/interface/prompt-editor`
- Proof: `tests/paste-input.test.js`
