#!/bin/bash
# The runs of PREREGISTRATION-v1-long.md: the long task (long.toml, four
# changes in one prompt) without memory and with the local-first memory
# (`--setup workflows-split`, the v1-finish home: as A of
# PREREGISTRATION-v1-lookups.md, handed over change by change). Claude Code
# 2.1.286, pinned as a copy under <workspaces>/_claude, as in the eighth
# session's measurements.
#
#   bash examples/excalidraw/run-long-measurement.sh FIRST LAST
#       passes FIRST..LAST: one run of each setup, the setups taking turns
#       going first
#
# TASK names the task of long.toml (default long-four-changes, into
# runs/excalidraw/long; TASK=long-mixed-changes, PREREGISTRATION-v1-long-mixed.md,
# into runs/excalidraw/long-mixed-changes).
#
# Two lanes: LANE=2 gives a lane its own workspace and output directories
# (suffix -lane2) and starts with the other setup, so the two lanes don't run
# the same setup side by side. Start lane 2 a few minutes after lane 1.
# Everything runs below normal priority; DRY_RUN=1 prints each run's plan
# instead of running it.
set -u
cd "$(dirname "$0")/../../../.."

SUITE=apps/cli/examples/excalidraw/long.toml
MEMORY=runs/excalidraw/memory/v1-finish
TASK=${TASK:-long-four-changes}
OUT=runs/excalidraw/long
[ "$TASK" != long-four-changes ] && OUT="runs/excalidraw/$TASK"

root=$(node -e 'import("./apps/cli/src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
CC="$root/_claude/2.1.286/claude.exe"
[ -x "$CC" ] || { echo "missing pinned Claude Code: $CC" >&2; exit 2; }

LANE=${LANE:-1}
LANE_ARGS=()
SUFFIX=""
if [ "$LANE" != 1 ]; then
  LANE_ARGS=(--workspaces "$root/lane$LANE")
  SUFFIX="-lane$LANE"
fi
[ -n "${DRY_RUN:-}" ] && LANE_ARGS+=(--dry-run)

run() {
  node apps/cli/src/cli.ts eval run "$SUITE" --task "$TASK" --frozen --reps 1 --claude "$CC" "${LANE_ARGS[@]}" "$@" || echo "!! run failed: $*" >&2
}

pass() {
  local rep=$1
  local nomem=(--setup no-memory --out "$OUT/nomem$SUFFIX")
  local mem=(--setup workflows-split --memory "$MEMORY" --out "$OUT/memory$SUFFIX")
  local flip=$((rep % 2))
  [ "$LANE" != 1 ] && flip=$((1 - flip))
  if ((flip == 0)); then
    run --first-rep "$rep" "${nomem[@]}"
    run --first-rep "$rep" "${mem[@]}"
  else
    run --first-rep "$rep" "${mem[@]}"
    run --first-rep "$rep" "${nomem[@]}"
  fi
}

[ $# -eq 2 ] || { echo "usage: $0 FIRST LAST" >&2; exit 2; }
for ((rep = $1; rep <= $2; rep++)); do pass "$rep"; done
