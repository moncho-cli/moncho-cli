#!/usr/bin/env bash
# What happens when there is no Monchofile yet: adopt the Dockerfile the project
# already has, or offer a starter — and never a blocking prompt in a run that has
# nobody to answer it (distributing.md 6.3 step 4, 8).
#
# The order is the one the user expects: a project that already carries a Dockerfile
# describing its own tooling is adopted first, because that file already knows more
# about the app than a template can. A starter is only generated when there is nothing
# to adopt.

# The one directory moncho-cli must never prepare: the agent's own checkout.
#
# A checkout carries a Dockerfile that belongs to the *maintainer's* loop -- it starts
# from node:22-alpine and ends with `CMD ["node", "main.js"]` -- so adopting it would
# rewrite the maintainer's own file and drop the CMD that makes `./start.sh run` work.
# The two flows stay separate: this repository is developed through start.sh, and every
# other directory is a project the runner prepares.
#
# The test is *identity*, never layout: "is there a src/ folder, a tests/ tree, a docs/
# tree" would stop matching the day one of them is renamed or moved, and the failure is
# the expensive one -- moncho-cli would quietly adopt the maintainer's own Dockerfile.
# So it asks the two questions only the agent can answer yes to: the manifest declares
# the program's name, and the entry point that manifest declares is there. A project
# cannot answer both by accident, and a *renamed or reorganised* checkout still does,
# which is exactly what layout markers could not do.
AGENT_PACKAGE_NAME="moncho-cli"

# The override for the one case a heuristic cannot win: a project that really is called
# moncho-cli and really does ship a main.js. It is explicit, it is documented in the
# refusal message, and it never guesses.
MONCHO_AS_PROJECT="${MONCHO_AS_PROJECT:-0}"

is_agent_checkout() {
  [ "$MONCHO_AS_PROJECT" = "1" ] && return 1
  local dir="${1:-$WORKSPACE}"
  local manifest="$dir/package.json" declared
  [ -f "$manifest" ] || return 1
  # The *value* of the field, not a substring of the file: the same one-sed read
  # validate_monchofile() already uses, so no jq and no second JSON parser.
  declared="$(sed -nE 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$manifest" | head -n 1)"
  [ "$declared" = "$AGENT_PACKAGE_NAME" ] || return 1
  # The entry point that manifest declares. A package that merely borrows the name is
  # not the agent; a renamed or moved copy of the checkout still is.
  [ -f "$dir/main.js" ] || return 1
  return 0
}

# The one message the maintainer flow gets, printed by both entry points into it: the
# gate (bin/lib/git.sh#prepare_workspace_git, before any docker work) and the prepare
# path (bin/lib/image.sh#ensure_monchofile, the backstop for a library used alone).
# One copy, so the two can never drift apart.
agent_checkout_notice() {
  log "This is the Moncho agent's own checkout, so there is nothing to prepare here."
  log "  develop it with ./start.sh run (or: make dev) -- the app source is bind-mounted"
  log "  a user project is any other directory: run moncho-cli there and it prepares it"
  log "  to prepare this directory anyway: MONCHO_AS_PROJECT=1 moncho-cli"
}

TEMPLATE_KINDS="node python go minimal"

template_dir() { printf '%s/templates' "$MONCHO_HOME"; }

# What the project looks like, by the markers each ecosystem leaves in a repository
# root. The answer preselects the menu and nothing else: detection never writes a file
# on its own, because a wrong guess would be a silent mistake.
detect_kind() {
  local dir="$WORKSPACE"
  if [ -f "$dir/package.json" ]; then printf 'node'
  elif [ -f "$dir/pyproject.toml" ] || [ -f "$dir/requirements.txt" ] || [ -f "$dir/setup.py" ]; then printf 'python'
  elif [ -f "$dir/go.mod" ]; then printf 'go'
  else printf 'minimal'
  fi
}

print_templates() {
  local kind index=0
  for kind in $TEMPLATE_KINDS; do
    index=$((index + 1))
    if [ "$kind" = "${1:-}" ]; then
      log "  $index) $kind   (detected)"
    else
      log "  $index) $kind"
    fi
  done
}

# The whole contract in one screen. Deliberately no example longer than the two
# rules: a Monchofile is an ordinary Dockerfile, and pretending otherwise is how
# people stop reading.
authoring_guide() {
  cat <<'EOF'

A Monchofile is an ordinary Dockerfile with two rules:

  1. its first instruction is   FROM moncho-agent
     (the agent is already in that base image: never copy it yourself, and the tag
     is rewritten to the installed version for you)
  2. it must not declare ENTRYPOINT or CMD
     moncho-cli appends the agent's own entrypoint after your instructions, so the
     agent always runs; a CMD would be handed to it as arguments

Everything else is normal: packages for your language, WORKDIR, COPY, VOLUME, USER.
Keep a .dockerignore next to it so build output and .moncho/ stay out of the image.

Already have a Dockerfile? Leave it here and run moncho-cli again: it is adopted by
rewriting its first FROM to moncho-agent and keeping the rest, so the agent's runtime
sits underneath whatever your app needs.
EOF
}

# Copy a starter into the project. It never overwrites: a generated Monchofile that
# already exists is the user's file, whatever it says.
scaffold_template() {
  local kind="$1" from
  from="$(template_dir)/Monchofile.$kind"
  [ -f "$from" ] || die "unknown template '$kind' (available: $TEMPLATE_KINDS)"
  [ -f "$WORKSPACE/Monchofile" ] && die "a Monchofile already exists in $WORKSPACE: not overwriting it"

  cp "$from" "$WORKSPACE/Monchofile"
  log "Wrote $WORKSPACE/Monchofile (from Monchofile.$kind)"

  if [ -f "$(template_dir)/.dockerignore.$kind" ] && [ ! -f "$WORKSPACE/.dockerignore" ]; then
    cp "$(template_dir)/.dockerignore.$kind" "$WORKSPACE/.dockerignore"
    log "Wrote $WORKSPACE/.dockerignore (from .dockerignore.$kind)"
  fi
}

# Which base images the agent's own runtime can stand in for. The base is
# node:22-alpine, so only an Alpine-flavoured Node image is a safe substitute: a
# Debian-flavoured `node:22` would take the project's own `apk`/`apt` instructions
# with it. Anything else is reported rather than guessed at.
base_is_replaceable() {
  local image="$1"
  case "$image" in
    moncho-agent*) return 0 ;;
    *alpine*) return 0 ;;
    node:*) return 0 ;;
    *) return 1 ;;
  esac
}

# Adopt the Dockerfile the project already has: its first FROM becomes the agent base
# and every other instruction is kept, so the agent's runtime sits underneath whatever
# the app needs. The original file is never touched — the result is a Monchofile.
#
# Two shapes are refused instead of repaired, because either would produce an image
# that cannot start the agent:
#   * a multi-stage file, where the last stage is what ships and the agent may not be
#     in it at all;
#   * a base the agent's Alpine runtime cannot stand in for.
adopt_dockerfile() {
  local file="$WORKSPACE/Dockerfile" first stages
  stages="$(grep -ciE '^[[:space:]]*FROM[[:space:]]' "$file" 2>/dev/null || true)"

  if [ "${stages:-0}" -gt 1 ]; then
    warn "the Dockerfile is multi-stage, so the agent cannot be guaranteed in the final image"
    warn "keep a single stage whose first instruction is 'FROM moncho-agent' (see the guide below)"
    return 1
  fi

  first="$(grep -m1 -iE '^[[:space:]]*FROM[[:space:]]' "$file" 2>/dev/null | sed -E 's/^[[:space:]]*FROM[[:space:]]+//I' || true)"
  first="${first%% *}"
  if [ -z "$first" ]; then
    warn "the Dockerfile has no FROM instruction, so there is nothing to adopt"
    return 1
  fi
  if ! base_is_replaceable "$first"; then
    warn "the Dockerfile starts from '$first', which the agent's Alpine base cannot stand in for"
    warn "put 'FROM moncho-agent' first and keep your instructions below it (see the guide below)"
    return 1
  fi

  # Rewrite the first FROM, and drop ENTRYPOINT/CMD: the runner appends its own, and a
  # CMD left in place would be passed to the agent's entrypoint as arguments.
  local dropped=0
  {
    printf '# Adopted from ./Dockerfile by moncho-cli. The original file is untouched.\n'
    printf '# The first FROM was rewritten to the agent base; the container start command was dropped.\n'
    awk '
      BEGIN { rewritten = 0 }
      {
        line = tolower($0)
        if (line ~ /^[[:space:]]*entrypoint[[:space:]]/ || line ~ /^[[:space:]]*cmd[[:space:]]/) next
        if (!rewritten && line ~ /^[[:space:]]*from[[:space:]]/) { print "FROM moncho-agent"; rewritten = 1; next }
        print
      }
    ' "$file"
  } > "$WORKSPACE/Monchofile"

  dropped="$(grep -ciE '^[[:space:]]*(ENTRYPOINT|CMD)([[:space:]]|$)' "$file" 2>/dev/null || true)"
  log "Adopted $WORKSPACE/Dockerfile as $WORKSPACE/Monchofile"
  log "  base rewritten to moncho-agent (the runner pins the installed version)"
  [ "${dropped:-0}" -gt 0 ] && log "  dropped $dropped ENTRYPOINT/CMD line(s): the agent supplies its own"
  return 0
}

# No Monchofile: adopt an existing Dockerfile, else ask when there is someone to ask,
# otherwise hand over the guide and leave the exit code at 0.
offer_templates() {
  if [ -f "$WORKSPACE/Dockerfile" ]; then
    adopt_dockerfile && return 0
  fi

  local detected
  detected="$(detect_kind)"
  log "No Monchofile in $WORKSPACE yet."

  if [ "$ASSUME_YES" = "1" ]; then
    scaffold_template "$detected"
    return 0
  fi

  if [ ! -t 0 ]; then
    log "Templates available:"
    print_templates "$detected"
    authoring_guide
    return 0
  fi

  log "Templates available:"
  print_templates "$detected"
  printf 'Number (empty takes the detected one, q for the guide): '
  local answer
  read -r answer || answer=""

  case "$answer" in
    q|Q|guide) authoring_guide; return 0 ;;
    "") scaffold_template "$detected"; return 0 ;;
  esac

  local kind index=0
  for kind in $TEMPLATE_KINDS; do
    index=$((index + 1))
    if [ "$answer" = "$index" ]; then
      scaffold_template "$kind"
      return 0
    fi
  done

  warn "not a template number: nothing was written"
  authoring_guide
}
