#!/usr/bin/env bash
# The `uninstall` verb: remove the installation the installer staged.
#
# Why it lives here and not only in scripts/install.sh: the installer is *not* part of
# the payload it installs (scripts/install.sh says so itself), so the only way to run the
# uninstaller today is to fetch it again over the network. But the runner is already on
# PATH, already knows where `MONCHO_HOME` is, and is the one thing guaranteed to be
# installed — so it is the right home for the verb. `scripts/install.sh --uninstall`
# stays, because it has to work when the tree is broken or half-removed.
#
# Sourced by bin/moncho-cli, never executed. Needs no docker unless --purge is asked for.

# The directory the installer links into. Same default as scripts/install.sh, spelled the
# same way, so an uninstall finds what an install created.
MONCHO_BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

# Where this library itself lives, for the one case that matters below: when the runner
# is the installed copy, removing the tree deletes the file bash is still reading.
uninstall_self_dir() {
  local source="${BASH_SOURCE[0]}"
  while [ -L "$source" ]; do
    local dir
    dir="$(cd "$(dirname "$source")" && pwd -P)"
    source="$(readlink "$source")"
    case "$source" in /*) ;; *) source="$dir/$source" ;; esac
  done
  ( cd "$(dirname "$source")" && pwd -P )
}

uninstall_usage() {
  cat <<'EOF'
Usage: moncho-cli uninstall [--purge [--yes]]

Removes what the installer put in place: the ~/.local/bin entry and the staged tree in
MONCHO_HOME (default ~/.config/moncho-cli). The Docker images and the state volumes are
left alone unless --purge is given.

Options:
  --purge    also remove the moncho-agent and moncho-project images, and every
             moncho-state-* volume. The volumes hold your session history, so this
             needs --yes as well.
  --yes, -y  agree to --purge without asking again

Your project directories are never touched: a Monchofile, a .env.moncho and a .moncho/
directory stay exactly where they are.
EOF
}

# Everything docker-side, which is the only part that needs the daemon. Deliberately the
# same commands scripts/install.sh prints, so the two never recommend different things.
uninstall_purge() {
  local containers images volumes
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker is not on PATH; the images and volumes were left in place"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "the docker daemon is not reachable; the images and volumes were left in place"
    return 0
  fi

  containers="$(docker ps -aq --filter "label=moncho.workspace" 2>/dev/null || true)"
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086
    docker rm -f $containers >/dev/null 2>&1 || true
    log "Removed the running containers"
  fi

  images="$(docker images -q --filter reference='moncho-agent:*' --filter reference='moncho-project:*' 2>/dev/null || true)"
  if [ -n "$images" ]; then
    # shellcheck disable=SC2086
    docker image rm -f $images >/dev/null 2>&1 || true
    log "Removed the moncho-agent and moncho-project images"
  fi

  volumes="$(docker volume ls -q --filter name=moncho-state- 2>/dev/null || true)"
  if [ -n "$volumes" ]; then
    # shellcheck disable=SC2086
    docker volume rm $volumes >/dev/null 2>&1 || true
    log "Removed $(printf '%s\n' "$volumes" | wc -l | tr -d ' ') state volume(s): your session history"
  fi
}

uninstall_moncho() {
  local target="$MONCHO_HOME"
  local purge="0"

  case "${PURGE:-0}" in 1) purge="1" ;; esac

  # Checked *before* anything is removed, so `--purge` without the consent flag is a
  # refusal rather than a half-finished uninstall. The volumes are the user's session
  # history and cannot be recovered, so this is not a prompt that a `yes |` pipe can
  # answer by accident: the flag has to be typed.
  if [ "$purge" = "1" ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    die "--purge removes your session history; pass --yes as well (or drop --purge)"
  fi

  # Removing the *checkout* would be a catastrophe, and MONCHO_HOME=. is a documented way
  # to use this runner without an install at all — so the guard is not paranoia, it is the
  # one case a maintainer actually hits.
  #
  # is_agent_checkout() is not usable here: the installed payload carries main.js and a
  # package.json with the same name, by design, so it answers "checkout" for every real
  # installation. What the payload never carries is the source tree — agent/, docs/,
  # tests/ — so one of those plus the manifest is what identifies a checkout.
  if [ -f "$target/main.js" ] && { [ -d "$target/agent" ] || [ -d "$target/docs" ] || [ -d "$target/tests" ]; }; then
    die "$target is the Moncho agent's own checkout; refusing to remove it (nothing was deleted)"
  fi
  if [ ! -d "$target" ] && [ ! -e "$MONCHO_BIN_DIR/moncho-cli" ]; then
    log "Nothing to uninstall: neither $target nor $MONCHO_BIN_DIR/moncho-cli is there"
    return 0
  fi

  # The bin entry first, before the tree it points at: a dangling link is worse than none.
  # A regular file is removed too — a user who worked around a broken link wrote one — and
  # says so, because it was not the installer's to own.
  if [ -L "$MONCHO_BIN_DIR/moncho-cli" ]; then
    rm -f "$MONCHO_BIN_DIR/moncho-cli"
    log "Removed $MONCHO_BIN_DIR/moncho-cli (symlink)"
  elif [ -f "$MONCHO_BIN_DIR/moncho-cli" ]; then
    rm -f "$MONCHO_BIN_DIR/moncho-cli"
    log "Removed $MONCHO_BIN_DIR/moncho-cli (a regular file, not the installer's symlink)"
  fi

  if [ "$purge" = "1" ]; then
    uninstall_purge
  else
    log ""
    log "The Docker images and the session volumes were left in place. To remove them:"
    log "  moncho-cli uninstall --purge --yes"
    log "(do it before this command is gone, or use:)"
    log "  docker image rm \$(docker images -q --filter reference='moncho-agent:*' --filter reference='moncho-project:*')"
    log "  docker volume ls --filter name=moncho-state- --format '{{.Name}}' | xargs -r docker volume rm"
  fi

  # The tree last, and through `exec`: when the runner being run *is* the installed copy,
  # deleting the tree pulls the file out from under bash, which reads a script
  # incrementally. Replacing the shell with `rm` means nothing is read after the delete.
  if [ -d "$target" ]; then
    log "Removing $target"
    if case "$(uninstall_self_dir)" in "$target"/*) true ;; *) false ;; esac; then
      exec rm -rf "$target"
    fi
    rm -rf "$target"
  fi
}