# Pre-registration: the graph setup on excalidraw

Written on 2026-10-01, before any graph was built, and committed together with
the three new tasks. The tasks, hidden tests, setups, run counts and thresholds
below don't change after the graph exists. Every task is reported, including
losses.

## The claim

Saved-scripts remembers whole tasks; the graph remembers steps. On exact
repeats and close variants a saved diff is already near the best possible
(tokens fell 75% and 61% against no memory). So the graph is worth its
complexity only where a new task reuses *parts* of past work, or where
*mistakes* from past runs matter. If it doesn't win there, that is a result
too: saved-scripts would be good enough.

## Memory: same input for every setup

Memory is built only from the two seed tasks' no-memory runs: `altkey-zen-m`
(3 runs in `runs/excalidraw/baseline-1`) and `toggle-minimap` (3 runs in
`runs/excalidraw/baseline-2-toggle`). Runs of a task being measured never go
into memory, and memory is frozen during measurement runs.

| Setup | Memory |
|---|---|
| `no-memory` | nothing |
| `saved-scripts` | the cheapest successful run of each seed task (`runs/excalidraw/memory/saved-scripts`, built earlier with `learn`); the best match above similarity 0.35 |
| `saved-scripts-top2` | the same memory; up to the two best matches, each above 0.35 |
| `graph` | built by Sonnet from all 6 seed runs, one run at a time, so detours can become pitfalls; not edited by hand |
| `graph` (zen only) | built the same way from the 3 zen-mode runs only, for the partial-overlap test |

The graph's design (how it is built, retrieved and rendered) may still be
fixed before measurement, but only by looking at what it gives the six
existing tasks, never the new ones.

## The new kinds of task

All three are in `suite.toml`, with hidden tests in `hidden/` and reference
solutions in `reference/`. Each was validated: its checks fail at the base
commit and pass on the reference solution.

| Kind | Task | Saved-scripts retrieves (prompt similarity) | What that leaves out |
|---|---|---|---|
| Recombined | `midpoint-snap-n`: give the existing "Snap to midpoints" setting an Alt+N shortcut, listed in the help dialog | zen mode (0.42), then minimap (0.37) | Zen mode only *changed* a shortcut. Adding one (a new shortcut-name entry and help row) is what the minimap run did. The new keyTest also changes the contextmenu snapshot |
| Subset | `page-breaks`: a "Show page breaks" setting in Preferences only, with no shortcut or context menu entry | minimap (0.72) | Nothing is missing, but about half of minimap's diff is work to skip |
| Lesson from failures | `stats-shortcut-k`: change the stats panel shortcut Alt+/ → Alt+K and add a test in `excalidraw.test.tsx` | zen mode (0.57) | That file lacks `handleKeyboardGlobally`, so a key event sent to the document never arrives. 2 of 3 zen baseline runs lost about 20 tool calls there; the saved zen run wrote no test, so it can't warn about it. Checked: the reference test fails with exactly that symptom when the prop is removed |
| Partial overlap | no new task: memory from zen mode only, measured on the three toggle tasks | nothing (0.10–0.20, below 0.35) | Everything; the graph can still contribute the shortcut steps |

## Runs

| What | Setups | Runs |
|---|---|---|
| The 3 new tasks | `no-memory`, `saved-scripts`, `graph` | 5 per task and setup: 45 |
| `midpoint-snap-n` | `saved-scripts-top2` | 5 |
| The 6 existing tasks | `graph` | 3 per task: 18, against `saved-scripts-1` (3 per task, already run) |
| The 3 toggle tasks | `graph` (zen only) | 3 per task: 9, against `baseline-2-toggle` |

`saved-scripts-top2` runs only where its notes differ from `saved-scripts`'.
For `page-breaks` and `stats-shortcut-k` only one saved run clears 0.35, so
both variants hand over the identical notes; this is checked with the
injection preview before running. In the partial-overlap test, saved-scripts
with zen-only memory injects nothing, which makes it the no-memory baseline.

77 runs, about $15 at recent costs. Sonnet 5.5 at medium effort, as in every
earlier run.

## What counts as a win

Headline metric: median total tokens per task (cache reads included), as in
the earlier results. Cost is reported alongside. Tool calls and wall time are
reported but don't decide anything: one run solved a task in 3 calls with a
single 4,000-character script, and wall time was inflated by other load.

1. **Not worse where saved-scripts is strong.** On the 6 existing tasks, the
   median of the per-task changes in median tokens, graph against
   saved-scripts, is at most +15%, and the graph has no more failed runs.
2. **Better where it should be.** The graph wins a kind of task when its median
   tokens are at least 25% below the better saved-scripts variant's (for
   partial overlap: the median of the per-task changes over the three toggle
   tasks, against no memory), with no more failed runs. The claim holds if the
   graph wins at least 3 of the 4 kinds.

Medians come with their min–max range. A win where the graph's median falls
inside the other setup's range is reported as within run-to-run noise.
