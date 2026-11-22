# Agent — the file size budget

The agent is told how large a file may be before it must be split. The backlog entry
this implements:

> while we chose to develop with a hard limit of 300 lines, this must be configurable,
> ......

The number was right for the project when it was chosen and wrong for it soon after, so
it lives in the environment and the code reads it from there. The default is **600**.

## The knob

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `FILE_LINE_LIMIT` | `600` | How many lines a file may hold before it must be split along its responsibilities. |

- The value is **normalised**: a positive integer is used as it is; anything else —
  empty, zero, negative, unparseable — falls back to the default. A broken environment
  variable must never be able to disable the rule or invert it. This is the same
  forgiving shape every other knob in the project has (`utils/task-pulse.js` for the
  pulse limit, `config/constants.js#toPositiveInt` for the rest).
- The **ceiling** is derived, never configured separately: it is the budget plus a half
  again (600 → 900). Two numbers rather than one, because "split when you get close"
  and "this is the point where it is refused" are different instructions — and a second
  variable could contradict the first.

## Where the model reads it

The rule is **prose in the agent prompt** (`config/prompt.md` §3.1): the model is the
one who writes the files, so the model is the one who has to know the budget. The prompt
therefore carries two **placeholders**:

- `{{FILE_LINE_LIMIT}}` — the configured budget;
- `{{FILE_LINE_CEILING}}` — the ceiling derived from it.

The provider receives the **rendered** prompt: `api/ollama.js#loadSystemPrompt` reads
the file and renders the configured numbers into it. So the model always reads the
budget that is actually in force, and the prompt file and the configuration cannot
drift apart.

Three rules keep the rendering honest:

- a prompt with **no** placeholder is returned unchanged, byte for byte — a rule may
  need no number at all;
- **every** occurrence is replaced, so the prompt may name the budget as often as it
  needs to;
- a placeholder that **survived** the rendering is a failure that is *reported*
  (`logEvent('error', 'provider', …)`), never silently shipped: a prompt carrying a
  literal `{{FILE_LINE_LIMIT}}` tells the model nothing at all.

The prompt file stays the **one** place the rule is written. The rendering module
substitutes numbers into it and never restates the prose, so the wording cannot drift
from the numbers.

## The maintainer's side

`CONTRIBUTING.md` names the **configured** budget rather than a fixed number, and says
where it comes from: the variable, not the prose. Changing the limit is a change to
`FILE_LINE_LIMIT` — the prompt follows by itself.

The knob is documented in `.env.example` and `.env.moncho.example`, next to the other
environment-driven settings.

## What it is not

- **Not enforced by code.** The budget is a rule the model follows, not a limit the
  harness refuses to cross: a file the model wrote is a file the model wrote, and
  refusing the write would cost the user their work. This is the same bargain as the
  model-call pulse (`docs/context/call-pulse`): the limit is *instructive*, the
  counting is the harness's.
- **Not a second source of truth.** The prose lives in the prompt file only; the
  module renders numbers into it.

## See also

- Implementation: `utils/file-size-budget.js`, `config/constants.js`,
  `api/ollama.js`, `config/prompt.md`
- Proof: `tests/file-size-budget.test.js`
