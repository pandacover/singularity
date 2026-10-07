# Pre-registration: memory v1 against v0, saved scripts and no memory

Written 2026-10-04, before any run of memory v1. The user approved the spend
("run the comparison", 2026-10-04): the full plan, new v0 runs included. This
file is committed with the code it measures before the first counted run;
changes after that are amendments, listed at the end with their reason.

## What is measured

Four setups on the nine excalidraw tasks of `suite.toml`, each handed over the
way it would be in daily use:

| Setup | What the agent gets | Built from |
|---|---|---|
| no memory | nothing | |
| exact script (`saved-scripts`) | the closest past run's diff and commands, in the system prompt | the seed tasks' runs |
| v0 (`hooks`, `runs/excalidraw/memory/local-seed-spots`) | its own hooks: a route of steps for the closest kind of task, and the code at the lines next to past edits | the seed tasks' 6 no-memory runs |
| v1 (`workflows`, `runs/excalidraw/memory/v1-seed`) | its own hooks: the workflows the task needs, with blanks, each step's place found in the code as it is; pitfall warnings | the same 6 runs |

v0 and v1 learned from the same six runs: the three no-memory runs of
`altkey-zen-m` (baseline-1) and of `toggle-minimap` (baseline-2-toggle).
v1's build cost $0.14 (one Sonnet call); its selection at task start (one
Sonnet call, about two cents) counts toward each run, as v0's does.

The goal is the project's: correct results for fewer tokens, tool calls and
dollars. The tasks, by how they relate to what memory learned from:

| Kind | Tasks |
|---|---|
| exact repeat | `altkey-zen-m`, `toggle-minimap` |
| twin (same steps at the same places, other names and values) | `altkey-viewmode-j`, `altkey-snap-u`, `toggle-rulers` |
| similar (shares only some steps) | `toggle-presenter` (other rules), `page-breaks` (a subset), `midpoint-snap-n` (a mix of two past tasks), `stats-shortcut-k` (a past task plus a test and its trap) |

Code that changed is checked for free instead (below): at the base commit the
code is the same one memory learned from.

## What the free checks already say (before any run)

`examples/excalidraw/check-v1-places.ts` (selection calls only, about $0.25)
holds each task out: memory from the seed tasks, compared with where the
task's own no-memory runs edited. Medians per task:

| Task | Places the runs edited | Shown by v1 | Shown, left alone | v0 (check-places.ts, 2026-10-03) |
|---|---|---|---|---|
| `toggle-rulers` | 18 | 18 | 1 | 16 of 17 additions, 1 place left alone |
| `toggle-presenter` | 17 | 17 | 1 (no view-mode list) | the view-mode menu shown in every run, which the task must leave alone |
| `page-breaks` | 7 | 7 | 4 (an action it didn't make) | 9 of 16 places shown were things the task must not do |
| `midpoint-snap-n` | 7 | 4 | 0 | none of its places |
| `altkey-viewmode-j`, `altkey-snap-u` | 4-5 | 3 | 0 | |
| `stats-shortcut-k` | 5 | 3 | 1 | |

The selection hands the test workflow only to the task that asks for a test
(`stats-shortcut-k`); the shortcut tasks don't get it.

`examples/excalidraw/check-older-code.ts` (free) looks memory up in the code
before four past excalidraw commits that added a setting, where the edits
went is known:

| Commit | v1 places found | Its additions in a v1 place | v0 places found | In a v0 place |
|---|---|---|---|---|
| 2026-03 arrow binding | 19 of 19 | 13 | 19 | 13 |
| 2025-05 shape switch | 16 of 19 | 0 | 16 | 0 |
| 2023-09 snapping (files moved since) | 11 of 19, all in the files they moved to | 10 | 0 | 0 |
| 2022-04 element locking | 7 of 19, all moved | 1 | 0 | 0 |

Over months the two are even here; across the move of excalidraw's files, v0
finds nothing and v1 finds its places by the blocks' first lines.

## The same conditions as the baselines

As in `PREREGISTRATION-local-memory.md`: the suite, Sonnet 5.5 at medium
effort, the harness, the vitest cap, and Claude Code pinned to the version
each task's baselines used: 2.1.286 for the six existing tasks, 2.1.287 for
the three new ones, from `<workspaces>/_claude/<version>/claude.exe`, never
updated during runs.

**The baselines** are the earlier runs, on those versions: no memory in
`baseline-1` (the shortcut tasks), `baseline-2-toggle` (the toggle tasks) and
`baseline-3-new*`; the exact script in `saved-scripts-1`, `saved-scripts-2-new*`
and `saved-scripts-top2-1*`. Their medians are in the Baselines table of
`PREREGISTRATION-local-memory.md`.

**The gate**, as before: 3 runs on each version repeat an earlier setup, and
must land within ±15% of its earlier median, or nothing else runs and we
decide with the user:

| Version | Setup and task | Earlier runs | Passes if the new median is within |
|---|---|---|---|
| 2.1.286 | saved-scripts on `altkey-viewmode-j` | 140k (139–144k) | 119k–161k |
| 2.1.287 | saved-scripts-warnings on `altkey-zen-m` | 118k (118–147k) | 100k–136k |

## Runs

| What | Setup | Claude Code | Runs |
|---|---|---|---|
| Smoke check, not counted | v1 on `altkey-zen-m` | 2.1.286 and 2.1.287 | 2 |
| The gate | see above | both | 6 |
| The 6 existing tasks | v1 | 2.1.286 | 3 per task: 18 |
| The 3 new tasks | v1 | 2.1.287 | 5 per task: 15 |
| The 6 existing tasks, rulers aside (it has 3) | v0 | 2.1.286 | 3 per task: 15 |
| The 3 new tasks | v0 | 2.1.287 | 5 per task: 15 |

71 runs, about $16 at the earlier runs' costs ($0.22 per run on average), about
3 hours in two lanes. No memory and the exact script have their runs already
(the baselines), on the same pinned versions.

`run-v1-measurement.sh` runs them: the smoke check and the gate in one lane,
then `existing 0 2` in lane 1 and `new 0 4` in lane 2, below normal priority
(the harness's default: the user didn't ask for normal this time, and wall
time decides nothing). Output: `runs/excalidraw/v1-existing*`, `v1-new*`,
`v0spots-existing*`, `v0spots-new*`, `v1-gate-286*`, `v1-gate-287*` and
`v1-smoke-*`; v0's earlier `toggle-rulers` runs are in `hooks-spots-1`.

**The memories stay as they are**, checked after the runs by their hashes
(`runs/` isn't in git):

    (cd runs/excalidraw/memory/v1-seed && find . -type f | LC_ALL=C sort | xargs sha256sum) | sha256sum
    v1-seed           3b3a719b6bd7758b1470e90fa26d3ce96ae451a76164fcc22eaf3048f000f7fd
    local-seed-spots  d00751f4ab8633c01f406dc27b94658cbf3735259b8e731b43a8f526f101e2c7

The v0 hash is the one recorded for its sixth-session test.

## What counts

The headline is the median of total tokens per task (cache reads included,
memory's own model calls included), with min–max; cost next to it; tool calls
reported. A win whose median falls inside the other setup's range is reported
as within run-to-run noise.

**The goal**, the user's rules (2026-10-03):

1. **Close to the exact script on exact repeats and twins.** On the five
   tasks of those kinds, the median of the per-task changes in median tokens,
   v1 against `saved-scripts-1`, is at most +15%.
2. **Better than the exact script on similar tasks.** On at least 3 of the 4
   similar tasks, v1's median is at least 25% below the better saved-scripts
   variant's: `toggle-presenter` at most 166k (221k), `page-breaks` at most
   228k (304k), `midpoint-snap-n` at most 203k (top2 271k),
   `stats-shortcut-k` at most 368k (491k).
3. **Never worse than no memory.** On none of the 9 tasks is v1's median more
   than 15% above no memory's median and above no memory's highest run.
4. **Success no worse.** None of v1's 33 runs fails its checks.

**Reported, deciding nothing:** v1 against v0 on every task; the mechanisms
counted by `check-warnings.ts` (the doubled `--watch=false`, the first test
without `handleKeyboardGlobally`, tests nobody asked for); for each v1 run,
the places it was shown (its hand-over log) against where its edits went (its
diff).

## Rules during the runs

As in `PREREGISTRATION-local-memory.md`: a run cut off at its time limit is
rerun in one lane; a run whose task-start hook didn't finish or logged an
error measured no memory and is rerun once (more than two such runs stop the
measurement); a failed selection call falls back to words and counts as the
product's behavior. Within each pass the setups take turns going first.

## Not measured here

- **Learning from results** isn't measured here: v1 stays as built from the
  six seed runs. A later round can let it learn from these runs
  (`workflows evolve`) and run the similar tasks again.

## Results (2026-10-04)

All 71 runs ran (2026-10-03, 19:43 to about 23:18 UTC, below normal priority),
for $11.36. The smoke check passed on both versions (the hand-over arrived,
its model call counted, no hook error). The gate passed: +4% (2.1.286) and
-1% (2.1.287). No run was cut off, no task-start hook failed or logged an
error, so nothing was rerun. Both memories kept their hashes. Lanes 1 and 2
outlived the 2-hour limit on the background commands that started them; the
scripts ran on, and every run finished on its own.

`score-v1.ts` gives:

| Rule | Result | |
|---|---|---|
| 1. Close to the exact script on exact repeats and twins | +41% (zen +43%, minimap +41%, viewmode +17%, snap +13%, rulers +184%) | fails |
| 2. Better than the exact script on similar tasks | 1 of 4: stats -48% (within run-to-run noise); presenter +74%, page-breaks -16%, midpoint +15% | fails |
| 3. Never worse than no memory | 0 of 9 worse; -4% (snap) to -85% (zen) | holds |
| 4. Success no worse | 1 of 33 failed: a rulers run named its label "Toggle rulers", and the hidden test looks for "Rulers" in the menus and the help dialog | fails |

**The goal isn't met.**

Median tokens (min-max) per task, with turns:

| Task | v1 | v0 | Exact script | No memory |
|---|---|---|---|---|
| `altkey-zen-m` | 172k, 5 turns | 158k, 5 | 120k, 4 | 1,165k, 25 |
| `altkey-viewmode-j` | 163k, 5 | 150k, 5 | 140k, 5 | 315k, 10 |
| `altkey-snap-u` | 203k, 6 | 227k, 7 | 180k, 6 | 213k, 7 |
| `toggle-minimap` | 441k, 10 | 314k, 8 | 312k, 8 | 787k, 16 |
| `toggle-rulers` | 531k, 12 | 328k, 8 | 187k, 5 | 563k, 13 |
| `toggle-presenter` | 385k, 10 | 407k, 10 | 221k, 6 | 673k, 15 |
| `midpoint-snap-n` | 312k, 9 | 263k, 8 | 271k (top2), 9 | 386k, 12 |
| `page-breaks` | 255k, 7 | 200k, 5 | 304k, 8 | 324k, 10 |
| `stats-shortcut-k` | 257k, 8 | 233k, 7 | 491k, 15 | 801k, 22 |

v1 against v0: a median of +11% (from -10% on snap to +62% on rulers).

**Why, from the runs** (no new runs):

- **Turns.** On the toggle tasks v1 took more turns than v0 (rulers 12
  against 8, minimap 10 against 8, page-breaks 7 against 5), and on rulers
  4-5 turns before its first edit (v0 2-3, the exact script 1). Each turn
  also weighed a little more: v1's hand-over is longer (median 4.2k
  characters, 9.3k on the toggle tasks; v0's 2.9k).
- **The places were right.** In v1's own runs (`score-v1.ts fit`) the places
  shown were where the edits went: rulers 19 of 19, presenter 17 of 18,
  page-breaks 7 of 7 (plus the 4 places of an action it didn't need),
  midpoint 4 of 6, the shortcut tasks 3 of 4.
- **What it lacked is an example to copy.** For a new action file v1 names
  the sibling files; v0 handed over a whole one. For a new Preferences item or
  help-dialog row, v1 shows the end of the list, not one complete member. The
  turns before the first edit are spent reading one.
- **The warnings worked** (`check-warnings.ts`): the doubled `--watch=false` in
  0 of 33 runs; all 5 stats runs wrote their test with
  `handleKeyboardGlobally`; no test nobody asked for (the one test edit on a
  shortcut task updated the existing view-mode test, as its task asks).

## After the results: an existing example at each place (2026-10-04)

The explanation above ("what it lacked is an example to copy") was tested
with the user's go, and it is wrong. The same memory, with the hand-over
changed to show at every place one whole entry of a single existing thing,
picked from the code at task start (zen mode: its action file whole, its
Preferences item, its help-dialog row, its line in each list), ran on the
three toggle tasks, 3 runs each, with Claude Code 2.1.286, for $2.99
(`run-v1-measurement.sh examples`, `score-v1.ts examples`). The change isn't
kept; it is in `runs/excalidraw/v1ex-toggles/example-change.patch`.

| Task | v1 + example | v1 | v0 | exact script | no memory |
|---|---|---|---|---|---|
| `toggle-minimap` | 432k, 10 turns | 441k, 10 | 314k, 8 | 312k, 8 | 787k, 16 |
| `toggle-rulers` | 584k, 12 | 531k, 12 (1 failed) | 328k, 8 | 187k, 5 | 563k, 13 |
| `toggle-presenter` | 621k, 12 | 385k, 10 | 407k, 10 | 221k, 6 | 673k, 15 |

All 9 runs passed. The first edit came no earlier (turns 3-8). Every run began
by searching the repository for the example (`zenMode`) and reading where it
appears, including wiring the task doesn't need (zen mode is also a prop of
the component), then compared it with the toggles the steps name (grid mode,
objects snap mode); presenter, whose rules differ from zen mode's, went on
looking for a closer one. All 3 rulers runs copied zen mode's icon.

So the turns don't go to finding an example. The agent checks and completes
whatever the hand-over leaves to it, and a named example gave it one more
thing to check. The exact script's runs edit everything in their second turn,
mostly without reading the files first, because it is the complete change in
concrete lines, with the lines around each edit.

## After that: the change drafted at task start (2026-10-04)

Next, with the user's go, the agent got the change itself: at task start a
second model call (Sonnet) wrote every edit the task needs, from the same
memory's chosen workflows and the code at their places, and each edit was
checked against the files before it was handed over (its old lines there
exactly once). New setup `workflows-draft` (`src/workflows/Draft.ts`), kept;
plain `workflows` is unchanged. The same three toggle tasks, 3 runs each,
Claude Code 2.1.286, $3.17 (`run-v1-measurement.sh draft`, `score-v1.ts
examples`). Before the runs, the three drafts were applied to the base commit
and passed the typecheck.

| Task | v1 + draft | v1 | exact script | draft call |
|---|---|---|---|---|
| `toggle-minimap` | 421k, 10 turns, $0.39 | 441k, 10, $0.29 | 312k, 8, $0.18 | $0.04-0.10 |
| `toggle-rulers` | 379k, 9, $0.37 | 531k, 12, $0.33 (1 failed) | 187k, 5, $0.16 | $0.04-0.10 |
| `toggle-presenter` | 394k, 9, $0.36 | 385k, 10, $0.29 | 221k, 6, $0.17 | $0.04-0.09 |

All 9 runs passed and none added an icon; every draft held 17-18 edits and
the new file, none left out by the checks, written in 20-24 s (one took
108 s). Tokens: -4% against v1 (median per task; rulers -29%, its first edit
in turn 2 in all three runs). Dollars: up by a quarter, because the drafting
call (4-10 cents) cost about what the agent saved (its own part fell from
$0.27-0.32 to $0.26-0.27).

Why the agent didn't save more: it checked the draft before using it. It read
a few lines around each edit in a file before editing that file, so the edits
took three turns instead of one, and it ran the finishing steps the workflows
list (prettier, the snapshot update, a look at the changed snapshots) one per
turn. With the exact script, agents made every edit in one turn without
reading the files first, then ran one chained command. Haiku as the drafter
(checked for free on the same three tasks) costs about half as much per draft
but wrote edits that weren't in the files and left out whole parts.
