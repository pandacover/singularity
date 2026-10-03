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
4. **Normal priority** (2026-10-03, at the user's request, after this was
   committed and before any run): every run goes at normal priority instead
   of below normal, to finish sooner (`PRIORITY=normal` in the script,
   `--priority normal`). Priority changes wall time, which decides nothing;
   the vitest cap stays. The 2.1.286 baselines also ran at normal priority:
   the priority was lowered after them.

## What this can't show

- The local memory's design was worked out (fifth session) while looking at
  the records of all 15 tasks, the three new ones included, and at hand-overs
  from the full memory for two of them. Its content here is held out; its
  design isn't, fully. The fair test of unseen tasks is a second repo (build
  stage 5).
- Three runs per existing task and five per new one, as before: a 4× swing
  from one choice (writing a test) is within reach of one run.

## Results (2026-10-03)

All 50 runs passed their checks: the 2 smoke runs, the 6 runs of the gate and
the 42 measured runs. They ran 15:09–17:56 local time at normal priority
(amendment 4) on the pinned 2.1.286 and 2.1.287, and cost $12.02, of which the
route selection was $0.33. No agent command reached its time limit (longest
318 s of 600 s) and no hook failed, so no run was rerun. The memories' hashes
are unchanged. Scores: `score-local-memory.ts`; run checks: `check-runs.ts`.

**The smoke check** passed on both versions: the route arrived at the first
prompt, its model call was counted, and no hook logged an error.

**The gate passed.** Saved-scripts on `altkey-viewmode-j` (2.1.286): 146k
(145–150k) against 140k, +4%. Saved-scripts with warnings on `altkey-zen-m`
(2.1.287): 117k (117–118k) against 118k, −1%. So the earlier runs are the
baselines.

| Rule | Result | Verdict |
|---|---|---|
| 1. Close to saved-scripts | median of the per-task changes +132% (+45% to +223%) | fails |
| 2. Never worse than no memory | 1 of 12 worse: the zen-only memory on `toggle-rulers`, 969k (554–1,021k) against 563k (446–754k), +72% | fails |
| 3. Success no worse | 0 of 42 runs failed | holds |
| 4a. The doubled flag | 4 of 42: 0 of 33 with the seed memory, 4 of 9 with the zen-only memory | fails |
| 4b. `handleKeyboardGlobally` | 0 of 5 `stats-shortcut-k` runs wrote their first test without it | holds |
| 4c. No tests nobody asked for | 2 of 11 changed a test file (zen mode 1, snap 1, midpoint 0) | holds |
| 5. The graph's claim | 1 of 4 kinds won: `stats-shortcut-k` 266k (185–288k) against saved-scripts' 491k (218–833k), −46%, within run-to-run noise | like the graph, 1 of 4 |

**Stage 4's goal is not met.** We decide again from what failed.

Median total tokens, turns (model calls) and tokens per turn:

| Task | No memory | Saved-scripts | Graph | Hooks (seed memory) |
|---|---|---|---|---|
| `altkey-zen-m` | 1,165k, 25 turns, 42k | 120k, 4, 30k | 221k, 7, 32k | 324k, 10, 32k |
| `altkey-viewmode-j` | 315k, 10, 32k | 140k, 5, 28k | 277k, 8, 35k | 204k, 7, 30k |
| `altkey-snap-u` | 213k, 7, 30k | 180k, 6, 30k | 224k, 7, 32k | 260k, 8, 32k |
| `toggle-minimap` | 787k, 16, 47k | 312k, 8, 39k | 499k, 11, 45k | 619k, 14, 44k |
| `toggle-rulers` | 563k, 13, 43k | 187k, 5, 37k | 399k, 9, 43k | 604k, 14, 43k |
| `toggle-presenter` | 673k, 15, 45k | 221k, 6, 37k | 398k, 9, 44k | 586k, 13, 41k |
| `midpoint-snap-n` | 386k, 12, 34k | 322k, 9, 36k; top2 271k | 432k, 11, 39k | 395k, 10, 37k |
| `page-breaks` | 324k, 10, 33k | 304k, 8, 38k | 336k, 9, 37k | 300k, 9, 35k |
| `stats-shortcut-k` | 801k, 22, 36k | 491k, 15, 33k | 252k, 8, 32k | 266k, 8, 32k |

The zen-only memory on the toggle tasks: minimap 691k (606–745k), rulers 969k
(554–1,021k), presenter 764k (629–877k).

Observations, not part of the rules:

- **Turns make the gap.** Every setup reads 30–45k tokens per turn; they
  differ in how many turns they take. On the toggle tasks the seed memory's
  runs took as many turns as no memory (13–14), against the graph's 9–11 and
  saved-scripts' 5–8.
- **The route says what to do, not how.** It names the steps and the files,
  not the edits, and its landmarks are few. So the agent still spends its
  first 5–9 turns reading existing toggles (`actionToggleGridMode.tsx`,
  `actionToggleObjectsSnapMode.tsx`) and the files to change, to learn how
  they are written. A saved-scripts run makes all 19 edits in its second turn,
  from the saved diff. The graph's checklist, with its guidance on each step,
  sat in between.
- **Against no memory it mostly helped**: zen mode −72%, stats −67%, view
  mode −35%, minimap −21%, presenter −13%, page breaks −7%; rulers +7%,
  midpoint +3% and snap +22% are within run-to-run noise.
- **A trap outside the route.** One snap run wrote a test nobody asked for,
  in a new file (`snapMode.test.tsx`), without `handleKeyboardGlobally`, and
  spent about 20 turns and 900k tokens finding out why the key never fired.
  The memory's trigger for this trap watches only `excalidraw.test.tsx`, where
  the zen runs made the mistake, so it never fired. In the zen run that wrote
  its test in `excalidraw.test.tsx`, it fired.
- **The warnings at the start worked; the triggers came too late.** No seed
  memory run doubled the flag (0 of 33). The zen-only memory hands nothing
  over at the start, and its trigger fires only after the failing command, as
  expected for this mistake: 4 of 9 runs made it.
- **The failed cell of rule 2 isn't advice that misled.** The zen-only memory
  found no kind that fits in all 9 toggle runs and handed nothing over at the
  start, so those runs behaved like runs without memory: 6–9 turns of
  reading, then the edits. Rulers' 969k is run-to-run variance in that. The
  zen-only graph, which did hand over steps, was 42% worse.
- The route selection cost $0.002–0.013 and 2–3k tokens per run, about 1% of
  a run's tokens (at most 1.8%).

## Follow-up: the code at the route's places (2026-10-03)

Written after the results above and before any run of it.

**Why.** Stage 4 failed on turns, and `check-turns.ts` shows where they go on
the toggle tasks. Every run without a saved diff (27 of 27: no memory, the
graph, the seed memory) already searches for an existing toggle in its first
turn, then takes 5-7 turns before its first edit, reading the places a few at
a time; a saved-scripts run takes 1. An edit to `App.tsx` then fails in 8 of
9 seed-memory runs, as in 8 of 9 without memory, although the route warns
about it: the agent writes the import list's neighbouring lines without having
read them. So the agent lacks the lines at the places, not the pattern.

**What changes.** With the route, the hook hands over the code at its places
as the working tree has it at task start. Memory keeps, for each step, the
existing lines its runs added theirs between (spots, from the runs' diffs;
never the runs' new lines), and the hand-over looks them up: a place counts
when two runs of the kind, and most of them, put an edit there. A step that
writes a new file also gets the file most of its runs read first. A file whose
lines are shown isn't listed with its step as well. Everything stays under
10,000 characters, where Claude Code cuts a hook's text.

**Memory.** `runs/excalidraw/memory/local-seed-spots`: a copy of `local-seed`
(the same six records and readings), built again with the current code
(`memory build`, no model call). Its graph, version 2, is version 1 plus the
spots and the files to read first, and nothing else (compared field by field).
`local-seed` itself is unchanged (same hash as above), and with it the
hand-over is still byte for byte the one measured.

    local-seed-spots  d00751f4ab8633c01f406dc27b94658cbf3735259b8e731b43a8f526f101e2c7

What each of the nine tasks would get is in
`runs/excalidraw/previews-local-memory/spots-*.md`. `toggle-rulers`: the same
8 steps and 3 warnings, 18 places in 11 files and one file whole, 9,376
characters (2,867 before).

**Runs.** `toggle-rulers`, 3 runs, hooks with this memory, the pinned 2.1.286,
everything else as above: `run-local-memory-measurement.sh spots 0 2`, output
in `runs/excalidraw/hooks-spots-1`. About $1. The gate isn't run again: it
passed on this version earlier the same day.

**What counts**, against the seed memory's runs on this task above (604k, 14
turns, 7 turns before the first edit) and saved-scripts (187k, 5 turns, 1):

1. **The reading turns go.** The median of turns before the first edit is at
   most 2.
2. **Tokens.** The idea works if the median of total tokens is at most 362k
   (40% below the seed memory's 604k). It meets stage 4's bar on this task at
   215k or less (within 15% of saved-scripts).
3. **Success.** All 3 runs pass their checks.

Counted without a verdict: turns; runs with a failed edit (3 of 3 before);
whether a run reads a file whose lines it was shown.

**Rules during the runs.** As above, and one more: if the hand-over didn't
arrive whole in the first run (Claude Code put a file path in its place), the
runs stop there; that run measured something else.

**What this can't show.** One task, three runs. The other toggle tasks, the
shortcut tasks (they get the key table, 2k characters) and the new tasks come
after it, with the never-worse rule: `page-breaks` is shown places it must
leave alone (the right-click menus), as its route already named them.

### Results of the follow-up (2026-10-03)

The 3 runs passed their checks. They ran 20:30-20:46 local time at below
normal priority on the pinned 2.1.286 and cost $0.65, of which the route
selection was $0.03. The hand-over arrived whole in each (9,376 characters),
no hook failed, and no command reached its time limit (longest 252 s of 600
s). Both memories' hashes are unchanged. Scores: `check-turns.ts` and
`check-runs.ts` on `runs/excalidraw/hooks-spots-1`.

| Rule | Result | Verdict |
|---|---|---|
| 1. The reading turns go: at most 2 before the first edit | 3 (2-3); 7 (5-7) before | fails |
| 2. Tokens: works at 362k or less; stage 4's bar at 215k | 328k (225-400k); 604k (587-740k) before | works: 46% less, below the earlier runs' range; the bar isn't met |
| 3. Success | 3 of 3 | holds |

Counted: 8 turns (6-10), 14 before. No run had a failed edit (3 of 3 before):
the `App.tsx` import went in at the first try each time. Every run read or
searched files whose lines it had been shown: 2, 10 and 4 of the 12.

Observations, not part of the rules:

- **The agent reads the lines it was shown again.** In the second run its
  first turn was eight reads at the line ranges in the hand-over
  (`appState.ts` 125-134, `types.ts` 544-548, ...), and it read the `App.tsx`
  and `DefaultItems.tsx` ranges again before its second batch of edits. The
  first run didn't, made 20 edits in one turn, and was the cheapest (225k).
  The Edit tool says a file must be read first; this version doesn't enforce
  it, and the model follows it or not from run to run.
- **It still looks at other examples.** All three runs read the zen-mode or
  grid-mode action although the snap-mode action came whole, and all three
  looked through the icons. One added an icon nobody asked for (the file
  handed over whole has one); 3 of 18 toggle runs without that file did.
- **The edits come in one to three batches** (20; 11 and 8; 11, 7 and 1),
  none failing, against 3-5 turns of edits with a failed one before.

**How well the places fit other tasks** (`check-places.ts`, no runs: memory
from the seed tasks only, compared with where each other task's own no-memory
runs added their lines; medians per run):

| Task | Added blocks | At the lines shown | In the same list, at other lines | Not shown | Places shown | Left alone |
|---|---|---|---|---|---|---|
| `toggle-rulers` (the twin) | 17 | 15 | 1 | 0 | 19 | 1 |
| `toggle-presenter` (a variant) | 16 | 9 | 7 | 0 | 19 | 2, the view-mode menu in every run |
| `page-breaks` (a subset) | 7 | 1 | 6 | 0 | 16 | 9: the key table, the action, the menus |
| `midpoint-snap-n` (recombined) | 7 | 0 | 0 | 7 | 0 | 0 |

So the follow-up measured the best case: the places are those of one task,
and they fit its twin. A variant and a subset are shown places they must
leave alone, a recombined task gets none, and runs of different tasks agree
on the list an edit goes into, not on the line: with every other task in
memory, fewer places reach agreement (13 instead of 19 for rulers) and 4 of
its 17 additions are no longer shown. (The check hands over the route's
required steps and the optional ones a run needed; the model at task start
drops more: `page-breaks` got 14 places in its preview, not 16.)
