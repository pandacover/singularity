# singularity

Procedural memory for coding agents: learn from past Claude Code sessions so
repeated and similar tasks take less time and fewer tokens. See HANDOFF.md for
the design.

Requires Python 3.11+. Tests: `python -m pytest`.

## Summarize a session

```
PYTHONPATH=src python -m singularity.traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls, and repeated file reads.

## Run an evaluation

```
PYTHONPATH=src python -m singularity.eval run examples/toy/suite.toml --reps 3
PYTHONPATH=src python -m singularity.eval report runs/toy/<run dir> [more dirs...]
```

A suite (TOML, see `examples/toy/suite.toml` and `src/singularity/eval/suite.py`)
names a source repo, agent settings, and tasks. Each task has a base commit, a
prompt, and check commands that decide success. `check_files` can add hidden
tests after the agent finishes, so the agent can't edit them to pass.

Every run starts from a clean clone of the repo at the task's base commit, in
`~/.singularity/workspaces/<suite>`. The clone has no remote, so the source repo
is never touched. Claude Code runs headless with its auto-memory off and no MCP
servers. Each run records cost, tokens, wall time, tool calls, and check
results to `results.jsonl`, and saves the transcript and diff alongside.
Use `--dry-run` to see the exact `claude` command without running anything.

`--setup` picks the memory setup. Only `no-memory` exists so far; the
saved-scripts baseline and the procedural graph plug in through
`MemorySetup` in `src/singularity/eval/setups.py`.
