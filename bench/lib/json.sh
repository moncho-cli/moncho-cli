#!/usr/bin/env bash
# A small JSON writer, in shell, because the bench framework runs on the *host*.
#
# The agent itself runs in a container and the host is not required to have Node.js
# (`scripts/install.sh#require_host` asks for curl, tar and docker, and nothing else).
# So the provenance record, the ledger and `--json` output are all written here rather
# than by a runtime we would then have to install and pin.
#
# The surface is deliberately tiny — escape one string, then build objects and arrays
# out of raw values — because that is the whole of what a bench writes. Anything more
# expressive would be better served by the `swe` kind's own scripts.

# Escape a string for use inside a JSON string literal.
#
# Two details are load-bearing, and both were found by probing rather than by
# reading:
#
#  * `RS="\001"` slurps the whole input as one record. awk otherwise splits on
#    newlines, so a value containing one (a diff stat, a provider error) would be
#    emitted as several lines and produce invalid JSON.
#  * the control characters are stripped by `tr`, not by an awk bracket expression.
#    `gsub(/[\000-\010]/, …)` is not portable — mawk rejects `\000` inside a bracket
#    expression ("bad regex '['"), and because the whole awk program then fails, the
#    command substitution yields the empty string. Every value silently became `""`.
#
# \t (\011), \n (\012) and \r (\015) are deliberately outside the stripped ranges so
# they survive to be escaped properly on the lines below.
json_escape() {
  printf '%s' "${1:-}" \
    | tr -d '\000-\010\013\014\016-\037' \
    | awk 'BEGIN { RS = "\001" } {
        gsub(/\\/, "\\\\\\\\")
        gsub(/"/,  "\\\"")
        gsub(/\t/, "\\t")
        gsub(/\r/, "\\r")
        gsub(/\n/, "\\n")
        printf "%s", $0
      }'
}

# A JSON string literal, quotes included.
json_string() {
  printf '"%s"' "$(json_escape "${1:-}")"
}

# A JSON boolean from the truthiness a shell script actually has.
json_bool() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON|y|Y) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

# A JSON number, or `null` for anything that is not one. An empty string must not
# become `0`: "we did not measure it" and "we measured nothing" are different facts,
# and a report that conflates them is wrong in a way nobody can see.
json_number() {
  local value="${1:-}"
  case "$value" in
    ''|*[!0-9.eE+-]*) printf 'null' ;;
    *) printf '%s' "$value" ;;
  esac
}

# An integer, or `null`.
json_int() {
  local value="${1:-}"
  case "$value" in
    ''|*[!0-9-]*) printf 'null' ;;
    *) printf '%s' "$value" ;;
  esac
}

# ---------------------------------------------------------------------------
# Building an object or an array
# ---------------------------------------------------------------------------
# The accumulator is a file, not a variable: a shell variable cannot hold a NUL, and
# a sub-shell in a pipeline would lose every append (the classic
# `while read` in a pipeline bug). One file per open object, held open across calls.
#
#   json_open "$tmp"
#   json_key "$tmp" "name" "$(json_string "$value")"
#   json_key "$tmp" "count" "$(json_int 3)"
#   json_close "$tmp"          # prints the object
#
# Every value is passed *already encoded* — `json_string`, `json_bool`,
# `json_int`/`json_number`, or a nested object — so the caller decides the type and
# this file never guesses at one.

json_open() {
  : > "${1:?json_open needs a path}"
}

# Append one `"key": value` member.
#
# A multi-line value — a nested object from `json_close` — carries its key on the first
# line only. Its continuation lines are indented here, so the document stays readable
# and its nesting stays visible; without this the closing brace lands at column 0 and
# the file reads as though the nesting had been lost.
json_key() {
  local file="$1" key="$2" value="$3" indented
  indented="$(printf '%s' "$value" | sed -e '1!s/^/    /')"
  # Whether a comma is needed is only known once the next member arrives, so every
  # member carries one and `json_close` removes the last. Cheaper than looking ahead.
  printf '    %s: %s,\n' "$(json_string "$key")" "$indented" >> "$file"
}

# Close and print. An empty accumulator is `{}`, not a syntax error.
json_close() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '{}'
    return 0
  fi
  # Drop the trailing comma of the final member.
  sed '$ s/,$//' "$file" | { printf '{\n'; cat; printf '}\n'; }
}

# A JSON array from the lines of a file, one encoded value per line.
json_array_from_lines() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '[]'
    return 0
  fi
  sed 's/^/    /' "$file" | sed '$ s/$//' | { printf '[\n'; awk '{ printf "%s%s", (NR>1 ? ",\n" : ""), $0 } END { print "" }'; printf ']\n'; }
}
