#!/bin/bash
# The harness runs of PREREGISTRATION-eval-2026-10-16.md, one lane: takes the
# next line of QUEUE (one task and pass: `suite|memory|out|task|rep|n`) and
# runs it without memory and with the scripts setup (frozen), the two taking
# turns going first (by n and rep; lane 2 starts with the other), until the
# queue is empty. Lanes can join at any time; each has its own workspaces
# (lane 1 the default, lane N <workspaces>/laneN) and output directories
# (<out>/nomem-laneN, <out>/scripts-laneN).
#
#   LANE=1 QUEUE=<file> bash apps/cli/examples/scripts/run-harness-lane.sh
#
# Claude Code 2.1.296 (pinned), leaving the user's own settings out
# (--setting-sources project,local), through SINGULARITY_CLAUDE. An agent
# that ran the installed `singularity` would find an empty home. DRY_RUN=1
# prints each run's plan and leaves the queue alone.
set -u
cd "$(dirname "$0")/../../../.."
LANE=${LANE:-1}
Q=${QUEUE:?QUEUE names the queue file}
CC=${CC:-C:/singularity-workspaces/_claude/2.1.296/claude.exe}
export SINGULARITY_CLAUDE="[\"$CC\",\"--setting-sources\",\"project,local\"]"
export SINGULARITY_HOME=${EMPTY_HOME:-C:/singularity-workspaces/eval-1016/empty-home}
mkdir -p "$SINGULARITY_HOME"
LANE_ARGS=()
[ "$LANE" != 1 ] && LANE_ARGS=(--workspaces "C:/singularity-workspaces/lane$LANE")
[ -n "${DRY_RUN:-}" ] && LANE_ARGS+=(--dry-run)
log() { echo "$(date -u +%FT%TZ) [lane $LANE] $*" >> "$Q.log"; }

run() {
  node apps/cli/src/cli.ts eval run "$suite" --task "$task" --reps 1 --first-rep "$rep" "${LANE_ARGS[@]}" "$@" \
    >> "$Q.lane$LANE.out" 2>&1 || log "!! run failed: $task rep $rep $*"
}

take() {
  until mkdir "$Q.lock" 2>/dev/null; do sleep 1; done
  line=$(head -n 1 "$Q")
  if [ -n "$line" ]; then tail -n +2 "$Q" > "$Q.tmp" && mv "$Q.tmp" "$Q"; fi
  rmdir "$Q.lock"
}

while true; do
  if [ -n "${DRY_RUN:-}" ]; then line=$(sed -n "${DRY_LINE:-1}p" "$Q"); else take; fi
  [ -z "$line" ] && break
  IFS='|' read -r suite memory out task rep n <<< "$line"
  nomem=(--setup no-memory --out "$out/nomem-lane$LANE")
  mem=(--setup scripts --memory "$memory" --frozen --out "$out/scripts-lane$LANE")
  flip=$(((n + rep) % 2))
  [ "$LANE" != 1 ] && flip=$((1 - flip))
  log "start $task rep $rep ($([ $flip = 0 ] && echo "no memory first" || echo "memory first"))"
  if ((flip == 0)); then run "${nomem[@]}"; run "${mem[@]}"; else run "${mem[@]}"; run "${nomem[@]}"; fi
  log "done $task rep $rep"
  [ -n "${DRY_RUN:-}" ] && break
done
log "queue empty, lane done"
