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

## Follow-up: saved solutions with the graph's warnings

Written on 2026-10-02, after the results above and before any run of this
setup. Its rules don't change once the runs start.

**Why.** The checklist lost, but the graph's warnings did their job wherever
they applied. Counted in the existing runs with `check-warnings.ts`, no new runs:

- `yarn test:update` already passes `--watch=false`, so passing it again
  fails. Runs that ran the command did that in 20 of 21 saved-scripts runs,
  31 of 44 no-memory runs and 0 of 34 graph runs. Each costs a turn and a
  full suite run, about 40k tokens.
- On `stats-shortcut-k`, every saved-scripts run (5 of 5) wrote its first
  test without `handleKeyboardGlobally`, and 4 of them lost 126k–615k tokens
  finding out why the key presses did nothing. Every graph run (0 of 5) used
  it from the start.
- The saved minimap solution lists the failing command as one that worked:
  a pipe into `tail` hid its exit status.

**What changes.**

1. A fix to saved-scripts: a shell command whose output reports a failure
   (a nonzero exit code, `npm ERR!`, a TypeScript error, failed tests) no
   longer counts as one that worked. The memory is rebuilt from the same seed
   runs into `runs/excalidraw/memory/saved-scripts-2`. Only the minimap entry
   changes: it loses that command and a failed prettier check.
2. A new setup, `saved-scripts-warnings`: the saved-scripts notes, then the
   graph's warnings, with no checklist and no model call. The notes come from
   the rebuilt memory: the best match above 0.35. The warnings are every
   pitfall and dead end on the edges into the steps that the graph setup's
   retrieval reaches; on this graph that is all 13 steps, for every task. They
   are listed under their step, with the condition of the edge they were
   recorded on, so that a warning which holds on one path only is shown with
   it. The graph is the measured one, version 6, unchanged.

The design was fixed by looking only at what it gives the six existing tasks.
The conditions went in after the preview showed "skipping this fails the
context menu test" bare, under the test step of a shortcut-only task. The
warnings add about 5,700 characters (about 1,400 tokens) to every task.

This checks the mechanism; it isn't a fresh test. Its idea came from the
results on the new tasks, and two of its three tasks are new tasks. No memory
comes from them.

**Runs.** 13, in two lanes as before, with the same cut-off rule:

| Task | Runs | Compared against |
|---|---|---|
| `stats-shortcut-k` | 5 | saved-scripts 491k (218–833k), graph 252k (234–289k) |
| `page-breaks` | 5 | saved-scripts 304k (264–348k), graph 336k (250–382k) |
| `altkey-zen-m` | 3 | saved-scripts 120k (116–148k), in `saved-scripts-1` (Claude Code 2.1.286) |

On `page-breaks` the fix and the warnings both change what the agent sees, so
this check can't tell their effects apart. On the other two tasks only the
warnings change it.

**What counts.** Medians of total tokens. Counts from `check-warnings.ts`.

1. **The warnings are followed.** Of the runs that run `yarn test:update`, at
   most 1 passes `--watch=false` to it. At most 1 of the 5 `stats-shortcut-k`
   runs writes its first test without `handleKeyboardGlobally`.
2. **Not worse where saved-scripts is strong.** On `altkey-zen-m` the median
   is at most 138k (+15%), and at most 1 of the 3 runs changes a test file
   (saved-scripts 0 of 3, graph 3 of 3).
3. **Better where the warnings apply.** On `stats-shortcut-k` the median is at
   most 368k (−25%). On `page-breaks` it is at most 304k. Five runs can't
   show the 10–15% gain expected there, so this only checks that the warnings
   don't cost more than they save.
4. **No failed runs.** Saved-scripts had none on these tasks.

If all four hold, `saved-scripts-warnings` is the memory the hosted version
starts from. If not, we decide again from what failed.

### Follow-up results (2026-10-02)

All 13 runs passed. They ran 20:36–21:13 local time on Claude Code 2.1.287 and
cost $1.27. No agent command reached its time limit (longest 317 s of 600 s),
so no run was rerun. Output: `runs/excalidraw/saved-scripts-warnings-1*`.

| Rule | Result | Verdict |
|---|---|---|
| 1. Warnings followed | `--watch=false` passed to `yarn test:update` in 0 of the 5 runs that ran it. First test without `handleKeyboardGlobally` in 0 of 5 | holds |
| 2. `altkey-zen-m` | 118k (118–147k) against saved-scripts 120k (116–148k): −2%. Test files changed in 0 of 3 | holds |
| 3. `stats-shortcut-k` | 187k (120–263k) against saved-scripts 491k (218–833k): −62% | holds |
| 3. `page-breaks` | 180k (170–226k) against saved-scripts 304k (264–348k): −41% | holds |
| 4. Failed runs | 0 of 13 | holds |

**All four hold:** `saved-scripts-warnings` is the memory the hosted version
starts from.

The user overrode that consequence the same day. Handing the agent a past
run's finished code to copy is an anti-pattern for them, so saved solutions,
with or without warnings, are the baseline. The product is the step graph, to
be improved until it gets close to them.

Observations, not part of the rules:

- It also beat the graph: on `stats-shortcut-k` 187k against 252k
  (234–289k), on `page-breaks` 180k against 336k (250–382k).
- On `page-breaks` the gain was larger than the 10–15% expected, because the
  old saved commands were costing more than one turn. Saved-scripts runs
  replayed the minimap entry's two failing commands, the doubled
  `--watch=false` and then a prettier check that fails. Each cost a turn of
  about 40k tokens before the fix. They made 7–9 model calls; the combined
  runs made 5–6, running prettier first and the tests once. The fix and the
  warnings both point that way, and as planned, this check can't tell them
  apart.
- On `stats-shortcut-k` every run used `handleKeyboardGlobally` from its first
  test, and the saved zen-mode diff left little else to work out: 4–8 model
  calls, against 7–22 for saved-scripts.
- On `altkey-zen-m` the 1,400 tokens of warnings made no visible difference.
  The agent wrote no test the task didn't ask for.
- The `page-breaks` and `stats-shortcut-k` comparisons ran on the same Claude
  Code version, 2.1.287. The `altkey-zen-m` baseline ran on 2.1.286.
