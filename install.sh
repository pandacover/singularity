#!/bin/sh
# Install singularity, procedural memory for coding agents:
#
#   curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
#
# Uses the Node.js on PATH when it is version 24 or later, and otherwise
# fetches its own into ~/.singularity/node (checked against nodejs.org's
# checksums; nothing else on the machine changes). Then it puts the code in
# ~/.singularity/app (a git clone, updated when this runs again), installs its
# dependencies, and starts `singularity setup`, which sets memory up in your
# coding agents.
#
# SINGULARITY_REF picks a branch or tag (default: main); SINGULARITY_OWN_NODE=1
# fetches its own Node.js even when one is on PATH. Flags for setup go after
# `sh -s --`, e.g. `curl ... | sh -s -- --yes`.
set -eu

REPO="${SINGULARITY_REPO:-https://github.com/pandacover/singularity.git}"
REF="${SINGULARITY_REF:-main}"
ROOT="${SINGULARITY_HOME:-$HOME/.singularity}"
APP="$ROOT/app"
NODE_MAJOR=24
NODE_DIST="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"

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
# Downloads give up on an address that doesn't answer and try the next.
get() { curl -fsSL --connect-timeout 20 --retry 2 "$@"; }

printf '\n  %s◆%s %sgetting singularity%s ' "$M" "$X" "$D" "$X"

command -v git >/dev/null 2>&1 || fail "git isn't installed: get it from https://git-scm.com (Ubuntu and WSL: sudo apt install git), then run this again."
command -v curl >/dev/null 2>&1 || fail "curl isn't installed (Ubuntu and WSL: sudo apt install curl)."

# A node's major version, 0 if it doesn't run.
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# The npm that belongs to a node: the one next to it, else one on PATH that
# isn't Windows' (WSL puts Windows programs on PATH under /mnt/).
npm_of() {
  if [ -x "$(dirname "$1")/npm" ]; then echo "$(dirname "$1")/npm"; return 0; fi
  p="$(command -v npm 2>/dev/null || true)"
  case "$p" in "" | /mnt/*) return 1 ;; *) echo "$p" ;; esac
}

# Node.js 24 from nodejs.org, unpacked into $ROOT/node.
fetch_node() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "there is no Node.js build to fetch for $(uname -s): install Node.js $NODE_MAJOR or later from https://nodejs.org, then run this again." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "there is no Node.js build to fetch for $(uname -m): install Node.js $NODE_MAJOR or later from https://nodejs.org, then run this again." ;;
  esac
  sums="$(get "$NODE_DIST/SHASUMS256.txt")" || fail "couldn't reach nodejs.org for Node.js $NODE_MAJOR."
  file="$(printf '%s\n' "$sums" | awk -v want="-$os-$arch.tar.gz" '$2 ~ /^node-v/ && substr($2, length($2) - length(want) + 1) == want { print $2; exit }')"
  sum="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1; exit }')"
  [ -n "$file" ] && [ -n "$sum" ] || fail "nodejs.org has no Node.js $NODE_MAJOR for $os-$arch."
  tmp="$(mktemp -d)"
  get "$NODE_DIST/$file" -o "$tmp/$file" || fail "couldn't download $file."
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
  [ "$got" = "$sum" ] || fail "$file doesn't match nodejs.org's checksum; nothing was installed."
  rm -rf "$ROOT/node.new"
  mkdir -p "$ROOT/node.new"
  tar -xzf "$tmp/$file" -C "$ROOT/node.new" --strip-components=1 || fail "couldn't unpack $file."
  rm -rf "$ROOT/node" "$tmp"
  mv "$ROOT/node.new" "$ROOT/node"
}

# The Node.js on PATH if it is new enough (not Windows' one, from WSL), else singularity's own.
NODE=""
on_path="$(command -v node 2>/dev/null || true)"
case "$on_path" in "" | /mnt/*) on_path="" ;; esac
if [ -z "${SINGULARITY_OWN_NODE:-}" ] && [ -n "$on_path" ] && [ "$(major "$on_path")" -ge "$NODE_MAJOR" ] && npm_of "$on_path" >/dev/null; then
  NODE="$on_path"
else
  [ -x "$ROOT/node/bin/node" ] && [ "$(major "$ROOT/node/bin/node")" -ge "$NODE_MAJOR" ] || fetch_node
  NODE="$ROOT/node/bin/node"
fi
NPM="$(npm_of "$NODE")" || fail "npm, which comes with Node.js, isn't next to $NODE."
case "$NODE" in
  "$ROOT"/node/*) done_ "node $("$NODE" -p 'process.versions.node') ${D}(its own)${X}" ;;
  *) done_ "node $("$NODE" -p 'process.versions.node')" ;;
esac

if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet --depth 1 origin "$REF" || fail "couldn't fetch $REF from $REPO."
  git -C "$APP" reset --quiet --hard FETCH_HEAD
else
  mkdir -p "$ROOT"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$APP" || fail "couldn't clone $REPO."
fi
done_ "code ${D}($REF, $(git -C "$APP" rev-parse --short HEAD))${X}"

# npm runs with its own node first on PATH, so it never picks up another.
(cd "$APP" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) ||
  fail "npm couldn't install the dependencies; the messages above say why."
done_ "dependencies"
printf '\n'

# Setup asks a few questions; curl's pipe is stdin, so they go through the terminal.
if [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  exec "$NODE" "$APP/src/cli.ts" setup "$@" </dev/tty
else
  exec "$NODE" "$APP/src/cli.ts" setup --yes "$@"
fi
