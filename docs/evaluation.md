# Evaluating memory

The eval harness runs Claude Code on a suite of tasks, with or without
memory, and records what each run cost and whether it passed. Every
measurement in the `PREREGISTRATION*.md` files under `apps/cli/examples/`
came from it. Runs spend real money on your Claude account: use `--dry-run`
first, and keep `max_budget_usd` set in suites.

## Run a suite

```
node apps/cli/src/cli.ts eval run apps/cli/examples/excalidraw/suite.toml --reps 3 [--task ID ...] [--dry-run]
node apps/cli/src/cli.ts eval report runs/excalidraw/<run dir> [more dirs...] [--compare]
```

A suite (TOML; see `apps/cli/examples/excalidraw/suite.toml` and
`apps/cli/src/eval/Suite.ts`) names a source repo, agent settings and tasks.
Each task has a base commit, a prompt, and check commands that decide
success. `check_files` adds hidden tests after the agent finishes, so the
agent can't edit them to pass.

- `apps/cli/examples/excalidraw/`: the main suite, task families against a
  local excalidraw clone; `long.toml` is a task that asks for several
  changes at once.
- `apps/cli/examples/validator/`: a second repository's suite.
- `apps/cli/examples/toy/`: a small, cheap one against this repo's history.

Every run starts from a clean clone of the repo at the task's base commit,
in `<workspaces>/<suite>`. Workspaces default to `C:\singularity-workspaces`
on Windows (outside the home folder, so a CLAUDE.md there isn't loaded into
runs) and `~/.singularity/workspaces` elsewhere; `SINGULARITY_WORKSPACES` or
`--workspaces` changes it. The clone has no remote, so the source repo is
never touched, and no branches, tags or reflog, so later commits (which may
hold hidden tests) stay out of the agent's sight.

Claude Code runs headless with its auto-memory off and no MCP servers. The
harness runs everything below normal priority (`--priority normal` when
nothing else needs the machine), and a suite's `env` table can cap test
workers, so the machine stays usable. Each run records cost, tokens, wall
time, tool calls and check results to `results.jsonl`, and saves the
transcript and diff alongside. `--dry-run` shows the exact `claude` command
without running anything.

Compare runs only with runs of the same Claude Code version: it updates
itself, and each turn rereads its own prompt. `--claude PATH` runs another
Claude Code, such as a pinned copy of an earlier version
(`~/.local/share/claude/versions/` keeps a few). Runs never update it.

## Memory setups

`--setup` picks what the agent is given:

| Setup | What the agent gets |
|---|---|
| `no-memory` | nothing: the baseline |
| `saved-scripts` | the closest past successful run (its prompt, files, source diff and working commands), matched by prompt similarity |
| `saved-scripts-top2` | up to the two closest past runs, each similar enough |
| `graph` | the procedural graph: a checklist of the steps that apply, picked by Sonnet from the steps near the task (about $0.01, counted in the run) |
| `saved-scripts-warnings` | the closest past run, plus the graph's warnings without the checklist |
| `hooks` | memory v0, handed over by its own hooks as in daily use |
| `workflows` | memory v1 as first measured: a model call picks the workflows at task start |
| `workflows-cues` | memory v1, local first: cues pick the workflows with no model call and fill in the blanks the task states |
| `workflows-split` | `workflows-cues`, with a hand-over too long for one hook sent in two parts |
| `workflows-draft` | tested and dropped: the change itself, drafted at task start |

Setups other than `no-memory` need `--memory DIR`; add `--frozen` for
measurement runs, so memory doesn't change while it is measured. The
memory setups copy the memory home into each run's directory, and their
hooks reach Claude Code through `--settings`. Model calls the hooks make
run the same Claude Code as the agent and count toward the run. Each run of
a `workflows` setup keeps its hand-over log (what was shown, at which
lines), which `workflows evolve` learns from.

Eval memory lives in its own home, `runs/eval-home` (`--home
runs/eval-home`, or `npm run cli:eval -- ...`), never in `~/.singularity`;
runs measure frozen copies of it under `runs/<suite>/memory/`. The harness
sets `SINGULARITY_HOOKS=off`, which silences memory's installed hooks, and
marks a run's own hooks so that they fire anyway.

Preview what a setup would hand each task, or what one task would get from
v1 memory (give `workflows handover` a copy of a frozen memory: reading a
repo from a new path adds that path to the memory's subjects):

```
node apps/cli/src/cli.ts eval inject apps/cli/examples/excalidraw/suite.toml --setup graph --memory runs/excalidraw/memory/graph
node apps/cli/src/cli.ts workflows handover "the prompt" --cwd REPO --at COMMIT --home COPY_OF_MEMORY --pick cues
node apps/cli/src/cli.ts graph show runs/excalidraw/memory/graph
```

Build memory from runs already recorded, without running the agent again:

```
node apps/cli/src/cli.ts eval learn apps/cli/examples/excalidraw/suite.toml runs/excalidraw/baseline-1 \
  --setup saved-scripts --memory runs/excalidraw/memory/saved-scripts --task altkey-zen-m
```

`eval report --compare --baseline saved-scripts` compares setups against
saved-scripts instead of no memory. New setups implement `MemorySetup` in
`apps/cli/src/eval/Setups.ts`.
