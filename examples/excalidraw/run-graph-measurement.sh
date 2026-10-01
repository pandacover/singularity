#!/bin/bash
# The measurement runs from PREREGISTRATION.md, one pass at a time: each pass
# runs every setup once on its tasks, and the setups take turns going first,
# so a slow stretch of API time or a busy machine doesn't land on one setup.
#
#   bash examples/excalidraw/run-graph-measurement.sh new FIRST LAST
#       the 3 new tasks: no-memory, saved-scripts and graph, plus
#       saved-scripts-top2 on midpoint-snap-n (passes 0-4 in the plan)
#   bash examples/excalidraw/run-graph-measurement.sh existing FIRST LAST
#       graph on the 6 existing tasks, and the zen-only graph (version 3) on
#       the toggle tasks (passes 0-2 in the plan)
#
# Passes can be split across invocations (e.g. "new 0 1", then "new 2 4"):
# every run appends to its setup's output directory.
set -u
cd "$(dirname "$0")/../.."

SUITE=examples/excalidraw/suite.toml
SAVED=runs/excalidraw/memory/saved-scripts
GRAPH=runs/excalidraw/memory/graph
NEW=(--task midpoint-snap-n --task page-breaks --task stats-shortcut-k)
EXISTING=(--task altkey-zen-m --task altkey-viewmode-j --task altkey-snap-u
  --task toggle-minimap --task toggle-rulers --task toggle-presenter)
TOGGLE=(--task toggle-minimap --task toggle-rulers --task toggle-presenter)

run() {
  node src/cli.ts eval run "$SUITE" --frozen --reps 1 "$@" || echo "!! run failed: $*" >&2
}

pass_new() {
  local rep=$1
  local setups=(
    "--setup no-memory ${NEW[*]} --out runs/excalidraw/baseline-3-new"
    "--setup saved-scripts --memory $SAVED ${NEW[*]} --out runs/excalidraw/saved-scripts-2-new"
    "--setup saved-scripts-top2 --memory $SAVED --task midpoint-snap-n --out runs/excalidraw/saved-scripts-top2-1"
    "--setup graph --memory $GRAPH ${NEW[*]} --out runs/excalidraw/graph-1-new"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" ${setups[$(((i + rep) % n))]}
  done
}

pass_existing() {
  local rep=$1
  local setups=(
    "--setup graph --memory $GRAPH ${EXISTING[*]} --out runs/excalidraw/graph-1-existing"
    "--setup graph --memory $GRAPH --graph-version 3 ${TOGGLE[*]} --out runs/excalidraw/graph-zen-only-1"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" ${setups[$(((i + rep) % n))]}
  done
}

case "${1:-}" in
  new) for ((rep = $2; rep <= $3; rep++)); do pass_new "$rep"; done ;;
  existing) for ((rep = $2; rep <= $3; rep++)); do pass_existing "$rep"; done ;;
  *) echo "usage: $0 new|existing FIRST LAST" >&2; exit 2 ;;
esac
