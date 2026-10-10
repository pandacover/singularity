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
# coding agents. Where memory is set up already, it brings that up to date
# with the new code instead (`singularity update` does all of this too).
# Node.js and the code are fetched side by side; the dependencies need both.
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
# Steps show a spinner while they run where the terminal can redraw a line;
# elsewhere each one prints its line once it is done.
LIVE=""
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then LIVE=1; fi

fail() {
  printf '\n  %s✗%s %s\n\n' "$R" "$X" "$1" >&2
  exit 1
}
# Downloads give up on an address that doesn't answer and try the next.
get() { curl -fsSL --connect-timeout 20 --retry 2 "$@"; }

printf '\n  %s◆%s %sgetting singularity%s\n' "$M" "$X" "$D" "$X"

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
OWN=""
FETCH=""
on_path="$(command -v node 2>/dev/null || true)"
case "$on_path" in "" | /mnt/*) on_path="" ;; esac
if [ -z "${SINGULARITY_OWN_NODE:-}" ] && [ -n "$on_path" ] && [ "$(major "$on_path")" -ge "$NODE_MAJOR" ] && npm_of "$on_path" >/dev/null; then
  NODE="$on_path"
else
  NODE="$ROOT/node/bin/node"
  OWN=1
  [ -x "$NODE" ] && [ "$(major "$NODE")" -ge "$NODE_MAJOR" ] || FETCH=1
fi

# The steps. Each runs in the background, writes its output to $LOG/<step>.log
# and, when it succeeds, the line that says what it did to $LOG/<step>.done.
LOG="$(mktemp -d)"
PIDS=""
trap 'rm -rf "$LOG"' EXIT
# A script's background steps ignore Ctrl+C. On Ctrl+C the terminal's shell
# has given this install a process group of its own, so it stops the group
# (curl, git and npm under the steps too); told to stop, it stops its steps.
stopped() { trap - INT TERM; [ -z "$LIVE" ] || printf '\033[?25h\n'; rm -rf "$LOG"; }
trap 'stopped; trap "" TERM; kill 0 2>/dev/null || :; exit 130' INT
trap 'stopped; kill $PIDS 2>/dev/null || :; exit 143' TERM

step_node() {
  if [ -n "$FETCH" ]; then fetch_node; fi
  npm_of "$NODE" >/dev/null || fail "npm, which comes with Node.js, isn't next to $NODE."
  printf 'node %s%s' "$("$NODE" -p 'process.versions.node')" "${OWN:+ ${D}(its own)${X}}" >"$LOG/node.done"
}

step_code() {
  if [ -d "$APP/.git" ]; then
    git -C "$APP" fetch --quiet --depth 1 origin "$REF" || fail "couldn't fetch $REF from $REPO."
    git -C "$APP" reset --quiet --hard FETCH_HEAD
  else
    mkdir -p "$ROOT"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$APP" || fail "couldn't clone $REPO."
  fi
  printf 'code %s(%s, %s)%s' "$D" "$REF" "$(git -C "$APP" rev-parse --short HEAD)" "$X" >"$LOG/code.done"
}

# npm runs with its own node first on PATH, so it never picks up another.
step_dependencies() {
  cd "$APP"
  PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null ||
    fail "npm couldn't install the dependencies; the messages above say why."
  printf 'dependencies' >"$LOG/dependencies.done"
}

# Start steps side by side; nothing reads the terminal, which is this script's pipe.
start() {
  for s in "$@"; do
    ( set +e; ( set -e; "step_$s" ) >"$LOG/$s.log" 2>&1 </dev/null; echo $? >"$LOG/$s.status" ) &
    PIDS="$PIDS $!"
  done
}

# One step's line: a spinner frame while it runs, then ✓ and what it did, or ✗.
line() {
  if [ ! -f "$LOG/$1.status" ]; then printf '    %s%s%s %s' "$M" "$2" "$X" "$1"
  elif [ "$(cat "$LOG/$1.status")" = 0 ]; then printf '    %s✓%s %s' "$G" "$X" "$(cat "$LOG/$1.done")"
  else printf '    %s✗%s %s' "$R" "$X" "$1"
  fi
}

frame() {
  case $(($1 % 10)) in
    0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;; 4) printf '⠼' ;;
    5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;; 8) printf '⠇' ;; *) printf '⠏' ;;
  esac
}

# Wait for the steps, redrawing their lines; a failed step's messages end the install.
finish() {
  n=0
  if [ -n "$LIVE" ]; then printf '\033[?25l'; fi
  while :; do
    left=0
    for s in "$@"; do [ -f "$LOG/$s.status" ] || left=1; done
    if [ -n "$LIVE" ]; then
      [ "$n" -eq 0 ] || printf '\033[%dA' "$#"
      f="$(frame "$n")"
      for s in "$@"; do printf '\r\033[2K%s\n' "$(line "$s" "$f")"; done
    fi
    [ "$left" -eq 1 ] || break
    n=$((n + 1))
    sleep 0.1 2>/dev/null || sleep 1
  done
  wait
  if [ -n "$LIVE" ]; then printf '\033[?25h'; else for s in "$@"; do printf '%s\n' "$(line "$s" "")"; done; fi
  for s in "$@"; do
    if [ "$(cat "$LOG/$s.status")" != 0 ]; then
      cat "$LOG/$s.log" >&2
      exit 1
    fi
  done
}

start node code
finish node code
NPM="$(npm_of "$NODE")"
start dependencies
finish dependencies
printf '\n'
rm -rf "$LOG"
trap - EXIT INT TERM

# Questions go through the terminal: curl's pipe is stdin.
CLI="$APP/apps/cli/src/singularity.ts"
tty=""
if [ -t 1 ] && (: </dev/tty) 2>/dev/null; then tty=1; fi
# Set up already (setup writes the command): the new code brings it up to date
# and asks nothing setup asked. Flags for setup run setup.
if [ $# -eq 0 ] && [ -f "$ROOT/bin/singularity" ]; then
  if [ -n "$tty" ]; then exec "$NODE" "$CLI" update --no-fetch </dev/tty; else exec "$NODE" "$CLI" update --no-fetch; fi
fi
if [ -n "$tty" ]; then
  exec "$NODE" "$CLI" setup "$@" </dev/tty
else
  exec "$NODE" "$CLI" setup --yes "$@"
fi
