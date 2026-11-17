#!/bin/bash

IMAGE_NAME="ollama-toolchain"
CONTAINER_NAME="ollama-app-container"

case "$1" in
  start)
    echo "Starting container in background..."
    # Check if already running
    if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
      echo "Error: Container '$CONTAINER_NAME' is already running."
      exit 1
    fi
    docker run -d --name "$CONTAINER_NAME" \
      -v "$(pwd):/app" \
      -v /app/node_modules \
      "$IMAGE_NAME"
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
    echo "Running container in foreground (interactive)..."
    docker run --rm -it --name "$CONTAINER_NAME" \
      -v "$(pwd):/app" \
      -v /app/node_modules \
      "$IMAGE_NAME"
    ;;
  shell)
    echo "Entering shell inside container..."
    if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
      docker exec -it "$CONTAINER_NAME" sh
    else
      echo "Error: Container '$CONTAINER_NAME' is not running. Use './start.sh start' first."
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|run|shell}"
    echo "  start: Runs in background"
    echo "  stop:  Stops and removes the container"
    echo "  run:   Runs in foreground (interactive)"
    echo "  shell: Opens a terminal inside the running container"
    exit 1
    ;;
esac
