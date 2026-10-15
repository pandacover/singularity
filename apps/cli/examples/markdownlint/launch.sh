#!/bin/bash
# Starts arms of the markdownlint long task side by side on Linux (a cloud
# container), each detached so it outlives the shell that starts it, with a
# clean environment: only PATH, HOME, the proxy and its certificates, and a
# Claude Code config folder of the run's own, so the machine's own settings,
# skills and CLAUDE.md folders stay out. launch.ps1 does the same on Windows.
#
#   bash launch.sh RUNS BASE_REPO CLAUDE ARM=CODE...
#
# RUNS: the folder for the arms' clones, memory homes and output.
# BASE_REPO: a markdownlint clone at the base commit, with node_modules.
# CLAUDE: the pinned Claude Code to run.
# ARM=CODE: an arm's name and the singularity checkout whose memory code it
# runs (driver.mjs --app); `without` for the arm with no memory.
set -eu
RUNS=$1 BASE=$2 CLAUDE=$3
shift 3
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUNS"
for spec in "$@"; do
  arm=${spec%%=*} code=${spec#*=}
  repo=$RUNS/$arm/repo
  rm -rf "$RUNS/$arm"
  mkdir -p "$RUNS/$arm"
  git clone -q "$BASE" "$repo"
  git -C "$repo" checkout -q "$(git -C "$BASE" rev-parse HEAD)"
  git -C "$repo" config user.email agent@example.com
  git -C "$repo" config user.name agent
  cp -a "$BASE/node_modules" "$repo/node_modules"
  mkdir -p "$RUNS/$arm/claude-config"
  args=(--repo "$repo" --out "$RUNS/$arm/out" --claude "$CLAUDE" --claude-config "$RUNS/$arm/claude-config")
  if [ "$code" = without ]; then
    args+=(--arm without)
  else
    mkdir -p "$RUNS/$arm/home"
    # The user's config at the first measurement: learning on its own, every 3 changes, $10 a day, through Claude Code.
    echo '{ "tenant": "local", "learn": { "auto": true, "every": 3, "max_usd_per_day": 10 } }' > "$RUNS/$arm/home/config.json"
    args+=(--arm with --home "$RUNS/$arm/home" --app "$code")
  fi
  env -i HOME="$HOME" PATH="$PATH" HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" \
    NO_PROXY="${NO_PROXY:-}" no_proxy="${no_proxy:-}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" \
    SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
    nohup node "$here/driver.mjs" "${args[@]}" > "$RUNS/$arm.out" 2>&1 < /dev/null &
  echo "$arm started: pid $!"
done
