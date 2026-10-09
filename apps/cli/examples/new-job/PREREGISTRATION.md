# Pre-registration: the "new job" benchmark (computer use)

Written 2026-10-09 before any benchmark run, overnight, unattended. The design
and the bars are in `DESIGN-one-layer.md` (repo root); this file fixes what is
run, in which order, with which code.

## What is frozen

- **Memory code**: `apps/cli/src`, sha256 below, computed over every file
  (sorted by path; path and content). No change to it until every run below
  is done. A fix found during the runs means rerunning what it touches, and
  saying so here.
- **The benchmark**: built by a separate agent in its own T3 thread, sealed
  with the sha256 in `C:\singularity-workspaces\new-job-public\SEALED.txt`
  (copied below by the run script's log). Reached only through its runner.
- **Claude Code**: 2.1.295, a copy at
  `C:\singularity-workspaces\tools\claude-pinned\claude.exe`; runs never update it.
- **Agent**: Sonnet (`--model sonnet --effort medium`), Playwright MCP 0.0.83
  with Chrome headless and an in-memory profile, `--tools ""` (no shell, no
  files), `--max-turns 80`, `--max-budget-usd 2`, 20 minutes per chore.
- **Memory's learning**: Sonnet, high effort; a first build after 2 sessions
  of an app, then a round every 3; frozen in the test phase.

## Order (`runs/new-job/run-all.sh`)

One run per chore and condition, one at a time (every chore resets the same app servers):

1. none, learn phase; memory, learn phase
2. none, test phase; memory, test phase
3. none, update phase; memory, update phase
4. AWM's workflows induced from the learn-phase runs without memory that passed; awm, test and update
5. the onboarding guide; guide, test and update
6. the stand-in for a second agent: Haiku without memory, and Haiku with the memory home as it was after Sonnet's test phase (frozen), test phase

Then the runner's `reveal`, and the report (`node src/cli.ts web-bench report`).

## Amendment, before any test-phase run (00:37 UTC, 2026-10-09)

Runs take about 30 seconds, not the minutes planned for, so a second pass is
added for the comparison that matters most, after everything above
(`runs/new-job/run-r2.sh`):

7. none again, test and update phases (`none-r2`);
8. memory again, test phase, from a copy of the memory home as it was after
   the first test pass, frozen (`memory-r2`);
9. memory again, update phase, from another copy of that same home, learning
   as in daily use (`memory-r2`): an independent replicate of the update.

Both passes count in the bars: per chore, success is the share of its runs
that passed and turns are the median of its runs; harm is a chore memory
passed less often than no memory did. Nothing else changes.

## Bars

As in `DESIGN-one-layer.md`, "Bars, written before any run". One run per
chore and condition is a small sample; differences of a turn or two on a
single chore are noise, and the report says so where it matters.

## Hashes

- Memory code (`apps/cli/src`): see `runs/new-job/FREEZE.txt`, written by the freeze step before the first run.
