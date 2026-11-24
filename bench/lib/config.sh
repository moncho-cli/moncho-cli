#!/usr/bin/env bash
# The configuration record: what a run's numbers are attributable to.
#
# Every knob is captured as {configured, default, effective, source}, the shape
# `utils/context-size.js#resolveContextSize` already uses in the agent. The `source`
# is the point: it distinguishes "we left it alone" from "we set it to today's
# default", which is exactly what a default moving between agent versions would
# otherwise hide. A run that recorded only values would file two different
# experiments under one name.
#
# Nothing secret is ever written: a provider key is recorded as a boolean.

# The complete inventory of environment variables the agent reads, with the default
# the agent itself falls back to. Extracted from `grep -rno 'process.env\.[A-Z_]*'`
# over app/, api/, config/, tools/, utils/ and main.js, so the list cannot drift from
# the code by being hand-written — and `probe` re-derives it and fails on a difference.
#
# Format: NAME<TAB>DEFAULT<TAB>CLASS
#   CLASS is `perf` (can move a benchmark number), `ident` (identity/plumbing) or
#   `secret` (recorded by presence only).
AGENT_ENV_INVENTORY='
OPENAI_BASE_URL	http://host.containers.internal:11434/api/chat	perf
OPENAI_MODEL	qwen3.6:35b-a3b-q4_K_M	perf
MODEL_TEMPERATURE		perf
OLLAMA_MAX_TOKENS		perf
MONCHO_USER_AGENT		ident
CONTEXT_MAX_LENGTH	128000	perf
COMPACTION_OLD_RATIO	0.7	perf
CHUNKPACTION_ENABLED	off	perf
PULSE_LIMIT	30	perf
APPROACH_MAX_REFUSALS	2	perf
FILE_LINE_LIMIT	600	perf
READ_MAX_LINES	2000	perf
PROJECT_LANGUAGE		ident
MONCHO_MAINTAINER	0	perf
TASK_FILE	task.md	ident
PLAN_FILE	implementation_plan.md	ident
SESSION_DIR	agent/sessions	ident
SKINS_DIR	agent/skins	ident
THINKING_FILE	agent/thinking.md	ident
LOG_FILE	agent/logs/moncho.log	ident
LOG_LEVEL	info	ident
LOG_MAX_BYTES	524288	ident
LOG_MAX_FILES	5	ident
CLIPBOARD_FILE_KEEP	single	ident
MONCHO_CONTINUE	0	perf
MONCHO_VERSION		ident
OPENAI_API_KEY		secret
'

# The bench-side knobs, which are this framework's own vocabulary.
BENCH_KNOB_INVENTORY='
BENCH_KIND
BENCH_NAME
AGENT_REF
AGENT_MODE
TURNS
TURNS_FOLLOWUP
AGENT_TIMEOUT
STALL_CYCLES
SUBSET
STRATIFY
SAMPLE
RUNS
GRADE_WORKERS
NODE_VERSION
RUN_BASH_ALLOWED
'

# The effective value of a variable, or empty. Read via `eval` so a name that is
# unset under `set -u` answers empty instead of killing the script — which is the
# normal case here, since most knobs are deliberately left alone.
env_value() {
  local name="$1"
  eval "printf '%s' \"\${$name-}\""
}

# Is a name present in the environment at all? Distinguishes "set to empty" from
# "never set", which matters for a knob whose empty value has a meaning.
env_is_set() {
  local name="$1"
  eval "[ \"\${$name+set}\" = set ]"
}

# ---------------------------------------------------------------------------
# The per-knob object
# ---------------------------------------------------------------------------
# `json_knob <accumulator> <name> <default> <source>` writes one member whose value is
# the four-field object. `source` is `benchfile`, `env`, `bench-env`, `default`, or
# `unset` for the two identity names the framework never sets.
json_knob() {
  local file="$1" name="$2" default="$3" source="$4" effective
  effective="$(env_value "$name")"

  # A secret is never written, and is not even read into a variable for writing: its
  # presence is the whole record.
  if [ "$source" = "secret" ]; then
    printf '    %s: {\n        "present": %s,\n        "source": %s\n    },\n' \
      "$(json_string "$name")" \
      "$(json_bool "$([ -n "$effective" ] && echo 1)")" \
      "$(json_string "$source")" >> "$file"
    return 0
  fi

  printf '    %s: {\n' "$(json_string "$name")" >> "$file"
  printf '        "configured": %s,\n' "$(json_string "$effective")" >> "$file"
  printf '        "default": %s,\n' "$(json_string "$default")" >> "$file"
  printf '        "effective": %s,\n' "$(json_string "$effective")" >> "$file"
  printf '        "source": %s\n' "$(json_string "$source")" >> "$file"
  printf '    },\n' >> "$file"
}

# Split one inventory row into NAME / DEFAULT / CLASS.
#
# Done by hand rather than with `read -r name default class` on a tab IFS, and the
# difference is a security bug. With TWO fields — a row written `NAME\t\tsecret` —
# `read` gives the last variable the whole remainder, so `default` received "secret"
# and `class` came back empty. The secret then failed the `class = secret` test and was
# written out **with its value**. Splitting explicitly gives an empty middle field the
# empty string it is, which is what makes the three-column shape mean what it says.
#
# Sets INV_NAME, INV_DEFAULT, INV_CLASS.
split_inventory_row() {
  local line="$1" tab
  tab="$(printf '\t')"
  INV_NAME="${line%%"$tab"*}"
  local rest="${line#*"$tab"}"
  INV_DEFAULT="${rest%%"$tab"*}"
  # No third tab at all (a malformed row) leaves the class equal to the remainder,
  # which is then an unknown class rather than a wrong one.
  case "$rest" in
    *"$tab"*) INV_CLASS="${rest#*"$tab"}" ;;
    *)        INV_CLASS="$rest" ;;
  esac
}

# Which *class* a name belongs to, from the inventory. An unknown name is `ident`.
knob_class() {
  local wanted="$1"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_inventory_row "$line"
    if [ "$INV_NAME" = "$wanted" ]; then printf '%s' "$INV_CLASS"; return 0; fi
  done <<EOF
$(printf '%s\n' "$AGENT_ENV_INVENTORY" | grep -v '^$')
EOF
  printf 'ident'
}

# The default the agent falls back to for a name, from the inventory.
knob_default() {
  local wanted="$1"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_inventory_row "$line"
    if [ "$INV_NAME" = "$wanted" ]; then printf '%s' "$INV_DEFAULT"; return 0; fi
  done <<EOF
$(printf '%s\n' "$AGENT_ENV_INVENTORY" | grep -v '^$')
EOF
  printf ''
}

# Where a value came from. The bench's own file is checked first because it is loaded
# last and therefore wins; `default` means the framework applied its fallback.
knob_source() {
  local name="$1"
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${name}=" "$BENCHFILE" 2>/dev/null; then
    printf 'benchfile'
  elif [ -f "$BENCH_ENV_FILE" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?${name}=" "$BENCH_ENV_FILE" 2>/dev/null; then
    printf 'bench-env'
  elif env_is_set "$name"; then
    printf 'inherited'
  else
    printf 'default'
  fi
}

# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------
# `config_snapshot` prints the whole thing. It is written once per run, beside the
# trials it explains, and its hash is what `compare` checks for comparability.
config_snapshot() {
  local file agent_part bench_part
  file="$(mktemp)"
  json_open "$file"

  # --- when, and by what ----------------------------------------------------
  json_key "$file" "captured_at" "$(json_string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
  json_key "$file" "bench_name" "$(json_string "$BENCH_NAME")"
  json_key "$file" "bench_kind" "$(json_string "$BENCH_KIND")"

  # --- the agent's own knobs ------------------------------------------------
  # The inventory drives the loop, so a knob the agent grows is picked up by the
  # record rather than forgotten by it.
  agent_part="$(mktemp)"
  json_open "$agent_part"
  local source
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_inventory_row "$line"
    # The class is read from the splitter, never inferred from the presence of a
    # default: that inference is what let the secret take the value branch.
    if [ "$INV_CLASS" = "secret" ]; then source="secret"; else source="$(knob_source "$INV_NAME")"; fi
    json_knob "$agent_part" "$INV_NAME" "$INV_DEFAULT" "$source"
  done <<EOF
$(printf '%s\n' "$AGENT_ENV_INVENTORY" | grep -v '^$')
EOF
  json_key "$file" "agent_env" "$(json_close "$agent_part")"
  rm -f "$agent_part"

  # --- the bench's own knobs ------------------------------------------------
  bench_part="$(mktemp)"
  json_open "$bench_part"
  local knob
  for knob in $BENCH_KNOB_INVENTORY; do
    [ -n "$knob" ] || continue
    json_knob "$bench_part" "$knob" "" "$(knob_source "$knob")"
  done
  json_key "$file" "bench_knobs" "$(json_close "$bench_part")"
  rm -f "$bench_part"

  # The turn budget and the agent ref are the two controlled variables that live in the
  # Benchfile rather than the environment. They are already in `bench_knobs` above, and
  # they are deliberately NOT repeated at the top level: a duplicate key makes the
  # single-line form and the block form both match a name, and a reader following the
  # first match would then report the wrong knob's value. One key, one place.

  json_close "$file"
  rm -f "$file"
}

# The knobs that `compare` requires to match for two runs to be comparable at all.
# These are the *controlled* variables: change one and the pair measures two things.
# A feature under test (`CHUNKPACTION_ENABLED`, `COMPACTION_OLD_RATIO`, …) is
# deliberately absent from this list — it is the variable, not a control.
COMPARABILITY_KNOBS='
AGENT_REF
AGENT_MODE
TURNS
SUBSET
MODEL_TEMPERATURE
OPENAI_MODEL
RUNS
'
