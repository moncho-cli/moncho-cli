#!/usr/bin/env bash
#
# Installer: stage the bench framework into a user-scoped directory.
#
#   curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/<ref>/bench/install.sh | bash
#   ./bench/install.sh --ref v0.1.1
#
# Deliberately the same shape as scripts/install.sh, and for the same reason: the two
# entry points are used by the same people, so a difference in how they resolve a ref,
# stage a tree or link a command would be a trap rather than a feature.
#
# What is *different* is what gets staged. The agent's installer copies an allow-list
# that never contains bench/, so this one fetches the same release tarball and copies
# only bench/. One release, two entry points, and neither ships the other's material.
#
# Reference: bench/README.md (the contract this implements).

set -euo pipefail

REPO="${MONCHO_REPO:-moncho-cli/moncho-cli}"
REF="${MONCHO_REF:-main}"
ARCHIVE_BASE="${MONCHO_ARCHIVE_BASE:-https://github.com}"
INSTALL_DIR="${MONCHO_BENCH_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/moncho-bench}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
FORCE="0"
UNINSTALL="0"
# The companion the agent's CLI reaches as `moncho-cli bench ...`. The program installed
# here is `moncho-bench` — the name bin/lib/subcommand.sh looks up — and CLI_NAME keeps
# the two words apart so the prose below cannot drift into naming the wrong one.
BIN_NAME="moncho-bench"
CLI_NAME="moncho-cli bench"

log() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Stages the bench framework. A bench itself is made afterwards, in any directory:

  moncho-cli bench init --kind swe --name my-bench

These are the commands of the companion `moncho-bench`, which the agent's own CLI reaches
as `moncho-cli bench ...` (docs/runtime/cli-subcommands).

Options:
  --ref <tag>        install a specific release (default: main)
  --dir <path>       install here instead of ~/.config/moncho-bench
  --no-symlink       do not link moncho-bench into ~/.local/bin
  --force            replace an existing installation of the same ref
  --uninstall        remove the installation and the symlink (benches are kept)
  -h, --help         this text

Environment:
  MONCHO_REPO        repository to download from (default: moncho-cli/moncho-cli)
  MONCHO_REF         same as --ref
  MONCHO_BENCH_HOME  same as --dir
  MONCHO_ARCHIVE_BASE  where archives are fetched from (default: https://github.com)

Nothing but the release URL above is contacted: no analytics, no fingerprints.
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

# curl and tar are required; docker is not. The framework stages and inspects itself
# without a daemon, so `init`, `status` and `explain` stay usable on a machine whose
# daemon is down — which is exactly when someone reads `explain`.
require_host() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download the release"
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the release"
}

tarball_url() {
  if [ "$REF" = "main" ] || [ "$REF" = "master" ]; then
    printf '%s/%s/archive/refs/heads/%s.tar.gz' "$ARCHIVE_BASE" "$REPO" "$REF"
  else
    printf '%s/%s/archive/refs/tags/%s.tar.gz' "$ARCHIVE_BASE" "$REPO" "$REF"
  fi
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  else cksum "$1"
  fi
}

download() {
  local url="$1" out="$2"
  log "Downloading $url"
  curl -fsSL "$url" -o "$out" || die "could not download $url"
  if curl -fsSL "$url.sha256" -o "$out.sha256" 2>/dev/null; then
    log "Verifying the checksum"
    local expected
    expected="$(cut -d' ' -f1 < "$out.sha256")"
    if ! digest_file "$out" | grep -qF "$expected"; then
      die "the downloaded archive does not match its .sha256 (delete it and retry)"
    fi
  else
    warn "the release publishes no .sha256; the archive cannot be verified"
  fi
}

# The staged tree: bench.sh, its libraries, the kinds, and nothing else. The repo's
# docs/ and tests/ are excluded for the same reason the agent's installer excludes
# them — development material is not payload. So are the SWE-bench artefacts a run
# produces, which live outside the framework by construction.
copy_payload() {
  local src="$1" dst="$2"
  mkdir -p "$dst/lib" "$dst/kinds"
  cp "$src/bench/bench.sh" "$dst/"
  cp "$src/bench/README.md" "$dst/" 2>/dev/null || true
  cp "$src/bench/install.sh" "$dst/" 2>/dev/null || true
  cp -R "$src/bench/lib/." "$dst/lib/"
  cp -R "$src/bench/kinds/." "$dst/kinds/"
}

# Verified, not assumed: anything that looks like development material aborts the
# install rather than shipping. This is the check that keeps the two installers
# honest about what each of them owns.
verify_exclusion() {
  local found
  found="$(find "$1" \( -name docs -o -name tests -o -name node_modules \) -print -quit 2>/dev/null || true)"
  if [ -n "$found" ]; then
    die "the staged framework contains $found; refusing to install (this is a packaging bug)"
  fi
  [ -f "$1/bench.sh" ] || die "the staged framework has no bench.sh; refusing to install"
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
  [ -d "$root/bench" ] || die "this release has no bench/ directory (nothing to install)"

  copy_payload "$root" "$staged"
  verify_exclusion "$staged"
  printf '%s\n' "$REF" > "$staged/VERSION"

  # One directory per ref, so two installed revisions can be compared — which is the
  # whole point of a framework whose releases are meant to be pinned by a result.
  if [ -d "$INSTALL_DIR/versions/$REF" ] && [ "$FORCE" != "1" ]; then
    die "$INSTALL_DIR/versions/$REF already exists (use --force to replace it)"
  fi

  mkdir -p "$INSTALL_DIR/versions"
  rm -rf "$INSTALL_DIR/versions/$REF"
  mv "$staged" "$INSTALL_DIR/versions/$REF"
  printf '%s\n' "$REF" > "$INSTALL_DIR/VERSION"
  chmod 0755 "$INSTALL_DIR/versions/$REF/bench.sh"
  chmod 0755 "$INSTALL_DIR/versions/$REF/install.sh" 2>/dev/null || true
  # Every library ships non-executable: they are sourced, never run, and the executable
  # bit on a sourced file invites someone to try running one directly.
  chmod 0644 "$INSTALL_DIR/versions/$REF/lib/"*.sh 2>/dev/null || true

  trap - EXIT
  rm -rf "$work"
  log "Installed $REF into $INSTALL_DIR/versions/$REF"
}

link_binary() {
  [ -n "$BIN_DIR" ] || return 0
  mkdir -p "$BIN_DIR"
  # The link points at the newest installed ref. A bench pins its framework in
  # manifest.json, so a later install changing what `moncho-cli bench` means cannot silently
  # change what an old result meant.
  local newest
  newest="$(ls -1 "$INSTALL_DIR/versions" 2>/dev/null | sort -Vr | head -n 1)"
  [ -n "$newest" ] || die "no installed framework to link"
  ln -sf "$INSTALL_DIR/versions/$newest/bench.sh" "$BIN_DIR/$BIN_NAME"
  log "Linked $BIN_DIR/$BIN_NAME -> $INSTALL_DIR/versions/$newest/bench.sh"

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
  cat <<EOF

Next: make a bench and run it.
  mkdir -p ~/benches/swe-lite && cd ~/benches/swe-lite
  $CLI_NAME init --kind swe --name swe-lite
  \$EDITOR .env.bench          # the provider, the model and the key for THIS bench
  $CLI_NAME build && $CLI_NAME select && $CLI_NAME run && $CLI_NAME grade

Each bench is a directory. Two benches never share images, results or credentials, so
two providers — or two models — can be measured side by side without interference.

Those commands are the companion installed as '$BIN_NAME'; the agent's CLI reaches it
through the generic subcommand rule (docs/runtime/cli-subcommands). Both spellings work,
and '$BIN_NAME' is the one to use where the agent's CLI is not installed.
EOF
}

uninstall() {
  if [ -n "$BIN_DIR" ] && { [ -L "$BIN_DIR/$BIN_NAME" ] || [ -f "$BIN_DIR/$BIN_NAME" ]; }; then
    if [ -L "$BIN_DIR/$BIN_NAME" ]; then
      rm -f "$BIN_DIR/$BIN_NAME"
      log "Removed $BIN_DIR/$BIN_NAME (symlink)"
    else
      rm -f "$BIN_DIR/$BIN_NAME"
      log "Removed $BIN_DIR/$BIN_NAME (a regular file, not the installer's symlink)"
    fi
  fi
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "Removed $INSTALL_DIR"
  fi
  # Benches are never touched. They hold results that took real money to produce, and
  # they live outside the install directory precisely so that removing the framework
  # cannot take them with it.
  log ""
  log "Your benches were left alone: they are the directories you made, and they hold"
  log "the results. Remove one by deleting its directory."
  log "The images a bench pulled are also left in place:"
  log "  docker images --filter reference='swebench/sweb.eval.*'"
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
}

main "$@"
