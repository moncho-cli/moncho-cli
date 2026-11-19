#!/usr/bin/env bash
# Shared plumbing for bin/moncho-cli.
#
# Sourced by the entry point, never executed: the entry point owns argument parsing
# and the exit code, this file owns the one constant every other file needs, the
# logger, and the digest used for container names and image fingerprints.
#
# Everything here must survive `set -euo pipefail` from the caller.

# The installed payload. Overridable on purpose: `MONCHO_HOME=. bin/moncho-cli
# build --base` bakes the agent image straight from a checkout, with nothing staged.
MONCHO_HOME="${MONCHO_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/moncho-cli}"

# How the agent is delivered: every Monchofile opens with `FROM moncho-agent…` and
# the generated Dockerfile rewrites that line to the tag actually installed
# (distributing.md 9/D1). One name, spelled once.
BASE_IMAGE_NAME="moncho-agent"

log() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# The version the payload was staged at, or `dev` when it was never staged — which
# is what makes a checkout usable without an installer run.
moncho_version() {
  local file="$MONCHO_HOME/VERSION"
  if [ -f "$file" ]; then
    tr -d '[:space:]' < "$file"
  else
    printf 'dev'
  fi
}

# A stream digest with whatever the host provides (coreutils, then perl, then
# POSIX): the runner may not assume sha256sum is installed, and a weaker digest
# used consistently is still a correct fingerprint.
digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else
    cksum
  fi
}

# A short digest of a literal string, or of a file when the argument names one.
moncho_hash() {
  local input="${1:-}"
  if [ -n "$input" ] && [ -f "$input" ]; then
    digest < "$input" | cut -c1-16
  else
    printf '%s' "$input" | digest | cut -c1-16
  fi
}

# Everything this session is scoped to: the project as $PWD resolves, and the
# names derived from it. One function, so no two commands can disagree about which
# container belongs to which directory.
resolve_workspace() {
  WORKSPACE="$(pwd -P)"
  WORKSPACE_HASH="$(moncho_hash "$WORKSPACE")"
  CONTAINER_NAME="moncho-$WORKSPACE_HASH"
  PROJECT_IMAGE="moncho-project:$WORKSPACE_HASH"
  STATE_VOLUME="moncho-state-$WORKSPACE_HASH"
  MONCHO_DIR="$WORKSPACE/.moncho"
  BASE_IMAGE="$BASE_IMAGE_NAME:$(moncho_version)"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (is it running?)"
}

# The container is found by label, not by a state file: `.moncho/container.json` is
# a convenience a user may delete, the label is what docker itself remembers.
container_exists() {
  [ -n "$(docker ps -aq --filter "label=moncho.workspace=$WORKSPACE" 2>/dev/null)" ]
}

container_running() {
  [ -n "$(docker ps -q --filter "label=moncho.workspace=$WORKSPACE" 2>/dev/null)" ]
}
