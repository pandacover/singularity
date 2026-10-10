#!/bin/sh
# Try the install as a user gets it, with the code as it is in this checkout,
# uncommitted changes included, in a sandbox: nothing outside it changes.
#
#   sh <repo>/scripts/try-install.sh [--fresh] [--update] [--setup] [--own-node] [setup flags]
#
# The first run installs from zero, the way `curl .../install.sh | sh` does,
# and runs setup; a run after that updates, the way running the installer
# again does. --fresh starts over; --update updates (and says so when nothing
# is installed yet); --setup runs `singularity setup` from this checkout
# instead, the way a user runs it again later, with no install; --own-node
# makes the installer fetch its own Node.js. Anything else goes to setup.
#
# The sandbox (${TMPDIR:-/tmp}/singularity-try) is a home of its own: agents
# found on PATH get memory in its copies of their folders, not yours, and the
# installer serves this checkout from a git repository there. Setup gets
# --no-path, so no shell startup file (or Windows' registry, from Git Bash)
# changes.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
sandbox="${TMPDIR:-/tmp}/singularity-try"
fresh=""
own=""
setup=""
update=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) fresh=1 ;;
    --own-node) own=1 ;;
    --setup) setup=1 ;;
    --update) update=1 ;;
    *) break ;;
  esac
  shift
done
if [ -n "$update" ] && { [ -n "$fresh" ] || [ -n "$setup" ] || [ $# -gt 0 ]; }; then
  printf 'try-install: --update runs the installer the way it updates, with no flags; it goes with nothing else.\n' >&2
  exit 2
fi

[ -z "$fresh" ] || rm -rf "$sandbox"
mkdir -p "$sandbox/home"
home="$sandbox/home"
memory="$home/.singularity"
served="$sandbox/served.git"

# This checkout as one commit, untracked files too (not ignored ones), made
# with an index of its own: the checkout's index, branches and stash stay as they are.
rm -f "$sandbox/index"
GIT_INDEX_FILE="$sandbox/index" git -C "$repo" -c core.safecrlf=false add -A
tree="$(GIT_INDEX_FILE="$sandbox/index" git -C "$repo" write-tree)"
rm -f "$sandbox/index"
commit="$(git -C "$repo" -c user.name=try -c user.email=try@localhost commit-tree "$tree" -p HEAD -m 'try-install snapshot')"
[ -d "$served" ] || git init -q --bare "$served"
git -C "$repo" push -q -f "$served" "$commit:refs/heads/main"
# Git for Windows takes a Windows path in a file:// address.
url="file://$served"
if command -v cygpath >/dev/null 2>&1; then url="file:///$(cygpath -m "$served")"; fi

# The sandbox's home, for setup and every agent it finds.
sandboxed() {
  env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u HERMES_HOME -u XDG_CONFIG_HOME \
    HOME="$home" USERPROFILE="$home" LOCALAPPDATA="$home/AppData/Local" APPDATA="$home/AppData/Roaming" \
    SINGULARITY_HOME="$memory" SINGULARITY_REPO="$url" SINGULARITY_REF=main SINGULARITY_AUTOLEARN=off \
    ${own:+SINGULARITY_OWN_NODE=1} "$@"
}

status=0
if [ -n "$setup" ]; then
  printf 'try-install: singularity setup from %s, in %s\n' "$repo" "$sandbox"
  sandboxed node "$repo/apps/cli/src/singularity.ts" setup --no-path "$@" || status=$?
  printf '\ntry-install: --setup again changes the answers; without it, the installer updates.\n'
  exit "$status"
fi

if [ -n "$update" ] && [ ! -f "$memory/bin/singularity" ]; then
  printf 'try-install: nothing is installed in %s yet, so there is nothing to update; run it without --update first.\n' "$sandbox" >&2
  exit 2
fi

# Installed already: no flags, so the installer updates. Otherwise setup, kept off PATH.
if [ -f "$memory/bin/singularity" ] && [ $# -eq 0 ]; then what=updating; else what=installing; set -- --no-path "$@"; fi
printf 'try-install: %s of %s, %s in %s\n' "$(printf '%s' "$commit" | cut -c1-7)" "$repo" "$what" "$sandbox"
sandboxed sh "$repo/install.sh" "$@" || status=$?
printf '\ntry-install: run it again to try the update; --fresh starts over.\n'
exit "$status"
