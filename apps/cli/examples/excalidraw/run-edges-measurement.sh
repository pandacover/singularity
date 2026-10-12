#!/bin/bash
# The runs of PREREGISTRATION-v1-edges.md: the two long tasks of long.toml
# with the v1-finish memory (`--setup workflows-split`), handed over by three
# versions of the code side by side: main before the edges change (main),
# with what edges say between workflows (stage1), and with TRIGGERS edges
# followed and the branches not handed over named (stage2). Claude Code
# 2.1.286, pinned as a copy under <workspaces>/_claude, as the long tasks'
# earlier runs.
#
#   bash examples/excalidraw/run-edges-measurement.sh FIRST LAST
#       passes FIRST..LAST: one run of each version on each task, the
#       versions taking turns going first
#
# Each version's code is a worktree of this repository under
# <workspaces>/_code/<version>, made (with its dependencies) on first use;
# the runs' hooks run that code. Two lanes, as before: LANE=2 gives a lane
# its own workspaces and output directories (suffix -lane2) and starts the
# rotation one later. Start lane 2 a few minutes after lane 1. Everything
# runs below normal priority; DRY_RUN=1 prints each run's plan instead.
set -u
cd "$(dirname "$0")/../../../.."

SUITE=apps/cli/examples/excalidraw/long.toml
MEMORY=runs/excalidraw/memory/v1-finish
OUT=runs/excalidraw/edges
declare -A REF=([main]=8049074 [stage1]=a0b4331 [stage2]=05195f0)
VERSIONS=(main stage1 stage2)
TASKS=(long-four-changes long-mixed-changes)

root=$(node -e 'import("./apps/cli/src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
CC="$root/_claude/2.1.286/claude.exe"
[ -x "$CC" ] || { echo "missing pinned Claude Code: $CC" >&2; exit 2; }

code() {
  local dir="$root/_code/$1"
  if [ ! -d "$dir" ]; then
    git worktree add --detach "$dir" "${REF[$1]}" >&2 || return 1
    (cd "$dir" && npm ci --no-audit --no-fund >&2) || return 1
  fi
  echo "$dir"
}
for v in "${VERSIONS[@]}"; do code "$v" >/dev/null || { echo "couldn't make the $v worktree" >&2; exit 2; }; done

LANE=${LANE:-1}
LANE_ARGS=()
SUFFIX=""
if [ "$LANE" != 1 ]; then
  LANE_ARGS=(--workspaces "$root/lane$LANE")
  SUFFIX="-lane$LANE"
fi
[ -n "${DRY_RUN:-}" ] && LANE_ARGS+=(--dry-run)

run() {
  local version=$1 task=$2 rep=$3
  node "$(code "$version")/apps/cli/src/cli.ts" eval run "$SUITE" --task "$task" --frozen --reps 1 --first-rep "$rep" \
    --claude "$CC" --setup workflows-split --memory "$MEMORY" --out "$OUT/$task/$version$SUFFIX" "${LANE_ARGS[@]}" \
    || echo "!! run failed: $version $task $rep" >&2
}

pass() {
  local rep=$1 shift=$((rep + LANE - 1)) task i
  for task in "${TASKS[@]}"; do
    for ((i = 0; i < 3; i++)); do run "${VERSIONS[$(((i + shift) % 3))]}" "$task" "$rep"; done
  done
}

[ $# -eq 2 ] || { echo "usage: $0 FIRST LAST" >&2; exit 2; }
for ((rep = $1; rep <= $2; rep++)); do pass "$rep"; done
