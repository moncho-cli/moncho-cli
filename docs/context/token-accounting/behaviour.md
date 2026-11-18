# Context — token accounting

The context window is measured in tokens so the agent can compact *before* the
provider rejects a request. Providers do not report a token count for a pending
request, so the harness estimates. This spec fixes the estimation rules and the
reporting format; the implementation is linked below.

## Estimation

- The estimate is **character-based**: `CHARS_PER_TOKEN` (4) characters per token,
  always rounded **up**, so the estimate errs on the high side. A higher estimate
  only triggers compaction earlier, which is the safe direction.
- Each message also pays `MESSAGE_OVERHEAD_TOKENS` (4) for the role markers and
  separators the chat template adds.
- A request adds `TOOL_SCHEMA_OVERHEAD_TOKENS` (24) plus the serialised size of the
  tool definitions, since every request carries the full tool schema block.
- Estimators accept both plain strings (the chunk-based window) and chat messages,
  and they account for `content`, `thinking`, every `tool_calls` entry
  (`id`, `type`, `function.name`, `function.arguments`) and nested
  `context_chunks`.
- Null, undefined and empty values cost 0. Estimates are additive and never
  negative: `estimateMessagesTokens(list)` equals the sum of the per-message
  estimates.

## Budgets

- `parseTokenBudget` reads an environment/config value and ignores anything that is
  not a positive integer (invalid input is `null`, never `NaN` or a negative).
- A budget of `0` (or any non-positive / non-finite value) means **no limit**:
  `exceedsTokenBudget` returns `false` and `remainingTokens` returns `Infinity`.
- `remainingTokens` never goes negative; it floors at 0.

## Reporting

- `formatTokenCount` prints raw counts below 1000, `x.xxk` twice-rounded below
  10000, `x.xk` up to a million, and `x.xM` above.
- `formatUsage` renders `"<used> / <max> tokens (<pct>%)"`, with the percentage
  capped at 999% so an astronomically over-budget window still renders sensibly,
  and `"<used> tokens (no limit)"` when there is no budget.

## See also

- Implementation: `utils/tokens.js`, `config/constants.js`
- Used by: `app/context-window.js`, `utils/compaction.js`, `tools/compact_context.js`
- Proof: `tests/harness-tools.test.js`
