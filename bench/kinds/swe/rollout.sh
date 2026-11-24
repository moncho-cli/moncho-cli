#!/usr/bin/env bash
# `run`: the rollouts.
#
# One instance is one *trial*: a fresh clone at base_commit, N cycles of the agent,
# and a patch extracted on the host. Everything the agent is told to do arrives as a
# file inside its own workspace, so the harness never turns into something the agent
# can observe.
#
# The loop is the bench's, not the agent's (bench/README.md): each cycle is one
# `--exec` process, so the bench supplies the repetition and the agent needs no
# self-drive and no work:on lock. Cycle 1 is a fresh session; later cycles resume with
# MONCHO_CONTINUE=1, which is the environment variable main.js reads.

# The prompt a rollout starts from. The instance's own problem statement, verbatim:
# paraphrasing it would make the run incomparable with published numbers, and adding
# framing is exactly the kind of instrument that quietly changes a score.
# The `problem_statement` is extracted from the row at run time (it is multi-line, so
# it cannot survive a shell variable round-trip comfortably); `swe_write_prompts`
# writes it straight from the ndjson.
swe_write_prompts() {
  local dir="$1" row="$2"
  mkdir -p "$dir/.bench"
  # One line of the ndjson is one JSON object; a tiny node script would be another
  # process per instance, so the statement is decoded with the same field reader the
  # rest of the harness uses and written through a here-doc-free path.
  json_field "$row" problem_statement > "$dir/.bench/issue.md"
  {
    cat "$dir/.bench/issue.md"
    printf '\n'
    printf '%s\n' '---'
    printf '\n'
    cat <<'EOF'
Fix the bug described above in this repository.

Work in the checkout you are in. When you are done, stop — do not commit, and do not
try to open a pull request.
EOF
  } > "$dir/.bench/prompt.md"
}

# The nudge for cycles 2..N: a *continuation*, not a restart. It says what is still
# failing rather than restating the issue, because a cycle that begins by re-reading
# its own first prompt tends to start over.
swe_write_nudge() {
  local dir="$1"
  mkdir -p "$dir/.bench"
  if [ -n "$TURNS_FOLLOWUP" ]; then
    printf '%s\n' "$TURNS_FOLLOWUP" > "$dir/.bench/nudge.md"
    return 0
  fi
  cat > "$dir/.bench/nudge.md" <<'EOF'
The change is not finished yet — the tests named in the issue still fail.

Continue from the work already in the tree: inspect what you have changed, run the
relevant tests, and fix what is still broken. Do not start over.
EOF
}

# The `AGENTS.md` the agent reads on every request through the project-rules channel
# (docs/agent/project-rules). This is the environment half of self-description — how
# to run things *here* — and deliberately nothing about being evaluated, which would
# be an instrument rather than a description.
swe_write_agents_md() {
  local dir="$1" row="$2" image="$3"
  local repo id
  repo="$(json_field "$row" repo)"
  id="$(json_field "$row" instance_id)"
  cat > "$dir/AGENTS.md" <<EOF
# Working in this checkout

This is a checkout of \`$repo\` at a fixed commit. It is a Python project and its test
suite runs under \`pytest\`.

- Run one test file with \`python3 -m pytest -rA path/to/test_file.py\`.
- Run one test with \`python3 -m pytest -rA path/to/test_file.py::test_name\`.
- Keep changes minimal and focused: the fix is expected to touch a small number of
  files in the library, not the test suite. Do not modify tests to make them pass.
- Prefer \`grep\`/\`find\` (or \`git grep\`) to explore. Use \`git diff\` to review what you
  have changed.
- Nothing here should be committed. Leave the working tree dirty; the diff is the
  deliverable.
EOF
}

# Keep the agent's own state — and the harness's own files — out of the patch.
#
# None of these can be moved out of the workspace: utils/path-safety.js#resolveProjectPath
# refuses absolute paths, so SESSION_DIR and THINKING_FILE read as unset and the state lands
# under /testbed/agent whatever we set, and AGENTS.md only reaches the agent through the
# project-rules channel (docs/agent/project-rules) if it sits in the checkout. The local
# exclude file is the same mechanism bin/lib/git.sh uses for a user's checkout, and it is
# never committed — so the tree stays clean without these appearing in `git status`.
#
# `/AGENTS.md` is not an aesthetic choice. It is *this harness's* instrument, written by
# `swe_write_agents_md` after the seed and before the agent ever runs; leaving it in means
# every patch in the bench opens with a new-file hunk that no agent wrote, the deliverable
# stops being the agent's work, and `no_patch` becomes unreachable — a rollout in which the
# model changed nothing would still look like it produced something.
swe_write_excludes() {
  local dir="$1" exclude="$1/.git/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  {
    printf '%s\n' '# bench — the harness state, never part of the deliverable'
    printf '%s\n' '/agent/'
    printf '%s\n' '/.bench/'
    printf '%s\n' '/AGENTS.md'
    printf '%s\n' '*.orig'
    printf '%s\n' '*.rej'
  } >> "$exclude"
}

# A no-op for the pieces of the agent's tooling that would otherwise try to reach the
# network or a home directory that does not exist in the instance image.
swe_container_env() {
  printf '%s\n' \
    "-e" "OPENAI_BASE_URL" \
    "-e" "OPENAI_API_KEY" \
    "-e" "OPENAI_MODEL" \
    "-e" "MODEL_TEMPERATURE" \
    "-e" "CONTEXT_MAX_LENGTH" \
    "-e" "COMPACTION_OLD_RATIO" \
    "-e" "CHUNKPACTION_ENABLED" \
    "-e" "PULSE_LIMIT" \
    "-e" "RUN_BASH_ALLOWED" \
    "-e" "MONCHO_MAINTAINER" \
    "-e" "HOME=/tmp" \
    "-e" "npm_config_cache=/tmp/.npm" \
    "-e" "GIT_OPTIONAL_LOCKS=0"
}

# Is this value set in the environment at all? Only a set variable is forwarded, so a
# knob left out of .env.bench keeps the agent's own default instead of being pinned to
# an empty string by the harness — which would be the harness changing the experiment.
forwarded_env_flags() {
  local name
  for name in OPENAI_BASE_URL OPENAI_API_KEY OPENAI_MODEL MODEL_TEMPERATURE \
              CONTEXT_MAX_LENGTH COMPACTION_OLD_RATIO CHUNKPACTION_ENABLED PULSE_LIMIT \
              RUN_BASH_ALLOWED MONCHO_MAINTAINER; do
    # MONCHO_MAINTAINER is deliberately forced off on the *host* side unless the
    # experimenter set it: an instance image is a user's project, so the fence
    # applies (docs/agent/host-fence).
    if [ "$name" = "MONCHO_MAINTAINER" ]; then
      printf '%s\n' "-e" "MONCHO_MAINTAINER=${MONCHO_MAINTAINER:-0}"
      continue
    fi
    if env_is_set "$name"; then
      printf '%s\n' "-e" "$name"
    fi
  done
  printf '%s\n' "-e" "HOME=/tmp"
  printf '%s\n' "-e" "npm_config_cache=/tmp/.npm"
  printf '%s\n' "-e" "GIT_OPTIONAL_LOCKS=0"
}

# ---------------------------------------------------------------------------
# The diff: the deliverable
# ---------------------------------------------------------------------------
# Taken on the host, never by the agent. The agent's tools cannot pipe or redirect, and
# the container's git is the instance image's; the host has a plain git and a plain
# diff, which is exactly what is needed.
swe_extract_patch() {
  local ws="$1" out="$2"
  git -C "$ws" add -A -- . >/dev/null 2>&1 || true
  git -C "$ws" diff --cached --no-color --binary > "$out" 2>/dev/null || : > "$out"
  git -C "$ws" reset >/dev/null 2>&1 || true
  # A diff with no hunks is not a patch. Reporting an empty file as one would make
  # "produced nothing" indistinguishable from "produced something empty".
  if ! grep -qE '^(diff --git|index |--- |\+\+\+ )' "$out" 2>/dev/null; then
    : > "$out"
  fi
}

# A cheap progress signal, used by the stall guard. `git status --porcelain` counts
# untracked files too, so a model that writes a brand-new file registers as progress.
swe_workspace_fingerprint() {
  local ws="$1"
  {
    git -C "$ws" status --porcelain 2>/dev/null | wc -l | tr -d ' '
    git -C "$ws" diff 2>/dev/null | digest | cut -d' ' -f1
  } | tr '\n' ':'
}

# The checklist, counted the way the harness counts it. `entriesOf` is what filters the
# seeded placeholder ("(no items recorded)") that a naive parse reads as a pending
# item — see bench/README.md.
swe_checklist_ticks() {
  local ws="$1" task
  task="$(newest_named_file "$ws/agent/sessions" 'task.md')"
  [ -n "$task" ] || { printf '0'; return 0; }
  awk '
    /^[[:space:]]*[-*][[:space:]]+\[[xX]\][[:space:]]+/ { done += 1 }
    /^[[:space:]]*[-*][[:space:]]+\[ \][[:space:]]+/ {
      line = $0
      # The seeded placeholder is not an item.
      if (line !~ /\(no (items|steps) recorded\)/ && line !~ /\(nothing .*recorded\)/) pending += 1
    }
    END { printf "%d/%d", done + 0, done + pending + 0 }
  ' "$task"
}

# ---------------------------------------------------------------------------
# The cycle loop for one instance
# ---------------------------------------------------------------------------
# Returns via the globals the caller reads: SWE_TRIAL_STATUS (`ok`, `no_patch`,
# `stalled`, `timeout`, `error`), SWE_TRIAL_TURNS, SWE_TRIAL_REASON.
swe_run_instance() {
  local id="$1" image="$2" run_root="$3"
  local trial_dir="$run_root/instances/$id"
  mkdir -p "$trial_dir"
  SWE_TRIAL_STATUS="error"
  SWE_TRIAL_TURNS=0
  SWE_TRIAL_REASON=""

  local ws="$trial_dir/workspace"
  # A fresh clone per attempt, from the image's own copy of the repository. The
  # SWE-bench images ship /testbed already at the right commit, so the fastest correct
  # seed is a copy of that rather than a network clone.
  mkdir -p "$ws"
  if ! docker run --rm -u "$(id -u):$(id -g)" \
      -v "$ws:/out" \
      --entrypoint /bin/bash "$image" -lc '
        set -e
        cp -a /testbed/. /out/ 2>/dev/null || true
        cd /out && git checkout -- . >/dev/null 2>&1 || true
      ' >/dev/null 2>&1; then
    SWE_TRIAL_REASON="could not seed the workspace from $image"
    return 1
  fi
  [ -d "$ws/.git" ] || { SWE_TRIAL_REASON="the seeded workspace has no .git"; return 1; }

  # The row for this instance, so the prompt and AGENTS.md come from the dataset.
  local row
  row="$(grep -m1 -F "\"instance_id\":\"$id\"" "$(swe_instances_file)" || true)"
  [ -n "$row" ] || { SWE_TRIAL_REASON="no dataset row for $id"; return 1; }

  swe_write_prompts "$trial_dir" "$row"
  swe_write_nudge "$trial_dir"
  swe_write_agents_md "$ws" "$row" "$image"
  swe_write_excludes "$ws"

  local node payload
  node="$(swe_node_dir)"
  payload="$(swe_payload_dir)"
  local -a env_flags=()
  while IFS= read -r flag; do env_flags+=("$flag"); done < <(forwarded_env_flags)

  local cycle=1 last_fp="" unproductive=0
  local previous_fp="" previous_ticks=""
  while [ "$cycle" -le "$TURNS" ]; do
    local prompt nudge continue_flag=()
    if [ "$cycle" -eq 1 ]; then
      prompt="/testbed/.bench/prompt.md"
    else
      prompt="/testbed/.bench/nudge.md"
      continue_flag=(-e "MONCHO_CONTINUE=1")
    fi

    local cycle_log="$trial_dir/cycle-$cycle.log"
    local started ended
    started="$(date -u '+%s')"

    # -i, never -t: a tty gets the TUI, and the TUI needs a screen. With no tty the
    # agent takes the line CLI, reads the prompt from --exec, and exits on its own.
    if timeout "${AGENT_TIMEOUT}s" docker run --rm -i \
        -u "$(id -u):$(id -g)" \
        -v "$ws:/testbed" \
        -v "$node:/opt/node:ro" \
        -v "$payload:/opt/moncho-cli:ro" \
        "${env_flags[@]}" "${continue_flag[@]+"${continue_flag[@]}"}" \
        -e "PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin" \
        --entrypoint /bin/bash "$image" -lc \
        "/opt/node/bin/node /opt/moncho-cli/main.js --exec $prompt --mode $AGENT_MODE" \
        > "$cycle_log" 2>&1; then
      :
    else
      local code=$?
      if [ "$code" -eq 124 ]; then
        SWE_TRIAL_STATUS="timeout"
        SWE_TRIAL_REASON="cycle $cycle exceeded ${AGENT_TIMEOUT}s"
        ended="$(date -u '+%s')"
        printf '%s\t%s\t%s\n' "$cycle" "$((ended - started))" "$SWE_TRIAL_STATUS" >> "$trial_dir/cycles.tsv"
        break
      fi
      # A non-zero exit is not fatal by itself: the agent may have failed on a tool and
      # still left a usable tree. It is recorded, and the patch decides.
      printf '[bench] cycle %s exited %s\n' "$cycle" "$code" >> "$cycle_log"
    fi

    ended="$(date -u '+%s')"
    printf '%s\t%s\t%s\n' "$cycle" "$((ended - started))" "ok" >> "$trial_dir/cycles.tsv"
    SWE_TRIAL_TURNS="$cycle"

    # --- progress, from two independent signals -----------------------------
    local fp ticks
    fp="$(swe_workspace_fingerprint "$ws")"
    ticks="$(swe_checklist_ticks "$ws")"
    if [ "$fp" = "$previous_fp" ] && [ "$ticks" = "$previous_ticks" ]; then
      unproductive=$((unproductive + 1))
    else
      unproductive=0
    fi
    previous_fp="$fp"
    previous_ticks="$ticks"

    if [ "$unproductive" -ge "$STALL_CYCLES" ]; then
      SWE_TRIAL_STATUS="stalled"
      SWE_TRIAL_REASON="$unproductive consecutive cycles with no workspace or checklist change"
      break
    fi

    cycle=$((cycle + 1))
  done

  swe_extract_patch "$ws" "$trial_dir/diff.patch"

  if [ "$SWE_TRIAL_STATUS" != "timeout" ] && [ "$SWE_TRIAL_STATUS" != "stalled" ]; then
    if [ -s "$trial_dir/diff.patch" ]; then
      SWE_TRIAL_STATUS="ok"
    else
      # A clean exit with an empty diff is a *measurement*, not a failure — and it is
      # kept separate from a patch that was produced and wrong. The two need opposite
      # fixes, so `report` counts them apart.
      SWE_TRIAL_STATUS="no_patch"
      SWE_TRIAL_REASON="the agent finished without changing the workspace"
    fi
  fi

  # The session record, copied out so cost is recoverable even when the run dies
  # (utils/session-format.js#sessionUsage reads this shape). Best-effort by construction:
  # a rollout whose agent never started has no session directory at all.
  local session
  session="$(newest_named_file "$ws/agent/sessions" 'context.json')"
  if [ -n "$session" ]; then
    cp "$session" "$trial_dir/context.json" 2>/dev/null || true
  fi
  return 0
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
swe_run() {
  require_docker
  # The patch is taken on the host (swe_extract_patch), not in a container: a plain git and
  # a plain diff are all it needs, and using the host's own keeps the instance image out of
  # a step that has nothing to do with the environment being measured. So this is a real
  # precondition, checked here where the message can say what it is for.
  command -v git >/dev/null 2>&1 || die "git is required on the host: the patch is extracted with
       'git -C <workspace> diff', which is also what makes it comparable with a published one"
  [ -f "$BENCH_DIR/plan.json" ] || die "no plan.json: run 'moncho-cli bench select' first (it freezes the subset)"
  [ -f "$(swe_instances_file)" ] || die "no instance records: re-run 'moncho-cli bench select'"
  [ -x "$(swe_node_dir)/bin/node" ] || die "the pinned Node is missing: run 'moncho-cli bench build'"
  [ -f "$(swe_payload_dir)/main.js" ] || die "the agent payload is missing: run 'moncho-cli bench build'"
  [ -n "$(env_value OPENAI_MODEL)" ] || die "no OPENAI_MODEL: fill in .env.bench"
  [ -n "$(env_value OPENAI_BASE_URL)" ] || die "no OPENAI_BASE_URL: fill in .env.bench"

  local run_id run_root
  run_id="$(new_run_id)"
  RUN_ID="$run_id"
  run_root="$(run_dir "$run_id")"
  mkdir -p "$run_root"
  # Before the first rollout: the identity and the configuration of everything that
  # could move a number. Written first on purpose (bench/README.md, rule 1).
  config_snapshot > "$run_root/config-snapshot.json"
  write_manifest "$run_id"

  local -a planned=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    planned+=("$line")
  done < <(swe_plan_lines)
  [ "${#planned[@]}" -gt 0 ] || die "the plan selected no instances"

  # `--instances a,b,c` narrows an existing plan without rewriting it: the plan is
  # still the pre-registration, and the subset actually attempted is recorded per run.
  local -a chosen=()
  if [ -n "$INSTANCES_ARG" ]; then
    local want
    for want in $(printf '%s' "$INSTANCES_ARG" | tr ',' ' '); do
      local found=0 line
      for line in "${planned[@]}"; do
        case "$line" in "$want"$'\t'*) chosen+=("$line"); found=1; break ;; esac
      done
      [ "$found" = "1" ] || warn "instance $want is not in the plan; skipping"
    done
    [ "${#chosen[@]}" -gt 0 ] || die "none of the instances given are in the plan"
  else
    chosen=("${planned[@]}")
  fi

  log "Run $run_id — ${#chosen[@]} instance(s), TURNS=$TURNS, model $(env_value OPENAI_MODEL)"
  log "  $run_root"

  local trials="$run_root/trials.jsonl"
  : > "$trials"
  local index=0 total="${#chosen[@]}"
  local record id repo image status turns
  for record in "${chosen[@]}"; do
    index=$((index + 1))
    id="$(printf '%s' "$record" | cut -f1)"
    repo="$(printf '%s' "$record" | cut -f2)"
    image="$(printf '%s' "$record" | cut -f3)"
    printf '[%s/%s] %s (%s)\n' "$index" "$total" "$id" "$repo"

    if ! docker image inspect "$image" >/dev/null 2>&1; then
      log "         pulling $image"
      docker pull "$image" >/dev/null 2>&1 || warn "could not pull $image"
    fi

    # `|| true` is deliberate, and it is the difference between one failed instance and a
    # failed benchmark. `swe_run_instance` returns non-zero for the conditions that are
    # *ordinary* in a long run — an image that could not be pulled, a seed that would not
    # copy — and reports them through SWE_TRIAL_STATUS/SWE_TRIAL_REASON. This whole script
    # runs under `set -euo pipefail` (bench/bench.sh), so an unguarded call would abort
    # `swe_run` at instance N and throw away every instance after it: a 300-instance bench
    # ended by the fourth image. The trial is recorded as `error` instead, which is what
    # `report` counts apart.
    swe_run_instance "$id" "$image" "$run_root" || true
    status="$SWE_TRIAL_STATUS"
    turns="$SWE_TRIAL_TURNS"

    if [ "$status" = "ok" ]; then
      printf '         %s — %s turn(s), %s bytes of patch\n' "$status" "$turns" "$(wc -c < "$run_root/instances/$id/diff.patch" | tr -d ' ')"
    else
      printf '         %s — %s\n' "$status" "${SWE_TRIAL_REASON:-no reason recorded}"
    fi

    swe_append_trial "$trials" "$id" "$repo" "$image" "$status" "$turns" "$run_root"
    swe_append_prediction "$run_root" "$id"
  done

  append_ledger "$run_id"
  log ""
  log "Rollouts done: $run_root"
  log "next: moncho-cli bench grade   (the official harness over predictions.jsonl)"
}

# One record per attempt, appended as it lands so a run that dies at instance 30 still
# has 29 usable records.
swe_append_trial() {
  local file="$1" id="$2" repo="$3" image="$4" status="$5" turns="$6" run_root="$7"
  local dir="$run_root/instances/$id" diff_bytes=0 ticks="0/0"
  [ -f "$dir/diff.patch" ] && diff_bytes="$(wc -c < "$dir/diff.patch" | tr -d ' ')"
  [ -d "$dir/workspace" ] && ticks="$(swe_checklist_ticks "$dir/workspace")"

  local line
  line="$(mktemp)"
  json_open "$line"
  json_key "$line" "instance_id" "$(json_string "$id")"
  json_key "$line" "repo" "$(json_string "$repo")"
  json_key "$line" "image" "$(json_string "$image")"
  json_key "$line" "status" "$(json_string "$status")"
  json_key "$line" "reason" "$(json_string "${SWE_TRIAL_REASON:-}")"
  json_key "$line" "turns_used" "$(json_int "$turns")"
  json_key "$line" "turns_budget" "$(json_int "$TURNS")"
  json_key "$line" "diff_bytes" "$(json_int "$diff_bytes")"
  json_key "$line" "checklist" "$(json_string "$ticks")"
  json_key "$line" "resolved" "null"
  json_key "$line" "wall_clock_s" "$(json_int "$(swe_trial_seconds "$dir")")"
  json_key "$line" "tokens_total" "$(json_int "$(swe_trial_tokens "$dir")")"
  json_close "$line" | tr -d '\n' | sed 's/  */ /g' >> "$file"
  printf '\n' >> "$file"
  rm -f "$line"
}

swe_trial_seconds() {
  local dir="$1"
  [ -f "$dir/cycles.tsv" ] || { printf '0'; return 0; }
  awk -F'\t' '{ total += $2 } END { printf "%d", total + 0 }' "$dir/cycles.tsv"
}

# The session's own usage block, when the run got far enough to write one. Summed
# across the classes the agent accounts for.
swe_trial_tokens() {
  local dir="$1" file="$dir/context.json"
  [ -f "$file" ] || { printf '0'; return 0; }
  # The usage table is a small nested object; summing every `*_tokens` integer in it is
  # enough for a cost line and cannot be wrong in a way that matters.
  grep -oE '"[a-z_]*tokens[a-z_]*"[[:space:]]*:[[:space:]]*[0-9]+' "$file" 2>/dev/null \
    | grep -oE '[0-9]+$' | awk '{ total += $1 } END { printf "%d", total + 0 }'
}

# `predictions.jsonl` in the shape the official harness reads. Written during the run
# so grading never has to re-derive a patch.
swe_append_prediction() {
  local run_root="$1" id="$2" dir
  dir="$run_root/instances/$id"
  [ -s "$dir/diff.patch" ] || return 0
  mkdir -p "$(swe_pred_dir)"
  # The patch is embedded as a JSON string, so it is escaped by the same writer the
  # rest of the harness uses rather than by a hand-rolled sed.
  local line
  line="$(mktemp)"
  json_open "$line"
  json_key "$line" "instance_id" "$(json_string "$id")"
  json_key "$line" "model_name_or_path" "$(json_string "moncho-${BENCH_NAME}")"
  json_key "$line" "model_patch" "$(json_string "$(cat "$dir/diff.patch")")"
  json_close "$line" | tr -d '\n' | sed 's/  */ /g' >> "$(swe_pred_dir)/${RUN_ID}.jsonl"
  printf '\n' >> "$(swe_pred_dir)/${RUN_ID}.jsonl"
  rm -f "$line"
}
