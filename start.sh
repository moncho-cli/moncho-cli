#!/bin/bash

IMAGE_NAME="moncho"
CONTAINER_NAME="moncho"

# The host-side clipboard pickup (bin/lib/clipboard-watch.sh): a selection the agent saves
# into the workspace is read on the host and fed to the host's own clipboard tool. Sourced
# by absolute path, so it works whatever directory this script is invoked from.
# Resolved through any symlink first, for the same reason bin/moncho-cli does it
# (`install.sh#link_binary` links that runner into ~/.local/bin): `dirname` of the path
# this script was *reached* by is not where its libraries live once it is a link.
START_SOURCE="${BASH_SOURCE[0]}"
while [ -L "$START_SOURCE" ]; do
  START_LINK_DIR="$(cd "$(dirname "$START_SOURCE")" && pwd -P)"
  START_SOURCE="$(readlink "$START_SOURCE")"
  case "$START_SOURCE" in
    /*) ;;
    *) START_SOURCE="$START_LINK_DIR/$START_SOURCE" ;;
  esac
done
START_DIR="$(cd "$(dirname "$START_SOURCE")" && pwd -P)"
# shellcheck source=bin/lib/clipboard-watch.sh
. "$START_DIR/bin/lib/clipboard-watch.sh"
# The env-file rule is shared with the runner (`bin/lib/env.sh`): the file is *sourced* as
# shell, and the names it defines are what cross into the container. Sourcing the library
# rather than repeating it is the point — this script used to carry its own allow-list, and
# an allow-list is a second place for the env grammar to drift: a name added to the app and
# not to the list simply never arrived, silently (`CHUNKPACTION_ENABLED` was lost that way).
# shellcheck source=bin/lib/env.sh
. "$START_DIR/bin/lib/env.sh"
# Where the watcher's pid is recorded, so `stop` can end it. Named after this checkout.
WATCH_PIDFILE="$START_DIR/.moncho/clipboard-watch.pid"

# Moncho's configuration lives in `./.env` here, and **only** here — this is the maintainer
# flow, which runs from the checkout. `.env.moncho` is the *other* flow's file: `moncho-cli`
# reads it in whatever project directory it is invoked from, and this script never looks at
# it. See CONTRIBUTING.md (maintainer) and USAGE.md (user); the two names are deliberately
# different so a project's own credentials can never become the agent's provider.
#
# Nothing below enumerates the variables. `resolve_env_file` picks the file (an explicit
# `--env` would win, but this flow has no flag for it — the file is the convention),
# `load_env_file` sources it and records the names it defines, and `build_env_flags` turns
# each name into `-e NAME`, so docker reads the value out of this process's environment
# rather than out of the command line. A name the file mentions but this shell does not
# export is simply unset in the container, which is docker's own behaviour for a bare `-e`.
MONCHO_ENV_FILE=".env"
# `-r`, not `-f`: `resolve_env_file` refuses an unreadable file with `die`, which belongs to
# the runner's library (`bin/lib/common.sh`) and is not sourced here. Guarding on readability
# keeps that branch unreachable, so this script depends on nothing it does not load.
if [ -r "$MONCHO_ENV_FILE" ]; then
  resolve_env_file "$MONCHO_ENV_FILE"
  load_env_file
fi
build_env_flags

# Build the application image from ./Dockerfile (installs deps incl. `diff`).
build_image() {
  echo "Building image '$IMAGE_NAME' from ./Dockerfile..."
  docker build -t "$IMAGE_NAME" . || { echo "Error: docker build failed."; exit 1; }
}

# Build the image only when it does not exist yet. The app source is bind-mounted
# live, so a rebuild is only needed when dependencies change.
ensure_image() {
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    build_image
  fi
}

case "$1" in
  start)
    echo "Starting container in background..."
    ensure_image
    # Check if already running
    if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
      echo "Error: Container '$CONTAINER_NAME' is already running."
      exit 1
    fi
    docker run -d --name "$CONTAINER_NAME" \
      -u "$(id -u):$(id -g)" \
      --add-host=host.containers.internal:host-gateway \
      --add-host=host.docker.internal:host-gateway \
      -v "$(pwd):/app" \
      -w /app \
      -v /app/node_modules \
      -e MONCHO_MAINTAINER=1 \
      "${ENV_FLAGS[@]}" \
      "$IMAGE_NAME" \
      node main.js
    echo "Container started: $CONTAINER_NAME"
    # Detached: the watcher outlives this script, and `stop` is what ends it.
    clipboard_watch_start "$(pwd)" "$WATCH_PIDFILE" 1
    ;;
  stop)
    echo "Stopping container..."
    clipboard_watch_stop "$WATCH_PIDFILE"
    if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
      docker stop "$CONTAINER_NAME" && docker rm "$CONTAINER_NAME"
      echo "Container stopped and removed."
    else
      echo "Error: Container '$CONTAINER_NAME' was not found."
      exit 1
    fi
    ;;
  run)
    echo "Running application in foreground (interactive)..."
    ensure_image
    # The watcher lives exactly as long as this run: it reads what the agent saves into
    # the workspace and feeds the host's clipboard, then goes when the container does.
    clipboard_watch_start "$(pwd)" "$WATCH_PIDFILE" 0
    docker run --rm -it --name "$CONTAINER_NAME" \
      -u "$(id -u):$(id -g)" \
      --add-host=host.containers.internal:host-gateway \
      --add-host=host.docker.internal:host-gateway \
      -v "$(pwd):/app" \
      -w /app \
      -v /app/node_modules \
      -e MONCHO_MAINTAINER=1 \
      "${ENV_FLAGS[@]}" \
      "$IMAGE_NAME" \
      node main.js
    clipboard_watch_stop "$WATCH_PIDFILE"
    ;;
  build)
    build_image
    ;;
  shell)
    echo "Entering shell inside container..."
    if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
      docker exec -it -u "$(id -u)" "$CONTAINER_NAME" sh
    else
      echo "Error: Container '$CONTAINER_NAME' is not running. Use './start.sh start' first."
      exit 1
    fi
    ;;
  exec)
    # One command inside the running container, the suite being the usual one:
    # ./start.sh exec npm test. Node, npm and the dev dependencies live in the image.
    shift
    if [ "$#" -eq 0 ]; then
      echo "Usage: $0 exec <command> [args...]" >&2
      exit 1
    fi
    if [ -z "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
      echo "Error: Container '$CONTAINER_NAME' is not running. Use './start.sh start' first." >&2
      exit 1
    fi
    if [ -t 0 ]; then
      exec docker exec -it -u "$(id -u)" "$CONTAINER_NAME" "$@"
    fi
    exec docker exec -i -u "$(id -u)" "$CONTAINER_NAME" "$@"
    ;;
  *)
    echo "Usage: $0 {start|stop|run|shell|exec|build}"
    echo "  start: Runs in background"
    echo "  stop:  Stops and removes the container"
    echo "  run:   Runs in foreground (interactive)"
    echo "  shell: Opens a terminal inside the running container"
    echo "  exec:  Runs one command inside it (e.g. exec npm test)"
    echo "  build: Builds the application image from the Dockerfile"
    exit 1
    ;;
esac
