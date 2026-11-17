# Implementation Plan - Upgrade start.sh to Start/Stop functionality

## 1. Architecture & Patterns
- **Goal**: Transform `start.sh` from a single-use command into a script that can `start`, `stop`, or `run` (interactive) the application.
- **Key Files**: 
    - `start.sh` (Complete Rewrite)
- **Pattern**: Wrapper script around `docker` commands with state tracking via container name.

## 2. Step-by-Step Implementation Strategy

### Phase 1: Script Logic Design
- I will implement a script that accepts one argument: `start`, `stop`, or `run` (default).
- **Container Name**: I'll use `ollama-toolchain-container` as a consistent name.
- **Command mapping**:
    - `start`: `docker run -d --name ollama-toolchain-container -v $(pwd):/app -v /app/node_modules ollama-toolchain`
    - `stop`: `docker stop ollama-toolchain-container && docker rm ollama-toolchain-container`
    - `run` (default/interactive): `docker run --rm -it -v $(pwd):/app -v /app/node_modules ollama-toolchain`

### Phase 2: Implementation
- [ ] **Step 1**: Rewrite `start.sh`
    - *Context*: The current version uses `podman` and references `index.js` (which doesn't exist, it's `main.js`). It also lacks state management.
    - *Instruction*: Create a robust bash script that:
        1. Sets the image name (`ollama-toolchain`).
        2. Sets the container name (`ollama-toolchain-instance`).
        3. Handles `start` (background), `stop` (stop and remove), and `run` (interactive foreground).
        4. Uses `docker` instead of `podman` (since the user specifically mentioned docker).
        5. Corrects the entry point to `node main.js`.
        6. Includes error handling (e.g., if trying to start a container that is already running).

## 3. Verification
- [ ] **Manual Check**: 
    1. Try `./start.sh run`.
    2. Try `./start.sh start`.
    3. Try `./start.sh stop`.
    4. Ensure `docker ps` shows the container as expected.
