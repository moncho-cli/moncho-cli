#!/usr/bin/env bash
# The workspace as a git repository: the precondition, and the one write moncho makes
# to keep its own files out of the user's history.
#
# Why a repository is required at all: moncho writes inside the directory it works on
# (`.moncho/`, and `agent/` when the state is kept in the repo). A working tree is the
# only thing that lets those files be excluded *reliably*, and the tool assumes a
# checkout anyway — an agent that patches code without version control gives the user no
# way back. `--skip-git` is the escape hatch for a deliberate exception.
#
# Why the *local* exclude file and not `.gitignore`: `$GIT_DIR/info/exclude` is never
# committed, so excluding moncho's directories cannot appear in the user's `git status`
# as a modified file, cannot be accidentally committed, and cannot surprise a teammate.
# "Do not contaminate the repository" is taken literally here.

# The repository the workspace belongs to, or empty when it is not in one.
workspace_git_root() {
  git -C "$WORKSPACE" rev-parse --show-toplevel 2>/dev/null || true
}

# The absolute path of the local exclude file (`git rev-parse --git-path` already
# resolves the worktree case, where $GIT_DIR is not the directory holding info/).
local_exclude_file() {
  local path
  path="$(git -C "$WORKSPACE" rev-parse --git-path info/exclude 2>/dev/null)" || return 1
  [ -n "$path" ] || return 1
  case "$path" in
    /*) printf '%s' "$path" ;;
    *) printf '%s/%s' "$WORKSPACE" "$path" ;;
  esac
}

# One line, added once. Anchored to the repository root, so the pattern means the same
# thing whatever directory inside the repo the user invokes moncho from.
add_exclude_pattern() {
  local file="$1" pattern="$2"
  [ -f "$file" ] || : > "$file"
  if grep -qxF "$pattern" "$file" 2>/dev/null; then
    return 0
  fi
  # A trailing newline is not guaranteed in a hand-edited file.
  if [ -s "$file" ] && [ -n "$(tail -c 1 "$file" 2>/dev/null)" ]; then
    printf '\n' >> "$file"
  fi
  printf '%s\n' "$pattern" >> "$file"
  EXCLUDES_ADDED="${EXCLUDES_ADDED:-0}"
  EXCLUDES_ADDED=$((EXCLUDES_ADDED + 1))
}

# Exclude the directories moncho writes inside the workspace. Idempotent: a second run
# adds nothing and says nothing.
ensure_local_excludes() {
  local file prefix rel
  file="$(local_exclude_file)" || return 0
  # The workspace may be a subdirectory of the repository, so the pattern needs the
  # path from the root (ignore patterns are matched relative to the file's directory).
  rel="${WORKSPACE#"$(workspace_git_root)"}"
  rel="${rel#/}"
  if [ -n "$rel" ]; then prefix="/$rel"; else prefix=""; fi

  add_exclude_pattern "$file" "${prefix}/.moncho/"
  # The state directory only lands in the workspace under --state-in-repo; excluding it
  # unconditionally is harmless and means a later switch cannot leak a stray file.
  add_exclude_pattern "$file" "${prefix}/agent/"

  if [ "${EXCLUDES_ADDED:-0}" -gt 0 ]; then
    log "Kept moncho's own files out of git in $file"
  fi
}

# The gate, and the one entry point the runner calls. Everything that prepares or runs
# the project goes through it; `status`, `stop` and `shell` do not, so a session can
# always be inspected and cleaned up — a refusal that also blocked those would strand
# the user with a container they cannot stop.
prepare_workspace_git() {
  local root

  # The agent's own checkout is the maintainer's flow: `./start.sh` runs the app. Neither
  # the gate nor the exclude write belongs here, so a stray run never touches this
  # repository — but it is told why, rather than exiting as a silent no-op.
  if is_agent_checkout; then
    # A base-image build is meant to run *here* (`make base`, and its --build-base flag),
    # so it passes through untouched instead of being sent to ./start.sh. A plain
    # `--rebuild run` is not a base build, so it keeps the notice.
    case "${BASE_ONLY:-0}${BUILD_BASE:-0}" in
      *1*) return 0 ;;
    esac
    # Otherwise say so and stop before any docker work: a silent no-op would leave the
    # user wondering why nothing happened. One copy of the message lives in template.sh.
    agent_checkout_notice
    exit 0
  fi

  root="$(workspace_git_root)"

  if [ "${SKIP_GIT:-0}" = "1" ]; then
    if [ -n "$root" ]; then
      ensure_local_excludes
    else
      warn "--skip-git: there is no repository at $WORKSPACE, so moncho's files cannot be excluded"
      warn "            anything written here will show up as untracked"
    fi
    return 0
  fi

  if [ -z "$root" ]; then
    die "refusing to work in $WORKSPACE: it is not a git repository
       moncho writes inside the directory it works on (.moncho/, and agent/ for
       --state-in-repo), and a repository is what keeps those out of your history.
       Run 'git init' here, use a directory inside an existing repository, or pass
       --skip-git if you really mean to work without version control."
  fi

  ensure_local_excludes
}