#!/usr/bin/env bash
# `select`: draw the subset and freeze it.
#
# The frozen plan.json is the pre-registration (bench/README.md, rule 1). It is
# written *before* the first rollout and never rewritten, because a subset chosen
# after seeing the results is not a sample — it is a story.
#
# The dataset is read through the HuggingFace dataset viewer, which is what makes this
# work without a Python environment on the host. The paging is done here in shell
# (it is a plain offset loop) and the JSON is parsed by dataset.mjs, because a
# problem statement with a code fence in it is not something a sed script survives.

SWE_VIEWER_PAGE="${SWE_VIEWER_PAGE:-100}"

swe_dataset_cache_dir() { printf '%s/.cache' "$(swe_work_dir)"; }
swe_dataset_cache()     { printf '%s/dataset-%s-%s.json' "$(swe_dataset_cache_dir)" "$SUBSET" "$(bench_hash "$SWE_DATASET_REPO")"; }

# The split name for a subset: `dev` is a real split of the Lite dataset, the other
# two are the test split filtered by nothing — Lite *is* the curated 300, and
# `verified` a different dataset of the same family.
swe_subset_dataset() {
  case "$SUBSET" in
    lite)     printf 'SWE-bench/SWE-bench_Lite' ;;
    verified) printf 'princeton-nlp/SWE-bench_Verified' ;;
    dev)      printf 'SWE-bench/SWE-bench_Lite' ;;
    *)        die "unknown SUBSET '$SUBSET' (use lite, verified or dev)" ;;
  esac
}

swe_subset_split() {
  case "$SUBSET" in
    dev) printf 'dev' ;;
    *)   printf 'test' ;;
  esac
}

# Which Node runs dataset.mjs. The pinned runtime if it is there, else whatever the
# host has — `select` is a cheap, local step and should not require `build` first,
# but it must not silently depend on an unpinned interpreter either.
swe_node_binary() {
  local pinned
  pinned="$(swe_node_dir)/bin/node"
  if [ -x "$pinned" ]; then printf '%s' "$pinned"; return 0; fi
  command -v node >/dev/null 2>&1 || die "select needs a node interpreter:
       run 'moncho-cli bench build' to fetch the pinned one (NODE_VERSION=$NODE_VERSION),
       or install Node.js on the host"
  command -v node
}

# Fetch every page of the dataset into one file of concatenated JSON documents.
# Cached: the dataset is immutable, and re-downloading 300 rows to change a sample
# size would be rude to the API and slow for no reason.
swe_fetch_dataset() {
  local cache dir dataset split offset page total files
  cache="$(swe_dataset_cache)"
  dir="$(swe_dataset_cache_dir)"
  mkdir -p "$dir"

  if [ -f "$cache" ] && [ "$FORCE" != "1" ]; then
    note "Reusing the cached dataset at $cache"
    printf '%s' "$cache"
    return 0
  fi

  dataset="$(swe_subset_dataset)"
  split="$(swe_subset_split)"
  note "Fetching $dataset ($split) from the dataset viewer"

  files=()
  offset=0
  total=1
  while [ "$offset" -lt "$total" ]; do
    page="$dir/page-$offset.json"
    local url="${SWE_HF_ENDPOINT}/rows?dataset=${dataset}&config=default&split=${split}&offset=${offset}&length=${SWE_VIEWER_PAGE}"
    curl -fsSL "$url" -o "$page" || die "could not fetch the dataset page at offset $offset
       ($url)
       the environment needs network access to the HuggingFace dataset viewer"
    # The first page carries the total, which is how paging knows to stop without a
    # second endpoint. `num_rows_total` is a plain integer field.
    if [ "$offset" -eq 0 ]; then
      total="$(sed -nE 's/.*"num_rows_total":[[:space:]]*([0-9]+).*/\1/p' "$page" | head -n 1)"
      [ -n "$total" ] || die "the dataset page had no num_rows_total (the viewer API may have changed)"
    fi
    files+=("$page")
    offset=$((offset + SWE_VIEWER_PAGE))
  done

  # One JSON array of pages. dataset.mjs accepts both this and a single page, so the
  # reader can be probed on a captured page without building the whole thing.
  {
    printf '['
    local first=1 f
    for f in "${files[@]}"; do
      [ "$first" = "1" ] || printf ','
      printf '%s' "$(cat "$f")"
      first=0
    done
    printf ']'
  } > "$cache"

  for f in "${files[@]}"; do rm -f "$f"; done
  note "Cached $total row(s) at $cache"
  printf '%s' "$cache"
}

# Every row, one JSON object per line, projected to the fields a rollout needs.
swe_rows_file() {
  printf '%s/rows-ndjson' "$(swe_work_dir)"
}

swe_materialise_rows() {
  local cache out node
  cache="$(swe_fetch_dataset)"
  out="$(swe_rows_file)"
  mkdir -p "$(dirname "$out")"
  node="$(swe_node_binary)"
  "$node" "$SCRIPT_DIR/kinds/swe/dataset.mjs" rows "$cache" > "$out" \
    || die "the dataset could not be read ($cache)"
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# select
# ---------------------------------------------------------------------------
swe_select() {
  command -v curl >/dev/null 2>&1 || die "curl is required to fetch the dataset"
  if [ -f "$BENCH_DIR/plan.json" ] && [ "${FORCE:-}" != "1" ]; then
    die "$BENCH_DIR/plan.json already exists and is a pre-registration:
       rewriting it would erase what this bench declared it would measure.
       pass --force only if you have not run anything yet."
  fi

  local rows node ids
  rows="$(swe_materialise_rows)"
  node="$(swe_node_binary)"
  mkdir -p "$(swe_work_dir)"

  ids="$(mktemp)"
  "$node" "$SCRIPT_DIR/kinds/swe/dataset.mjs" select "$(swe_dataset_cache)" "$SAMPLE" "$STRATIFY" > "$ids" \
    || die "the sample could not be drawn"
  local count
  count="$(wc -l < "$ids" | tr -d ' ')"
  [ "$count" -gt 0 ] || die "the sample came out empty (SAMPLE=$SAMPLE, SUBSET=$SUBSET)"

  # The plan keeps the whole projected row for each selected instance, so `run` never
  # needs the dataset again and a later reader can see the prompt that was given.
  local instances_file
  instances_file="$(mktemp)"
  : > "$instances_file"
  local id row
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    row="$(grep -m1 -F "\"instance_id\":\"$id\"" "$rows" || true)"
    if [ -z "$row" ]; then
      warn "instance $id was selected but is not in the rows file; skipping"
      continue
    fi
    printf '%s\n' "$row" >> "$instances_file"
  done < "$ids"

  local plan_file file
  plan_file="$(mktemp)"
  json_open "$plan_file"
  json_key "$plan_file" "bench_name" "$(json_string "$BENCH_NAME")"
  json_key "$plan_file" "bench_kind" "$(json_string "$BENCH_KIND")"
  json_key "$plan_file" "frozen_at" "$(json_string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
  json_key "$plan_file" "dataset" "$(json_string "$SWE_DATASET_REPO")"
  json_key "$plan_file" "subset" "$(json_string "$SUBSET")"
  json_key "$plan_file" "stratify" "$(json_string "$STRATIFY")"
  json_key "$plan_file" "requested" "$(json_int "$SAMPLE")"
  json_key "$plan_file" "instance_count" "$(json_int "$count")"
  json_key "$plan_file" "agent_ref" "$(json_string "$AGENT_REF")"
  json_key "$plan_file" "turns" "$(json_int "$TURNS")"
  json_key "$plan_file" "model" "$(json_string "$(env_value OPENAI_MODEL)")"
  # The hypothesis is free text and belongs to the experimenter. It is recorded so a
  # report can be read against what was actually being tested.
  json_key "$plan_file" "hypothesis" "$(json_string "${HYPOTHESIS:-}")"
  json_close "$plan_file" > "$BENCH_DIR/plan.json"
  rm -f "$plan_file"

  # The instance records themselves, so `run` is self-contained.
  mkdir -p "$(swe_work_dir)"
  cp "$instances_file" "$(swe_instances_file)"
  # And the ledger's instance list, which `report` reads.
  cp "$ids" "$(swe_selected_ids_file)"
  rm -f "$ids" "$instances_file"

  log "Froze plan.json: $count instance(s), SUBSET=$SUBSET, STRATIFY=$STRATIFY, SAMPLE=$SAMPLE"
  log "  $BENCH_DIR/plan.json"
  log "next: moncho-cli bench build   (fetches the payload, the runtime and the images)"
}

swe_instances_file()  { printf '%s/instances.ndjson' "$(swe_work_dir)"; }
swe_selected_ids_file() { printf '%s/selected-ids.txt' "$(swe_work_dir)"; }

# The instance image of every planned instance, deduplicated. Used by build (to pull)
# and by clean --images (to remove).
swe_plan_images() {
  [ -f "$(swe_instances_file)" ] || return 0
  sed -nE 's/.*"image":"([^"]*)".*/\1/p' "$(swe_instances_file)" | sed '/^$/d'
}

swe_first_image() {
  swe_plan_images | head -n 1
}

# The planned instances as `<id>\t<repo>\t<image>` lines, in plan order. `run` walks
# this rather than the dataset.
swe_plan_lines() {
  [ -f "$(swe_instances_file)" ] || return 0
  local id repo image
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    id="$(json_field "$row" instance_id)"
    repo="$(json_field "$row" repo)"
    image="$(json_field "$row" image)"
    printf '%s\t%s\t%s\n' "$id" "$repo" "$image"
  done < "$(swe_instances_file)"
}

# One string field out of a one-line JSON object. The rows are written by dataset.mjs
# with `JSON.stringify`, so a value is a quoted string with `\"` for an embedded quote
# and `\\` for a backslash — which is all this has to undo.
json_field() {
  local row="$1" key="$2"
  printf '%s' "$row" | sed -nE "s/.*\"${key}\":\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" | head -n 1 \
    | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g' -e 's/\\n/\n/g' -e 's/\\t/\t/g' -e 's/\\r//g'
}
