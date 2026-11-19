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
COPY go.mod go.sum ./
RUN go mod download || true

COPY . .

ENV GOFLAGS=-mod=mod
ENV GOCACHE=/tmp/go-build
RUN mkdir -p /tmp/go-build && chmod -R a+rwX /tmp/go-build
