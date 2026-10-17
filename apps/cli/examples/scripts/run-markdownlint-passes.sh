#!/bin/bash
# The markdownlint passes of PREREGISTRATION-eval-2026-10-16.md: in each pass
# both arms run side by side (../markdownlint/driver.mjs), each in a clone of
# its own (arm-<arm>-p<N>, made at 314ab18e beforehand), the with arm with a
# fresh memory home (sg-home-p<N>) and the memory code in APP; then the next
# pass.
#
#   bash apps/cli/examples/scripts/run-markdownlint-passes.sh FIRST LAST
#
# ROOT holds the clones, homes and runs-p<N>; CC is the pinned Claude Code.
# Sessions leave the user's own settings out (--setting-sources project,local).
set -u
cd "$(dirname "$0")/../markdownlint"
ROOT=${ROOT:-C:/singularity-workspaces/eval-1016/ml}
APP=${APP:-C:/singularity-workspaces/eval-1016/app}
CC=${CC:-C:/singularity-workspaces/_claude/2.1.295/claude.exe}
for p in $(seq "$1" "$2"); do
  runs="$ROOT/runs-p$p"
  mkdir -p "$runs"
  echo "$(date -u +%FT%TZ) pass $p started" >> "$ROOT/passes.log"
  for arm in without with; do
    extra=()
    [ "$arm" = with ] && extra=(--home "$ROOT/sg-home-p$p" --app "$APP")
    node driver.mjs --arm "$arm" --repo "$ROOT/arm-$arm-p$p" --out "$runs/$arm" --claude "$CC" \
      --setting-sources project,local "${extra[@]}" >> "$runs/$arm.out" 2>&1 &
  done
  wait
  echo "$(date -u +%FT%TZ) pass $p done" >> "$ROOT/passes.log"
done
