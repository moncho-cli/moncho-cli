#!/usr/bin/env bash
# The env-file rule (distributing.md 6.2): exactly one file, and only the one the
# user named. Nothing here ever looks at a generic `.env`, which is the whole point
# of the rule — a project's own credentials do not become the agent's provider.
#
# The file is *sourced*, not parsed (9/D3): `set -a` makes every assignment an
# export, so `KEY=value`, `export KEY=value`, quoting, comments and escapes all
# behave the way a shell user already expects, exactly as start.sh behaves today.
#
# What crosses into the container is `-e NAME`, never `-e NAME=value`: docker reads
# the value out of this process's environment, so a key never appears in the host
# process list.

ENV_FILE=""
ENV_NAMES=""
ENV_FLAGS=()

# Which file, if any, is read: --env wins, then $WORKSPACE/.env.moncho, else none.
resolve_env_file() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then
    [ -r "$explicit" ] || die "the file given to --env cannot be read: $explicit"
    ENV_FILE="$explicit"
    return 0
  fi
  if [ -r "$WORKSPACE/.env.moncho" ]; then
    ENV_FILE="$WORKSPACE/.env.moncho"
    return 0
  fi
  ENV_FILE=""
}

# Source the resolved file (if there is one) and remember which names it defines.
# A relative --env path is resolved once, against the project directory.
load_env_file() {
  [ -n "$ENV_FILE" ] || return 0
  local absolute
  absolute="$(cd "$(dirname "$ENV_FILE")" && pwd -P)/$(basename "$ENV_FILE")"
  set -a
  # shellcheck disable=SC1090
  . "$absolute"
  set +a
  ENV_FILE="$absolute"
  ENV_NAMES="$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$absolute" \
    | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//' | cut -d= -f1 | sort -u)"
}

# The `-e NAME` flags, built once so every command passes the same set. A name the
# file mentions but this shell does not export is simply not set in the container,
# which is docker's own behaviour for a bare `-e`.
build_env_flags() {
  ENV_FLAGS=()
  local name
  for name in $ENV_NAMES; do
    ENV_FLAGS+=(-e "$name")
  done
}
