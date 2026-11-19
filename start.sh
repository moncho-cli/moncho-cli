#!/bin/bash

IMAGE_NAME="moncho"
CONTAINER_NAME="moncho"

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
[ -n "${PULSE_LIMIT:-}" ]     && ENV_FLAGS+=(-e "PULSE_LIMIT=$PULSE_LIMIT")

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
      "${ENV_FLAGS[@]}" \
      "$IMAGE_NAME" \
      node main.js
    echo "Container started: $CONTAINER_NAME"
    ;;
  stop)
    echo "Stopping container..."
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
    docker run --rm -it --name "$CONTAINER_NAME" \
      -u "$(id -u):$(id -g)" \
      --add-host=host.containers.internal:host-gateway \
      --add-host=host.docker.internal:host-gateway \
      -v "$(pwd):/app" \
      -w /app \
      -v /app/node_modules \
      "${ENV_FLAGS[@]}" \
      "$IMAGE_NAME" \
      node main.js
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
  *)
    echo "Usage: $0 {start|stop|run|shell|build}"
    echo "  start: Runs in background"
    echo "  stop:  Stops and removes the container"
    echo "  run:   Runs in foreground (interactive)"
    echo "  shell: Opens a terminal inside the running container"
    echo "  build: Builds the application image from the Dockerfile"
    exit 1
    ;;
esac
