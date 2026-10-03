#!/bin/bash
# The measurement runs from PREREGISTRATION-local-memory.md: the local memory,
# handed over by its own hooks (`--setup hooks`), against the earlier runs.
#
# Every run uses the Claude Code version its baselines used, pinned as copies
# under <workspaces>/_claude, so an update can't land in the middle:
# 2.1.286 for the six existing tasks (their saved-scripts and no-memory runs),
# 2.1.287 for the three new tasks.
#
#   bash examples/excalidraw/run-local-memory-measurement.sh smoke
#       one hooks run of altkey-zen-m on each version, to check the plumbing;
#       not part of the results
#   bash examples/excalidraw/run-local-memory-measurement.sh drift FIRST LAST
#       the gate (passes 0-2): saved-scripts on altkey-viewmode-j (2.1.286)
#       and saved-scripts-warnings on altkey-zen-m (2.1.287), the same memory
#       as their earlier runs
#   bash examples/excalidraw/run-local-memory-measurement.sh existing FIRST LAST
#       passes 0-2: hooks with the seed memory on the six existing tasks, and
#       with the zen-only memory on the three toggle tasks (2.1.286)
#   bash examples/excalidraw/run-local-memory-measurement.sh new FIRST LAST
#       passes 0-4: hooks with the seed memory on the three new tasks (2.1.287)
#   bash examples/excalidraw/run-local-memory-measurement.sh spots FIRST LAST
#       the follow-up, passes 0-2: hooks with the seed memory and its spots
#       (the code at the route's places goes along) on toggle-rulers (2.1.286)
#
# Two lanes, as in run-graph-measurement.sh: LANE=2 gives a lane its own clone
# and output directories (suffix -lane2). The plan:
#   gate, one lane:  smoke, then drift 0 2
#   then             lane 1: existing 0 1, then new 4 4
#                    lane 2 (LANE=2): new 0 3, then existing 2 2
#
# PRIORITY=normal runs everything at normal priority instead of below normal
# (the user asked for it for this measurement, to finish sooner).
#
# DRY_RUN=1 prints each run's plan instead of running it.
set -u
cd "$(dirname "$0")/../.."

SUITE=examples/excalidraw/suite.toml
SEED=runs/excalidraw/memory/local-seed
ZEN=runs/excalidraw/memory/local-zen
SPOTS=runs/excalidraw/memory/local-seed-spots
SAVED=runs/excalidraw/memory/saved-scripts
SAVED2=runs/excalidraw/memory/saved-scripts-2
GRAPH=runs/excalidraw/memory/graph
EXISTING=(--task altkey-zen-m --task altkey-viewmode-j --task altkey-snap-u
  --task toggle-minimap --task toggle-rulers --task toggle-presenter)
TOGGLE=(--task toggle-minimap --task toggle-rulers --task toggle-presenter)
NEW=(--task midpoint-snap-n --task page-breaks --task stats-shortcut-k)

root=$(node -e 'import("./src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
CC286="$root/_claude/2.1.286/claude.exe"
CC287="$root/_claude/2.1.287/claude.exe"
for cc in "$CC286" "$CC287"; do
  [ -x "$cc" ] || { echo "missing pinned Claude Code: $cc" >&2; exit 2; }
done

LANE=${LANE:-1}
LANE_ARGS=()
SUFFIX=""
if [ "$LANE" != 1 ]; then
  LANE_ARGS=(--workspaces "$root/lane$LANE")
  SUFFIX="-lane$LANE"
fi
[ -n "${DRY_RUN:-}" ] && LANE_ARGS+=(--dry-run)
[ "${PRIORITY:-}" = normal ] && LANE_ARGS+=(--priority normal)

run() {
  node src/cli.ts eval run "$SUITE" --frozen --reps 1 "${LANE_ARGS[@]}" "$@" || echo "!! run failed: $*" >&2
}

pass_existing() {
  local rep=$1
  local setups=(
    "--setup hooks --memory $SEED ${EXISTING[*]} --out runs/excalidraw/hooks-1-existing$SUFFIX"
    "--setup hooks --memory $ZEN ${TOGGLE[*]} --out runs/excalidraw/hooks-zen-only-1$SUFFIX"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" --claude "$CC286" ${setups[$(((i + rep) % n))]}
  done
}

pass_new() {
  run --first-rep "$1" --claude "$CC287" --setup hooks --memory "$SEED" "${NEW[@]}" --out "runs/excalidraw/hooks-1-new$SUFFIX"
}

pass_drift() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup saved-scripts --memory "$SAVED" --task altkey-viewmode-j \
    --out "runs/excalidraw/drift-286$SUFFIX"
  run --first-rep "$rep" --claude "$CC287" --setup saved-scripts-warnings --memory "$SAVED2" --warnings "$GRAPH" --graph-version 6 \
    --task altkey-zen-m --out "runs/excalidraw/drift-287$SUFFIX"
}

case "${1:-}" in
  smoke)
    run --claude "$CC286" --setup hooks --memory "$SEED" --task altkey-zen-m --out "runs/excalidraw/hooks-smoke-286$SUFFIX"
    run --claude "$CC287" --setup hooks --memory "$SEED" --task altkey-zen-m --out "runs/excalidraw/hooks-smoke-287$SUFFIX"
    ;;
  drift) for ((rep = $2; rep <= $3; rep++)); do pass_drift "$rep"; done ;;
  existing) for ((rep = $2; rep <= $3; rep++)); do pass_existing "$rep"; done ;;
  new) for ((rep = $2; rep <= $3; rep++)); do pass_new "$rep"; done ;;
  spots)
    for ((rep = $2; rep <= $3; rep++)); do
      run --first-rep "$rep" --claude "$CC286" --setup hooks --memory "$SPOTS" --task toggle-rulers --out "runs/excalidraw/hooks-spots-1$SUFFIX"
    done
    ;;
  *) echo "usage: $0 smoke | drift|existing|new|spots FIRST LAST" >&2; exit 2 ;;
esac
