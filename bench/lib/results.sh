#!/usr/bin/env bash
# The run store: where a run's numbers live, and how two runs are compared.
#
# The layout is the one bench/README.md fixes:
#
#   results/index.jsonl          append-only, one line per run — the ledger
#   results/<run-id>/manifest.json         identity: plan, digests, revisions
#   results/<run-id>/config-snapshot.json  the knobs, with their sources
#   results/<run-id>/trials.jsonl          one record per instance attempt
#   results/<run-id>/report.{json,md}      aggregates, and the writeup
#   results/<run-id>/instances/<id>/attempt-N/…
#
# The ledger is what makes iteration cheap: comparing two runs reads two lines rather
# than two trees, and it survives a result directory being pruned to save space —
# which is why a run appends to it and never rewrites it.

results_dir() {
  printf '%s' "${BENCH_RESULTS_DIR:-$BENCH_DIR/results}"
}

ledger_path() {
  printf '%s/index.jsonl' "$(results_dir)"
}

# A run id that sorts by time and is unique without a random source: the ISO stamp is
# second-resolution, and two runs in one second (a smoke loop) would collide, so the
# label carries an ordinal when it has to.
new_run_id() {
  local stamp base candidate n=0
  stamp="$(date -u '+%Y-%m-%dT%H-%M-%SZ')"
  base="${1:-run}"
  candidate="$stamp"
  while [ -e "$(results_dir)/$candidate" ]; do
    n=$((n + 1))
    candidate="$stamp-$n"
  done
  printf '%s' "$candidate"
}

run_dir() {
  printf '%s/%s' "$(results_dir)" "$1"
}

require_run() {
  local id="$1"
  [ -n "$id" ] || die "a run id is required"
  [ -f "$(run_dir "$id")/manifest.json" ] \
    || die "no run '$id' in $(results_dir)
       list them with: moncho-cli bench report"
}

# ---------------------------------------------------------------------------
# The manifest and the snapshot
# ---------------------------------------------------------------------------
# Written before the first rollout. Together with plan.json it is what makes a result
# reproducible: the identity of everything that could have moved a number.
write_manifest() {
  local id="$1" dir plan_hash snapshot_hash
  dir="$(run_dir "$id")"
  mkdir -p "$dir/instances"
  plan_hash="$(bench_hash "$BENCH_DIR/plan.json")"
  snapshot_hash="$(bench_hash "$dir/config-snapshot.json")"

  local file
  file="$(mktemp)"
  json_open "$file"
  json_key "$file" "run_id" "$(json_string "$id")"
  json_key "$file" "bench_name" "$(json_string "$BENCH_NAME")"
  json_key "$file" "bench_kind" "$(json_string "$BENCH_KIND")"
  json_key "$file" "created_at" "$(json_string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"

  # Identity: everything that would make a later reader unsure what ran.
  json_key "$file" "agent_ref" "$(json_string "$AGENT_REF")"
  json_key "$file" "agent_payload_sha256" "$(json_string "$(agent_payload_digest 2>/dev/null || printf '')")"
  json_key "$file" "framework_version" "$(json_string "$(bench_version)")"
  json_key "$file" "framework_rev" "$(json_string "$(framework_rev)")"
  json_key "$file" "node_version" "$(json_string "$NODE_VERSION")"
  json_key "$file" "host_tz" "$(json_string "${TZ:-}")"
  json_key "$file" "host_uname" "$(json_string "$(uname -sm 2>/dev/null || printf '')")"

  # The two hashes that tie this run to the plan it was meant to follow.
  json_key "$file" "plan_sha256" "$(json_string "$plan_hash")"
  json_key "$file" "config_snapshot_sha256" "$(json_string "$snapshot_hash")"

  # The bench as configured, so the manifest stands alone.
  json_key "$file" "turns" "$(json_int "$TURNS")"
  json_key "$file" "stall_cycles" "$(json_int "$STALL_CYCLES")"
  json_key "$file" "agent_timeout" "$(json_int "$AGENT_TIMEOUT")"
  json_key "$file" "runs" "$(json_int "$RUNS")"
  json_key "$file" "model" "$(json_string "$(env_value OPENAI_MODEL)")"
  json_key "$file" "provider_host" "$(json_string "$(provider_host)")"

  json_close "$file" > "$dir/manifest.json"
  rm -f "$file"
}

# The provider's host only — never the full URL, which can carry a query token, and
# never the key. A report that leaked a key to be reproducible would be a bad trade.
provider_host() {
  local url
  url="$(env_value OPENAI_BASE_URL)"
  [ -n "$url" ] || { printf ''; return 0; }
  printf '%s' "$url" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##'
}

# Append one line to the ledger. This is the only write that is never rewritten: a
# later `report` over the whole history reads these lines and nothing else.
append_ledger() {
  local id="$1" dir line
  dir="$(run_dir "$id")"
  mkdir -p "$(results_dir)"
  line="$(mktemp)"
  json_open "$line"
  json_key "$line" "run_id" "$(json_string "$id")"
  json_key "$line" "at" "$(json_string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
  json_key "$line" "bench_name" "$(json_string "$BENCH_NAME")"
  json_key "$line" "agent_ref" "$(json_string "$AGENT_REF")"
  json_key "$line" "model" "$(json_string "$(env_value OPENAI_MODEL)")"
  json_key "$line" "turns" "$(json_int "$TURNS")"
  json_key "$line" "config_snapshot_sha256" "$(json_string "$(bench_hash "$dir/config-snapshot.json")")"
  # The outcome fields are filled by `report`, which is when they are known. A run
  # that has not been graded yet carries nulls, which `json_number` produces from an
  # empty string — "not measured" stays distinguishable from "measured zero".
  json_key "$line" "resolved" "$(json_number "$(report_field resolved)")"
  json_key "$line" "attempted" "$(json_number "$(report_field attempted)")"
  json_key "$line" "pass_at_1" "$(json_number "$(report_field pass_at_1)")"
  json_key "$line" "no_patch" "$(json_number "$(report_field no_patch)")"
  json_key "$line" "stalled" "$(json_number "$(report_field stalled)")"
  json_key "$line" "tokens_total" "$(json_number "$(report_field tokens_total)")"
  json_key "$line" "wall_clock_s" "$(json_number "$(report_field wall_clock_s)")"
  printf '%s\n' "$(json_close "$line" | tr -d '\n' | sed 's/  */ /g')" >> "$(ledger_path)"
  rm -f "$line"
}

# One scalar from this run's report.json, or empty. Deliberately a grep rather than a
# JSON parse: the value is written by `report` in a flat block, and a shell framework
# should not grow a parser to read its own file.
report_field() {
  local key="$1" file
  file="$(run_dir "${RUN_ID:-}")/report.json"
  [ -f "$file" ] || return 0
  sed -nE "s/^[[:space:]]*\"${key}\":[[:space:]]*([^,]+),?[[:space:]]*$/\1/p" "$file" \
    | head -n 1 | tr -d '"'
}

# Every run in the ledger, oldest first, as `<run-id>` lines. Reads the directory
# rather than the ledger when the ledger is missing, so a hand-copied result tree
# still lists.
list_runs() {
  local dir
  dir="$(results_dir)"
  [ -d "$dir" ] || return 0
  local entry
  for entry in "$dir"/*/; do
    [ -d "$entry" ] || continue
    [ -f "$entry/manifest.json" ] || continue
    basename "$entry"
  done | sort
}

# The newest run id, or empty.
latest_run() {
  list_runs | tail -n 1
}

# ---------------------------------------------------------------------------
# Comparability
# ---------------------------------------------------------------------------
# Two runs are comparable when their *controlled* variables match. This is the guard
# that stops a confounded difference being read as a finding — the whole reason the
# snapshot exists. It reports the first difference it finds rather than a boolean, so
# a refusal can say what to fix.
#
# A knob an experiment is *supposed* to move is not a control, so it is absent from
# the list. `compare` reports those as the difference under test instead.
comparability_diff() {
  local a="$1" b="$2" knob va vb
  for knob in $COMPARABILITY_KNOBS; do
    [ -n "$knob" ] || continue
    va="$(snapshot_value "$a" "$knob")"
    vb="$(snapshot_value "$b" "$knob")"
    if [ "$va" != "$vb" ]; then
      printf '%s\t%s\t%s' "$knob" "$va" "$vb"
      return 0
    fi
  done
  return 1
}

# The `effective` value of one knob in one run's snapshot.
#
snapshot_value() {
  local run="$1" knob="$2" file
  file="$(run_dir "$run")/config-snapshot.json"
  [ -f "$file" ] || return 0
  # The snapshot is pretty-printed with a fixed shape, so the knob's block is followed
  # rather than parsed. Two details are load-bearing:
  #
  #  * the member line is matched at ANY depth, because `agent_env` and `bench_knobs`
  #    are nested objects and their keys are indented beneath their parent;
  #  * the current key is tracked and reset on every member line. A secret block has no
  #    `effective` field at all, so a reader that only ever set `inside = 1` would keep
  #    scanning past it and report the *next* knob's value as the secret's.
  awk -v want="$knob" '
    {
      if (match($0, /"[A-Z_0-9]+": \{/)) {
        key = substr($0, RSTART + 1, RLENGTH - 1)
        sub(/"[[:space:]]*:[[:space:]]*\{$/, "", key)
        current = key
        next
      }
      if (current == want && /"effective":/) {
        line = $0
        sub(/^[^:]*:[[:space:]]*/, "", line)
        sub(/,[[:space:]]*$/, "", line)
        gsub(/^"|"$/, "", line)
        print line
        exit
      }
    }
  ' "$file"
}

# Did a knob differ between two runs, and was it a feature rather than a control?
# Prints the changed knob names, one per line — the variables actually under test.
#
# It always succeeds. The last iteration of the loop is normally a knob that did NOT
# change, so the loop's own exit status is 1 — and under `set -e` that killed the
# caller mid-comparison, producing no output at all rather than a comparison.
variable_diff() {
  local a="$1" b="$2" knob va vb
  while IFS= read -r knob; do
    [ -n "$knob" ] || continue
    case " $COMPARABILITY_KNOBS " in
      *" $knob "*) continue ;;
    esac
    va="$(snapshot_value "$a" "$knob")"
    vb="$(snapshot_value "$b" "$knob")"
    if [ "$va" != "$vb" ]; then printf '%s\t%s\t%s\n' "$knob" "$va" "$vb"; fi
  done <<EOF
$(snapshot_knob_names "$a")
EOF
  return 0
}

# Every knob name in a run's snapshot, in file order.
#
# Any indentation: the two knob groups are nested, so their members sit at eight
# spaces rather than the four a top-level key uses.
snapshot_knob_names() {
  local file
  file="$(run_dir "$1")/config-snapshot.json"
  [ -f "$file" ] || return 0
  sed -nE 's/^[[:space:]]*"([A-Z_0-9]+)": \{$/\1/p' "$file"
}
