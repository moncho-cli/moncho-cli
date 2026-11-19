# Liability

Moncho is free software under the MIT licence. It is provided as it is, with no
warranty of any kind, and the full text of the licence governs — this document explains
what that means in practice. It is not legal advice and it does not change the licence.

## What the licence says

[LICENSE](LICENSE) is the MIT licence. In short: you may use, copy, modify, merge,
publish, distribute, sublicense and sell copies of this software, provided the copyright
notice and the permission notice travel with it. The software is provided "as is",
without warranty of any kind, express or implied, and in no event shall the authors or
copyright holders be liable for any claim, damages or other liability arising from the
software or its use.

## What that means for an agent that edits your files

An agent runs commands and changes files. That is the point of it, and it is also the
reason this document exists. The practical consequences:

- **Review what it did.** Every write is a real change to a real file. The agent shows
  what it ran and what it changed; read it. Nothing here prevents you from reviewing a
  diff, and nothing here substitutes for reviewing one.
- **Keep a copy.** Run it in a git repository, on a branch, or both. A clean tree is the
  only reliable undo. The agent's own tracking files are not a backup.
- **Do not point it at what you cannot lose.** A directory with no version control, a
  production share, a secret store: none of those are a sensible workspace.
- **Credentials are yours.** The provider key you configure is your key. Usage is billed
  to your account by your provider, and the amount depends on the model and the length
  of the conversation.

## Limits the agent does not remove

The agent works inside a container and sandboxes its tools, but it is not a security
boundary between you and your own machine:

- The container mounts your workspace, and the agent runs as your uid inside it. Files
  it writes are owned by you on the host.
- The sandbox refuses paths outside the workspace and refuses shell metacharacters in a
  command, but a command it is allowed to run can still do whatever that command does.
- The model is a third party. Its output is not verified for correctness, and a wrong
  answer is a wrong answer even when it is confidently phrased.

Sandboxing reduces the blast radius of a mistake. It does not remove the need to look at
what happened.

## Model output

The agent sends your prompt and the conversation context to the provider you configure.
The provider's terms govern what happens to that data — see [PRIVACY.md](PRIVACY.md) for
what is sent and what stays local.

Nothing in this repository promises that a model's answer is correct, complete or fit
for a particular purpose. A change the agent proposes is a proposal, and it is yours
once you accept it.

## Third-party components

The runtime dependencies are `neo-blessed` and `diff`, both under their own licences.
`neo-blessed` draws the terminal interface; `diff` applies and cross-checks patches. The
container image is `node:22-alpine` plus a handful of Alpine packages. Each component
carries its own terms, and none of them are extended or restricted by this document.

## No support obligation

There is no support contract. Issues are read and answered on a best-effort basis.
Nothing in this repository creates an obligation to fix a defect, to keep a version
available, or to answer a question within any particular time.

## If you redistribute it

The MIT licence requires the copyright notice and the permission notice to travel with
the software. A fork or a repackaged build keeps [LICENSE](LICENSE) beside it. A fork
that changes behaviour is its own project: its maintainers are responsible for what it
does, not the authors of this one.
