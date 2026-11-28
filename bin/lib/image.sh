#!/usr/bin/env bash
# Images: the agent base baked from the installed payload, and the project image
# built from the workspace's own Monchofile (distributing.md 6.5, 9/D1, 9/D6).

# Bake moncho-agent:<version> from the staged payload. /opt/moncho-cli is the module
# root, because api/ollama.js reads config/prompt.md and app/brand.js imports package.json
# *relative to it* — so the layout has to survive the copy.
build_base_image() {
  # The context is the *resolved version's* tree (`resolve_workspace` sets PAYLOAD_DIR from
  # `moncho_payload_dir`), not the install root: once a second version is installed the root
  # still holds the first one, and building from it would bake the old code under the new
  # tag — the version the image claims and the code inside it would disagree. Defaulted for a
  # caller that resolves no workspace (`MONCHO_HOME=. bin/moncho-cli build --base` in a
  # checkout).
  local context="${PAYLOAD_DIR:-${MONCHO_HOME:-}}"
  [ -f "$context/main.js" ] || die "no agent payload in $context (run the installer, or set MONCHO_HOME)"
  [ -f "$context/Dockerfile.agent" ] || die "no Dockerfile.agent in $context"
  log "Building $BASE_IMAGE from $context"
  docker build -t "$BASE_IMAGE" -f "$context/Dockerfile.agent" "$context"
}

ensure_base_image() {
  docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || build_base_image
}

# The two rules a Monchofile must obey, checked before anything is built. Both are
# refusals rather than repairs: guessing what the user meant here is how a project
# ends up with an image that cannot start the agent.
validate_monchofile() {
  local file="$WORKSPACE/Monchofile" first
  [ -f "$file" ] || die "there is no Monchofile in $WORKSPACE"
  first="$(grep -m1 -E '^[[:space:]]*[A-Za-z]' "$file" 2>/dev/null | sed -E 's/^[[:space:]]+//' || true)"
  case "${first:-}" in
    FROM[[:space:]]moncho-agent*) ;;
    *)
      die "the first instruction of Monchofile must be 'FROM moncho-agent' (found: ${first:-nothing})"
      ;;
  esac
  if grep -qiE '^[[:space:]]*ENTRYPOINT([[:space:]]|$)' "$file"; then
    die "Monchofile must not declare ENTRYPOINT: moncho-cli appends the agent's own (distributing.md 6.5)"
  fi
  if grep -qiE '^[[:space:]]*CMD([[:space:]]|$)' "$file"; then
    die "Monchofile must not declare CMD: the agent's appended ENTRYPOINT would receive it as arguments"
  fi
}

# No Monchofile yet: offer the starters, and stop cleanly when the guide was what
# came out instead (distributing.md 6.3 step 4).
#
# The agent's own checkout is the one exception, and it stops *before* the offer: this
# repository is developed through ./start.sh (its Dockerfile belongs to that loop), so
# preparing it as a project would rewrite the maintainer's own file. The two flows are
# deliberately separate; see bin/lib/template.sh#is_agent_checkout.
ensure_monchofile() {
  [ -f "$WORKSPACE/Monchofile" ] && return 0
  if is_agent_checkout; then
    # The same message the runner's git gate prints, from bin/lib/template.sh, so the
    # two entries into the maintainer flow can never drift apart.
    agent_checkout_notice
    exit 0
  fi
  offer_templates
  [ -f "$WORKSPACE/Monchofile" ] || exit 0
}

# The generated Dockerfile: the Monchofile with its FROM rewritten to the tag that is
# actually installed, followed by the enforced tail.
#
# Two decisions live in these twelve lines:
#   * rewriting FROM is what makes the installed agent authoritative — a Monchofile
#     cannot pin a version that is not on this machine;
#   * appending the tail *after* the user's instructions is what makes the entrypoint
#     impossible to override, which is the whole reason the contract exists.
generate_project_dockerfile() {
  mkdir -p "$MONCHO_DIR"
  {
    awk -v base="$BASE_IMAGE" '
      !rewritten && tolower($1) == "from" && $2 ~ /^moncho-agent/ { print "FROM " base; rewritten = 1; next }
      { print }
    ' "$WORKSPACE/Monchofile"
    cat <<EOF

# ---------------------------------------------------------------------------
# Appended by moncho-cli. Everything below is owned by the runner: a Monchofile
# that could set its own ENTRYPOINT could stop the agent from starting at all.
# ---------------------------------------------------------------------------
WORKDIR /app
RUN [ -d /app/node_modules ] && chmod -R a+rwX /app/node_modules || true
ENV npm_config_cache=/tmp/.npm
RUN mkdir -p /tmp/.npm && chmod -R a+rwX /tmp/.npm
ENTRYPOINT ["node", "/opt/moncho-cli/main.js"]
EOF
  } > "$MONCHO_DIR/Dockerfile"
}

# What the project image was built from: the base image's id and the Monchofile's
# bytes. The answer is stored as an image *label*, so the rebuild decision survives
# a deleted .moncho/ and travels with the image rather than beside it.
project_fingerprint() {
  local base_id
  base_id="$(docker image inspect -f '{{.Id}}' "$BASE_IMAGE" 2>/dev/null || printf 'missing')"
  printf '%s\n%s\n' "$base_id" "$(moncho_hash "$WORKSPACE/Monchofile")" | digest | cut -c1-16
}

build_project_image() {
  local fingerprint="$1"
  generate_project_dockerfile
  log "Building $PROJECT_IMAGE from $WORKSPACE/Monchofile"
  docker build \
    -t "$PROJECT_IMAGE" \
    -f "$MONCHO_DIR/Dockerfile" \
    --label "moncho.workspace=$WORKSPACE" \
    --label "moncho.fingerprint=$fingerprint" \
    "$WORKSPACE"
}

# Build when the image is missing, when the base image or the Monchofile changed, or
# when --rebuild says so. A match means no `docker build` is invoked at all.
ensure_project_image() {
  local fingerprint current
  ensure_monchofile
  validate_monchofile
  ensure_base_image
  fingerprint="$(project_fingerprint)"

  if ! docker image inspect "$PROJECT_IMAGE" >/dev/null 2>&1; then
    build_project_image "$fingerprint"
    return 0
  fi

  current="$(docker image inspect -f '{{index .Config.Labels "moncho.fingerprint"}}' "$PROJECT_IMAGE" 2>/dev/null || true)"
  if [ "$REBUILD" = "1" ]; then
    log "Rebuilding $PROJECT_IMAGE (--rebuild)"
    build_project_image "$fingerprint"
  elif [ "$current" != "$fingerprint" ]; then
    log "Rebuilding $PROJECT_IMAGE (the Monchofile or the base image changed)"
    build_project_image "$fingerprint"
  else
    log "Reusing image $PROJECT_IMAGE"
  fi
}

# `moncho-cli build`: the project image, rebuilt unconditionally.
build_project_image_now() {
  # --base-only is the maintainer's `make base`: bake the agent image from a checkout
  # that carries no project Monchofile by design, and stop there. It must run before
  # ensure_monchofile, because the checkout is the one directory never prepared.
  if [ "${BASE_ONLY:-0}" = "1" ]; then
    ensure_base_image
    return 0
  fi
  ensure_monchofile
  validate_monchofile
  ensure_base_image
  build_project_image "$(project_fingerprint)"
}
