#!/usr/bin/env bash
# `grade` and `report`: the official verdict, then the writeup.
#
# Grading is not reimplemented. `swebench.harness.run_evaluation` applies the test
# patch and runs FAIL_TO_PASS/PASS_TO_PASS inside the instance's own image, and a
# second implementation of that would produce numbers that are not comparable with
# anything published — which is the one thing a benchmark cannot afford.
#
# The harness is Python, so it runs in the official grader image rather than on the
# host: the host is promised curl, tar and docker, and adding a Python toolchain to it
# would be a second thing to install and pin.

SWE_GRADER_IMAGE="${SWE_GRADER_IMAGE:-python:3.11-slim}"
SWE_GRADER_PY="${SWE_GRADER_PY:-swebench==2.1.8}"

swe_predictions_file() {
  local run="${1:-${RUN_ID:-}}"
  printf '%s/%s.jsonl' "$(swe_pred_dir)" "$run"
}

swe_grade() {
  require_docker
  local run="${RUN_ID:-$(latest_run)}"
  [ -n "$run" ] || die "no run to grade in $(results_dir)"
  RUN_ID="$run"

  local predictions
  predictions="$(swe_predictions_file "$run")"
  [ -f "$predictions" ] || die "no predictions for $run
       ($predictions)
       a run that produced no patch at all has nothing to grade — that is a result,
       and 'moncho-cli bench report' already counts it."

  local count
  count="$(wc -l < "$predictions" | tr -d ' ')"
  log "Grading $count prediction(s) from $run with the official harness"
  log "  grader image: $SWE_GRADER_IMAGE ($SWE_GRADER_PY)"
  log "  this runs the real test suites and takes a while"

  local run_root
  run_root="$(run_dir "$run")"
  mkdir -p "$run_root/grading"

  # The dataset the run was measured against, not "the latest one": a grader that
  # fetched a newer dataset would silently change what the patches are checked
  # against, which is exactly the drift pre-registration exists to prevent.
  #
  # So a missing plan is a refusal, not a fallback. Grading against a guessed dataset
  # would produce a number that looks fine and answers a different question — and the
  # `sed` that read it would have said nothing beyond a stderr line nobody reads.
  local dataset split log_dir
  [ -f "$BENCH_DIR/plan.json" ] || die "no plan.json in $BENCH_DIR
       grading needs the dataset the run was measured against, and the plan is where it
       is recorded. Restore the plan, or grade a run from a bench that still has one."
  dataset="$(sed -nE 's/^[[:space:]]*"dataset":[[:space:]]*"([^"]+)".*/\1/p' "$BENCH_DIR/plan.json" | head -n 1)"
  split="$(sed -nE 's/^[[:space:]]*"subset":[[:space:]]*"([^"]+)".*/\1/p' "$BENCH_DIR/plan.json" | head -n 1)"
  case "$split" in
    dev) split='dev' ;;
    *)   split='test' ;;
  esac
  [ -n "$dataset" ] || die "the plan records no dataset; it is not a plan this can grade against"

  # The harness writes reports/<model>/<run-id>/<instance>.json. The volume is the
  # run's own grading directory, so a re-grade of the same run is reproducible and
  # never mixes with another run's output.
  local pred_dir
  pred_dir="$(cd "$(dirname "$predictions")" && pwd -P)"
  log_dir="$run_root/grading"
  log_dir="$(cd "$log_dir" && pwd -P)"

  if ! docker run --rm \
      -v "$pred_dir:/preds:ro" \
      -v "$log_dir:/logs" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "swebench-cache-$(bench_hash "$BENCH_NAME"):/root/.cache" \
      -e "DATASET=$dataset" \
      -e "SPLIT=$split" \
      -e "PRED=/preds/$(basename "$predictions")" \
      -e "WORKERS=$GRADE_WORKERS" \
      -e "RUN_ID=swe" \
      "$SWE_GRADER_IMAGE" bash -lc '
        set -e
        pip install --quiet --no-cache-dir swebench==2.1.8 || pip install --quiet --no-cache-dir swebench
        cd /logs
        python -m swebench.harness.run_evaluation \
          --dataset_name "$DATASET" \
          --split "$SPLIT" \
          --predictions_path "$PRED" \
          --max_workers "$WORKERS" \
          --run_id "$RUN_ID" \
          --report_dir /logs
      ' 2>&1 | tee "$log_dir/grade.log"; then
    warn "the grader exited non-zero; read $log_dir/grade.log"
  fi

  local report_json
  # Best-effort by construction, and this one matters most: the harness writing nothing is
  # an ordinary outcome of a failed grading run, and it must reach the `-z` branch below
  # and say so — not abort the script through an unguarded `find` pipeline.
  report_json="$(newest_named_file "$log_dir" '*.json' ! -name 'grade.json')"
  if [ -z "$report_json" ]; then
    warn "the harness produced no report JSON; grading did not complete"
    warn "the log is at $log_dir/grade.log"
    return 1
  fi

  cp "$report_json" "$run_root/grading/report-source.json"
  swe_merge_grades "$run" "$report_json" "$predictions"
  log ""
  log "Graded. Report written to $run_root/report.md"
}

# The set of resolved ids, one per line. Its only contract is that an id appears here **if
# and only if** the harness resolved it: the merge reads every other id as not resolved, so
# an extractor that over-includes silently *inflates* the score — the one failure a
# benchmark must not have, because it looks like a good result.
#
# The shapes the harness writes, in one place because they differ by version:
#
#   "resolved_ids": ["a__a-1"]                  a flat array of the passing ids
#   "resolved": {"a__a-1": true}                a map, holding only the passing entries
#   "resolved_instances": {"a__a-1": true}      the same map under an older name
#   "resolved_status": {"a__a-1": true, "b__b-2": false}
#                                               a map that carries BOTH answers
#
# `resolved_status` is why this cannot be a "does the text mention true" search, which is
# what it used to be: reading that map's keys wholesale counts its `false` entries as
# passes, and the report then claims a patch passed that the harness explicitly marked as
# failed. Each map is extracted, then filtered to the entries whose value is literally
# `true`; the arrays are read on their own terms.
swe_resolved_ids() {
  local source="$1" flat
  # One line, whatever the harness pretty-printed: the searches below cannot see a map
  # split across lines, and a missed id scores a *resolved* instance as a failure.
  flat="$(tr '\n' ' ' < "$source" 2>/dev/null || true)"

  # The arrays: every id inside them passed.
  printf '%s' "$flat" \
    | grep -oE '"(resolved|resolved_ids|resolved_instances)"[[:space:]]*:[[:space:]]*\[[^]]*\]' 2>/dev/null \
    | grep -oE '"[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+"' 2>/dev/null \
    | tr -d '"' || true

  # The maps: only the entries whose value is `true`.
  printf '%s' "$flat" \
    | grep -oE '"(resolved|resolved_instances|resolved_status)"[[:space:]]*:[[:space:]]*[{][^}]*[}]' 2>/dev/null \
    | tr ',' '\n' \
    | sed -nE 's/.*"([A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+)"[[:space:]]*:[[:space:]]*true.*/\1/p' || true
}

# Fold the harness's verdict into the run's own trials, then aggregate.
#
# The harness's report maps a resolved instance id to `true`; an instance it could not
# resolve is simply absent. Reading a *missing* key as "not resolved" is the whole
# contract, and it is why the merge is a lookup rather than a count.
swe_merge_grades() {
  local run="$1" source="$2" predictions="$3"
  local run_root trials merged
  run_root="$(run_dir "$run")"
  trials="$run_root/trials.jsonl"

  local resolved_ids
  resolved_ids="$(mktemp)"
  swe_resolved_ids "$source" | sort -u >> "$resolved_ids"

  merged="$(mktemp)"
  local line id
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | sed -nE 's/.*"instance_id":[[:space:]]*"([^"]+)".*/\1/p')"
    if [ -n "$id" ] && grep -qxF "$id" "$resolved_ids"; then
      printf '%s\n' "$(printf '%s' "$line" | sed -E 's/"resolved":[[:space:]]*(null|true|false)/"resolved": true/')" >> "$merged"
    else
      printf '%s\n' "$(printf '%s' "$line" | sed -E 's/"resolved":[[:space:]]*(null|true|false)/"resolved": false/')" >> "$merged"
    fi
  done < "$trials"
  mv "$merged" "$trials"
  rm -f "$resolved_ids"

  swe_write_report "$run"
  append_ledger "$run"
}

# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------
# How many lines of a file contain a fixed string — or, with an empty needle, how many
# lines it has at all.
#
# Not `grep -c`, and the difference is not style. On ZERO matches `grep -c` prints `0`
# *and* exits non-zero, so the idiomatic `$(grep -c … || printf '0')` emits "0\n0":
# the guard meant to supply a missing zero appends a second one. Every count that is
# legitimately zero — no stalls, no timeouts, no errors, which is what a *good* run
# looks like — then reached the arithmetic as a two-line value and killed the report.
# `awk` counts and exits 0 whatever the count is.
count_trials() {
  local file="$1" needle="${2:-}"
  awk -v want="$needle" '
    want == "" { if (NF) n += 1; next }
    index($0, want) { n += 1 }
    END { printf "%d", n + 0 }
  ' "$file" 2>/dev/null || printf '0'
}

# The numbers, and the reason for every miss. `no_patch` and `stalled` are kept apart
# from a wrong patch throughout: all three fail, and all three need a different fix,
# so a report that merged them would be accurate and useless.
swe_write_report() {
  local run="$1" run_root trials
  run_root="$(run_dir "$run")"
  trials="$run_root/trials.jsonl"

  local attempted resolved no_patch stalled timeout errors
  attempted="$(count_trials "$trials" '')"
  resolved="$(count_trials "$trials" '"resolved": true')"
  no_patch="$(count_trials "$trials" '"status": "no_patch"')"
  stalled="$(count_trials "$trials" '"status": "stalled"')"
  timeout="$(count_trials "$trials" '"status": "timeout"')"
  errors="$(count_trials "$trials" '"status": "error"')"

  local pass_at_1 interval tokens wall_clock
  pass_at_1="$(awk -v r="$resolved" -v n="$attempted" 'BEGIN { if (n > 0) printf "%.4f", r / n; else printf "" }')"
  interval="$(wilson_interval "$resolved" "$attempted")"
  tokens="$(awk -F'"tokens_total": ' '{ split($2, a, ","); total += a[1] + 0 } END { printf "%d", total + 0 }' "$trials" 2>/dev/null)"
  wall_clock="$(awk -F'"wall_clock_s": ' '{ split($2, a, ","); total += a[1] + 0 } END { printf "%d", total + 0 }' "$trials" 2>/dev/null)"

  local json
  json="$(mktemp)"
  json_open "$json"
  json_key "$json" "run_id" "$(json_string "$run")"
  json_key "$json" "bench_name" "$(json_string "$BENCH_NAME")"
  json_key "$json" "attempted" "$(json_int "$attempted")"
  json_key "$json" "resolved" "$(json_int "$resolved")"
  json_key "$json" "pass_at_1" "$(json_number "$pass_at_1")"
  json_key "$json" "pass_at_1_low" "$(json_number "$(printf '%s' "$interval" | cut -f1)")"
  json_key "$json" "pass_at_1_high" "$(json_number "$(printf '%s' "$interval" | cut -f2)")"
  json_key "$json" "no_patch" "$(json_int "$no_patch")"
  json_key "$json" "stalled" "$(json_int "$stalled")"
  json_key "$json" "timeout" "$(json_int "$timeout")"
  json_key "$json" "errors" "$(json_int "$errors")"
  json_key "$json" "tokens_total" "$(json_int "$tokens")"
  json_key "$json" "wall_clock_s" "$(json_int "$wall_clock")"
  json_key "$json" "turns_budget" "$(json_int "$TURNS")"
  json_close "$json" > "$run_root/report.json"
  rm -f "$json"

  swe_write_report_md "$run" "$run_root" "$attempted" "$resolved" "$pass_at_1" \
    "$interval" "$no_patch" "$stalled" "$timeout" "$errors" "$tokens" "$wall_clock"
}

# The Wilson score interval: the honest error bar on a proportion from a small sample.
# A raw "27/40" invites a reader to treat 67.5% as precise, and at n=40 the 95%
# interval is roughly ±15 points — which is the difference between two configurations
# being distinguishable or not.
wilson_interval() {
  local successes="${1:-0}" total="${2:-0}"
  awk -v k="$successes" -v n="$total" 'BEGIN {
    if (n == 0) { print "\t"; exit }
    z = 1.96
    p = k / n
    denom = 1 + (z * z) / n
    centre = (p + (z * z) / (2 * n)) / denom
    margin = (z * sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
    low = centre - margin; if (low < 0) low = 0
    high = centre + margin; if (high > 1) high = 1
    printf "%.4f\t%.4f", low, high
  }'
}

swe_write_report_md() {
  local run="$1" run_root="$2" attempted="$3" resolved="$4" pass_at_1="$5" interval="$6"
  local no_patch="$7" stalled="$8" timeout="$9" errors="${10}" tokens="${11}" wall_clock="${12}"
  local low high
  low="$(printf '%s' "$interval" | cut -f1)"
  high="$(printf '%s' "$interval" | cut -f2)"

  local manifest="$run_root/manifest.json"
  local model agent_ref turns
  model="$(sed -nE 's/^[[:space:]]*"model":[[:space:]]*"([^"]*)".*/\1/p' "$manifest" | head -n 1)"
  agent_ref="$(sed -nE 's/^[[:space:]]*"agent_ref":[[:space:]]*"([^"]*)".*/\1/p' "$manifest" | head -n 1)"
  turns="$(sed -nE 's/^[[:space:]]*"turns":[[:space:]]*([0-9]+).*/\1/p' "$manifest" | head -n 1)"

  {
    printf '# %s — run `%s`\n\n' "$BENCH_NAME" "$run"
    printf '| | |\n|---|---|\n'
    printf '| agent | `%s` |\n' "$agent_ref"
    printf '| model | `%s` |\n' "$model"
    printf '| turns | %s |\n' "${turns:-?}"
    printf '| resolved | **%s / %s** |\n' "$resolved" "$attempted"
    if [ -n "$pass_at_1" ]; then
      printf '| pass@1 | **%s** (95%% CI %s–%s) |\n' "$pass_at_1" "$low" "$high"
    else
      printf '| pass@1 | — |\n'
    fi
    printf '| tokens | %s |\n' "$tokens"
    printf '| wall clock | %ss |\n' "$wall_clock"
    printf '\n'
    printf '## Where the rest went\n\n'
    printf '| outcome | count | what it means |\n|---|---|---|\n'
    printf '| resolved | %s | the verdict of the official harness |\n' "$resolved"
    printf '| wrong patch | %s | a patch was produced and did not pass |\n' "$((attempted - resolved - no_patch - stalled - timeout - errors))"
    printf '| no patch | %s | finished without changing the workspace |\n' "$no_patch"
    printf '| stalled | %s | no workspace or checklist change within the guard window |\n' "$stalled"
    printf '| timeout | %s | hit the per-instance limit |\n' "$timeout"
    printf '| error | %s | seeding or the container failed |\n' "$errors"
    printf '\n'
    printf '`no patch` and `wrong patch` are kept apart on purpose: the first needs a\n'
    printf 'different prompt or a higher turn budget, the second needs a better model or a\n'
    printf 'better harness. Merging them produces a number that is accurate and useless.\n'
    printf '\n'
    printf '## Per instance\n\n'
    printf '| instance | status | turns | patch | resolved |\n|---|---|---|---|---|\n'
    local line id status tbytes bytes res
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      id="$(printf '%s' "$line" | sed -nE 's/.*"instance_id": "([^"]+)".*/\1/p')"
      status="$(printf '%s' "$line" | sed -nE 's/.*"status": "([^"]+)".*/\1/p')"
      tbytes="$(printf '%s' "$line" | sed -nE 's/.*"turns_used": ([0-9null]+).*/\1/p')"
      bytes="$(printf '%s' "$line" | sed -nE 's/.*"diff_bytes": ([0-9]+).*/\1/p')"
      case "$line" in
        *'"resolved": true'*) res='yes' ;;
        *'"resolved": false'*) res='no' ;;
        *) res='—' ;;
      esac
      printf '| `%s` | %s | %s | %s B | %s |\n' "$id" "$status" "$tbytes" "$bytes" "$res"
    done < "$run_root/trials.jsonl"
    printf '\n'
    printf '## How to reproduce\n\n'
    printf '```sh\n'
    printf 'moncho-cli bench status          # this bench, its plan and its latest run\n'
    printf 'moncho-cli bench explain         # the resolved recipe for a run\n'
    printf 'moncho-cli bench compare %s <other>\n' "$run"
    printf '```\n'
    printf '\n'
    printf 'The configuration this run was made under is in\n'
    printf '`%s/config-snapshot.json`, with the source of every knob.\n' "$run_root"
  } > "$run_root/report.md"
}
