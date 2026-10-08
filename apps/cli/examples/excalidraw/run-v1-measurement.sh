#!/bin/bash
# The measurement runs from PREREGISTRATION-v1.md: memory v1 (`--setup
# workflows`) and memory v0 with its code at the places (`--setup hooks`, the
# local-seed-spots home), each handed over by its own hooks, against the
# earlier runs of no memory and the exact script.
#
# Every run uses the Claude Code version its baselines used, pinned as copies
# under <workspaces>/_claude: 2.1.286 for the six existing tasks, 2.1.287 for
# the three new ones.
#
#   bash examples/excalidraw/run-v1-measurement.sh smoke
#       one v1 run of altkey-zen-m on each version, to check the plumbing;
#       not part of the results
#   bash examples/excalidraw/run-v1-measurement.sh drift FIRST LAST
#       the gate (passes 0-2): saved-scripts on altkey-viewmode-j (2.1.286)
#       and saved-scripts-warnings on altkey-zen-m (2.1.287), the same memory
#       as their earlier runs
#   bash examples/excalidraw/run-v1-measurement.sh existing FIRST LAST
#       passes 0-2: v1 on the six existing tasks, v0 on five of them (it has
#       its toggle-rulers runs from the sixth session) (2.1.286)
#   bash examples/excalidraw/run-v1-measurement.sh new FIRST LAST
#       passes 0-4: v1 and v0 on the three new tasks (2.1.287)
#   bash examples/excalidraw/run-v1-measurement.sh examples FIRST LAST
#       after the measurement, passes 0-2: v1 with one existing example at
#       each place on the three toggle tasks (2.1.286), against v1's runs of
#       them in v1-existing; the same memory, only the hand-over's code
#       differs. That change wasn't kept: apply
#       runs/excalidraw/v1ex-toggles/example-change.patch first
#   bash examples/excalidraw/run-v1-measurement.sh draft FIRST LAST
#       after that, passes 0-2: v1 handing over the change itself, drafted at
#       task start from the same memory and the code (`--setup
#       workflows-draft`, src/workflows/Draft.ts), on the three toggle tasks
#       (2.1.286)
#   bash examples/excalidraw/run-v1-measurement.sh cues FIRST LAST
#       after that, passes 0-2: v1 without a model call at task start, its
#       cues picking the workflows and filling the blanks the task states
#       (`--setup workflows-cues`, src/workflows/Cues.ts), from the v1-cues
#       home (v1-seed plus cues, version 2), on the three toggle tasks
#       (2.1.286) and the three new ones (2.1.287)
#   bash examples/excalidraw/run-v1-measurement.sh split-finish FIRST LAST
#       PREREGISTRATION-v1-lookups.md, A: the v1-finish home (the finish in
#       one command) handed over in up to two parts (`--setup
#       workflows-split`), on toggle-rulers and toggle-presenter (2.1.286)
#   bash examples/excalidraw/run-v1-measurement.sh split-learned FIRST LAST
#       PREREGISTRATION-v1-lookups.md, B: the v1-learned home (A after a
#       learning round on what runs looked up), the same way, the tasks in
#       the other order
#
# Two lanes, as before: LANE=2 gives a lane its own clone and output
# directories (suffix -lane2). The plan:
#   one lane:  smoke, then drift 0 2 (the gate decides whether to go on)
#   then       lane 1: existing 0 2
#              lane 2 (LANE=2): new 0 4
#
# Everything runs below normal priority, the harness's default, so the
# machine stays usable; PRIORITY=normal changes that. DRY_RUN=1 prints each
# run's plan instead of running it.
set -u
cd "$(dirname "$0")/../../../.."

SUITE=apps/cli/examples/excalidraw/suite.toml
V1=runs/excalidraw/memory/v1-seed
V1CUES=runs/excalidraw/memory/v1-cues
V1FINISH=runs/excalidraw/memory/v1-finish
V1LEARNED=runs/excalidraw/memory/v1-learned
V0=runs/excalidraw/memory/local-seed-spots
SAVED=runs/excalidraw/memory/saved-scripts
SAVED2=runs/excalidraw/memory/saved-scripts-2
GRAPH=runs/excalidraw/memory/graph
EXISTING=(--task altkey-zen-m --task altkey-viewmode-j --task altkey-snap-u
  --task toggle-minimap --task toggle-rulers --task toggle-presenter)
# v0 with its places already ran toggle-rulers three times (runs/excalidraw/hooks-spots-1).
EXISTING_V0=(--task altkey-zen-m --task altkey-viewmode-j --task altkey-snap-u
  --task toggle-minimap --task toggle-presenter)
NEW=(--task midpoint-snap-n --task page-breaks --task stats-shortcut-k)

root=$(node -e 'import("./apps/cli/src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
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
  node apps/cli/src/cli.ts eval run "$SUITE" --frozen --reps 1 "${LANE_ARGS[@]}" "$@" || echo "!! run failed: $*" >&2
}

# Within each pass the two memories take turns going first.
pass_existing() {
  local rep=$1
  local setups=(
    "--setup workflows --memory $V1 ${EXISTING[*]} --out runs/excalidraw/v1-existing$SUFFIX"
    "--setup hooks --memory $V0 ${EXISTING_V0[*]} --out runs/excalidraw/v0spots-existing$SUFFIX"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" --claude "$CC286" ${setups[$(((i + rep) % n))]}
  done
}

pass_new() {
  local rep=$1
  local setups=(
    "--setup workflows --memory $V1 ${NEW[*]} --out runs/excalidraw/v1-new$SUFFIX"
    "--setup hooks --memory $V0 ${NEW[*]} --out runs/excalidraw/v0spots-new$SUFFIX"
  )
  local n=${#setups[@]}
  for ((i = 0; i < n; i++)); do
    # shellcheck disable=SC2086
    run --first-rep "$rep" --claude "$CC287" ${setups[$(((i + rep) % n))]}
  done
}

pass_examples() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup workflows --memory "$V1" \
    --task toggle-minimap --task toggle-rulers --task toggle-presenter --out "runs/excalidraw/v1ex-toggles$SUFFIX"
}

pass_draft() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup workflows-draft --memory "$V1" \
    --task toggle-minimap --task toggle-rulers --task toggle-presenter --out "runs/excalidraw/v1draft-toggles$SUFFIX"
}

pass_cues() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup workflows-cues --memory "$V1CUES" \
    --task toggle-minimap --task toggle-rulers --task toggle-presenter --out "runs/excalidraw/v1cues-toggles$SUFFIX"
  # shellcheck disable=SC2086
  run --first-rep "$rep" --claude "$CC287" --setup workflows-cues --memory "$V1CUES" ${NEW[*]} --out "runs/excalidraw/v1cues-new$SUFFIX"
}

pass_split_finish() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup workflows-split --memory "$V1FINISH" \
    --task toggle-rulers --task toggle-presenter --out "runs/excalidraw/v1split-finish$SUFFIX"
}

pass_split_learned() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup workflows-split --memory "$V1LEARNED" \
    --task toggle-presenter --task toggle-rulers --out "runs/excalidraw/v1split-learned$SUFFIX"
}

pass_drift() {
  local rep=$1
  run --first-rep "$rep" --claude "$CC286" --setup saved-scripts --memory "$SAVED" --task altkey-viewmode-j \
    --out "runs/excalidraw/v1-gate-286$SUFFIX"
  run --first-rep "$rep" --claude "$CC287" --setup saved-scripts-warnings --memory "$SAVED2" --warnings "$GRAPH" --graph-version 6 \
    --task altkey-zen-m --out "runs/excalidraw/v1-gate-287$SUFFIX"
}

case "${1:-}" in
  smoke)
    run --claude "$CC286" --setup workflows --memory "$V1" --task altkey-zen-m --out "runs/excalidraw/v1-smoke-286$SUFFIX"
    run --claude "$CC287" --setup workflows --memory "$V1" --task altkey-zen-m --out "runs/excalidraw/v1-smoke-287$SUFFIX"
    ;;
  drift) for ((rep = $2; rep <= $3; rep++)); do pass_drift "$rep"; done ;;
  existing) for ((rep = $2; rep <= $3; rep++)); do pass_existing "$rep"; done ;;
  new) for ((rep = $2; rep <= $3; rep++)); do pass_new "$rep"; done ;;
  examples) for ((rep = $2; rep <= $3; rep++)); do pass_examples "$rep"; done ;;
  draft) for ((rep = $2; rep <= $3; rep++)); do pass_draft "$rep"; done ;;
  cues) for ((rep = $2; rep <= $3; rep++)); do pass_cues "$rep"; done ;;
  split-finish) for ((rep = $2; rep <= $3; rep++)); do pass_split_finish "$rep"; done ;;
  split-learned) for ((rep = $2; rep <= $3; rep++)); do pass_split_learned "$rep"; done ;;
  *) echo "usage: $0 smoke | drift|existing|new|examples|draft|cues|split-finish|split-learned FIRST LAST" >&2; exit 2 ;;
esac
