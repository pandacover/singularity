#!/bin/bash
# The passes of PREREGISTRATION-day-2026-10-16.md: in each pass the three arms
# run side by side (../markdownlint/day-driver.mjs), each in a clone of its own
# (day-<arm>-p<N>, made at 314ab18e beforehand), old and new with a fresh
# memory home (day-home-<arm>-p<N>) and the memory code in OLD_APP or NEW_APP;
# then the next pass, unless SPENT_FILE says the cap is reached.
#
#   bash apps/cli/examples/scripts/run-day-passes.sh FIRST LAST
#
# ROOT holds the clones, homes and day-runs-p<N>; CC is the pinned Claude Code.
# It starts day-watchdog.ps1 beside the passes, and is best started by Task
# Scheduler: a process Windows' WMI host started (Win32_Process.Create) dies
# when that host is recycled, as pass 1 did once at 14:54Z.
set -u
cd "$(dirname "$0")/../markdownlint"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File day-watchdog.ps1 > /dev/null 2>&1 &
ROOT=${ROOT:-C:/singularity-workspaces/eval-1016/ml}
OLD_APP=${OLD_APP:-C:/singularity-workspaces/eval-1016/app}
NEW_APP=${NEW_APP:-C:/singularity-workspaces/eval-1016/app-new}
CC=${CC:-C:/singularity-workspaces/_claude/2.1.296/claude.exe}
CAP=${CAP:-60}
spent() {
  # Dollars spent so far, over every arm of every pass: each driver's last running total.
  local t=0 f last
  for f in "$ROOT"/day-runs-p*/*/driver.log; do
    [ -f "$f" ] || continue
    last=$(grep -o 'spent \$[0-9.]*' "$f" | tail -1 | awk -F'$' '{print $2}')
    t=$(awk -v a="$t" -v b="${last:-0}" 'BEGIN{printf "%.2f", a + b}')
  done
  echo "$t"
}
for p in $(seq "$1" "$2"); do
  if awk -v s="$(spent)" -v c="$CAP" 'BEGIN{exit !(s >= c)}'; then
    echo "$(date -u +%FT%TZ) pass $p not started: \$$(spent) spent, cap \$$CAP" >> "$ROOT/day-passes.log"
    break
  fi
  runs="$ROOT/day-runs-p$p"
  mkdir -p "$runs"
  echo "$(date -u +%FT%TZ) pass $p started" >> "$ROOT/day-passes.log"
  pids=()
  for arm in without old new; do
    extra=()
    [ "$arm" = old ] && extra=(--arm with --home "$ROOT/day-home-old-p$p" --app "$OLD_APP")
    [ "$arm" = new ] && extra=(--arm with --home "$ROOT/day-home-new-p$p" --app "$NEW_APP")
    [ "$arm" = without ] && extra=(--arm without)
    mkdir -p "$ROOT/day-home-$arm-p$p"
    [ "$arm" != without ] && printf '{\n  "tenant": "local"\n}\n' > "$ROOT/day-home-$arm-p$p/config.json"
    node day-driver.mjs "${extra[@]}" --repo "$ROOT/day-$arm-p$p" --out "$runs/$arm" --claude "$CC" >> "$runs/$arm.out" 2>&1 &
    pids+=($!)
  done
  limited=0
  for pid in "${pids[@]}"; do
    wait "$pid"
    [ $? -eq 75 ] && limited=1
  done
  if [ "$limited" = 1 ]; then
    # An arm met the account's usage limit (day-driver.mjs exits 75): the pass is incomplete; none after it starts.
    echo "$(date -u +%FT%TZ) pass $p stopped at the usage limit; run it again from fresh clones and homes" >> "$ROOT/day-passes.log"
    break
  fi
  echo "$(date -u +%FT%TZ) pass $p done" >> "$ROOT/day-passes.log"
done
