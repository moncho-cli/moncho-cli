#!/usr/bin/env bash
# Shared plumbing for the bench framework.
#
# Sourced by bench.sh, never executed. It owns the one thing every command needs:
# where the framework is, where the bench is, and the names derived from the bench
# directory. Everything here must survive `set -euo pipefail` from the caller.
#
# The shape mirrors bin/lib/common.sh deliberately: the two entry points are used by
# the same people, so a resolution rule or a logger that behaved differently between
# them would be a trap rather than a feature.

# The staged framework. `MONCHO_BENCH_HOME=. bench/bench.sh …` runs a checkout with
# nothing installed, which is how this framework is developed and probed.
MONCHO_BENCH_HOME="${MONCHO_BENCH_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/moncho-bench}"

log() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Progress from a function that also *returns* a value.
#
# `log` writes to stdout, which is two different channels at once: the prose a command
# shows the user, and the one place `$(...)` captures a value. A function that did both
# would hand its caller its own progress notes as part of the value — `cache="$(fetch)"`
# would set `cache` to "Fetching …\n/path/to/cache", and the failure would surface far
# away, as a missing file with a message for a name.
#
# So the split is: a command's own prose goes through `log` on stdout, and a *value*
# function says what it is doing through `note` on stderr, keeping stdout for the one
# thing it returns. This is why `warn` and `die` were already on stderr.
note() { printf '%s\n' "$*" >&2; }

# A stream digest with whatever the host provides: the same three-way fallback the
# agent's runner uses, because a weaker digest used consistently is still a correct
# fingerprint and `sha256sum` is not on every host.
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
bench_hash() {
  local input="${1:-}"
  if [ -n "$input" ] && [ -f "$input" ]; then
    digest < "$input" | cut -c1-16
  else
    printf '%s' "$input" | digest | cut -c1-16
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (is it running?)"
}

# ---------------------------------------------------------------------------
# The staged framework's version, the same idea as the agent's
# ---------------------------------------------------------------------------
# `$MONCHO_BENCH_HOME/VERSION` is written by the installer. A checkout has none, and
# answers `dev` — which is what makes the framework runnable before it is installed.

bench_version() {
  local file="$MONCHO_BENCH_HOME/VERSION"
  if [ -f "$file" ]; then
    tr -d '[:space:]' < "$file"
  else
    printf 'dev'
  fi
}

bench_versions() {
  local dir="$MONCHO_BENCH_HOME/versions"
  [ -d "$dir" ] || return 0
  ls -1 "$dir" 2>/dev/null | sort -Vr
}

bench_latest_version() {
  local versions
  versions="$(bench_versions)"
  if [ -n "$versions" ]; then
    printf '%s\n' "$versions" | head -n 1
  else
    bench_version
  fi
}

# Where a kind's implementation lives: beside the framework that is running.
kind_dir() {
  printf '%s/kinds/%s' "$SCRIPT_DIR" "$1"
}

# Is this a directory a kind actually implements?
kind_exists() {
  [ -d "$(kind_dir "$1")" ] && [ -f "$(kind_dir "$1")/kind.sh" ]
}

kind_names() {
  local dir
  for dir in "$SCRIPT_DIR"/kinds/*/; do
    [ -d "$dir" ] || continue
    [ -f "$dir/kind.sh" ] || continue
    basename "$dir"
  done
}

# ---------------------------------------------------------------------------
# The bench directory: which one, and the names derived from it
# ---------------------------------------------------------------------------
# A bench is the directory you stand in — the same rule `moncho-cli` applies to a
# project, and for the same reason: the thing you are working on is the thing you are
# inside. `--bench <dir>` is the one override, for a script that drives several.
resolve_bench() {
  BENCH_DIR="$(cd "${BENCH_DIR_ARG:-$PWD}" && pwd -P)" \
    || die "cannot resolve the bench directory: ${BENCH_DIR_ARG:-$PWD}"
  BENCH_DIR_HASH="$(bench_hash "$BENCH_DIR")"
  BENCHFILE="$BENCH_DIR/Benchfile"
  BENCH_ENV_FILE="$BENCH_DIR/.env.bench"
}

bench_has_config() {
  [ -f "$BENCHFILE" ]
}

require_bench() {
  bench_has_config || die "no Benchfile in $BENCH_DIR
       make one here with: moncho-cli bench init --kind swe
       or point at an existing bench with: --bench <dir>"
}

# The Benchfile is *sourced*, exactly like .env.moncho, so quoting, comments and
# `export` behave the way a shell user already expects. It is configuration, not a
# parser's input: there is no second language to learn.
load_benchfile() {
  require_bench
  set -a
  # shellcheck disable=SC1090
  . "$BENCHFILE"
  set +a
  apply_bench_defaults
}

# The credentials file is optional: a bench with no provider configured can still
# build, select, inspect itself and grade a run it was given.
load_bench_env() {
  [ -f "$BENCH_ENV_FILE" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$BENCH_ENV_FILE"
  set +a
}

# Every default lives here and nowhere else, so `explain` and `run` cannot disagree
# about what an unset knob means.
apply_bench_defaults() {
  BENCH_KIND="${BENCH_KIND:-}"
  BENCH_NAME="${BENCH_NAME:-$(basename "$BENCH_DIR")}"
  AGENT_REF="${AGENT_REF:-main}"
  AGENT_MODE="${AGENT_MODE:-work}"
  TURNS="${TURNS:-1}"
  TURNS_FOLLOWUP="${TURNS_FOLLOWUP:-}"
  AGENT_TIMEOUT="${AGENT_TIMEOUT:-1800}"
  STALL_CYCLES="${STALL_CYCLES:-3}"
  SUBSET="${SUBSET:-lite}"
  STRATIFY="${STRATIFY:-repo}"
  SAMPLE="${SAMPLE:-40}"
  RUNS="${RUNS:-1}"
  GRADE_WORKERS="${GRADE_WORKERS:-8}"
  NODE_VERSION="${NODE_VERSION:-22.14.0}"
  BENCH_RESULTS_DIR="${BENCH_RESULTS_DIR:-$BENCH_DIR/results}"

  # The argument-parser's own variables, defaulted here as well.
  #
  # `bench.sh` declares them before it sources anything, so a normal run never notices.
  # But the kind libraries are also sourced on their own — by a probe, by a test — and
  # every script here runs under `set -u`, where reading an unset variable is a hard
  # error that takes the process down. `swe_run` reads INSTANCES_ARG on every run, so a
  # checkout that had not gone through the parser died on its first rollout with
  # "INSTANCES_ARG: unbound variable" — naming a variable the user never set and cannot
  # see, in place of the run it was supposed to perform.
  #
  # They live here rather than at each use site for the same reason every other default
  # does: one place to read, and `explain` and `run` cannot disagree about what unset means.
  JSON="${JSON:-0}"
  FORCE="${FORCE:-0}"
  INSTANCES_ARG="${INSTANCES_ARG:-}"
  HYPOTHESIS="${HYPOTHESIS:-}"
  CLEAN_IMAGES="${CLEAN_IMAGES:-0}"
  ASSUME_YES="${ASSUME_YES:-0}"
  BENCH_DIR_ARG="${BENCH_DIR_ARG:-}"
}

# The newest file with this name under this directory, or the empty string.
#
# Every caller wants a *best-effort* lookup — "the session's task.md, if the agent got far
# enough to write one" — and the obvious spelling is a trap. `find <dir> … | sort | tail -n 1`
# exits **1** when the directory does not exist, and under the `set -euo pipefail` every
# script here runs, an unguarded `x="$(find … | sort | tail -n 1)"` **aborts the whole
# process** rather than yielding an empty string. In a rollout that is a benchmark run
# dying on the very first cycle, before the agent has had a chance to create the directory
# the harness is looking in — and the trace points at a helper whose only job was to count
# something, which is a diagnosis nobody should have to make twice.
#
# The status is swallowed here, once, with the reason written down, instead of at each of
# the call sites where it would be easy to forget and invisible when forgotten.
newest_named_file() {
  local dir="$1" name="$2"
  shift 2
  [ -d "$dir" ] || return 0
  find "$dir" -name "$name" -type f "$@" 2>/dev/null | sort | tail -n 1 || true
}

require_kind() {
  [ -n "${BENCH_KIND:-}" ] || die "the Benchfile does not set BENCH_KIND (try: BENCH_KIND=\"swe\")"
  kind_exists "$BENCH_KIND" || die "unknown bench kind '$BENCH_KIND' (available: $(kind_names | tr '\n' ' '))"
}

# The framework's own revision, when it is a git checkout. Recorded in every manifest
# so a result can be tied to the code that produced it.
framework_rev() {
  local dir="$SCRIPT_DIR"
  if command -v git >/dev/null 2>&1 && git -C "$dir" rev-parse --short HEAD >/dev/null 2>&1; then
    git -C "$dir" rev-parse --short HEAD
  else
    bench_version
  fi
}
