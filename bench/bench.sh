#!/usr/bin/env bash
#
# moncho-cli bench — measure an agent, reproducibly, in a directory you own.
#
#   moncho-cli bench init --kind swe --name swe-lite
#   moncho-cli bench build && moncho-cli bench select && moncho-cli bench run && moncho-cli bench grade
#
# The lifecycle is the one the project already teaches: the directory you stand in is
# the thing you are working on, and every name — the image, the results, the labels —
# is derived from it. The layer on top is the one a benchmark needs and a general
# runner has no reason to provide: a run is an *experiment*, so its configuration is
# declared before it happens and recorded beside its results.
#
# Reference: bench/README.md (the contract this implements).

set -euo pipefail

# The installer links this script into ~/.local/bin, so `dirname` of the path we were
# *reached* by points at the link, not at the framework. Resolve the chain first —
# the same reason bin/moncho-cli does it.
ENTRY_SOURCE="${BASH_SOURCE[0]}"
while [ -L "$ENTRY_SOURCE" ]; do
  ENTRY_DIR="$(cd "$(dirname "$ENTRY_SOURCE")" && pwd -P)"
  ENTRY_SOURCE="$(readlink "$ENTRY_SOURCE")"
  case "$ENTRY_SOURCE" in
    /*) ;;
    *) ENTRY_SOURCE="$ENTRY_DIR/$ENTRY_SOURCE" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$ENTRY_SOURCE")" && pwd -P)"

# ---------------------------------------------------------------------------
# Defaults, then the libraries
# ---------------------------------------------------------------------------
COMMAND=""
BENCH_DIR_ARG=""
KIND_ARG=""
NAME_ARG=""
JSON="0"
INSTANCES_ARG=""
CLEAN_IMAGES="0"
ASSUME_YES="0"
FORCE="0"
COMPARE_ARGS=()

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/json.sh
. "$SCRIPT_DIR/lib/json.sh"
# shellcheck source=lib/config.sh
. "$SCRIPT_DIR/lib/config.sh"
# shellcheck source=lib/results.sh
. "$SCRIPT_DIR/lib/results.sh"
# shellcheck source=lib/commands.sh
. "$SCRIPT_DIR/lib/commands.sh"

usage() {
  cat <<'EOF'
Usage: moncho-cli bench <command> [options]

Commands:
  init          make a bench in this directory (writes Benchfile + .env.bench)
  status        what this bench is, and where its last run got to
  explain       the resolved recipe: the exact command a run would use
  build         prepare the payload, the node runtime and the instance images
  select        draw the subset and freeze plan.json
  run           roll the agent out over the selected instances
  grade         run the official harness over the produced patches
  report        resolved, pass@1, cost, and the reason for every miss
  compare       two runs side by side, with the comparability guard
  shell         a shell in this bench's instance image
  clean         drop derived data (--images also drops the pulls)
  versions      list the installed framework revisions
  help          this text

Options:
  --bench <dir>      use this bench instead of the current directory
  --kind <name>      with init: which kind to make (default: swe)
  --name <name>      with init: the bench's name (default: the directory's)
  --instances <list> with run: a comma-separated instance-id subset
  --json             with status/explain/report/compare: machine-readable output
  --images           with clean: also remove the pulled instance images
  --force            with init: write into a directory that already has a Benchfile
  --yes, -y          take the default instead of asking
  -h, --help         this text

Environment:
  MONCHO_BENCH_HOME  where the framework is installed (default ~/.config/moncho-bench);
                     MONCHO_BENCH_HOME=. uses this checkout, so no install is needed
  BENCH_RESULTS_DIR  write this bench's results somewhere else (a sweep, a volume)

A bench is a directory: Benchfile (committed, no secrets), .env.bench (gitignored,
holds the provider and the key), plan.json (frozen before the first rollout) and
results/ (the ledger and every trial). Two benches never share state.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      init|status|explain|build|select|run|grade|report|compare|shell|clean|versions|help)
        COMMAND="$1"; shift ;;
      --bench) [ $# -ge 2 ] || die "--bench needs a path"; BENCH_DIR_ARG="$2"; shift 2 ;;
      --bench=*) BENCH_DIR_ARG="${1#--bench=}"; shift ;;
      --kind) [ $# -ge 2 ] || die "--kind needs a name"; KIND_ARG="$2"; shift 2 ;;
      --kind=*) KIND_ARG="${1#--kind=}"; shift ;;
      --name) [ $# -ge 2 ] || die "--name needs a value"; NAME_ARG="$2"; shift 2 ;;
      --name=*) NAME_ARG="${1#--name=}"; shift ;;
      --instances) [ $# -ge 2 ] || die "--instances needs a list"; INSTANCES_ARG="$2"; shift 2 ;;
      --instances=*) INSTANCES_ARG="${1#--instances=}"; shift ;;
      --json) JSON="1"; shift ;;
      --images) CLEAN_IMAGES="1"; shift ;;
      --force) FORCE="1"; shift ;;
      --yes|-y) ASSUME_YES="1"; shift ;;
      -h|--help) COMMAND="help"; shift ;;
      # `compare` takes two positional run ids and an optional flag; everything else
      # is an error, so a typo can never be silently treated as a run id.
      -*) die "unknown argument '$1' (try 'moncho-cli bench help')" ;;
      *)
        if [ "$COMMAND" = "compare" ]; then COMPARE_ARGS+=("$1"); shift
        else die "unexpected argument '$1' (try 'moncho-cli bench help')"
        fi
        ;;
    esac
  done
}

main() {
  parse_args "$@"
  [ -n "$COMMAND" ] || COMMAND="status"
  [ "$COMMAND" = "help" ] && { usage; return 0; }

  # `versions` answers a question about the installation, so it needs no bench — the
  # same reason `moncho-cli status` deliberately skips the repository gate.
  if [ "$COMMAND" = "versions" ]; then
    command_versions
    return 0
  fi

  resolve_bench

  # `init` is the one command that runs *without* a Benchfile: it is what writes one.
  if [ "$COMMAND" = "init" ]; then
    command_init
    return 0
  fi

  require_bench
  load_benchfile
  load_bench_env

  # The kind's implementation, sourced once its Benchfile has said which one it is.
  # Every `kind_*` function the dispatcher calls below is defined there, so a missing
  # kind is a refusal from `require_kind` rather than a "command not found" later.
  require_kind
  # shellcheck source=/dev/null
  . "$(kind_dir "$BENCH_KIND")/kind.sh"

  case "$COMMAND" in
    status)   command_status ;;
    explain)  command_explain ;;
    build)    require_docker; kind_build ;;
    select)   kind_select ;;
    run)      require_docker; kind_run ;;
    grade)    require_docker; kind_grade ;;
    report)   kind_report ;;
    compare)  command_compare "${COMPARE_ARGS[@]+"${COMPARE_ARGS[@]}"}" ;;
    shell)    require_docker; kind_shell ;;
    clean)    command_clean ;;
    *)        die "unknown command '$COMMAND'" ;;
  esac
}

main "$@"
