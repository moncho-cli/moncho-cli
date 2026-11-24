#!/usr/bin/env bash
# The `swe` kind: SWE-bench Lite, graded by the official harness.
#
# Two stages, deliberately apart:
#
#   1. rollout  — the agent works the issue inside the instance's *own* SWE-bench
#                 image, so the environment is the one the benchmark pinned. The
#                 agent's runtime is a pinned Node mounted read-only rather than a
#                 rebuilt image, so the instance images stay pristine and shared.
#   2. grading  — `swebench.harness.run_evaluation` over predictions.jsonl. It
#                 applies the test patch and runs the tests. Reimplementing that is
#                 how a benchmark stops being comparable with published numbers.
#
# The patch is extracted on the *host*, with `git diff` against base_commit. The
# agent's own state cannot be moved out of the workspace (`utils/path-safety.js`
# refuses absolute paths, so SESSION_DIR reads as unset), so it is kept out of the
# diff by `.git/info/exclude` — the same mechanism bin/lib/git.sh uses.

SWE_DATASET_REPO="${SWE_DATASET_REPO:-SWE-bench/SWE-bench_Lite}"
SWE_HF_ENDPOINT="${SWE_HF_ENDPOINT:-https://datasets-server.huggingface.co}"
SWE_GRADER_IMAGE="${SWE_GRADER_IMAGE:-python:3.11-slim}"

# shellcheck source=instances.sh
. "$SCRIPT_DIR/kinds/swe/instances.sh"
# shellcheck source=rollout.sh
. "$SCRIPT_DIR/kinds/swe/rollout.sh"
# shellcheck source=grade.sh
. "$SCRIPT_DIR/kinds/swe/grade.sh"

# Directory names, all under the bench, all derived from settings the record keeps.
swe_work_dir()  { printf '%s/.work' "$BENCH_DIR"; }
swe_payload_dir() { printf '%s/payload/%s' "$MONCHO_BENCH_HOME" "$AGENT_REF"; }
swe_node_dir()  { printf '%s/node/%s' "$MONCHO_BENCH_HOME" "$NODE_VERSION"; }
swe_pred_dir()  { printf '%s/predictions' "$BENCH_DIR"; }

# The node tarball is keyed by version *and* architecture: an arm64 host and an amd64
# host must not share a cache, and the digest of the wrong one would be a silent
# failure inside the container rather than an error here.
swe_node_arch() {
  case "$(uname -m 2>/dev/null)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) die "no pinned Node build for this architecture: $(uname -m)" ;;
  esac
}

# The digest of the agent payload, for the manifest. Long, so it is its own function
# rather than a clause inside write_manifest.
agent_payload_digest() {
  local dir
  dir="$(swe_payload_dir)"
  [ -d "$dir" ] || return 0
  # A content digest of the tree, not of the tarball: the payload is extracted once
  # and reused, so what matters is what is on disk when the run starts.
  (cd "$dir" && find . -type f ! -path './node_modules/*' -print0 2>/dev/null \
    | sort -z | xargs -0 cat 2>/dev/null \
    | digest | cut -d' ' -f1)
}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
# Three steps, all idempotent and all expensive enough to be worth skipping:
#
#   payload  the agent at AGENT_REF, with its dependencies installed, self-contained
#   node     the pinned glibc runtime, mounted into the instance image
#   images   the instance images for the selected subset
#
# There is deliberately no "tools" image. An earlier version built one — alpine plus git
# — for the host side of a rollout, and then never used it: the patch is taken with the
# *host's* own git (swe_extract_patch), which is a plain git and a plain diff and needs no
# container at all. An image that is built and listed but never run is worse than no
# image, because it makes the bench look like it depends on something it does not.
kind_build() {
  swe_build_payload
  swe_build_node
  swe_pull_images
}

# The agent payload, at AGENT_REF. `npm ci --omit=dev` into it makes the tree
# self-contained, which is what lets it be mounted read-only and reused for every
# instance instead of rebuilt per rollout.
swe_build_payload() {
  local dir ref="${AGENT_REF}"
  dir="$(swe_payload_dir)"

  if [ -f "$dir/.bench-ready" ] && [ "$FORCE" != "1" ]; then
    log "Reusing the payload at $dir (AGENT_REF=$ref)"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || die "curl is required to fetch the payload"
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the payload"

  local work
  work="$(mktemp -d)"
  local url
  url="$(swe_tarball_url "$ref")"
  log "Fetching the agent payload: $url"
  curl -fsSL "$url" -o "$work/agent.tar.gz" || {
    rm -rf "$work"
    die "could not download the agent payload at $ref"
  }
  tar -xzf "$work/agent.tar.gz" -C "$work"

  local root
  root="$(find "$work" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  [ -n "$root" ] || { rm -rf "$work"; die "the payload archive contained no directory"; }

  rm -rf "$dir"
  mkdir -p "$(dirname "$dir")"
  mv "$root" "$dir"
  rm -rf "$work"

  # The dependencies the agent imports at run time. A failure here is fatal on
  # purpose: a payload without them starts and dies inside the container, where the
  # error is far harder to read than it is here.
  if command -v npm >/dev/null 2>&1; then
    ( cd "$dir" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
      || ( cd "$dir" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
      || die "could not install the payload's dependencies in $dir (is npm available?)"
  else
    warn "npm not found on the host; the payload may not resolve its dependencies"
    warn "install Node.js on the host, or copy node_modules into $dir yourself"
  fi

  [ -f "$dir/main.js" ] || die "the payload at $dir has no main.js (this is a packaging bug)"
  : > "$dir/.bench-ready"
  log "Payload ready: $dir"
}

swe_tarball_url() {
  local ref="$1" repo="${MONCHO_REPO:-moncho-cli/moncho-cli}" base="${MONCHO_ARCHIVE_BASE:-https://github.com}"
  if [ "$ref" = "main" ] || [ "$ref" = "master" ]; then
    printf '%s/%s/archive/refs/heads/%s.tar.gz' "$base" "$repo" "$ref"
  else
    printf '%s/%s/archive/refs/tags/%s.tar.gz' "$base" "$repo" "$ref"
  fi
}

# The pinned Node, extracted once and mounted at /opt/node. A glibc build, because
# the SWE-bench images are Debian-derived; the probe below is what turns a wrong
# choice into a failed build rather than a mysterious failure mid-rollout.
swe_build_node() {
  local dir arch url
  dir="$(swe_node_dir)"
  arch="$(swe_node_arch)"

  if [ -x "$dir/bin/node" ]; then
    log "Reusing Node $NODE_VERSION at $dir"
    return 0
  fi

  mkdir -p "$(dirname "$dir")"
  # `.tar.gz`, not `.tar.xz`, and the reason is a host dependency rather than size. Node
  # publishes both (54 MB against 30 MB), but unpacking an `.xz` needs the `xz` binary,
  # which is *not* installed by default on every host this runs on — while gzip is
  # everywhere `tar` is. A build that dies on a missing optional decompressor, and explains
  # itself with a tarball name the user never chose, is a worse trade than 24 MB of
  # download. `tar -xzf` needs nothing beyond tar itself.
  url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz"
  log "Fetching Node: $url"
  local work
  work="$(mktemp -d)"
  if ! curl -fsSL "$url" -o "$work/node.tar.gz"; then
    rm -rf "$work"
    die "could not download Node $NODE_VERSION for linux-$arch
       set NODE_VERSION in the Benchfile to a version that publishes a linux-$arch build,
       or install Node into $dir by hand"
  fi
  tar -xzf "$work/node.tar.gz" -C "$work" || { rm -rf "$work"; die "the Node archive would not unpack"; }

  local root
  root="$(find "$work" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  rm -rf "$dir"
  mv "$root" "$dir"
  rm -rf "$work"
  [ -x "$dir/bin/node" ] || die "the extracted Node has no bin/node at $dir"
  log "Node ready: $dir ($("$dir/bin/node" --version 2>/dev/null || echo unknown))"
}

# Pull the instance images for the selected subset. Without a selection, pull nothing
# and say so: 300 images is a lot to fetch for a bench that has not chosen a subset.
swe_pull_images() {
  require_docker
  [ -f "$BENCH_DIR/plan.json" ] || {
    log "No plan yet, so nothing to pull. Run 'moncho-cli bench select' first."
    return 0
  }
  local image
  while IFS= read -r image; do
    [ -n "$image" ] || continue
    if docker image inspect "$image" >/dev/null 2>&1; then
      log "Already present: $image"
    else
      log "Pulling $image"
      docker pull "$image" || warn "could not pull $image; that instance will fail to run"
    fi
  done <<EOF
$(swe_plan_images | sort -u)
EOF
}

# ---------------------------------------------------------------------------
# select, run, grade — each in its own file, all dispatched from here
# ---------------------------------------------------------------------------
kind_select()  { swe_select; }
kind_run()     { swe_run; }
kind_grade()   { swe_grade; }
kind_report()  { command_report "${1:-}"; }

kind_shell() {
  local image
  image="$(swe_first_image)" || die "no instance image yet — run 'moncho-cli bench select' first"
  log "A shell in $image (the workspace is not mounted; this is for inspecting the image)"
  docker run --rm -it --entrypoint /bin/bash "$image" -l
}

kind_clean_images() {
  local image
  while IFS= read -r image; do
    [ -n "$image" ] || continue
    docker image rm "$image" >/dev/null 2>&1 && log "Removed $image"
  done <<EOF
$(swe_plan_images | sort -u)
EOF
}

# The resolved recipe, for `moncho-cli bench explain`. Rendered from the same values `run`
# consumes — never re-derived — so the document cannot describe another run.
kind_explain() {
  local payload node
  payload="$(swe_payload_dir)"
  node="$(swe_node_dir)"

  if [ "$JSON" = "1" ]; then
    local file
    file="$(mktemp)"
    json_open "$file"
    json_key "$file" "dataset" "$(json_string "$SWE_DATASET_REPO")"
    json_key "$file" "subset" "$(json_string "$SUBSET")"
    json_key "$file" "stratify" "$(json_string "$STRATIFY")"
    json_key "$file" "sample" "$(json_int "$SAMPLE")"
    json_key "$file" "payload_dir" "$(json_string "$payload")"
    json_key "$file" "payload_ready" "$(json_bool "$([ -f "$payload/.bench-ready" ] && echo 1)")"
    json_key "$file" "node_dir" "$(json_string "$node")"
    json_key "$file" "node_ready" "$(json_bool "$([ -x "$node/bin/node" ] && echo 1)")"
    json_key "$file" "run_bash_allowed" "$(json_string "$(env_value RUN_BASH_ALLOWED)")"
    json_key "$file" "turns" "$(json_int "$TURNS")"
    json_key "$file" "agent_timeout" "$(json_int "$AGENT_TIMEOUT")"
    json_key "$file" "stall_cycles" "$(json_int "$STALL_CYCLES")"
    json_close "$file"
    rm -f "$file"
    printf '\n'
    return 0
  fi

  printf 'dataset   %s (%s, %s%%) \n' "$SWE_DATASET_REPO" "$SUBSET" "$STRATIFY"
  printf 'sample    %s instance(s)\n' "$SAMPLE"
  printf 'payload   %s%s\n' "$payload" "$([ -f "$payload/.bench-ready" ] && echo ' (ready)' || echo ' (not built)')"
  printf 'node      %s%s\n' "$node" "$([ -x "$node/bin/node" ] && echo " ($("$node/bin/node" --version 2>/dev/null))" || echo ' (not built)')"
  printf 'palette   %s\n' "${RUN_BASH_ALLOWED:-(the agent default)}"
  printf '\n'
  printf 'per instance, %s cycle(s), each one an --exec process:\n' "$TURNS"
  printf '  docker run --rm -i -u %s:%s -v <ws>:/testbed:rw -v %s:/opt/node:ro -v %s:/opt/moncho-cli:ro \\\n' \
    "$(id -u)" "$(id -g)" "$node" "$payload"
  printf '    --entrypoint /bin/bash <instance-image> -lc \\\n'
  printf '      "/opt/node/bin/node /opt/moncho-cli/main.js --exec <prompt> --mode %s"\n' "$AGENT_MODE"
  printf 'patch is taken on the host afterwards:\n'
  printf '  git -C <ws> diff --no-color > diff.patch\n'
}
