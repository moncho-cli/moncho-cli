<p align="center">
  <img src="moncho.png" alt="Moncho logo" width="220">
</p>

<h1 align="center">Moncho</h1>

<p align="center">
  A terminal coding agent that runs itself: it reads, patches, greps and executes,
  then proves what it changed.
</p>

Moncho is a Node.js agent with a full-screen TUI, a tool sandbox, a token-aware
context window and a project that keeps three realms honest — **code**, **docs**
and **tests**. It talks to any OpenAI-compatible provider (OpenRouter, OpenAI) and
to Ollama, chosen entirely through environment variables.

## Highlights

- **Auto-loaded tools.** Every module in `tools/` is discovered at startup; adding
  a capability is one file, with no registry to edit.
- **A real sandbox.** `run_bash`/`run_npm` accept one allow-listed command per call,
  reject shell metacharacters, and file tools refuse to escape the project root.
- **Verbatim patches.** `patch_file` applies a unified diff, then verifies the file
  byte-for-byte and reports a stable error code (`HUNK_MISMATCH`, `NO_HUNKS`, …)
  instead of claiming success.
- **A context window that measures itself.** Token use is estimated per request; at
  the budget the older part of the conversation is summarised and the newest kept.
- **Sessions you can resume.** Every turn is snapshotted to disk, and `/sessions`
  replays one back into the live context.
- **Both front ends.** A neo-blessed TUI on a pty, a plain line chat when there is
  none — with the same commands and the same interrupt keys.

## Quick start (Docker)

```bash
cp .env.example .env   # or edit .env directly: provider URL, key and model
./start.sh run         # build if needed, then run in the foreground
```

`start.sh` wraps Docker for the whole lifecycle:

| Command | What it does |
| -------------- | ------------------------------------------------------------ |
| `./start.sh run` | Runs interactively in the foreground (the usual way to use it) |
| `./start.sh start` | Runs detached in the background |
| `./start.sh stop` | Stops and removes the container |
| `./start.sh shell` | Opens a shell inside the running container |
| `./start.sh build` | Rebuilds the image (needed only when dependencies change) |

The source tree is bind-mounted into the container, so editing a file needs no
rebuild; the image is built once and reused.

## Quick start (local)

```bash
npm install
node main.js      # or: npm start
```

Node 22+. There is no build step: the project is plain ES modules.

## Configuration

Everything is environment-driven; `start.sh` forwards the four variables below from
`.env` when they are set.

| Variable | Default | Purpose |
| ------------------- | -------------------------------- | ---------------------------------------- |
| `OPENAI_BASE_URL` | `http://host.containers.internal:11434/api/chat` | Provider endpoint (OpenAI-compatible or Ollama) |
| `OPENAI_API_KEY` | *(empty)* | Bearer token; omitted from headers when unset |
| `OPENAI_MODEL` | `qwen3.6:35b-a3b-q4_K_M` | Model id sent with every request |
| `CONTEXT_MAX_LENGTH` | the provider's real total, else `128000` | Working token budget; the override wins but both numbers are shown |

The provider label (`openrouter · deepseek/…`) is derived from the base URL, so
switching providers is a `.env` change and nothing else. The context budget is
resolved at startup: a config override first, then the real context length the
provider reports over HTTP, then the 128k default — and the UI shows the override
next to the provider total when the two differ.

## Using it

Type a prompt and press Enter. A task runs until the model stops asking for tools:

- `exit` quits (and snapshots the session);
- `/help` lists the commands; `/sessions` (alias `/resume`) lists the stored
  conversations and continues one, replaying its chunks into the live context;
- **ESC** or **Ctrl+C** cancels a running task — press twice to confirm — and quits
  when idle. Ctrl+C never kills a half-finished task by accident.

In the TUI every tool result is a **collapsible block**: one header line carrying
its `X char response` size, expanded with a click. The status bar keeps the token
meter pinned to its right edge, and new output only scrolls the view when you are
already at the bottom — scroll up to read history and the conversation stays put.

## Tools

Each tool takes an `intent` parameter: a short phrase saying **why** it is called.
The intent is printed next to the call *and* stored at the head of the result
chunk, so the reason is both visible and part of the model's context.

| Tool | What it does |
| ---------------- | ------------------------------------------------------------- |
| `read_file` | Pages a text file, with line numbers and offset |
| `write_file` | Creates or overwrites a file, verified byte-for-byte |
| `patch_file` | Applies a unified diff, cross-checked before writing |
| `blob` | Fetches several files at once (path, directory or glob) |
| `grep` | Searches contents with optional context lines and globs |
| `run_bash` | One allow-listed command (`ls`, `node`, `git`, …), no shell |
| `run_npm` | Allow-listed npm subcommands inside the project |
| `update_task` | Marks a `task.md` item done and resets the plan |
| `compact_context` | Reports the window, or requests a compaction |

## How it fits together

```
main.js                the host loop: front end, tools, sessions, commands
├── app/               conversation loop, context window, TUI, commands, picker
├── api/               provider call (streaming, retries, normalised responses)
├── config/            provider + budget constants, read from the environment
├── tools/             the auto-loaded agent tools
├── utils/             token accounting, compaction, sandbox, patch, sessions
├── docs/              the behavioural contract (see below)
└── tests/             executable proof that the code honours the docs
```

Requests flow one way: the host loop appends the prompt as a chunk, the
`ConversationManager` calls the provider, tool calls are executed and their results
become chunks, and the loop repeats until a tool-free reply arrives. Sessions are
snapshotted after every turn, so a stored context matches what the model saw —
compaction included.

## The three realms

The project is organised so behaviour cannot silently rot:

| Realm | Location | Role |
| ----- | ---------- | ------------------------------------------------------ |
| Code | `app/`, `api/`, `config/`, `tools/`, `utils/`, `main.js` | The ultimate truth: what the agent does |
| Docs | `docs/<domain>/<capability>/` | The behavioural contract: `behaviour.md` + `spec.yaml` |
| Tests | `tests/` | Executable proof, named after the capability it proves |

A behaviour is finished only when a spec under `docs/` describes it and a test
under `tests/` proves it; `tests/docs-realm.test.js` enforces the links, so a
missing spec, a dangling `path#symbol` reference or an unproven source module fails
the suite. Start with `docs/README.md` and `tests/README.md`.

## Development

```bash
npm test        # Node's built-in runner over tests/**/*.test.js
```

The suite is self-contained: it stubs the provider over local HTTP and fakes a TTY
with a `PassThrough` stream, so it needs no network and no pty. Ad-hoc exploration
scripts live in `agent/` (gitignored and disposable) and are deleted unless they
stay genuinely reusable; anything that must run on every change is a test instead.
