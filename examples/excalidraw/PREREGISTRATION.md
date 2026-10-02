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

## Amendments before measurement

Made after the graph was built and before any measurement run, from what it
gave the six existing tasks only. The tasks, runs and thresholds above are
unchanged.

- **The graph (2026-10-02).** Built from the 6 seed runs as planned: 13 steps,
  22 transitions, $0.53 for 6 Sonnet calls (`runs/excalidraw/memory/graph`,
  version 6). The zen-only graph is the same store at version 3, the state
  after the three zen runs and before any minimap run, read with
  `--graph-version 3`.
- **Step selection.** Word overlap alone handed the alt-shortcut tasks the
  toggle-setting steps as well: they sit downstream of the shortcut steps, and
  overlap can't read a step's condition ("when the toggle needs a keyboard
  shortcut"). So Sonnet, with thinking off, now reads the task and the
  candidate steps with their conditions and decides for each whether it
  applies. That costs about $0.005–0.013 per run, and the run's cost and
  tokens include it (`memory_spent` in the record). Haiku was tried first and
  rejected: with thinking on it spent about 8k tokens per answer, and with
  thinking off it dropped a needed step in 1 of 2 tries.
- **Rendering.** A step shows the advice on the edges from the chosen steps
  into it, and its conditions only when every such edge has one.
- **Two lanes (2026-10-02).** To about halve the wall time, the runs go
  through two clones of the repo at once (`LANE=2` in
  `run-graph-measurement.sh`). Lane 1 runs passes 0–2 of the new tasks and
  pass 2 of the existing ones, lane 2 the rest. Each pass stays in one lane,
  with its setups taking turns as before, and each lane writes its own output
  directories. Nothing the agent sees or the checks do changes. The agent's
  own test runs are slower when both clones test at once, so wall time is
  noisier; it doesn't decide anything.
- **Cut-off commands (2026-10-02, after the first 3 runs, before any
  cut-off).** With both clones testing at once, the full suite took 190–275 s
  instead of about 185 s, and one chained command (typecheck, lint fix and
  the full suite) took 441 s of the 600 s the agent allowed it. If an agent
  command reaches its time limit, the agent's behavior changes for a reason
  that has nothing to do with memory. So a run in which any agent command
  reaches its limit is rerun in one lane with nothing else running, and the
  rerun replaces it. If more than two runs are cut off, the remaining passes
  run in one lane.

## Results (2026-10-02)

All 77 runs completed, and no agent command reached its time limit. One run
failed: the graph on `toggle-rulers` labelled the setting "Toggle rulers"
(after the existing "Toggle grid") instead of "Rulers". The runs cost $18.21.
Median total tokens, with min–max:

| Rule | Comparison | Change | Verdict |
|---|---|---|---|
| 1. Existing tasks | graph against saved-scripts, median of the per-task changes | +82% (+25% to +114%); 1 failed run against 0 | fail |
| 2. Recombined | `midpoint-snap-n`: graph 432k (369–559k) against saved-scripts-top2 271k (215–419k) | +59% | no win |
| 2. Subset | `page-breaks`: graph 336k (250–382k) against saved-scripts 304k (264–348k) | +10% | no win |
| 2. Lesson from failures | `stats-shortcut-k`: graph 252k (234–289k) against saved-scripts 491k (218–833k) | −49% | win, within run-to-run noise |
| 2. Partial overlap | zen-only graph against no memory, median of the per-task changes on the toggle tasks | +42% (−6% to +51%) | no win |

**The claim doesn't hold.** The graph won 1 of the 4 kinds (3 were needed)
and used more tokens than saved-scripts on the existing tasks.

Observations, not part of the rules:

- Every graph run on a shortcut task (zen mode, view mode, snap, midpoint)
  was handed the `update_shortcut_tests` step and wrote a new keyboard test in
  `excalidraw.test.tsx`, though none of those prompts asked for one.
  Saved-scripts runs edited no test files there (1 of 5 on midpoint). The
  zen-only graph did the same on the toggle tasks, where it was worse than no
  memory.
- A checklist leaves the edits to the agent, while a saved diff can be copied:
  graph runs made more tool calls and reads than saved-scripts (zen mode 16
  against 8 calls, `toggle-rulers` 40 against 24).
- On `stats-shortcut-k` the graph's `handleKeyboardGlobally` pitfall worked:
  all 5 runs stayed between 234k and 289k tokens, against 471k–1,296k for no
  memory and 218k–833k for saved-scripts.
- The step selector added about 2.8k tokens per run, about 1%.
- The earlier runs used as baselines here (`saved-scripts-1`,
  `baseline-2-toggle`) ran on Claude Code 2.1.286, the measurement on 2.1.287
  (an auto-update). The new-task comparisons all ran on 2.1.287 and show the
  same pattern.
