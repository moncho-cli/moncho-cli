# Privacy

What Moncho sends, what it stores, and where. Every claim here is a property of the code
in this repository; where the answer depends on a third party, this document says so
instead of guessing.

## The short version

- The only network traffic is to the provider you configure. There is no telemetry, no
  analytics, no crash reporting and no update check. The one exception is deliberate and
  visible: when the agent uses `web_fetch`, the URL it fetches is a request to that site.
- The conversation is sent to that provider. That is how a model call works.
- Everything else stays on your machine: sessions, the tracking files, the operational
  log, and the workspace itself.
- The provider's key is read from the environment. It is never written to a session, a
  log line or a tracking file.

## What leaves the machine

Four calls, the first two always to the base URL in `OPENAI_BASE_URL`:

| Call | When | What it carries |
| ---- | ---- | --------------- |
| The chat completion | Every turn | The system prompt, the conversation so far, and the tool definitions |
| The context-length probe | At startup | A request for the model's metadata, not the conversation |
| A `web_fetch` GET | Only when the agent calls the tool | The URL, and the headers `utils/web-fetch.js` sends — no conversation, no key, no local file |
| A `web_search` GET | Only when the agent calls the tool | The query, and the key `WEB_SEARCH_API_KEY` when one is configured — no conversation, no local file |

The first two happen by existing. The third and fourth happen because the agent *chose* to
retrieve a URL — `web_fetch` reads one it was given, `web_search` finds the ones worth
reading — and the user sees each call in the transcript. Nothing else is fetched. `scripts/install.sh` downloads the release tarball once, from
the repository named in `MONCHO_REPO`; that request happens at install time and not
again. The agent does not check for updates.

### What the conversation carries

The context sent to the provider is what the agent knows at that moment:

- The system prompt, which is `config/prompt.md` in this repository.
- The conversation: your prompts, the model's answers, and the results of the tools it
  ran. A tool result is the file it read, the command output it received, or the diff it
  applied — so **whatever the agent read is sent to the provider**. A secret in a file
  the agent opens is a secret in the request.
- The tool definitions, which are the schemas in `tools/`.

A `web_fetch` result is part of the conversation too: **whatever the agent fetched is sent
to the provider on the next turn**. A page pulled from a URL the agent chose is a page the
provider then reads. The same holds for a `web_search` result: the titles, URLs and snippets
it returns travel to the provider with the next turn.

The agent reads what its tools are asked to read. It does not crawl the workspace. If a
file should never leave the machine, do not let the agent read it.

### What the provider does with it

That is the provider's policy, not this repository's. OpenRouter, OpenAI and a local
Ollama instance have different terms, and a local Ollama sends nothing anywhere. Read the
policy of the provider you configure before pointing the agent at a repository with
material you would not send to that provider.

## What stays on the machine

| What | Where | Contains |
| ---- | ----- | -------- |
| Sessions | The state volume, or `agent/sessions/` | The conversation, the mode, the usage table |
| Tracking files | The state volume, or `agent/` | `task.md` and `implementation_plan.md` |
| Operational log | `agent/logs/` | Events: a retry, a failed tool, a failed save |
| The workspace | Your directory | Whatever the agent wrote |

The state volume is per-project and named after the workspace path. It is not shared
between projects, and it is not uploaded anywhere. `--state-in-repo` puts the same files
in `./agent` instead, which is excluded through `.git/info/exclude` so they do not end up
in a commit.

### The volume is the boundary

The container's workspace is bind-mounted, so what the agent writes lands in your checkout.
The state directory is the exception: in the default `volume` mode `/app/agent` is a named
Docker volume, so sessions, the tracking files and the log stay in Docker's storage and your
checkout never sees a file. Two things move data out of that boundary, and both are choices
you make explicitly:

- **`--state-in-repo`** mounts `./agent` into the checkout on purpose, so the same files sit
  in your directory instead of the volume.
- **`--sync-files`** copies `/app` back into your checkout when the run ends. The copy
  excludes `agent/`, so even then the state does not travel — but the flag is a copy of the
  workspace, and the workspace is what the agent wrote.

The maintainer's own loop (`./start.sh`) is the exception to the exception: it runs this
repository's checkout, where the operator is the maintainer, and its `MONCHO_MAINTAINER=1`
lifts the host fence so a hook in their own repository is their tool rather than an
injection (`docs/agent/host-fence`). The read-only shadow mounts are unchanged — they belong
to the user flow.

### What the log does not contain

The operational log records what the *harness* did — a provider call that was retried, a
tool that threw, a session that failed to save. It does not record the conversation, the
model's text, or the provider key. It is a diagnostic aid, and it is written to a local
file.

### The key

`OPENAI_API_KEY` is read from the environment. It is used to build the `Authorization`
header of the provider request. It is never written to a session file, a log line or a
tracking file, and it is not included in the context sent to the model.

The runner passes it to the container as an environment variable by name, not by value,
so it does not appear in the host process list. A `.env.moncho` file that holds it is
sourced on the host; keep that file out of version control — it is ignored by default.

## Choices you control

| Choice | Effect |
| ------ | ------ |
| The provider | A local Ollama keeps the conversation on your machine |
| The model | A provider's model may have different retention than another's |
| The workspace | The agent reads only what its tools are asked to read |
| `web_fetch` | A `Chat` session may fetch; the tool is a reader, one GET, and it writes nothing |
| `web_search` | A `Chat` session may search; the tool is a reader, one GET, and it writes nothing |
| `--state-in-repo` | Keeps the state in the repository instead of a volume |
| The tracking files | `task.md` and the plan are prose you wrote and the agent updated |

## What is not collected

- No usage analytics. The usage table in a session is local, and it exists so `/usage`
  can show you your own spend.
- No identifiers. There is no install id, no device id and no session id sent anywhere.
- No crash reports. A failure is written to the local log and shown in the transcript.
- No cookies, no tracking pixels, no third-party scripts. The interface is a terminal.

## Deleting what is stored

```bash
rm -rf agent/sessions agent/logs        # or the state volume, for a container install
docker volume rm <the volume name>      # listed by `moncho-cli status`
```

Removing the workspace's `.git/info/exclude` lines and the `agent/` directory leaves no
trace of the agent in the repository. The provider's copy is governed by the provider's
policy, and this repository cannot delete it for you.

## Questions

The behaviour described here is implemented in `api/ollama.js` (the provider calls),
`utils/web-fetch.js` (the outbound GET), `utils/web-search.js` (the search provider seam),
`utils/session-store.js` (what a session holds), `utils/logger.js` (what the log holds)
and `bin/lib/env.sh` (how the key reaches the container). If a change makes one of those
statements false, the document and the code are both wrong until they agree.
