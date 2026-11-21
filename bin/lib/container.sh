#!/usr/bin/env bash
# The container lifecycle, deliberately the same shape as start.sh — run, start,
# stop, shell — plus the layer a repository-local script has no reason to have: the
# name, the label and the state volume are all derived from $PWD, so two projects on
# one machine never see each other's container.

RUN_ARGS=()

# The flags every invocation shares: uid mapping, host gateways, the workspace, the
# env file's values, the clock, and where the agent's own state lives.
# The two decisions the entry point makes. Defaulted here as well, so the library is
# usable on its own — a probe, a test — without the argument parser having run first.
MOUNT_MODE="${MOUNT_MODE:-bind}"
STATE_MODE="${STATE_MODE:-volume}"
build_run_args() {
  RUN_ARGS=(
    --name "$CONTAINER_NAME"
    --label "moncho.workspace=$WORKSPACE"
    -u "$(id -u):$(id -g)"
    --add-host=host.containers.internal:host-gateway
    --add-host=host.docker.internal:host-gateway
  )

  case "$MOUNT_MODE" in
    bind)
      # The workspace is the user's checkout, so an edit needs no rebuild — the same
      # deal start.sh offers with its repository.
      RUN_ARGS+=(-v "$WORKSPACE:/app" -w /app)
      # The workspace is read-write, so the two paths the *host* executes are shadowed with
      # read-only mounts of their own: a git hook (or a config that redirects the hook
      # directory) and the env file the runner sources. A nested mount wins over the parent,
      # so git stays readable and runnable inside the container, but nothing the agent does —
      # through a file tool or through run_bash — can write a path the host later runs.
      # Conditional on the path existing: docker creates a *directory* at a mount point that
      # does not exist, and a directory where .env.moncho belongs is worse than no mount.
      if [ -d "$WORKSPACE/.git" ]; then
        RUN_ARGS+=(-v "$WORKSPACE/.git:/app/.git:ro")
      fi
      if [ -f "$WORKSPACE/.env.moncho" ]; then
        RUN_ARGS+=(-v "$WORKSPACE/.env.moncho:/app/.env.moncho:ro")
      fi
      # A project's node_modules is shadowed by an anonymous volume so the tree the
      # image built wins over the host's (start.sh's trick). Conditional on the
      # directory existing, so a non-Node project never has one created inside it and
      # its checkout stays exactly as the user left it.
      if [ -d "$WORKSPACE/node_modules" ]; then
        RUN_ARGS+=(-v /app/node_modules)
      fi
      ;;
    copy|none)
      # No mount: /app is whatever the project image put there.
      RUN_ARGS+=(-w /app)
      ;;
  esac

  # State: sessions, task.md, implementation_plan.md and the log all default under
  # agent/, so the volume only has to sit there (distributing.md 6.7). Under
  # --state-in-repo the bind mount already *is* $PWD/agent.
  if [ "$STATE_MODE" = "volume" ]; then
    RUN_ARGS+=(-v "$STATE_VOLUME:/app/agent")
  fi

  # A read-only .git makes git's optional index refresh fail noisily; this tells git to skip
  # those writes entirely. Read commands (status, diff, log) still work, and the mount stays
  # the boundary.
  RUN_ARGS+=(-e "GIT_OPTIONAL_LOCKS=0")

  # Clock parity: the zone by name, and the host's own file when there is one.
  if [ -n "${TZ:-}" ]; then
    RUN_ARGS+=(-e "TZ=$TZ")
  fi
  if [ -f /etc/localtime ]; then
    RUN_ARGS+=(-v /etc/localtime:/etc/localtime:ro)
  fi

  build_env_flags
  if [ "${#ENV_FLAGS[@]}" -gt 0 ]; then
    RUN_ARGS+=("${ENV_FLAGS[@]}")
  fi

  RUN_ARGS+=("$PROJECT_IMAGE")
}

# `run`: foreground, disposable, and it refuses to fight a container that is already
# up for this workspace — start.sh's behaviour, one workspace at a time.
run_container() {
  ensure_project_image
  if container_running; then
    die "a container for this project is already running ($CONTAINER_NAME):
       attach to it with 'docker start -ai $CONTAINER_NAME',
       open a shell with 'moncho-cli shell',
       or stop it with 'moncho-cli stop'"
  fi
  if container_exists; then
    log "Reusing the existing container $CONTAINER_NAME"
    clipboard_watch_start "$WORKSPACE" "$WATCH_PIDFILE" 0
    docker start -ai "$CONTAINER_NAME"
    clipboard_watch_stop "$WATCH_PIDFILE"
    return 0
  fi

  build_run_args
  local -a disposable=(--rm)
  # --sync-files needs the container to outlive the run: it is the thing copied back.
  if [ "$SYNC_FILES" = "1" ]; then
    disposable=()
  fi
  local -a tty=(-i)
  if [ -t 0 ]; then
    tty=(-it)
  fi

  log "Starting $CONTAINER_NAME (workspace $WORKSPACE)"
  # The watcher serves the selections made during this run, and dies with it (the
  # foreground path is the one where the lifecycle is obvious).
  clipboard_watch_start "$WORKSPACE" "$WATCH_PIDFILE" 0
  # `${arr[@]+"${arr[@]}"}` rather than `"${arr[@]}"`: `disposable` is empty under
  # --sync-files, and an empty array expansion is an unbound variable under `set -u`
  # on bash 3.2, which is what macOS ships.
  docker run ${disposable[@]+"${disposable[@]}"} "${tty[@]}" "${RUN_ARGS[@]}"
  clipboard_watch_stop "$WATCH_PIDFILE"

  if [ "$SYNC_FILES" = "1" ]; then
    sync_back
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

# `start`: detached and persistent, so `shell` or a later attach can rejoin the very
# container the agent is already running in.
start_container() {
  ensure_project_image
  if container_running; then
    die "container $CONTAINER_NAME is already running"
  fi
  if container_exists; then
    log "Starting the existing container $CONTAINER_NAME"
    docker start "$CONTAINER_NAME" >/dev/null
    log "Started: $CONTAINER_NAME"
    clipboard_watch_start "$WORKSPACE" "$WATCH_PIDFILE" 1
    return 0
  fi

  build_run_args
  local -a flags=(-d)
  # A tty at create time is what lets a later `docker start -ai` show the TUI
  # instead of falling back to the line chat.
  if [ -t 0 ]; then
    flags+=(-t)
  fi

  docker run "${flags[@]}" "${RUN_ARGS[@]}" >/dev/null
  log "Started: $CONTAINER_NAME"
  # The container is detached, so the watcher must be too: it keeps running until a
  # `stop` ends it, and its pid lives beside the container's own bookkeeping.
  clipboard_watch_start "$WORKSPACE" "$WATCH_PIDFILE" 1
}

# `stop`: stop and remove every container labelled with this workspace.
stop_container() {
  # The watcher goes first: it serves a container that is about to disappear.
  clipboard_watch_stop "$WATCH_PIDFILE"
  if ! container_exists; then
    warn "no container for this project ($CONTAINER_NAME)"
    return 0
  fi
  local name
  for name in $(docker ps -aq --filter "label=moncho.workspace=$WORKSPACE"); do
    docker stop "$name" >/dev/null 2>&1 || true
    docker rm "$name" >/dev/null 2>&1 || true
    log "Stopped and removed $name"
  done
}

open_shell() {
  container_running || die "no container is running for this project: 'moncho-cli start' (or run) first"
  local -a flags=(-i)
  if [ -t 0 ]; then
    flags+=(-it)
  fi
  docker exec "${flags[@]}" -u "$(id -u)" "$CONTAINER_NAME" sh
}

show_status() {
  log "workspace     $WORKSPACE"
  log "container     $CONTAINER_NAME"
  log "image         $PROJECT_IMAGE"
  log "base image    $BASE_IMAGE"
  if [ "$STATE_MODE" = "volume" ]; then
    log "state         volume $STATE_VOLUME (mounted at /app/agent)"
  else
    log "state         in the checkout ($WORKSPACE/agent)"
  fi
  log "mount         $MOUNT_MODE"
  log "env file      ${ENV_FILE:-(none: $WORKSPACE/.env.moncho is absent)}"
  log "installed at  $MONCHO_HOME"
}

# `--sync-files`: copy /app back into the checkout. Deletions only propagate with
# --sync-delete *and* rsync, and the script says so rather than silently keeping a
# file the user deleted inside the container.
#
# The agent's own state is **never** copied back. `docker cp` carries a mounted
# volume's contents, so `/app/agent` would otherwise travel from the state volume
# into the host's checkout — the raw transcripts and the operator's notebook landing
# on the host, which is exactly what the volume exists to prevent. The exclusion is a
# removal from the staging copy, so both branches get it without a second code path.
sync_back() {
  local name
  name="$(docker ps -aq --filter "label=moncho.workspace=$WORKSPACE" | head -n 1)"
  if [ -z "$name" ]; then
    warn "--sync-files: no container to copy from"
    return 0
  fi
  log "Copying /app back from $name into $WORKSPACE"

  if [ "$SYNC_DELETE" = "1" ] && command -v rsync >/dev/null 2>&1; then
    local tmp
    tmp="$(mktemp -d)"
    docker cp "$name:/app/." "$tmp/"
    rm -rf "$tmp/agent"
    rsync -a --delete "$tmp/" "$WORKSPACE/"
    rm -rf "$tmp"
    return 0
  fi

  if [ "$SYNC_DELETE" = "1" ]; then
    warn "--sync-delete needs rsync on the host; copying back without deletions"
  fi
  # The staging copy is a host path, so the second step is a host `cp`, not `docker cp`
  # (which needs one side to be a container). `cp` is coreutils, so unlike rsync it is
  # always there.
  local staging
  staging="$(mktemp -d)"
  docker cp "$name:/app/." "$staging/"
  rm -rf "$staging/agent"
  cp -a "$staging/." "$WORKSPACE/"
  rm -rf "$staging"
}
