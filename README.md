# singularity

Procedural memory for coding agents: learn from past Claude Code sessions so
repeated and similar tasks take less time and fewer tokens. See `HANDOFF.md`
for the design, decisions and results, and `CLAUDE.md` for how the code is
written.

TypeScript 7 and Effect 4, run directly by Node 24 (no build step):

```
npm install
npm test               # vitest
npm run typecheck      # tsc
```

## Summarize a session

```
node src/cli.ts traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls, and repeated file reads.

## Run an evaluation

```
node src/cli.ts eval run examples/excalidraw/suite.toml --reps 3 [--task ID ...] [--dry-run]
node src/cli.ts eval report runs/excalidraw/<run dir> [more dirs...] [--compare]
```

A suite (TOML, see `examples/excalidraw/suite.toml` and `src/eval/Suite.ts`)
names a source repo, agent settings, and tasks. Each task has a base commit, a
prompt, and check commands that decide success. `check_files` can add hidden
tests after the agent finishes, so the agent can't edit them to pass.
`examples/excalidraw/` is the real evaluation suite (two task families against
a local excalidraw clone); `examples/toy/` is a small, cheap one against this
repo's history.

Every run starts from a clean clone of the repo at the task's base commit, in
`<workspaces>/<suite>`. Workspaces default to `C:\singularity-workspaces` on
Windows (outside the home folder, so a CLAUDE.md there isn't loaded into runs)
and `~/.singularity/workspaces` elsewhere; set `SINGULARITY_WORKSPACES` or pass
`--workspaces` to change it. The clone has no remote, so the source repo is
never touched, and no branches, tags or reflog, so later commits (which may
hold hidden tests) stay out of the agent's sight.

Claude Code runs headless with its auto-memory off and no MCP servers. The
harness runs everything below normal priority, and a suite's `env` table can
cap test workers, so the machine stays usable. Each run records cost, tokens,
wall time, tool calls, and check results to `results.jsonl`, and saves the
transcript and diff alongside. Use `--dry-run` to see the exact `claude`
command without running anything.

## Memory setups

`--setup` picks what the agent is given:

- `no-memory`: nothing (the baseline).
- `saved-scripts`: the closest past successful run (its prompt, files, source
  diff and working commands), matched by prompt similarity. Needs
  `--memory DIR`; add `--frozen` for measurement runs so memory doesn't change
  while it's being measured.

Build memory from runs already recorded, without running the agent again:

```
node src/cli.ts eval learn examples/excalidraw/suite.toml runs/excalidraw/baseline-1 \
  --setup saved-scripts --memory runs/excalidraw/memory/saved-scripts --task altkey-zen-m
```

New setups implement `MemorySetup` in `src/eval/Setups.ts`.
