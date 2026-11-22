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
      curl \
 && git --version \
 && patch --version \
 && diff --version \
 && curl --version

# ---------------------------------------------------------------------------
# Docker: the client always, the daemon for a privileged run
# ---------------------------------------------------------------------------
# The packaging work in this repository is about installing and building the
# agent through docker, so the tooling that exercises it has to exist here.
#
# `docker-cli` (+ buildx, compose) is what actually works in this image, and it
# is the half that matters: pointed at a socket from outside, `docker build` and
# `docker run` are ordinary client calls.
#
#   -v /var/run/docker.sock:/var/run/docker.sock
#
# `docker-engine` (dockerd) is installed too, so the image *can* serve as its own
# daemon — but only when it is started privileged. That is a runtime property,
# not a property of this file: the default runtime drops CAP_SYS_ADMIN, and
# dockerd needs it to mount filesystems and create the namespaces containers
# live in. Measured in this very image: CapEff is 0000000000000000 and
# `unshare -Ur` / `unshare -m` both fail with EPERM, so no daemon can start
# without one of
#
#   docker run --privileged ...
#   docker run --cap-add SYS_ADMIN --device /dev/fuse ...
#
# The version checks make the build fail loudly if a package name is ever renamed
# or dropped from the Alpine repos — the same guard the block above uses.
RUN apk add --no-cache \
      docker-cli \
      docker-cli-buildx \
      docker-cli-compose \
 && docker --version \
 && docker buildx version \
 && docker compose version

# The daemon, and the helpers a daemon needs when it cannot be root. Kept apart from
# the client above so this heavier layer is visible for what it is.
#
# `shadow-subids` (v3.22 community) is what supplies /usr/bin/newuidmap and
# /usr/bin/newgidmap: a rootless daemon maps a subuid range for the uid it runs as,
# which is 1001 here and never root. `docker-rootless-extras` brings rootlesskit,
# slirp4netns and fuse-overlayfs — and, being packaged on top of the `docker`
# metapackage, it makes this layer carry docker-engine too, so do not read the split
# above as the client ever living without the engine in the final image.
#
# `--no-scripts` keeps the openrc service from being wired up: nothing here boots an
# init system, and the daemon is started by whoever runs the container.
#
# The daemon is deliberately *not* started at image build: a RUN step could not start
# it under the default runtime and the build would fail for a reason that has nothing
# to do with this project's code. tests/install-build.test.js gates its build case on
# `docker info` succeeding and says so when it does not.
RUN apk add --no-cache --no-scripts \
      docker-engine \
      shadow-subids \
      docker-rootless-extras \
 && dockerd --version \
 && test -x /usr/bin/newuidmap

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
