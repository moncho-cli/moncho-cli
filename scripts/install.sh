#!/usr/bin/env bash
#
# Installer: stage the Moncho agent into a user-scoped directory.
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/<ref>/scripts/install.sh | bash
#   ./scripts/install.sh --ref v0.1.0
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
  --uninstall        remove the installation and the symlink
  -h, --help         this text

Environment:
  MONCHO_REPO        <org>/<repo> to download from
  MONCHO_REF         same as --ref
  MONCHO_HOME        same as --dir
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
# uses the release asset path, which is what a pinned REF is for.
tarball_url() {
  if [ "$REF" = "main" ] || [ "$REF" = "master" ]; then
    printf 'https://github.com/%s/archive/refs/heads/%s.tar.gz' "$REPO" "$REF"
  else
    printf 'https://github.com/%s/archive/refs/tags/%s.tar.gz' "$REPO" "$REF"
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
    if [ "$installed" != "$REF" ]; then
      die "$INSTALL_DIR already holds $installed (use --force to replace it with $REF)"
    fi
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR"
  mv "$staged" "$INSTALL_DIR"
  chmod 0755 "$INSTALL_DIR/bin/moncho-cli"
  chmod 0755 "$INSTALL_DIR/bin/lib"/*.sh
  trap - EXIT
  rm -rf "$work"
  log "Installed $REF into $INSTALL_DIR"
}

link_binary() {
  [ -n "$BIN_DIR" ] || return 0
  mkdir -p "$BIN_DIR"
  ln -sf "$INSTALL_DIR/bin/moncho-cli" "$BIN_DIR/moncho-cli"
  log "Linked $BIN_DIR/moncho-cli"

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
}

uninstall() {
  if [ -n "$BIN_DIR" ] && [ -L "$BIN_DIR/moncho-cli" ]; then
    rm -f "$BIN_DIR/moncho-cli"
    log "Removed $BIN_DIR/moncho-cli"
  fi
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "Removed $INSTALL_DIR"
  fi
  # Images are not removed for the user: they may be shared with other installs, and
  # deleting them silently would be a surprise. The command is printed instead.
  log ""
  log "The Docker images were left in place. To remove them:"
  log "  docker image rm moncho-agent:${REF} \$(docker images -q --filter reference='moncho-project:*')"
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
