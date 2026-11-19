# Distribution packaging and the maintainer shortcuts.
#
# The project has no build step (plain ES modules), so a Makefile would be ceremony
# for `npm test` alone. It earns its place here for what the packaging work needs and
# cannot express on its own:
#
#   make test          the test suite
#   make check-shell   parse every shipped script and set the executable bits
#   make probe         the docker-free half of the runner's behaviour
#   make payload       stage the distribution payload into build/ and prove that
#                      docs/ and tests/ did not come along
#   make base          bake moncho-agent:$(VERSION) from this checkout, and nothing else
#   make dev           run the agent on this checkout the way it has always been run
#
# `make payload` is the one to run before a release: it applies the installer's own
# allow-list locally, so a packaging mistake shows up here rather than in a user's
# ~/.config. Nothing here needs a network or a Docker daemon except `base` and `dev`.
#
# Two flows, two entry points, never mixed:
#   * a *user* never clones this repository; the installer puts `moncho-cli` on their
#     PATH and every project directory is prepared on its first run (README.md);
#   * a *maintainer* works on this checkout through ./start.sh — that is what `dev`
#     wraps — and `moncho-cli` refuses to prepare the checkout as if it were a
#     project (bin/lib/template.sh#is_agent_checkout).

SHELL := /bin/bash
VERSION ?= dev

.PHONY: help test check-shell probe payload base dev clean

help:
	@echo "make test         run the test suite"
	@echo "make check-shell  bash -n every shipped script, set the exec bits"
	@echo "make probe        docker-free checks of the runner's logic"
	@echo "make payload      stage the distribution payload into build/payload"
	@echo "make base         build moncho-agent:$(VERSION) from this checkout"
	@echo "make dev          run the agent on this checkout (./start.sh run)"
	@echo "make clean        remove build/"

test:
	npm test

check-shell:
	node agent/utils/shell-sanity.mjs

probe:
	node agent/utils/probe-moncho-cli.mjs

payload:
	node agent/utils/probe-payload.mjs $(VERSION)

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
