#!/bin/bash
# The runs of PREREGISTRATION-v1-new-kinds.md: memory v1 on bug fixes in
# excalidraw and on a second repository, validator.js. All on Claude Code
# 2.1.286, pinned as a copy under <workspaces>/_claude, as in this session's
# other measurements.
#
#   bash examples/run-new-kinds.sh bugfix-seeds
#       the two bug-fix seeds, 2 runs each without memory (memory learns from them)
#   bash examples/run-new-kinds.sh validator-seeds
#       the two validator.js seeds, 2 runs each without memory
#   bash examples/run-new-kinds.sh bugfix FIRST LAST
#       passes FIRST..LAST: the two held-out bug fixes without memory and with
#       the excalidraw memory (`--setup workflows-split`, runs/excalidraw/memory/v1-bugfix),
#       the two setups taking turns going first
#   bash examples/run-new-kinds.sh validator FIRST LAST
#       the same for the two held-out validator.js tasks (runs/validator/memory/v1)
#
# LANE=2 gives a lane its own workspace and output directories (suffix
# -lane2). Everything runs below normal priority; DRY_RUN=1 prints each run's
# plan instead of running it.
set -u
cd "$(dirname "$0")/.."

EXCALIDRAW=examples/excalidraw/suite.toml
VALIDATOR=examples/validator/suite.toml
BUGFIX_MEMORY=runs/excalidraw/memory/v1-bugfix
VALIDATOR_MEMORY=runs/validator/memory/v1

root=$(node -e 'import("./src/eval/Runner.ts").then((m) => console.log(m.defaultWorkspaces()))')
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
  node src/cli.ts eval run "$@" --frozen --claude "$CC" "${LANE_ARGS[@]}" || echo "!! run failed: $*" >&2
}

# One pass over two held-out tasks: without memory and with it, the setups
# taking turns going first, and the tasks in the other order on odd passes.
pass() {
  local suite=$1 memory=$2 out=$3 rep=$4 a=$5 b=$6
  local tasks=(--task "$a" --task "$b")
  ((rep % 2 == 1)) && tasks=(--task "$b" --task "$a")
  local nomem=(--setup no-memory "${tasks[@]}" --out "runs/$out/nomem$SUFFIX")
  local mem=(--setup workflows-split --memory "$memory" "${tasks[@]}" --out "runs/$out/memory$SUFFIX")
  if ((rep % 2 == 0)); then
    run "$suite" --reps 1 --first-rep "$rep" "${nomem[@]}"
    run "$suite" --reps 1 --first-rep "$rep" "${mem[@]}"
  else
    run "$suite" --reps 1 --first-rep "$rep" "${mem[@]}"
    run "$suite" --reps 1 --first-rep "$rep" "${nomem[@]}"
  fi
}

case "${1:-}" in
  bugfix-seeds)
    run "$EXCALIDRAW" --setup no-memory --task eraser-while-drawing --task edit-arrow-crash --reps 2 \
      --out "runs/excalidraw/bugfix-seeds$SUFFIX"
    ;;
  validator-seeds)
    run "$VALIDATOR" --setup no-memory --task aba-routing --task iso31661-numeric --reps 2 --out "runs/validator/seeds$SUFFIX"
    ;;
  bugfix) for ((rep = $2; rep <= $3; rep++)); do pass "$EXCALIDRAW" "$BUGFIX_MEMORY" excalidraw/bugfix "$rep" save-as-in-text dropdown-outside-click; done ;;
  validator) for ((rep = $2; rep <= $3; rep++)); do pass "$VALIDATOR" "$VALIDATOR_MEMORY" validator/held-out "$rep" ulid postal-code-pk; done ;;
  *) echo "usage: $0 bugfix-seeds | validator-seeds | bugfix|validator FIRST LAST" >&2; exit 2 ;;
esac
