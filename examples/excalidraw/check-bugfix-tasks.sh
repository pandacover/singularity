#!/bin/bash
# Checks the bug-fix tasks of suite.toml before any run: at each task's base
# commit its hidden test must fail (the bug is there), and pass with the
# upstream fix applied, with the typecheck passing too. Uses an eval
# workspace (its node_modules fits every base, since the lockfile is the
# same); don't run it while runs use that workspace.
#
#   bash examples/excalidraw/check-bugfix-tasks.sh [WORKSPACE]
set -u
export FORCE_COLOR=0 NO_COLOR=1
here="$(cd "$(dirname "$0")" && pwd)"
ws="${1:-C:/singularity-workspaces/excalidraw}"
cd "$ws" || exit 2

check() {
  local task=$1 base=$2 test=$3
  git checkout -q --force --detach "$base" && git clean -ffdxq -e node_modules
  cp "$here/hidden/$task/$test" "$test"
  local before after tsc
  before=$(yarn -s vitest run --minWorkers=1 --maxWorkers=2 "$test" 2>&1 | grep -E "^ +Tests " | tr -s ' ')
  git checkout -q -- "$test"
  git apply "$here/reference/$task.patch" && cp "$here/hidden/$task/$test" "$test"
  after=$(yarn -s vitest run --minWorkers=1 --maxWorkers=2 "$test" 2>&1 | grep -E "^ +Tests " | tr -s ' ')
  tsc=skipped
  [ -z "${SKIP_TSC:-}" ] && tsc=$(yarn -s tsc >/dev/null 2>&1 && echo "tsc ok" || echo "TSC FAILS")
  echo "$task: without the fix [$before], with it [$after], $tsc"
  git checkout -q --force . && git clean -ffdxq -e node_modules
}

check eraser-while-drawing 4ce70b81 packages/excalidraw/tests/multiPointCreate.test.tsx
check edit-arrow-crash 792ea3a0 packages/element/tests/linearElementEditor.test.tsx
check save-as-in-text d29d8648 packages/excalidraw/wysiwyg/textWysiwyg.test.tsx
check dropdown-outside-click f1a79b73 packages/excalidraw/components/dropdownMenu/DropdownMenu.test.tsx
