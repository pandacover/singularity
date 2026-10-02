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
#   bash examples/excalidraw/run-graph-measurement.sh warnings FIRST LAST
#       the follow-up: saved-scripts-warnings on stats-shortcut-k and
#       page-breaks (passes 0-4), and on altkey-zen-m (passes 0-2)
#
# Passes can be split across invocations (e.g. "new 0 1", then "new 2 4"):
# every run appends to its setup's output directory.
#
# Two lanes can run at the same time, which about halves the wall time. LANE=2
# gives a lane its own clone (<workspaces>/lane2/excalidraw) and its own output
# directories (suffix -lane2), so the lanes share no files. Reports take both
# (e.g. runs/excalidraw/graph-1-new*). The measurement used:
#   lane 1:          new 0 2, then existing 2 2
#   lane 2: LANE=2   new 3 4, then existing 0 1
# and the follow-up:
#   lane 1:          warnings 0 1
#   lane 2: LANE=2   warnings 2 4
#
# DRY_RUN=1 prints each run's plan instead of running it.
set -u
cd "$(dirname "$0")/../.."

SUITE=examples/excalidraw/suite.toml
SAVED=runs/excalidraw/memory/saved-scripts
# Rebuilt from the same runs once saved-scripts stopped keeping failed commands.
SAVED2=runs/excalidraw/memory/saved-scripts-2
GRAPH=runs/excalidraw/memory/graph
NEW=(--task midpoint-snap-n --task page-breaks --task stats-shortcut-k)
EXISTING=(--task altkey-zen-m --task altkey-viewmode-j --task altkey-snap-u
  --task toggle-minimap --task toggle-rulers --task toggle-presenter)
TOGGLE=(--task toggle-minimap --task toggle-rulers --task toggle-presenter)

LANE=${LANE:-1}
LANE_ARGS=()
SUFFIX=""
if [ "$LANE" != 1 ]; then
  root=$(node -e 'import("./src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
  LANE_ARGS=(--workspaces "$root/lane$LANE")
  SUFFIX="-lane$LANE"
fi
[ -n "${DRY_RUN:-}" ] && LANE_ARGS+=(--dry-run)

run() {
  node src/cli.ts eval run "$SUITE" --frozen --reps 1 "${LANE_ARGS[@]}" "$@" || echo "!! run failed: $*" >&2
}

pass_new() {
  local rep=$1
  local setups=(
    "--setup no-memory ${NEW[*]} --out runs/excalidraw/baseline-3-new$SUFFIX"
    "--setup saved-scripts --memory $SAVED ${NEW[*]} --out runs/excalidraw/saved-scripts-2-new$SUFFIX"
    "--setup saved-scripts-top2 --memory $SAVED --task midpoint-snap-n --out runs/excalidraw/saved-scripts-top2-1$SUFFIX"
    "--setup graph --memory $GRAPH ${NEW[*]} --out runs/excalidraw/graph-1-new$SUFFIX"
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
    "--setup graph --memory $GRAPH ${EXISTING[*]} --out runs/excalidraw/graph-1-existing$SUFFIX"
    "--setup graph --memory $GRAPH --graph-version 3 ${TOGGLE[*]} --out runs/excalidraw/graph-zen-only-1$SUFFIX"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" ${setups[$(((i + rep) % n))]}
  done
}

pass_warnings() {
  local rep=$1
  local tasks=(--task stats-shortcut-k --task page-breaks)
  [ "$rep" -le 2 ] && tasks+=(--task altkey-zen-m)
  run --first-rep "$rep" --setup saved-scripts-warnings --memory "$SAVED2" --warnings "$GRAPH" --graph-version 6 \
    "${tasks[@]}" --out "runs/excalidraw/saved-scripts-warnings-1$SUFFIX"
}

case "${1:-}" in
  new) for ((rep = $2; rep <= $3; rep++)); do pass_new "$rep"; done ;;
  existing) for ((rep = $2; rep <= $3; rep++)); do pass_existing "$rep"; done ;;
  warnings) for ((rep = $2; rep <= $3; rep++)); do pass_warnings "$rep"; done ;;
  *) echo "usage: $0 new|existing|warnings FIRST LAST" >&2; exit 2 ;;
esac
