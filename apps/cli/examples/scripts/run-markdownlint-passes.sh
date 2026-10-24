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
# STOP_USD, if set: no pass starts once the records under ROOT cost that much.
# A pass whose sessions hit a rate or usage limit stops the run (the pass is
# rerun whole, not counted).
set -u
cd "$(dirname "$0")/../markdownlint"
ROOT=${ROOT:-C:/singularity-workspaces/eval-1016/ml}
APP=${APP:-C:/singularity-workspaces/eval-1016/app}
CC=${CC:-C:/singularity-workspaces/_claude/2.1.295/claude.exe}
spent() {
  cat "$ROOT"/runs-p*/*/records.jsonl 2>/dev/null | node -e 'let t=0;for(const l of require("fs").readFileSync(0,"utf8").split(/\r?\n/))if(l.trim())t+=JSON.parse(l).result?.total_cost_usd??0;console.log(t.toFixed(2))'
}
# A session that ended on an API error naming a rate or usage limit (its
# result, not the agent's own words).
limited() {
  node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){try{const r=JSON.parse(fs.readFileSync(f,"utf8").trim().split(/\r?\n/).pop());if(r.is_error&&(r.api_error_status===429||/429|rate.?limit|usage limit/i.test(String(r.result))))process.exit(0)}catch{}}process.exit(1)' "$1"/*/*/agent.stdout
}
for p in $(seq "$1" "$2"); do
  runs="$ROOT/runs-p$p"
  if [ -n "${STOP_USD:-}" ] && node -e "process.exit(Number('$(spent)') >= Number('$STOP_USD') ? 0 : 1)"; then
    echo "$(date -u +%FT%TZ) stopped before pass $p: \$$(spent) spent" >> "$ROOT/passes.log"; exit 0
  fi
  mkdir -p "$runs"
  echo "$(date -u +%FT%TZ) pass $p started" >> "$ROOT/passes.log"
  for arm in without with; do
    extra=()
    [ "$arm" = with ] && extra=(--home "$ROOT/sg-home-p$p" --app "$APP")
    node driver.mjs --arm "$arm" --repo "$ROOT/arm-$arm-p$p" --out "$runs/$arm" --claude "$CC" \
      --setting-sources project,local "${extra[@]}" >> "$runs/$arm.out" 2>&1 &
  done
  wait
  echo "$(date -u +%FT%TZ) pass $p done, \$$(spent) spent" >> "$ROOT/passes.log"
  if limited "$runs"; then
    echo "$(date -u +%FT%TZ) stopped after pass $p: a session hit a rate or usage limit" >> "$ROOT/passes.log"; exit 0
  fi
done
