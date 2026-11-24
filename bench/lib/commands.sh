#!/usr/bin/env bash
# The subcommands that are the framework's own, rather than a kind's.
#
# `init` writes a bench; `status`, `explain` and `report` describe one; `compare` puts
# two side by side; `clean` removes derived data. Everything that knows about SWE-bench
# lives in kinds/swe/, so this file has no opinion about what is being measured.

# ---------------------------------------------------------------------------
# init — one command, one directory, isolated per bench
# ---------------------------------------------------------------------------
# Idempotent and never destructive: a Benchfile that exists is the user's file, and
# refusing to overwrite it is the difference between a tool and a hazard. The one
# thing that is written unconditionally is the .gitignore, because a bench whose
# credentials could be committed is a bench that will leak one.
command_init() {
  local kind="${KIND_ARG:-swe}"
  local name="${NAME_ARG:-$(basename "$BENCH_DIR")}"

  kind_exists "$kind" || die "unknown bench kind '$kind' (available: $(kind_names | tr '\n' ' '))"

  if [ -f "$BENCHFILE" ] && [ "$FORCE" != "1" ]; then
    die "$BENCHFILE already exists
       it is your file, so this refuses to overwrite it (use --force to replace it)"
  fi

  name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')"
  mkdir -p "$BENCH_DIR"

  # The kind owns its own template, so a new kind needs no change here.
  write_benchfile_from_template "$kind" "$name"
  write_bench_env_skeleton "$kind"
  write_bench_gitignore

  if [ "$JSON" = "1" ]; then
    local file
    file="$(mktemp)"
    json_open "$file"
    json_key "$file" "bench_dir" "$(json_string "$BENCH_DIR")"
    json_key "$file" "bench_name" "$(json_string "$name")"
    json_key "$file" "bench_kind" "$(json_string "$kind")"
    json_key "$file" "benchfile" "$(json_string "$BENCHFILE")"
    json_key "$file" "env_file" "$(json_string "$BENCH_ENV_FILE")"
    json_close "$file"
    rm -f "$file"
    printf '\n'
    return 0
  fi

  cat <<EOF

Made a $kind bench in $BENCH_DIR

  Benchfile     $BENCHFILE
                committed, shareable, no credentials in it
  .env.bench    $BENCH_ENV_FILE
                gitignored — put the provider, the model and the key here

Next:
  1. fill in $(basename "$BENCH_ENV_FILE")
  2. moncho-cli bench build      prepare the payload, the runtime and the images
  3. moncho-cli bench select     draw the subset and freeze plan.json
  4. moncho-cli bench run        roll out, then grade
EOF
}

write_benchfile_from_template() {
  local kind="$1" name="$2" template
  template="$(kind_dir "$kind")/templates/Benchfile"
  [ -f "$template" ] || die "the $kind kind has no templates/Benchfile (this is a packaging bug)"
  # The name is the one field init knows better than the template does.
  sed -E "s#^BENCH_NAME=.*#BENCH_NAME=\"$name\"#" "$template" > "$BENCHFILE"
  log "Wrote $BENCHFILE (kind: $kind)"
}

write_bench_env_skeleton() {
  local kind="$1" template
  template="$(kind_dir "$kind")/templates/env.bench"
  # Never overwrite: a bench that has been configured must survive a second init.
  if [ -f "$BENCH_ENV_FILE" ]; then
    log "Kept the existing $BENCH_ENV_FILE"
    return 0
  fi
  [ -f "$template" ] || die "the $kind kind has no templates/env.bench (this is a packaging bug)"
  cp "$template" "$BENCH_ENV_FILE"
  chmod 0600 "$BENCH_ENV_FILE"
  log "Wrote $BENCH_ENV_FILE (mode 600: it holds a key)"
}

write_bench_gitignore() {
  local target="$BENCH_DIR/.gitignore"
  # Appended, never replaced: the directory may already be inside a repository with
  # rules of its own, and clobbering them would be the tool overstepping.
  local marker="# bench"
  if [ -f "$target" ] && grep -qxF "$marker" "$target" 2>/dev/null; then
    return 0
  fi
  cat >> "$target" <<'EOF'

# bench — the credentials and the derived data are never committed
.gitignore
.env.bench
results/
node/
payload/
*.partial
EOF
  log "Wrote $target"
}

# ---------------------------------------------------------------------------
# status — what this bench is, and where its last run got to
# ---------------------------------------------------------------------------
# Deterministic and local: it reads files and never calls a provider, so it is safe in
# a loop and honest on a machine with no network.
command_status() {
  local last
  last="$(latest_run)"

  if [ "$JSON" = "1" ]; then
    local file
    file="$(mktemp)"
    json_open "$file"
    json_key "$file" "bench_dir" "$(json_string "$BENCH_DIR")"
    json_key "$file" "bench_name" "$(json_string "$BENCH_NAME")"
    json_key "$file" "bench_kind" "$(json_string "$BENCH_KIND")"
    json_key "$file" "framework_version" "$(json_string "$(bench_version)")"
    json_key "$file" "framework_rev" "$(json_string "$(framework_rev)")"
    json_key "$file" "agent_ref" "$(json_string "$AGENT_REF")"
    json_key "$file" "model" "$(json_string "$(env_value OPENAI_MODEL)")"
    json_key "$file" "provider_host" "$(json_string "$(provider_host)")"
    json_key "$file" "api_key_present" "$(json_bool "$([ -n "$(env_value OPENAI_API_KEY)" ] && echo 1)")"
    json_key "$file" "turns" "$(json_int "$TURNS")"
    json_key "$file" "subset" "$(json_string "$SUBSET")"
    json_key "$file" "sample" "$(json_int "$SAMPLE")"
    json_key "$file" "results_dir" "$(json_string "$(results_dir)")"
    json_key "$file" "runs" "$(json_int "$(list_runs | wc -l | tr -d ' ')")"
    json_key "$file" "latest_run" "$(json_string "$last")"
    json_key "$file" "plan_frozen" "$(json_bool "$([ -f "$BENCH_DIR/plan.json" ] && echo 1)")"
    json_close "$file"
    rm -f "$file"
    printf '\n'
    return 0
  fi

  printf '%-12s %s\n' 'bench' "$BENCH_NAME"
  printf '%-12s %s\n' 'directory' "$BENCH_DIR"
  printf '%-12s %s (%s, rev %s)\n' 'framework' "$(bench_version)" "$BENCH_KIND" "$(framework_rev)"
  printf '%-12s %s\n' 'agent' "$AGENT_REF"
  printf '%-12s %s @ %s (key: %s)\n' 'model' \
    "$(env_value OPENAI_MODEL)" \
    "$(provider_host)" \
    "$([ -n "$(env_value OPENAI_API_KEY)" ] && echo present || echo MISSING)"
  printf '%-12s %s · subset %s · sample %s\n' 'run' "$TURNS turn(s)" "$SUBSET" "$SAMPLE"

  if [ -f "$BENCH_DIR/plan.json" ]; then
    printf '%-12s %s\n' 'plan' "$(plan_summary)"
  else
    printf '%-12s %s\n' 'plan' 'not frozen yet (moncho-cli bench select)'
  fi

  local count
  count="$(list_runs | wc -l | tr -d ' ')"
  printf '%-12s %s\n' 'results' "$(results_dir) — $count run(s)"
  if [ -n "$last" ]; then
    printf '%-12s %s\n' 'latest' "$last$(report_verdict "$last")"
  fi
}

# The one-line verdict of a run, appended to its id in `status`.
report_verdict() {
  local id="$1" file resolved attempted
  file="$(run_dir "$id")/report.json"
  [ -f "$file" ] || { printf ' (not graded)'; return 0; }
  RUN_ID="$id"
  resolved="$(report_field resolved)"
  attempted="$(report_field attempted)"
  if [ -n "$resolved" ] && [ -n "$attempted" ]; then
    printf ' (%s/%s resolved)' "$resolved" "$attempted"
  else
    printf ' (graded, no verdict)'
  fi
}

plan_summary() {
  local file="$BENCH_DIR/plan.json" count frozen
  count="$(sed -nE 's/^[[:space:]]*"instance_count":[[:space:]]*([0-9]+),?$/\1/p' "$file" | head -n 1)"
  frozen="$(sed -nE 's/^[[:space:]]*"frozen_at":[[:space:]]*"([^"]+)".*$/\1/p' "$file" | head -n 1)"
  printf '%s instances, frozen %s' "${count:-?}" "${frozen:-?}"
}

# ---------------------------------------------------------------------------
# explain — the resolved recipe
# ---------------------------------------------------------------------------
# Rendered from the same resolver `run` consumes, never re-derived from the Benchfile.
# That is the rule that keeps a document from describing a run other than the one
# performed (bench/README.md, rule 3).
command_explain() {
  if [ "$JSON" = "1" ]; then
    kind_explain
    return 0
  fi
  printf 'bench     %s (%s)\n' "$BENCH_NAME" "$BENCH_KIND"
  printf 'agent     %s\n' "$AGENT_REF"
  printf 'mode      %s\n' "$AGENT_MODE"
  printf 'turns     %s (stall after %s unproductive cycles)\n' "$TURNS" "$STALL_CYCLES"
  printf 'timeout   %ss per instance\n' "$AGENT_TIMEOUT"
  printf 'results   %s\n' "$(results_dir)"
  printf '\n'
  kind_explain
}

# ---------------------------------------------------------------------------
# report — the ledger, or one run in full
# ---------------------------------------------------------------------------
function command_report() {
  local id="${1:-$(latest_run)}"
  if [ -z "$id" ]; then
    log "no runs yet in $(results_dir)"
    log "start one with: moncho-cli bench run"
    return 0
  fi
  require_run "$id"

  if [ "$JSON" = "1" ]; then
    cat "$(run_dir "$id")/report.json"
    printf '\n'
    return 0
  fi

  local file
  file="$(run_dir "$id")/report.md"
  if [ -f "$file" ]; then
    cat "$file"
  else
    log "run $id has no report yet — grade it first: moncho-cli bench grade"
  fi
}

# ---------------------------------------------------------------------------
# compare — two runs side by side, with the guard
# ---------------------------------------------------------------------------
# Two runs whose *controlled* variables differ measure two things, and a delta
# between them is not evidence for anything. This refuses that comparison, naming the
# knob that moved. A changed knob outside the control list is reported as the
# variable under test — which is the comparison the experiment was for.
command_compare() {
  local a="${1:-}" b="${2:-}"
  [ -n "$a" ] && [ -n "$b" ] || die "usage: moncho-cli bench compare <run-a> <run-b> [--json]"
  require_run "$a"
  require_run "$b"

  local diff
  if diff="$(comparability_diff "$a" "$b")"; then
    local knob va vb
    knob="$(printf '%s' "$diff" | cut -f1)"
    va="$(printf '%s' "$diff" | cut -f2)"
    vb="$(printf '%s' "$diff" | cut -f3)"
    if [ "$JSON" = "1" ]; then
      local file
      file="$(mktemp)"
      json_open "$file"
      json_key "$file" "comparable" "false"
      json_key "$file" "reason" "$(json_string "the controlled variable $knob differs")"
      json_key "$file" "knob" "$(json_string "$knob")"
      json_key "$file" "a" "$(json_string "$va")"
      json_key "$file" "b" "$(json_string "$vb")"
      json_key "$file" "a_run" "$(json_string "$a")"
      json_key "$file" "b_run" "$(json_string "$b")"
      json_close "$file"
      rm -f "$file"
      printf '\n'
    else
      warn "these two runs are not comparable: $knob differs"
      warn "  $a: $va"
      warn "  $b: $vb"
      warn "a controlled variable has to match for a delta to mean anything."
      warn "re-run one side with $knob=$va to make the pair comparable."
    fi
    return 1
  fi

  local file
  file="$(mktemp)"
  json_open "$file"
  json_key "$file" "comparable" "true"
  json_key "$file" "a_run" "$(json_string "$a")"
  json_key "$file" "b_run" "$(json_string "$b")"

  local variables
  variables="$(variable_diff "$a" "$b")"
  if [ -n "$variables" ]; then
    json_key "$file" "variable_under_test" "$(json_string "$(printf '%s' "$variables" | cut -f1)")"
  else
    json_key "$file" "variable_under_test" "$(json_string '')"
  fi

  local key
  for key in resolved attempted pass_at_1 no_patch stalled tokens_total wall_clock_s; do
    local va vb
    va="$(RUN_ID="$a" report_field "$key")"
    vb="$(RUN_ID="$b" report_field "$key")"
    json_key "$file" "$key" "{\"a\": $(json_number "$va"), \"b\": $(json_number "$vb")}"
  done
  json_close "$file"
  rm -f "$file"
  printf '\n'
}

# ---------------------------------------------------------------------------
# clean
# ---------------------------------------------------------------------------
# Derived data only, and never the ledger: removing `index.jsonl` would be removing
# the record of what was measured, which is the one thing a bench exists to keep.
command_clean() {
  local dir
  dir="$(results_dir)"
  [ -d "$dir" ] || { log "nothing to clean in $dir"; return 0; }
  [ "$ASSUME_YES" = "1" ] || die "clean removes $(list_runs | wc -l | tr -d ' ') run(s) from $dir
       keep the ledger and pass --yes to confirm"
  local id
  for id in $(list_runs); do
    rm -rf "$(run_dir "$id")"
  done
  log "Removed the run directories; kept $(ledger_path)"
  if [ "$CLEAN_IMAGES" = "1" ]; then
    kind_clean_images
  fi
}

# ---------------------------------------------------------------------------
# versions
# ---------------------------------------------------------------------------
command_versions() {
  local v current
  current="$(bench_version)"
  if [ -z "$(bench_versions)" ]; then
    printf 'framework   %s (a checkout; nothing staged)\n' "$current"
    return 0
  fi
  for v in $(bench_versions); do
    if [ "$v" = "$current" ]; then
      printf '%-10s newest\n' "$v"
    else
      printf '%-10s\n' "$v"
    fi
  done
}
