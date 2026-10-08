#!/bin/bash
# The runs of examples/excalidraw/PREREGISTRATION-v1-bugfix-common.md: what
# different bug fixes share (how a bug is reproduced in a test here and how
# the fix is checked), learned from three bugs' runs, handed to the fourth,
# held out. On Claude Code 2.1.286, pinned as a copy under <workspaces>/_claude,
# as the baseline runs were.
#
#   bash examples/run-bugfix-common.sh memory FIRST LAST
#       passes FIRST..LAST: save-as-in-text with the memory learned without it
#       (runs/excalidraw/memory/v1-common-wo-saveas), then dropdown-outside-click
#       with its own (v1-common-wo-dropdown); on odd passes dropdown goes first
#   bash examples/run-bugfix-common.sh drift REP
#       one run of each held-out task without memory: whether runs without
#       memory still cost what they did on 2026-10-06
#
# LANE=2 gives a lane its own workspace and output directories (suffix
# -lane2). Everything runs below normal priority; DRY_RUN=1 prints each run's
# plan instead of running it.
set -u
cd "$(dirname "$0")/../../.."

SUITE=apps/cli/examples/excalidraw/suite.toml
OUT=runs/excalidraw/bugfix-common

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
  node apps/cli/src/cli.ts eval run "$SUITE" "$@" --frozen --claude "$CC" "${LANE_ARGS[@]}" || echo "!! run failed: $*" >&2
}

with_memory() {
  local task=$1 home=$2 rep=$3
  run --setup workflows-split --memory "runs/excalidraw/memory/$home" --task "$task" --reps 1 --first-rep "$rep" --out "$OUT/memory$SUFFIX"
}

case "${1:-}" in
  memory)
    for ((rep = $2; rep <= $3; rep++)); do
      if ((rep % 2 == 0)); then
        with_memory save-as-in-text v1-common-wo-saveas "$rep"
        with_memory dropdown-outside-click v1-common-wo-dropdown "$rep"
      else
        with_memory dropdown-outside-click v1-common-wo-dropdown "$rep"
        with_memory save-as-in-text v1-common-wo-saveas "$rep"
      fi
    done
    ;;
  drift)
    run --setup no-memory --task save-as-in-text --task dropdown-outside-click --reps 1 --first-rep "$2" --out "$OUT/nomem$SUFFIX"
    ;;
  *) echo "usage: $0 memory FIRST LAST | drift REP" >&2; exit 2 ;;
esac
