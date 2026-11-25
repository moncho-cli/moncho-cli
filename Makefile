# Distribution packaging and the maintainer shortcuts.
#
# The project has no build step (plain ES modules), so a Makefile would be ceremony
# for `npm test` alone. It earns its place here for what the packaging work needs and
# cannot express on its own:
#
#   make test          the test suite
#   make lint          the static gate: no-undef as an error, no-unused-vars a warning
#   make check-shell   parse every shipped script and set the executable bits
#   make probe         the docker-free half of the runner's behaviour
#   make payload       stage the distribution payload into build/ and prove that
#                      docs/ and tests/ did not come along
#   make install       install from a local archive and build the base image (the
#                      daemon-dependent half of tests/install-build.test.js)
#   make bump          move the version a session owes (default: a patch step)
#   make release       check the next release and print the URLs the install uses
#   make base          bake moncho-agent:$(VERSION) from this checkout, and nothing else
#   make dev           run the agent on this checkout the way it has always been run
#
# `make payload` is the one to run before a release: it applies the installer's own
# allow-list locally, so a packaging mistake shows up here rather than in a user's
# ~/.config. Nothing here needs a network or a Docker daemon except `base`, `dev`
# and `install` — whose daemon-dependent case reports why it skipped.
#
# Two flows, two entry points, never mixed:
#   * a *user* never clones this repository; the installer puts `moncho-cli` on their
#     PATH and every project directory is prepared on its first run (README.md);
#   * a *maintainer* works on this checkout through ./start.sh — that is what `dev`
#     wraps — and `moncho-cli` refuses to prepare the checkout as if it were a
#     project (bin/lib/template.sh#is_agent_checkout).

SHELL := /bin/bash
VERSION ?= dev
BUMP ?= patch

.PHONY: help test lint check-shell probe payload install bump release base dev clean

help:
	@echo "make test         run the test suite"
	@echo "make lint         the static gate: no-undef at error strength"
	@echo "make check-shell  bash -n every shipped script, set the exec bits"
	@echo "make probe        docker-free checks of the runner's logic"
	@echo "make payload      stage the distribution payload into build/payload"
	@echo "make install      install from a local archive and build the base image"
	@echo "make bump         move the version (BUMP=minor|major|patch)"
	@echo "make release      check the next release, print the install URLs"
	@echo "make base         build moncho-agent:$(VERSION) from this checkout"
	@echo "make dev          run the agent on this checkout (./start.sh run)"
	@echo "make clean        remove build/"

test:
	npm test

# The one spelling CI and the agent share (docs/maintainer/lint): eslint.config.js.
lint:
	npm run lint

check-shell:
	node agent/utils/shell-sanity.mjs

probe:
	node agent/utils/probe-moncho-cli.mjs

payload:
	node agent/utils/probe-payload.mjs $(VERSION)

# The install path proved against a local archive, and — when a daemon is reachable —
# a dedicated container that installs and builds the agent. Without a daemon the suite
# reports why it skipped instead of failing, so this target is safe to run anywhere.
install:
	node --test tests/install-build.test.js

# One step is enough even when a session changed many things
# (docs/maintainer/version-bump): this rewrites the manifest and both lockfile
# versions together, which is the mistake it exists to prevent.
bump:
	node scripts/bump-version.mjs --$(BUMP)

# The tag is declared by package.json#version, never discovered. Nothing is tagged,
# committed or pushed: this checks the documents and prints the commands to run.
release:
	node scripts/release.mjs

# MONCHO_HOME=. is what makes this work without an installer run: the runner bakes
# moncho-agent:$(VERSION) from the payload it was pointed at. --base-only stops before
# the project image, because a checkout has no project Monchofile by design.
base:
	MONCHO_HOME=. ./bin/moncho-cli --build-base --base-only build

# The maintainer's local loop, unchanged: the app source is bind-mounted and the
# container runs `node main.js` with the provider variables start.sh reads from .env.
dev:
	./start.sh run

clean:
	rm -rf build
