# Interface — skins

A **skin** is a saved look for a project: the conversation palette and a handful of
presentation tokens, kept as one JSON file per name under `agent/skins/<name>.json`.
Typed as `/skins`, the command lists, applies, saves and creates them — including from
a natural-language request through a **modal subchat**. This spec fixes the store, the
live palette and the command; the implementation is linked below.

## The store (`utils/skins-store.js`)

- A skin is a plain object: `{ name, palette, border, brand, hint, selected, selectedFg,
  boldIntent, boldTracking }`. `SKIN_KEYS` is that list and `PALETTE_KEYS` names every
  colour key the screen paints. Eight are the kinds of transcript row (`user`,
  `tool`, `intent`, `context`, `error`, `notice`, `tracking`, `refusal`,
  `docs/interface/conversation-colors`); six are the chrome the markdown renderer and
  the tool delimiters paint (`frame`, `table`, `code`, `quote`, `bullet`, `heading`);
  three are the tool families (`toolRead`, `toolWrite`, `toolBash`). `PRESENTATION_KEYS`
  names the rest.
- Every colour is a **blessed colour name** (`bright-blue`, `cyan`, `grey`), never a hex
  code or an `rgb()` value: a character-cell terminal addresses named colours, so a skin
  cannot carry a pixel. The vocabulary is a **closed set** (`utils/color-names.js`,
  `BLESSED_COLORS`): exactly the names a blessed tag really paints. A name blessed does
  not know is not an error the widget reports — the tag parser prints it **literally** —
  so `isColorName()` refuses `orange` or a hex code instead of putting `{orange-fg}` on
  screen as text.
- `agent/` is the workspace's gitignored state tree (like the sessions and the log), so a
  skin is a per-project preference and never a chunk: nothing here reaches the model
  context or a session file.
- `DEFAULT_SKIN` is the palette `app/theme.js` ships, so a project with **no** skin file
  looks exactly as it always did. It is never written to disk.
- `normalizeSkin()` folds a partial object, a full object or a corrupt file into the
  canonical shape: an unknown key is dropped and an invalid colour degrades to the
  shipped one, so a bad file can never leave the session unreadable.
- `listSkins()` answers the default first, then one entry per file sorted by name, and
  reports an unreadable file as its own entry with an `error` rather than hiding it.
- `saveSkin()` writes through `utils/file-io.js#writeFileVerified`, so the bytes are read
  back and proven before success is reported, and the path is resolved through the same
  sandbox every file tool uses (`utils/path-safety.js`).
- `readActiveName()`/`writeActiveName()` remember the active skin in
  `agent/skins/active.json`, so reopening the project repaints in it without an argument.

## The live palette (`app/theme-palette.js`, re-exported by `app/theme.js`)

- `CONVERSATION_COLORS`, `SLASH_COLORS`, `THEME_TOKENS` and the scalars
  (`INTENT_COLOR`, `TRACKING_COLOR`, `STAMP_COLOR`, `REFUSAL_COLOR`) keep their names and
  their shipped **defaults**; the objects are no longer frozen.
- `setPalette()`, `setTokens()`, `applySkin()` and `resetTheme()` mutate them **in place**,
  so a skin repaints a running transcript without any module that imported a colour
  having to be re-imported. `activePalette()`/`activeTokens()` are the read side.
- Every consumer reads the live value at paint time rather than snapshotting it at import:
  `colorizeIntent()`/`colorizeTracking()`/`colorizeStamp()` and `colorizeLine()`
  (`app/theme.js`), `trackingBlockColor()` (`app/tracking-block.js`),
  `NOTICE_COLORS` (getters, `app/notice-overlay.js`),
  `selectedOpen()`/`selectedClose()` and the box border (`app/slash-bar.js`), the input
  hint (`app/input-hint.js`), the brand mark (`app/brand-bar.js`), the modal border and
  cursor (`app/tui-modal.js`).
- The transcript **colours at paint time**. `app/tui-render.js#renderTranscriptLines()`
  renders the markdown and tool delimiters *without* the palette, and
  `app/transcript-view.js#paintRecord()` applies `colorizeLine()` to each stored row on
  every repaint — from the uncoloured source the model keeps. That is what lets a skin
  repaint the conversation **already on screen**: fold the two steps together and
  applying a skin moves only the chrome, which is the "I applied a skin and nothing
  changed" bug this design exists to prevent. A block body carries one colour
  (`bodyColor`, e.g. the tracking colour) beside the payload rather than inside it, and
  the view re-applies it on every paint for the same reason.
- Colour stays presentation only: it never reaches the model context or a session file,
  and only the TUI applies it (the line CLI prints through `console.log`).
- `tui.repaintTheme()` (`app/tui-surface.js`) re-reads the chrome — the border, the brand
  mark, the notice rows, the copy toast, the slash popup — and repaints the transcript in
  place, which is how a `/skins` command reaches the screen from the host loop.

## The tag layer (`app/paint-tags.js`)

- **Nothing but this module writes a colour into a blessed tag.** A paint site names a
  palette key as a *symbolic* tag — `{@frame-fg}…{/@frame-fg}` — and `resolveTags()`
  turns it into the live value at paint time. A site that interpolates a raw colour
  (`{cyan-fg}`) bypasses the palette and freezes the row at render time, which is exactly
  the bug where a skin saved and reported success while the screen did not change.
- `resolveTags(text, palette)` resolves every symbolic tag against `palette`, falling back
  to `FALLBACK_COLOR` for a key the palette does not carry or a value that is not a
  paintable name. An unresolved symbol must never reach the screen: blessed prints a tag
  it cannot parse **literally**, so `{orange-fg}` would appear as text.
- `default` resolves to **no tag at all**, because it *is* the absence of a colour; that
  keeps the shipped bytes of a skin-less project identical to what they were before.
- `fgTag(color, body)` is the same rule for a caller holding a plain colour name (a block
  body's `bodyColor`): an invalid name degrades to `FALLBACK_COLOR` instead of becoming a
  literal tag. `hasSymbolicTags()`/`stripSymbolicTags()` and `symbolicTag()` are the
  helpers a caller needs to test for and build a symbolic tag.
- The layer is why the palette's new keys matter: `frame`, `table`, `code`, `quote`,
  `bullet`, `heading` and the three tool families (`toolRead`, `toolWrite`, `toolBash`)
  are the literals that used to be hardcoded in `app/tui-render.js` and
  `app/markdown-table.js`.

## The command (`app/skins-command.js`)

`/skins` returns a plain result object and never prints, so both front ends report it
identically (`docs/interface/commands`). `parseSkinsArgs()` splits the argument and the
command answers one of seven shapes:

- `/skins` or `/skins list` — `LISTED`: the project's skins, the active one flagged;
- `/skins <name>` — `APPLIED`: the skin is put on at once and remembered as the project's
  active one; an unknown name is `UNKNOWN_SKIN`;
- `/skins save <name>` — `SAVED`: **what is on screen now** is written down, which is how
  a look built by hand through the arguments is kept; the saved skin is put on and
  remembered as the project's active one, so the screen changes at once (writing the
  file alone left the project on the previous skin and the screen unchanged);
- `/skins <name> <token>=<value>… [save [<name>]]` — `APPLIED`/`SAVED`: a look is built
  from the skin `<name>` (from what is on screen when `<name>` is new), individual tokens
  are set, and it is applied — written down when `save` is named, e.g.
  `/skins warm intent=bright-yellow user=cyan save warm`. A bad colour or unknown key is
  `BAD_VALUE`; a colour the terminal cannot paint is refused too, because a blessed tag
  it does not know is printed literally rather than painted.
- `/skins reset` — `RESET`: back to the shipped default;
- `/skins prompt <request>` — the modal subchat proposes a **new** skin (below);
- `/skins customize <request>` — the same subchat **updates the active skin** in place
  (`CUSTOMIZED`), with no new name and no new file. It refuses with `NO_ACTIVE_SKIN` when
  the project is still on the built-in default, because there is no file to update.

## `/skins prompt`: the modal subchat (`app/skin-prompt.js`, `app/skin-modal.js`)

- `createSkinProposer()` turns a request into a **proposed** skin with one model call. It
  is pure in the sense that matters: `callModel(messages)` is injected
  (`api/ollama.js#callOllama` shaped), so the prompt, the parsing and the normalisation are
  unit tested with a stub and no network — the shape `app/compaction-runner.js` uses.
- `buildSkinMessages()` sends a system text naming every key and the blessed colour
  vocabulary (a hex code is refused), plus the palette in force so "make it warmer" has a
  floor. `parseSkinProposal()` is forgiving (it slices the first `{` to the last `}`) and
  `mergeProposal()` folds the answer through `normalizeSkin()` on top of the base skin. An
  answer with no usable JSON is `null`, and the command then leaves the look untouched.
- **a model answer is validated before it is merged.** `validateProposal()` walks the
  proposal and returns one sentence per problem: an unknown top-level key, a palette key
  that is not a palette key, a colour that is not a name the terminal can paint (a hex
  code, `orange`, a number), a presentation token that is not a colour, and a `boldIntent`
  or `boldTracking` that is not a boolean. `createSkinProposer()` refuses an answer with
  problems by throwing an error that lists them, so the modal shows the reason beside the
  request instead of a preview nobody can paint. This is the deliberate difference from
  `normalizeSkin()`: degrading silently is right for a **corrupt file** read at startup —
  the session must still open — but wrong for a **model answer**, where a hex code used to
  apply "successfully" and change nothing on screen.
- `openSkinModal()` shows the request, the waiting state and the proposal **inside a
  modal** rather than applying it silently, because a look is the user's to accept. It
  offers `Apply for this session`, `Apply and save to agent/skins/` and `Cancel`, owns the
  keyboard while it is open (the screen's dispatch is locked, a program-level keypress
  listener is prepended — the same rule as `app/tui-modal.js`), and resolves with
  `{ skin, save }` or `null` on Escape/Ctrl+C. It moves no state itself: the command
  applies the confirmed skin.
- **the name is the user's to confirm or change.** The proposal arrives with a name, and
  the modal shows it in an editable field (`app/skin-name-field.js`) prefilled with that
  name — the person who asked knows what the look should be called. The field starts
  empty and is filled the moment the proposal lands, so the caret is never shown over a
  name nobody has been offered. The name the skin is saved under is the *slug* of the
  buffer (`slugName`), shown beside it when the two differ. A name that cannot be used
  (empty, no usable characters, or the built-in `default`) puts the reason under the field
  and takes the apply actions off the list, so the user fixes it while they still can.
- **an apply action cannot be chosen until the skin is ready.** The gate is structural
  (`app/skin-actions.js#availableActions`): while the proposal is in flight the only action
  on the list is Cancel. Readiness is a parameter of the key contract
  (`decideKey({ key, focus, ready })`), not something read off the focus: until the
  proposal arrives the name field does not exist, so the focus stays on the actions and
  Enter there chooses Cancel. A refusal a keystroke could bypass would be a refusal that
  fails on the one path nobody tested.
- **an applied skin is always written down.** A skin is a file
  (`agent/skins/<name>.json`), and a look that exists only in RAM cannot be re-read,
  listed, edited — or restored when a session resumes. So the command writes the file
  whether the modal answered `Apply for this session` or `Apply and save`, and the
  directory is created by `utils/file-io.js#writeFileVerified` on the first save. What
  `save` decides is narrower and separate: whether the *project* adopts the skin as its
  default (`agent/skins/active.json`). The narrower reading was the bug — "apply for this
  session" wrote nothing, so a session recorded a skin *name* with no file behind it and
  the look was never linked to the conversation.
- `createSkinSubchat()` (`app/skin-subchat.js`) is the `skinSubchat(request, { base })`
  surface the command calls; the host wires it (`main.js`). A front end without one (the
  line CLI) refuses `/skins prompt` with `NO_SUBCHAT` and changes nothing.
- **`/skins customize` is the same widget, asking a different question.**
  `runSkinCustomize()` (`app/skins-prompt-action.js`) reads the active skin's file, sends
  the request through the same one model call — with `skinCustomizeSystemPrompt()`, which
  tells the model to *adjust* the look and *not* to name it — and opens the modal with
  `{ customize: true, editable: false }`. The name field is off (the name is settled), the
  action list is `CUSTOMIZE_ACTIONS` (`Update the active skin` / `Cancel`), and the
  confirmed change is written over the active skin's own file. A name the model invents
  anyway is dropped: `createSkinProposer()` keeps the base name in customize mode. Nothing
  is created and the project default does not move. No active file means `NO_ACTIVE_SKIN`
  — a customize request without a skin to customize would be a prompt request wearing a
  different name.
- **the waiting state is live.** A model call takes seconds, and a body painted once
  reads as a hang, so the modal runs an `unref()`ed timer while the call is in flight:
  `tick()` advances a spinner frame and the elapsed seconds and repaints. The indicator
  is *indeterminate* on purpose — how long a model will take is not knowable, so a
  percentage or a determinate bar would be a lie about it. The elapsed time is read from
  the injected clock rather than counted in ticks, so a delayed interval cannot make it
  drift; `now`/`intervalMs` are injectable, so a test drives the frames with no real
  clock. The timer is released the moment the call settles and again on close, so nothing
  repaints a modal that is gone.
- The body text — `formatSkinPreview()`, `formatSkinWaiting()` and `formatSkinBody()` —
  lives in `app/skin-preview.js`, so the wording is testable without a terminal; the
  modal re-exports the three names it always had.

## Startup and the session link (`app/skin-host.js`)

The project's active skin is read and applied **before the screen is built**, so the first
frame — border, brand line, input hint — already wears it, and a project that saved a skin
opens in it. A missing skin file is not an error: the built-in default is what a project
with none looks like.

The order is the whole contract, and it is order-sensitive:

1. `applyProjectSkin()` applies the project's stored skin and then marks the bootstrap
   done. That mark is what licenses a **resume** to restore a session's own look — a
   restore before it would be painted over by step 1.
2. `currentSkin()` is the live reader the session recorder is built with (`skinOf`), so
   the look a conversation was held in travels with its record.
3. `rememberAppliedSkin()` is the `onApply` hook `/skins` calls: it remembers the applied
   skin as the project's and repaints the chrome.
4. `restoreSessionSkin()` is how `/sessions` brings a session's look back. It reads the
   **file first** and refuses when the file is gone: renaming the palette to a skin with no
   file would re-create the broken link this feature exists to avoid.

A skin is **per project**, and the session only records *which* skin it was held in. The
record carries the name in `context.json` (`utils/session-format.js#serializeSession`);
`sessionSkin()` reads it back, returning `null` for a file written before the field
existed, so an older conversation resumes with whatever look is in force. Colour remains
presentation only: it never reaches a chunk and never reaches the model.

## What the log records

Every `/skins` run writes **info-level** lines through
`utils/logger.js#logEvent()` under the `skins` scope, so a look that "did not change" can
be diagnosed from the log alone instead of from a reproduction:

- `command /skins <action>` — what was asked, with the argument and the skins directory;
- `applied the skin "<name>"` — with the palette and tokens now in force;
- `proposal requested` / `applied the proposed skin` / `saved the proposed skin`;
- `no skin proposed; the look is unchanged` — the cancelled-or-empty case, which is also
  said **on screen** (`No skin applied; the look is unchanged.`) so a silent no-op can
  never be mistaken for a broken feature.

With no logger registered `logEvent()` is a silent no-op, which is what keeps the test
suites free of side effects. `LOG_LEVEL=info` (or lower) is what makes these lines appear
in `LOG_FILE`.

## See also

- Implementation: `utils/skins-store.js`, `app/theme-palette.js`, `app/theme.js`,
  `app/skins-command.js`, `app/skins-prompt-action.js`, `app/skin-prompt.js`,
  `app/skin-preview.js`, `app/skin-actions.js`, `app/skin-name-field.js`,
  `app/skin-modal.js`, `app/skin-subchat.js`, `app/skin-host.js`, `main.js`
- Spec of the palette the skins repaint: `docs/interface/conversation-colors`
- Spec of the slash-command registry: `docs/interface/commands`
- Spec of the modal the subchat borrows its key ownership from: `docs/interface/commands`
- Spec of the logger: `docs/runtime/logger`
- Proof: `tests/skins.test.js`, `tests/skins-command.test.js`, `tests/skins-prompt.test.js`,
  `tests/skin-host.test.js`
