#!/bin/sh
# Install singularity, procedural memory for coding agents:
#
#   curl -fsSL https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
#
# Checks for Node.js 24+ and git, puts the code in ~/.singularity/app (a git
# clone, updated when this runs again), installs its dependencies, then starts
# `singularity setup`, which sets memory up in your coding agents.
#
# SINGULARITY_REF picks a branch or tag (default: main). Flags for setup go
# after `sh -s --`, e.g. `curl ... | sh -s -- --yes`.
set -eu

REPO="${SINGULARITY_REPO:-https://github.com/pandacover/singularity.git}"
REF="${SINGULARITY_REF:-main}"
ROOT="${SINGULARITY_HOME:-$HOME/.singularity}"
APP="$ROOT/app"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  D="$(printf '\033[2m')" G="$(printf '\033[32m')" R="$(printf '\033[31m')" M="$(printf '\033[35m')" X="$(printf '\033[0m')"
else
  D="" G="" R="" M="" X=""
fi

# One line of progress, then setup takes over.
done_() { printf '  %s %s✓%s' "$1" "$G" "$X"; }
fail() {
  printf '\n\n  %s✗%s %s\n\n' "$R" "$X" "$1" >&2
  exit 1
}

printf '\n  %s◆%s %sgetting singularity%s ' "$M" "$X" "$D" "$X"

command -v node >/dev/null 2>&1 || fail "Node.js isn't installed: get version 24 or later from https://nodejs.org, then run this again."
NODE_VERSION="$(node -p 'process.versions.node')"
if [ "${NODE_VERSION%%.*}" -lt 24 ] 2>/dev/null; then
  fail "Node.js $NODE_VERSION is too old: singularity needs 24 or later (https://nodejs.org)."
fi
command -v npm >/dev/null 2>&1 || fail "npm isn't on your PATH (it comes with Node.js)."
command -v git >/dev/null 2>&1 || fail "git isn't installed: get it from https://git-scm.com, then run this again."
done_ "node $NODE_VERSION"

if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet --depth 1 origin "$REF" || fail "couldn't fetch $REF from $REPO"
  git -C "$APP" reset --quiet --hard FETCH_HEAD
else
  mkdir -p "$ROOT"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$APP" || fail "couldn't clone $REPO"
fi
done_ "code ${D}($REF, $(git -C "$APP" rev-parse --short HEAD))${X}"

(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) || fail "npm couldn't install the dependencies; the messages above say why."
done_ "dependencies"
printf '\n'

# Setup asks a few questions; curl's pipe is stdin, so they go through the terminal.
if [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  exec node "$APP/src/cli.ts" setup "$@" </dev/tty
else
  exec node "$APP/src/cli.ts" setup --yes "$@"
fi
