#!/usr/bin/env bash
# The external-subcommand seam (docs/runtime/cli-subcommands).
#
# `moncho-cli <word> ...`, where <word> is not one of the commands this program implements,
# is a request for a **companion tool**: `moncho-<word>`, found on PATH. It is the same
# convention `git` and `cargo` use, and it is how a program that lives beside the agent — a
# bench, a dashboard, a site-specific tool — is reached as `moncho-cli <word> ...` without
# this program carrying a list of them.
#
# The seam is deliberately ignorant of what any companion is. The payload ships in every
# install, and one of those installs has `node main.js` as its entrypoint inside a
# container: a table of companion names here would be a list of capabilities the agent
# carries but does not own, and every entry would be a name to keep in step with something
# outside this repository. So the rule is stated in terms of *shape* — an unrecognised,
# non-flag first word — and never in terms of any particular tool.
#
# Sourced by bin/moncho-cli, never executed.

# The commands this program implements itself. Anything else that is not a flag is a
# companion. Kept as one string so the functions below cannot disagree about the set.
MONCHO_CLI_BUILTINS="run start stop shell build status uninstall help"

# Is the first word a request for a companion tool?
#
# A non-zero answer means "this program owns it": a flag, a known command, or no first word
# at all. Only the *first* word is examined, and parsing stops there by design —
# everything after it belongs to the companion, which is why `moncho-cli <word> --flag`
# never has its flags read here.
is_external_subcommand() {
  [ $# -gt 0 ] || return 1
  case "$1" in
    -*|'') return 1 ;;
  esac
  local name
  for name in $MONCHO_CLI_BUILTINS; do
    [ "$1" = "$name" ] && return 1
  done
  return 0
}

# The companion a first word names: `bench` -> `moncho-bench`.
external_subcommand_name() {
  printf 'moncho-%s' "$1"
}

# Resolve a companion to an executable path, or fail.
#
# `command -v` also answers for a file that exists but is not executable, and an `exec` of
# one fails with a message about permissions rather than about the tool — which sends a
# reader looking at the wrong thing. The executable bit is checked here instead, so the
# refusal that follows can say what is actually missing.
external_subcommand_path() {
  local path
  path="$(command -v "$1" 2>/dev/null || true)"
  [ -n "$path" ] && [ -x "$path" ] || return 1
  printf '%s' "$path"
}

# Hand the command line over to the companion, and become it.
#
# `exec` rather than a child process, for two reasons: the companion inherits this
# process's exit status instead of this program having to relay it, and no shell stays
# behind waiting on a tool whose output is a stream a user may be piping. The arguments
# are passed verbatim — this program has already stopped parsing, so nothing here can
# reinterpret a flag that belongs to the companion.
run_external_subcommand() {
  local word="${EXTERNAL_WORD:-}" name path
  name="$(external_subcommand_name "$word")"

  if ! path="$(external_subcommand_path "$name")"; then
    die "'$word' is not a command moncho-cli implements, and no companion '$name' was found on PATH

       A companion is a separate program installed as '$name'. If you meant to run it,
       check that it is installed and that its directory is on PATH.
       If '$word' was a typo, run 'moncho-cli help' for the commands this program has."
  fi

  exec "$path" ${EXTERNAL_ARGS[@]+"${EXTERNAL_ARGS[@]}"}
}
