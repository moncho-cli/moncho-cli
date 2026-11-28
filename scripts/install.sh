#!/usr/bin/env bash
#
# Installer: stage the Moncho agent into a user-scoped directory.
#
#   curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/<ref>/scripts/install.sh | bash
#   ./scripts/install.sh --ref v0.1.1
#
# What it does, in order: checks the host, downloads the release tarball into a
# temporary directory, verifies its checksum when the release publishes one, extracts
# into a staging directory, refuses to install if docs/ or tests/ came along, and only
# then swaps the staged tree into place. Nothing is executed straight off the wire, so
# a truncated download cannot leave a half-installed tree behind.
#
# The payload is runtime-only: the agent itself is baked into the `moncho-agent` Docker
# image by `moncho-cli build`, so no Node.js and no npm are needed on the host.
#
# Reference: agent/tmp/distributing.md (sections 4 and 5).

set -euo pipefail

REPO="${MONCHO_REPO:-moncho-cli/moncho-cli}"
REF="${MONCHO_REF:-main}"
# Where the archives are fetched from. GitHub is the real answer; a test (or a mirror)
# points this at a local directory served over file:// instead, which is how the
# installer is proved without the repository being published.
ARCHIVE_BASE="${MONCHO_ARCHIVE_BASE:-https://github.com}"
INSTALL_DIR="${MONCHO_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/moncho-cli}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
FORCE="0"
UNINSTALL="0"

log() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --ref <tag>        install a specific release (default: main)
  --dir <path>       install here instead of ~/.config/moncho-cli
  --no-symlink       do not link moncho-cli into ~/.local/bin
  --force            replace an existing installation whose version is newer or equal
  --uninstall        remove the installation, the symlink and any state volumes note
  -h, --help         this text

Environment:
  MONCHO_REPO        repository to download from (default: moncho-cli/moncho-cli)
  MONCHO_REF         same as --ref
  MONCHO_HOME        same as --dir
  MONCHO_ARCHIVE_BASE  where the archives are fetched from (default: https://github.com)
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
      --ref=*) REF="${1#--ref=}"; shift ;;
      --dir) [ $# -ge 2 ] || die "--dir needs a path"; INSTALL_DIR="$2"; shift 2 ;;
      --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
      --no-symlink) BIN_DIR=""; shift ;;
      --force) FORCE="1"; shift ;;
      --uninstall) UNINSTALL="1"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
}

require_host() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download the release"
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the release"
  if ! command -v docker >/dev/null 2>&1; then
    die "docker is required: the agent runs in a container, so nothing can start without it"
  fi
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (is it running?)"
}

# The published tarball. `main` is served by GitHub's archive endpoint; a release tag
# uses the release asset path, which is what a pinned REF is for. ARCHIVE_BASE is the
# host: GitHub in every real install, a file:// fixture under test.
tarball_url() {
  if [ "$REF" = "main" ] || [ "$REF" = "master" ]; then
    printf '%s/%s/archive/refs/heads/%s.tar.gz' "$ARCHIVE_BASE" "$REPO" "$REF"
  else
    printf '%s/%s/archive/refs/tags/%s.tar.gz' "$ARCHIVE_BASE" "$REPO" "$REF"
  fi
}

download() {
  local url="$1" out="$2"
  log "Downloading $url"
  curl -fsSL "$url" -o "$out" || die "could not download $url"
  if curl -fsSL "$url.sha256" -o "$out.sha256" 2>/dev/null; then
    log "Verifying the checksum"
    ( cd "$(dirname "$out")" && digest_file "$(basename "$out")" > "$out.check" ) || true
    if ! grep -qF "$(cut -d' ' -f1 < "$out.sha256")" "$out.check" 2>/dev/null; then
      die "the downloaded archive does not match its .sha256 (delete it and retry)"
    fi
  else
    warn "the release publishes no .sha256; the archive cannot be verified"
  fi
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  else cksum "$1"
  fi
}

# The payload allow-list. Anything not named here never reaches the installation:
# docs/ and tests/ are the two the distribution is defined by excluding.
copy_payload() {
  local src="$1" dst="$2"
  mkdir -p "$dst/bin" "$dst/templates"
  # The system prompt is config/prompt.md: it travels inside config/ with the rest of
  # the agent's data, so it is never named on its own here.
  cp "$src/main.js" "$src/package.json" "$src/package-lock.json" "$dst/"
  [ -f "$src/Dockerfile.agent" ] && cp "$src/Dockerfile.agent" "$dst/"
  [ -f "$src/LICENSE" ] && cp "$src/LICENSE" "$dst/"
  cp -R "$src/app" "$src/api" "$src/config" "$src/tools" "$src/utils" "$dst/"
  cp -R "$src/bin/." "$dst/bin/"
  cp "$src"/templates/* "$dst/templates/" 2>/dev/null || true
}

# The exclusion is *verified*, not assumed: a docs/ or tests/ entry anywhere in the
# staged tree aborts the install instead of shipping development material.
verify_exclusion() {
  local found
  found="$(find "$1" \( -name docs -o -name tests \) -print -quit 2>/dev/null || true)"
  if [ -n "$found" ]; then
    die "the staged payload contains $found; refusing to install (this is a packaging bug)"
  fi
}

install_payload() {
  local work staged
  work="$(mktemp -d)"
  staged="$(mktemp -d)"
  trap 'rm -rf "$work" "$staged"' EXIT

  download "$(tarball_url)" "$work/release.tar.gz"
  tar -xzf "$work/release.tar.gz" -C "$work"

  local root
  root="$(find "$work" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  [ -n "$root" ] || die "the archive did not contain a directory"

  copy_payload "$root" "$staged"
  verify_exclusion "$staged"
  printf '%s\n' "$REF" > "$staged/VERSION"

  if [ -d "$INSTALL_DIR" ] && [ "$FORCE" != "1" ]; then
    local installed
    installed="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || printf 'unknown')"
    # The root layout is what an older installer left behind: it is upgraded in place, so
    # an existing install keeps working. A *different* version is a separate directory
    # under versions/ instead, which is what lets two versions be installed at once.
    if [ "$installed" != "$REF" ] && [ "$installed" != "unknown" ]; then
      install_versioned "$staged" "$REF"
      trap - EXIT
      rm -rf "$work"
      return 0
    fi
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  # The sibling version trees are kept: `versions/<ref>` holds the builds older sessions are
  # pinned to, and a bare `rm -rf $INSTALL_DIR` took them with it — the opposite of what the
  # pin is for (`docs/runtime/session-version`). They are stashed across the swap and restored,
  # so replacing the root tree cannot delete another version's history.
  local kept=""
  if [ -d "$INSTALL_DIR/versions" ]; then
    kept="$(mktemp -d)"
    mv "$INSTALL_DIR/versions" "$kept/versions"
  fi
  rm -rf "$INSTALL_DIR"
  mv "$staged" "$INSTALL_DIR"
  if [ -n "$kept" ]; then
    mv "$kept/versions" "$INSTALL_DIR/versions"
    rmdir "$kept" 2>/dev/null || true
  fi
  chmod 0755 "$INSTALL_DIR/bin/moncho-cli"
  chmod 0755 "$INSTALL_DIR/bin/lib"/*.sh
  trap - EXIT
  rm -rf "$work"
  log "Installed $REF into $INSTALL_DIR"
}

# Install one more version beside the others: `$MONCHO_HOME/versions/<ref>`.
#
# The versions live side by side rather than replacing each other because a session is
# pinned to the version that wrote it (`docs/runtime/session-version`): an upgrade that
# deleted the older tree would make its sessions unopenable, which is the opposite of
# what the pin is for.
install_versioned() {
  local staged="$1" ref="$2" target="$INSTALL_DIR/versions/$2"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  mv "$staged" "$target"
  chmod 0755 "$target/bin/moncho-cli"
  chmod 0755 "$target/bin/lib"/*.sh
  log "Installed $ref into $target"
  log "Run it with --version $ref (the newest version is the default)"
}

# Every ref this installation carries, newest first: the root tree when it holds a staged
# version, plus one ref per directory under `versions/`.
#
# The root tree is in the list because it is a real installed version, not just a mount
# point: the first install stages it there. The runner sorts the same two sources the same
# way (`bin/lib/common.sh#moncho_versions`), and the two must agree — the link below and the
# version a plain `moncho-cli` runs are the same question.
installed_refs() {
  {
    if [ -f "$INSTALL_DIR/VERSION" ]; then cat "$INSTALL_DIR/VERSION"; fi
    if [ -d "$INSTALL_DIR/versions" ]; then ls -1 "$INSTALL_DIR/versions" 2>/dev/null || true; fi
  } | sort -Vr
}

link_binary() {
  [ -n "$BIN_DIR" ] || return 0
  mkdir -p "$BIN_DIR"

  # Point the entry at the NEWEST installed tree rather than at the root. The first version
  # lives at the root and every later one under versions/<ref>, so a link pinned to the root
  # kept running the *first* version after a newer one was installed — the user re-ran the
  # installer and `moncho-cli` was still the old code. The root is used only when it really is
  # the newest (a first install), or when no versions/ tree carries the runner.
  local newest target
  newest="$(installed_refs | head -n 1)"
  [ -n "$newest" ] || die "no installed version to link"

  target="$INSTALL_DIR/versions/$newest/bin/moncho-cli"
  [ -f "$target" ] || target="$INSTALL_DIR/bin/moncho-cli"
  [ -f "$target" ] || die "no runner for $newest under $INSTALL_DIR"

  ln -sf "$target" "$BIN_DIR/moncho-cli"
  log "Linked $BIN_DIR/moncho-cli -> $target"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      log ""
      log "$BIN_DIR is not on your PATH. Add it with:"
      log "  export PATH=\"$BIN_DIR:\$PATH\""
      log "(the installer does not edit your shell configuration)"
      ;;
  esac
}

next_steps() {
  log ""
  log "Next: go to a project directory and run it. The first run does the rest."
  log "  cd ~/some/project && moncho-cli"
  log "That first run, in a directory with no Monchofile yet:"
  log "  * adopts ./Dockerfile when one is there (its first FROM becomes the agent"
  log "    base, so the agent's runtime sits under your app's own tooling), or"
  log "  * asks for the project type and writes a Monchofile from a starter"
  log "then bakes moncho-agent:$REF if it is missing, builds the project image,"
  log "and starts the agent. Nothing else needs preparing first."
  log ""
  # The one thing this installer does *not* bring, because a bench measures the agent and
  # must not travel inside it. A reader who only ever sees this output would otherwise meet
  # the companion seam's refusal ("no companion 'moncho-bench' was found on PATH") and
  # reasonably read it as a bug. scripts/ is not part of the payload, so naming it here
  # costs the container nothing (docs/agent/host-fence).
  log "To *measure* the agent on a benchmark, install the bench companion separately:"
  log "  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/bench/install.sh | bash"
  log "It stages 'moncho-bench' and links it onto PATH; 'moncho-cli bench' then reaches it."
  log "It is deliberately not part of the agent's own install (bench/README.md)."
}

uninstall() {
  # The link is what the installer created, but a user who worked around a broken
  # link has a regular file there instead (`exec ~/.config/moncho-cli/bin/moncho-cli`).
  # Guarding only on -L left that behind with no word about it, so anything at the name
  # is removed — and a regular file says so, because it was not the installer's to own.
  if [ -n "$BIN_DIR" ] && { [ -L "$BIN_DIR/moncho-cli" ] || [ -f "$BIN_DIR/moncho-cli" ]; }; then
    if [ -L "$BIN_DIR/moncho-cli" ]; then
      rm -f "$BIN_DIR/moncho-cli"
      log "Removed $BIN_DIR/moncho-cli (symlink)"
    else
      rm -f "$BIN_DIR/moncho-cli"
      log "Removed $BIN_DIR/moncho-cli (a regular file, not the installer's symlink)"
    fi
  fi
  if [ -d "$INSTALL_DIR" ]; then
    # Read the version *before* removing the tree: the image the user is told to delete is
    # tagged with the version that was installed, not with whatever `--ref` defaulted to.
    REMOVED_VERSION="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || printf '%s' "$REF")"
    rm -rf "$INSTALL_DIR"
    log "Removed $INSTALL_DIR"
  fi
  # Images and state volumes are not removed for the user: images may be shared with
  # other installs, and a state volume is the user's session history. Deleting either
  # silently would be a surprise. The commands are printed instead.
  log ""
  log "The Docker images were left in place. To remove them:"
  log "  docker image rm moncho-agent:${REMOVED_VERSION:-$REF} \$(docker images -q --filter reference='moncho-project:*')"
  # Each installed version has its own base image (`moncho-agent:<version>`), so the one
  # tag above is only the default's. Naming the rest keeps a user from leaving four
  # hundred megabytes behind per version by accident.
  log "  (one image per version: also 'docker images --filter reference='moncho-agent:*'')"
  log ""
  log "Session state was left in place too: one volume per workspace you ran it in."
  log "That is the agent's conversation history, so removing it is your call:"
  log "  docker volume ls --filter name=moncho-state- --format '{{.Name}}' | xargs -r docker volume rm"
}

main() {
  parse_args "$@"
  if [ "$UNINSTALL" = "1" ]; then
    uninstall
    return 0
  fi
  require_host
  install_payload
  link_binary
  next_steps

  # No analytics, no fingerprints, no request to anything but the release URL above.
}

main "$@"
