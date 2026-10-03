# Pre-registration: the local memory on excalidraw

Written on 2026-10-03, before any run of the `hooks` setup, and committed
before the first measured run. The memory, tasks, runs and rules below don't
change once the runs start. Every task is reported, including losses.

## The question

Build stage 4 (HANDOFF.md): the local memory, against saved solutions and no
memory. The goal, agreed before it was built: tokens close to saved-scripts,
success no worse. The memory stores no code: it hands over routes (steps,
where each happens, how it is checked) and warnings, some with exact triggers.

It is measured as it would be used: through its own hooks, not through the
system prompt. At the first prompt, word search proposes up to three kinds of
task, and Sonnet (thinking off) picks the kind and the steps that apply; the
route and its warnings arrive as additional context. During the run, after a
shell command or an edit, a warning whose exact trigger appears is handed over,
once. The route selection's model call counts toward the run's tokens and cost
(`memory_spent`), as the graph's step selection did.

## Memory: the same input as every earlier setup

As in PREREGISTRATION.md, memory is built only from the two seed tasks'
no-memory runs: `altkey-zen-m` (3 runs in `baseline-1`) and `toggle-minimap`
(3 runs in `baseline-2-toggle`). No run of another task goes into it.

Each memory was built with the current code in a home of its own
(`SINGULARITY_HOME`), so nothing from other tasks' records reaches it, not even
the names of their steps: `record import --task`, then the model's reading
(`record annotate`, Sonnet at medium effort; the zen runs first, the minimap
runs with the zen readings' names in view), then `memory build --conditions`,
whose replay check committed version 1.

| Memory | Built from | Content | Used for |
|---|---|---|---|
| `runs/excalidraw/memory/local-seed` | 3 zen and 3 minimap runs | 2 kinds of task, 10 steps, 5 warnings | the six existing tasks and the three new ones |
| `runs/excalidraw/memory/local-zen` | the 3 zen runs | 1 kind, 5 steps, 3 warnings | the partial-overlap test on the toggle tasks, like the zen-only graph |

The readings cost $0.35 and the conditions less than a cent. The replay check
over the six seed runs: every task gets the steps it needed and none it didn't
ask for, and the warnings reach all 9 detours that taught something, without
firing on a command that worked.

Each run copies its memory into its own directory and changes only the copy.
The memories stay as they are, checked after the runs by their hashes (`runs/`
isn't in git):

    (cd runs/excalidraw/memory/local-seed && find . -type f | LC_ALL=C sort | xargs sha256sum) | sha256sum
    local-seed  36401d2ba8cdc8560099f4dfa41b03a6cd9c68155dd6bac94ab7e8484df688f8
    local-zen   792606ea4429ae298e380ef469ddd2bbc63a98ad7cb9d9fda570e6c2586c7cf7

## The same conditions as the baselines

The suite (tasks, base commit, hidden tests, checks), the model (Sonnet 5.5 at
medium effort), the harness, the vitest cap and the low priority are the same
as in the earlier runs.

**Claude Code's version.** It updates itself, and each turn rereads its own
prompt, so a new version could change the tokens by itself. Its earlier
versions are still on disk, so every run uses the version its baselines used,
from a pinned copy (`<workspaces>/_claude/<version>/claude.exe`, byte-identical
to Claude Code's own), and no run updates it (`DISABLE_AUTOUPDATER=1`):

- 2.1.286 for the six existing tasks: their baselines are `baseline-1`,
  `baseline-2-toggle` and `saved-scripts-1`.
- 2.1.287 for the three new tasks: `baseline-3-new`, `saved-scripts-2-new`,
  `saved-scripts-top2-1`, `graph-1-new` and `saved-scripts-warnings-1`.

The hooks' own model call runs the same pinned copy (`SINGULARITY_CLAUDE`).

**The gate.** Something else could still have moved since 2026-10-01 (the
model behind the API, the machine). Before any measured run, 3 runs on each
version repeat an earlier setup whose runs were close together, with the same
memory:

| Version | Setup and task | Earlier runs | Passes if the new median is within |
|---|---|---|---|
| 2.1.286 | saved-scripts on `altkey-viewmode-j` | 140k (139–144k) | 119k–161k (±15%) |
| 2.1.287 | saved-scripts-warnings on `altkey-zen-m` | 118k (118–147k) | 100k–136k (±15%) |

If both pass, the earlier runs are the baselines. If either fails, nothing else
runs, and we decide with the user whether to rerun the baselines.

## Runs

| What | Setup | Claude Code | Runs |
|---|---|---|---|
| Smoke check, not counted | hooks, seed memory, `altkey-zen-m` | 2.1.286 and 2.1.287 | 2 |
| The gate | see above | both | 6 |
| The 6 existing tasks | hooks, seed memory | 2.1.286 | 3 per task: 18 |
| The 3 toggle tasks (partial overlap) | hooks, zen-only memory | 2.1.286 | 3 per task: 9 |
| The 3 new tasks | hooks, seed memory | 2.1.287 | 5 per task: 15 |

50 runs, about $10 at the earlier runs' costs. `run-local-memory-measurement.sh`
runs them: the smoke check and the gate in one lane, then the rest in two lanes
as before (about 3½ hours in all). The smoke check only shows that the hooks
work in the pinned versions (the route arrives, its cost is counted, no hook
error); if it shows a fault in the plumbing, the fix is listed below before any
counted run.

Output: `runs/excalidraw/hooks-1-existing*`, `hooks-zen-only-1*`,
`hooks-1-new*`, `drift-286*`, `drift-287*` and `hooks-smoke-*`. Each run keeps
what its hooks handed over (`injected.md`, and its copy of the memory home with
the session's hand-over log). Tables come from `eval report --compare` against
no memory and against saved-scripts (`--baseline saved-scripts`), the counts
from `check-warnings.ts`. The zen-only runs have the same setup name as the
seed memory's, so they are reported on their own.

## What counts

The headline is the median of total tokens per task (cache reads included),
with min–max. Cost is reported next to it; tool calls and wall time are
reported but decide nothing. A win whose median falls inside the other setup's
range is reported as within run-to-run noise.

**The goal.** These three decide stage 4:

1. **Close to saved-scripts where it is strong.** On the six existing tasks,
   the median of the per-task changes in median tokens, hooks against
   `saved-scripts-1`, is at most +15%. (The graph: +82%.)
2. **Never worse than no memory.** No task is worse: on none of the 12
   (the nine tasks with the seed memory, the three toggle tasks with the
   zen-only memory) is the median more than 15% above no memory's median and
   above no memory's highest run. (The zen-only graph was worse on two.)
3. **Success no worse.** None of the 42 runs fails its checks. Saved-scripts
   and no memory failed none of these tasks; the graph failed 1 of 42.

**The mechanisms**, counted with `check-warnings.ts`, each with its own verdict:

4. a. **The doubled flag**: of the runs that run `yarn test:update`, at most 1
      passes it `--watch=false` (on these tasks: no memory 16 of 28,
      saved-scripts 15 of 16, the graph 0 of 34).
   b. **`handleKeyboardGlobally`**: at most 1 of the 5 `stats-shortcut-k` runs
      writes its first test without it (no memory and saved-scripts 5 of 5;
      the graph and saved-scripts-warnings 0 of 5). The seed memory learned it
      from the two zen runs that lost 842k and 856k tokens to it.
   c. **No tests nobody asked for**: of the 11 runs on `altkey-zen-m`,
      `altkey-snap-u` and `midpoint-snap-n`, whose prompts ask for no new
      test, at most 3 change a test file (no memory 2 of 11, saved-scripts 1
      of 11, the graph 11 of 11).

**For comparison with the graph's claim** (reported; it doesn't decide stage 4):

5. The four kinds of new task as PREREGISTRATION.md defines them. A kind is won
   when the median is at least 25% below the better saved-scripts variant's,
   with no more failed runs: `midpoint-snap-n` at most 203k (saved-scripts-top2
   271k), `page-breaks` at most 228k (saved-scripts 304k), `stats-shortcut-k`
   at most 368k (saved-scripts 491k); partial overlap: the median of the
   per-task changes on the toggle tasks at most −25% against no memory. The
   graph won 1 of the 4.

If 1–3 hold, the local memory meets stage 4's goal, and the next stage is a
second subject (HANDOFF.md). If not, we decide again from what failed.

## Rules during the runs

- **Cut-off commands**, as before: a run in which an agent command reaches its
  time limit is rerun in one lane with nothing else running, and the rerun
  replaces it. If more than two runs are cut off, the remaining passes run in
  one lane.
- **Hook failures**: a run whose task-start hook didn't finish (no start entry
  in its hand-over log, `task_start: false` in its record) or logged an error
  (`hook_errors`) measured no memory, and is rerun once. If more than two runs
  are affected, the measurement stops. A failed route-selection call, which
  falls back to word search, is how the product behaves: counted, not rerun.
- Within each pass the setups take turns going first, as before.

## Baselines

Median total tokens (min–max), from the earlier runs:

| Task | Kind of run | No memory | Saved-scripts | Graph | Saved-scripts with warnings |
|---|---|---|---|---|---|
| `altkey-zen-m` | exact repeat | 1,165k (245–1,264k) | 120k (116–148k) | 221k (198–252k) | 118k (118–147k) |
| `altkey-viewmode-j` | similar | 315k (268–356k) | 140k (139–144k) | 277k (197–280k) | |
| `altkey-snap-u` | similar | 213k (211–279k) | 180k (145–223k) | 224k (221–226k) | |
| `toggle-minimap` | exact repeat | 787k (611–819k) | 312k (272–316k) | 499k (467–555k) | |
| `toggle-rulers` | similar | 563k (446–754k) | 187k (185–412k) | 399k (260–471k) | |
| `toggle-presenter` | similar | 673k (583–766k) | 221k (132–310k) | 398k (330–525k) | |
| `midpoint-snap-n` | recombined | 386k (355–466k) | 322k (285–532k); top2 271k (215–419k) | 432k (369–559k) | |
| `page-breaks` | subset | 324k (203–367k) | 304k (264–348k) | 336k (250–382k) | 180k (170–226k) |
| `stats-shortcut-k` | lesson from failures | 801k (471–1,296k) | 491k (218–833k) | 252k (234–289k) | 187k (120–263k) |

Zen-only graph on the toggle tasks: minimap 740k, rulers 852k, presenter 956k.
No memory, saved-scripts and the graph on the existing tasks, and the graph
and saved-scripts with warnings on `altkey-zen-m`, ran on different versions
(2.1.286 and 2.1.287) in the earlier comparisons; here every comparison that
decides something is between runs of the same version.

## What the six existing tasks get (previews before any run)

`handover --home` shows the hand-over without running the agent, its model
call included (about a cent each). The previews are saved in
`runs/excalidraw/previews-local-memory/`, and the memories' hashes didn't
change.

- **The shortcut tasks** (zen mode, view mode, snap): the kind "change an
  action's keyboard shortcut" and 4 steps: the key code, the action's keyTest,
  the shortcut label map and help dialog, the typecheck and tests. No test
  step: "the task doesn't explicitly ask for a new keyboard test". At the
  start, the doubled-flag warning, a prettier warning and a false lead; the
  `handleKeyboardGlobally` warning waits for its trigger. About 1.4k characters.
- **The toggle tasks**: the kind "add a toggle setting to the app", all 8
  steps, about 2.9k characters.
- **The zen-only memory on the toggle tasks**: no kind fits, so nothing at the
  start; the two triggers (the doubled flag, `handleKeyboardGlobally`) stay
  armed.

## Amendments before measurement

Made before any run of the setup, by looking only at the seed memories and at
what the six existing tasks get, never at the new tasks.

1. **Triggers with the task's own values.** The first zen-only build gave the
   `handleKeyboardGlobally` warning a trigger that needed the zen test's own
   title (`zen mode with Alt+M`), so it could never fire on another task. The
   reading now asks for strings any task making the mistake would write, and
   drops a trigger with the task's own values (a literal such as `false`
   doesn't count, nor does the trigger's file). The zen runs were read again;
   their trigger is now an edit to `excalidraw.test.tsx` writing `Alt+` and
   `render(<Excalidraw />)` without `handleKeyboardGlobally`. All 42 triggers
   of the 55 earlier readings pass the new rule.
2. **A task's own files.** The previews said "Usually edits
   `actionToggleZenMode.tsx`" on the shortcut route and
   `actionToggleMinimap.tsx`, which doesn't exist at the base commit, on the
   toggle route: one task's files, which the user ruled out as memory. A file
   named after the task's own values no longer counts as where a step happens.
   The memories were rebuilt from the same readings. The full store's replay
   still passes with the change.
3. **Kept as built**, known weak spots: one step's purpose says "CODES lacked
   M" (the seed tasks' key); a false lead about the Z key goes to every
   shortcut task; a prettier warning from one minimap run comes with the final
   check step.

## What this can't show

- The local memory's design was worked out (fifth session) while looking at
  the records of all 15 tasks, the three new ones included, and at hand-overs
  from the full memory for two of them. Its content here is held out; its
  design isn't, fully. The fair test of unseen tasks is a second repo (build
  stage 5).
- Three runs per existing task and five per new one, as before: a 4× swing
  from one choice (writing a test) is within reach of one run.
