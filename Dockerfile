FROM node:22-alpine

# ---------------------------------------------------------------------------
# System tooling: independent patch oracles
# ---------------------------------------------------------------------------
# The patch workflow cross-checks a change with several *independent*
# implementations instead of trusting a single one:
#   * diff / diff3 (diffutils) - GNU diff, for generating and verifying patches
#   * patch                    - GNU patch, the reference unified-diff applier
#   * git                      - `git apply --check` / `git diff` as a second opinion
# bash is installed because the repo scripts use `#!/bin/bash`.
# A text selection is saved to a file in the workspace (app/clipboard-file.js),
# so no clipboard client is installed: a Unix tool would be a client of a
# display server this container does not have.
# The version checks make the build fail loudly if a package is ever renamed
# or dropped from the Alpine repos.
RUN apk add --no-cache \
      bash \
      diffutils \
      patch \
      git \
 && git --version \
 && patch --version \
 && diff --version

WORKDIR /app

# Copy manifests first so the dependency layer stays cached across source edits.
COPY package*.json ./

# Reproducible install: prefer the lockfile, fall back to a plain install when it
# is absent so the build never breaks. Dev dependencies are installed so `npm test`
# works inside the container; `diff` is also a runtime dependency of the patch tool.
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

# Copy the rest of the application source code
COPY . .

# Fail the build if the patch cross-check oracle is not importable, so a broken
# dependency is caught here rather than mid-task.
RUN node -e "import('diff').then(m => { \
      if (typeof m.applyPatch !== 'function' || typeof m.parsePatch !== 'function') { \
        throw new Error('diff module is missing applyPatch/parsePatch'); \
      } \
      console.log('diff oracle ready (diff@' + m.version + ')'); \
    })"

# ---------------------------------------------------------------------------
# Runtime permissions
# ---------------------------------------------------------------------------
# start.sh runs the container as an arbitrary host UID (`-u $(id -u):$(id -g)`)
# and bind-mounts /app/node_modules as an anonymous volume seeded from this
# image. Because the install above ran as root, that volume is root-owned and a
# non-root runtime user cannot write to it (EACCES on `npm install`). Make it
# group/other writable so the runtime user can add packages.
RUN chmod -R a+rwX /app/node_modules

# HOME is "/" for this image and is not writable by the runtime UID, which makes
# npm try (and fail) to create "/.npm". Point the cache at a world-writable path
# so `npm install <pkg>` works without sudo at runtime.
ENV npm_config_cache=/tmp/.npm
RUN mkdir -p /tmp/.npm && chmod -R a+rwX /tmp/.npm

# Command to run the app
CMD ["node", "main.js"]
