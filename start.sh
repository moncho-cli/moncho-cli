#!/bin/bash

IMAGE_NAME="moncho"
CONTAINER_NAME="moncho"

# The host-side clipboard pickup (bin/lib/clipboard-watch.sh): a selection the agent saves
# into the workspace is read on the host and fed to the host's own clipboard tool. Sourced
# by absolute path, so it works whatever directory this script is invoked from.
START_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=bin/lib/clipboard-watch.sh
. "$START_DIR/bin/lib/clipboard-watch.sh"
# Where the watcher's pid is recorded, so `stop` can end it. Named after this checkout.
WATCH_PIDFILE="$START_DIR/.moncho/clipboard-watch.pid"

# Load local .env (if present) so provider settings are available to pass into the container.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Only forward the three provider variables, and only when they are set.
ENV_FLAGS=()
[ -n "${OPENAI_BASE_URL:-}" ] && ENV_FLAGS+=(-e "OPENAI_BASE_URL=$OPENAI_BASE_URL")
[ -n "${OPENAI_API_KEY:-}" ]  && ENV_FLAGS+=(-e "OPENAI_API_KEY=$OPENAI_API_KEY")
[ -n "${OPENAI_MODEL:-}" ]    && ENV_FLAGS+=(-e "OPENAI_MODEL=$OPENAI_MODEL")
[ -n "${CONTEXT_MAX_LENGTH:-}" ] && ENV_FLAGS+=(-e "CONTEXT_MAX_LENGTH=$CONTEXT_MAX_LENGTH")
[ -n "${COMPACTION_OLD_RATIO:-}" ] && ENV_FLAGS+=(-e "COMPACTION_OLD_RATIO=$COMPACTION_OLD_RATIO")
[ -n "${PULSE_LIMIT:-}" ]     && ENV_FLAGS+=(-e "PULSE_LIMIT=$PULSE_LIMIT")
[ -n "${LOG_LEVEL:-}" ]       && ENV_FLAGS+=(-e "LOG_LEVEL=$LOG_LEVEL")
[ -n "${LOG_FILE:-}" ]        && ENV_FLAGS+=(-e "LOG_FILE=$LOG_FILE")
[ -n "${LOG_MAX_BYTES:-}" ]   && ENV_FLAGS+=(-e "LOG_MAX_BYTES=$LOG_MAX_BYTES")
[ -n "${LOG_MAX_FILES:-}" ]   && ENV_FLAGS+=(-e "LOG_MAX_FILES=$LOG_MAX_FILES")

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
