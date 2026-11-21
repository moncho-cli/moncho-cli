#!/usr/bin/env bash
# Picking a selection up from the workspace and putting it on the *host's* clipboard.
#
# The container cannot reach the clipboard: it has no display server, so a Unix clipboard
# tool has nothing to talk to, and an OSC 52 sequence is only a hope. So the copy is
# written to a file in the workspace (app/clipboard-file.js), and this runs on the *host* —
# where the clipboard actually lives — reads each new file and feeds it to the host's own
# tool.
#
# That is the whole trick: the workspace is bind-mounted, so the file the container writes
# is the file the host reads. No socket is forwarded, no privilege is granted, and OSC 52
# is not involved.
#
# Sourced by bin/moncho-cli and start.sh; never executed on its own. It depends on nothing
# from lib/common.sh, so start.sh can source it without the rest of the runner.

# The prefix app/clipboard-file.js writes (and the gitignore glob that matches it).
CLIPBOARD_FILE_PREFIX=".moncho.clipboard."
# How often the workspace is looked at. The copy is a convenience, so half a second keeps
# it feeling immediate without spinning. Overridable so a test does not wait.
CLIPBOARD_POLL_SECONDS="${CLIPBOARD_POLL_SECONDS:-0.5}"

# The host's clipboard tool, as a command line, or nothing when the host has none.
#
# The order is by how directly each tool reaches the clipboard the user pastes from: macOS
# and WSL have exactly one each, and Wayland and X11 have a preferred client. A host with
# no display server (a bare SSH session) gets nothing, and then there is no watcher to
# start — there is no clipboard for it to feed.
#
# MONCHO_UNAME and the display variables are injectable so a test can drive every branch
# without owning a display server.
pick_clipboard_tool() {
  local name="${MONCHO_UNAME:-$(uname -s 2>/dev/null || true)}"

  if [ "$name" = "Darwin" ] && command -v pbcopy >/dev/null 2>&1; then
    printf 'pbcopy'
    return 0
  fi

  # WSL ships Windows' own clip.exe, which reaches the real Windows clipboard.
  if command -v clip.exe >/dev/null 2>&1; then
    printf 'clip.exe'
    return 0
  fi

  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
    printf 'wl-copy'
    return 0
  fi

  if [ -n "${DISPLAY:-}" ]; then
    if command -v xclip >/dev/null 2>&1; then
      printf 'xclip -selection clipboard'
      return 0
    fi
    if command -v xsel >/dev/null 2>&1; then
      printf 'xsel --clipboard --input'
      return 0
    fi
  fi

  return 0
}

# Hand one file to the tool. Silent on purpose: the agent's TUI owns the terminal, and a
# watcher that printed would corrupt the display it exists to serve.
feed_clipboard_file() {
  local file="$1" tool="$2"
  [ -s "$file" ] || return 0
  # shellcheck disable=SC2086  # the tool is a command line, so its words are arguments
  $tool < "$file" >/dev/null 2>&1 || true
}

# The poll loop, running until it is killed — which is exactly what its lifetime means:
# as long as the container whose selections it serves.
#
# A file is copied on the poll *after* the one that first saw it, and only when its size
# did not change in between. That is what makes a file still being written safe to read:
# the clipboard is never handed half a selection.
clipboard_watch_loop() {
  local dir="$1" tool="$2"
  local copied sizes next
  copied="$(mktemp)" || return 0
  sizes="$(mktemp)" || { rm -f "$copied"; return 0; }
  next="$(mktemp)" || { rm -f "$copied" "$sizes"; return 0; }
  # A signal must clean up *and* leave: `trap` with a bare command runs it and resumes,
  # which would make the watcher unkillable. `exit 0` is what makes `stop` work.
  # shellcheck disable=SC2064  # the paths are already fixed; expanding them now is right
  trap "rm -f '$copied' '$sizes' '$next'; exit 0" EXIT INT TERM

  # A watcher serves the selections made *while it runs*, so everything already in the
  # workspace is marked as seen before the first poll. Without this, starting the agent in
  # a directory where a selection was saved last week would silently overwrite the
  # clipboard on startup — the one thing a watcher must never do.
  local primed
  while IFS= read -r primed; do
    [ -n "$primed" ] || continue
    basename "$primed" >> "$copied"
  done < <(find "$dir" -maxdepth 1 -name "${CLIPBOARD_FILE_PREFIX}*" -type f 2>/dev/null)

  local file name size was
  while :; do
    : > "$next"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      name="$(basename "$file")"
      # Already handled, or already here when the watcher started: never re-copy.
      if grep -qxF "$name" "$copied" 2>/dev/null; then
        continue
      fi

      # `|| true` on both: under `set -e` a failing substitution would end the loop,
      # and a file that vanished mid-poll is not a reason to stop watching.
      size="$(wc -c < "$file" 2>/dev/null | tr -d ' ' || true)"
      [ -n "$size" ] || continue

      # The size the *previous* poll saw. `|| true` because grep finding no line is the
      # normal first sighting, not an error.
      was="$(grep -F "$name:" "$sizes" 2>/dev/null | tail -n 1 | cut -d: -f2 || true)"

      # Copied only when the size held from one poll to the next, so a selection still
      # being written is never handed to the clipboard half finished.
      if [ "$was" = "$size" ]; then
        feed_clipboard_file "$file" "$tool"
        printf '%s\n' "$name" >> "$copied"
      fi
      printf '%s:%s\n' "$name" "$size" >> "$next"
    done < <(find "$dir" -maxdepth 1 -name "${CLIPBOARD_FILE_PREFIX}*" -type f 2>/dev/null | sort)

    # Rewritten rather than appended: the state stays as small as the directory is.
    mv "$next" "$sizes"
    sleep "$CLIPBOARD_POLL_SECONDS"
  done
}

# Start the watcher for one workspace, optionally recording its pid so a later `stop` can
# end it. Prints nothing and returns 0 even without a clipboard tool: a host with none
# still works, it simply has no clipboard to fill.
#
# `detach` is what tells the two runs apart. A foreground `run` keeps the watcher as its
# own child and ends it when the container returns; a detached `start` outlives the
# launcher, so the watcher has to as well — `setsid` puts it in its own session, and
# `disown` is the fallback on a host without it (macOS).
clipboard_watch_start() {
  local dir="$1" pidfile="${2:-}" detach="${3:-0}"
  local tool
  tool="${MONCHO_CLIPBOARD_TOOL:-$(pick_clipboard_tool)}"
  [ -n "$tool" ] || return 0

  # The watcher is a background function, and `$!` is its real pid. `$$` inside that
  # subshell is the *launcher's* pid, which is why the launcher — not the loop — records
  # the pidfile: a pidfile naming the wrong process makes `stop` kill nothing at all.
  clipboard_watch_loop "$dir" "$tool" >/dev/null 2>&1 &
  CLIPBOARD_WATCH_PID=$!
  if [ -n "$pidfile" ] && [ -n "$CLIPBOARD_WATCH_PID" ]; then
    mkdir -p "$(dirname "$pidfile")" 2>/dev/null || true
    printf '%s\n' "$CLIPBOARD_WATCH_PID" > "$pidfile" 2>/dev/null || true
  fi
  # A detached watcher must outlive the shell that started it, or it dies with the
  # launcher and the clipboard is never fed. `disown` drops it from the job table, so no
  # SIGHUP reaches it on the way out. (`setsid` is not used: it is an external command and
  # cannot invoke a shell function.)
  if [ "$detach" = "1" ]; then
    disown "$CLIPBOARD_WATCH_PID" 2>/dev/null || true
  fi
  return 0
}
# End the watcher this shell started, and any recorded in the pidfile. Idempotent: the
# pidfile is removed, so a second call and a call with nothing running both do nothing.
clipboard_watch_stop() {
  local pidfile="${1:-}"

  if [ -n "$pidfile" ] && [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile" 2>/dev/null || true
  fi

  if [ -n "${CLIPBOARD_WATCH_PID:-}" ]; then
    kill "$CLIPBOARD_WATCH_PID" 2>/dev/null || true
    CLIPBOARD_WATCH_PID=""
  fi
  return 0
}
