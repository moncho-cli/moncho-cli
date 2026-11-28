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

# Every version installed here, newest first: **the root tree** when it was staged at a
# version (`$MONCHO_HOME/VERSION`), plus every ref under `versions/`. Empty for a bare
# checkout, which has one version and no staged tree: the one it is.
#
# The root tree belongs in this list. It is where the installer stages the first version,
# and a later `versions/<ref>` does not replace it — leave it out and installing an *older*
# ref beside a newer root would make the older one look newest
# (`moncho_latest_version`). The order is the same `sort -Vr` the installer links by
# (`scripts/install.sh#link_binary`), so the link and the default run cannot disagree.
moncho_versions() {
  local dir="$MONCHO_HOME/versions"
  {
    # `moncho_version()` strips its own trailing newline (`tr -d '[:space:]'`), so the
    # newline has to be put back here or the root ref would run into the first `ls` entry
    # and produce a single bogus name like `v0.20.0v0.21.0`.
    if [ -f "$MONCHO_HOME/VERSION" ]; then printf '%s\n' "$(moncho_version)"; fi
    if [ -d "$dir" ]; then ls -1 "$dir" 2>/dev/null; fi
  } | sort -Vr
}

# The newest installed version: what /upgrade moves a session towards, and what a plain
# `moncho-cli` runs when --version names nothing.
moncho_latest_version() {
  local versions
  versions="$(moncho_versions)"
  if [ -n "$versions" ]; then
    printf '%s\n' "$versions" | head -n 1
  else
    moncho_version
  fi
}

# The version this run uses: --version when given, else the newest installed.
resolve_version() {
  if [ -n "${VERSION_ARG:-}" ]; then
    case " $(moncho_versions | tr '\n' ' ') " in
      *" $VERSION_ARG "*) ;;
      *) [ "$VERSION_ARG" = "$(moncho_version)" ] || die "version $VERSION_ARG is not installed (try: moncho-cli versions)" ;;
    esac
    printf '%s' "$VERSION_ARG"
  else
    moncho_latest_version
  fi
}

# The payload tree a version runs from, or empty when none is installed for it.
#
# A version staged by the first install lives at the root (`$MONCHO_HOME/VERSION`); every
# later ref gets a tree of its own under `versions/`, because a session is pinned to the
# version that wrote it and replacing the older tree would make its sessions unopenable
# (`docs/runtime/session-version`). So `--version <ref>` is not just a name to print — it
# decides *which files* are built into the image and mounted at /opt/moncho-cli. Returning
# the root for a ref it does not carry keeps a checkout (`MONCHO_HOME=.`, no VERSION) working
# the way it always did.
moncho_payload_dir() {
  local want="${1:-}" target
  target="$MONCHO_HOME/versions/$want"
  if [ -n "$want" ] && [ -f "$target/main.js" ]; then
    printf '%s' "$target"
    return 0
  fi
  printf '%s' "$MONCHO_HOME"
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
  # The watcher that picks a selection up from the workspace and puts it on the host
  # clipboard (bin/lib/clipboard-watch.sh). Its pid lives with the rest of the runner's
  # bookkeeping, so a later `stop` finds the watcher this session's `start` left running.
  WATCH_PIDFILE="$MONCHO_DIR/clipboard-watch.pid"
  # The version this run uses, and the image that carries it. The tag is derived from the
  # *resolved* version rather than a fixed name: a fixed tag plus a moving default would
  # run the newest code on the oldest baked dependencies, with nothing reporting it.
  RUN_VERSION="$(resolve_version)"
  LATEST_VERSION="$(moncho_latest_version)"
  BASE_IMAGE="$BASE_IMAGE_NAME:$RUN_VERSION"
  # The tree that version's code lives in, which is *not* always $MONCHO_HOME once a second
  # version is installed: the payload that is baked and mounted follows the version, or
  # `--version v0.38.0` would report the new version while running the old tree's files.
  PAYLOAD_DIR="$(moncho_payload_dir "$RUN_VERSION")"
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
