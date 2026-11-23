# Monchofile — Go project
#
# Two rules: the first instruction is FROM moncho-agent, and there is no ENTRYPOINT or
# CMD (moncho-cli appends the agent's own). Everything else is an ordinary Dockerfile.
FROM moncho-agent

# The toolchain, plus git and gcc for `go build` of cgo-free modules with a module
# cache that wants to fetch.
RUN apk add --no-cache go gcc musl-dev make

WORKDIR /app

# Warm the module cache in the image. A workspace bind mount hides /app, so the
# cache is kept outside it — that is the whole point of GOFLAGS below.
#
# The workspace is copied first rather than go.mod/go.sum by name: go.sum does not
# exist until something has resolved dependencies, and a COPY whose source does not
# exist fails the build. `COPY . .` cannot miss.
COPY . .
# No go.sum yet is normal (a module with no dependencies has none until `go mod tidy`
# writes one), so a failure here is a warning, not a broken image.
RUN go mod download || true

ENV GOFLAGS=-mod=mod
ENV GOCACHE=/tmp/go-build
RUN mkdir -p /tmp/go-build && chmod -R a+rwX /tmp/go-build
