# Agent — the tool-call contract

Every capability the agent has is a **tool** declared in `tools/` and loaded by the
runtime. This spec fixes the contract that makes a tool callable, traceable and
auditable. It describes *behaviour*; the implementation lives in the files linked
at the bottom of this document.

## Declaration

- A tool module exports `definition` and `execute`; the runtime auto-discovers both
  by importing every `tools/*.js` file. Files without those exports are ignored.
- A tool is declared with `defineTool()` from `utils/tool-schema.js#defineTool`.
  That helper builds the OpenAI-compatible `definition`, adds the mandatory
  `intent` parameter, and wraps `execute` so the handler always receives parsed
  arguments plus `{ intent }`.
- `intent` is **required**: `defineTool` puts it first in `properties` and in
  `required`. `withIntentParameter` never drops the tool's own parameters, so a
  tool that declares `required: ['path']` ends up with `required: ['intent','path']`.

## Loading

- `loadTools(onToolResult)` imports each `tools/*.js`, collects the definitions and
  builds the `toolFunctions` map keyed by `definition.function.name`.
- Loading **fails loudly** instead of silently degrading:
  - a tool whose definition lacks the `intent` parameter throws, so a missing
    contract is caught at startup rather than mid-task;
  - two tools declaring the same name throw, so a later file cannot shadow an
    earlier one.
- After each successful call the loader invokes the result hook with
  `(name, result, intent)`, so the host loop can print the intent next to the
  output and keep it in the model context.

## Intents

- An intent is normalised to a single trimmed line: internal whitespace collapses
  to one space, and a non-string or absent value falls back to a visible
  placeholder (`(no intent provided)`) rather than an empty string.
- The intent is read from arguments that arrive either already parsed or as a JSON
  string. Malformed JSON never throws out of the intent helpers; they degrade to
  the placeholder so a broken tool call cannot crash the loop.
- Because the intent travels *inside* the arguments, it round-trips to the model:
  the conversation stores it in the tool result chunk, not only in the terminal.
- The loader's best-effort extraction never throws — the hook receives `null` when
  the intent is unusable, and the caller decides how to render that.

## Failure behaviour

- `defineTool` rejects a missing `name` and a non-function `execute` at definition
  time (programmer error, not a runtime condition).
- Tool arguments must parse to an object: `parseToolArgs` accepts `null`/
  `undefined`/`''` as `{}`, accepts an object as-is, parses a string, and throws a
  `TypeError` for any other type.
- Tool handlers own their own error reporting. The convention across `tools/` is a
  JSON result with `status: "error"` plus a stable `code` and a `guidance` hint
  when the caller can fix the call.

## See also

- Implementation: `utils/tool-schema.js`, `utils/tool-loader.js`, `config/constants.js`
- Tool surface: `tools/read_file.js`, `tools/write_file.js`, `tools/patch_file.js`,
  `tools/run_bash.js`, `tools/run_npm.js`, `tools/compact_context.js`,
  `tools/update_task.js`, `tools/grep.js`, `tools/blob.js` (the last two are
  specified in `docs/agent/project-discovery`)
- Proof: `tests/harness-tools.test.js`
