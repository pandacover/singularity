# Pre-registration: the local-first memory on a long task

Written 2026-10-07, before any counted run. Not committed (commits wait for
the user); the hash below pins the memory.

## The question

The user's: a task X with parts A, B, C and D, asked in one prompt and done
in one session, where A and C are alike. Does local v1 do better than no
memory?

Memory was measured so far one change per session. In one long session the
agent's own context remembers too: once it has done A, C may come cheap with
or without memory. So memory's saving could shrink (the agent learns A for C
by itself) or grow (one hand-over serves two changes).

## The task

`long-four-changes` (`examples/excalidraw/long.toml`), four tasks of
`suite.toml` in one prompt, as a numbered list:

1. **toggle-rulers**: a new toggle setting end to end (Alt+U); a twin of the
   seed toggle-minimap.
2. **midpoint-snap-n**: a shortcut for an existing setting (Alt+N).
3. **toggle-presenter**: another toggle setting, with other rules (not
   stored, not in view mode; Alt+J). 1 and 3 are the similar pair.
4. **stats-shortcut-k**: a shortcut changed (Alt+/ to Alt+K) and a test of it
   in `excalidraw.test.tsx`, the file whose keyboard trap runs without memory
   fall into.

Memory learned from none of them (only altkey-zen-m and toggle-minimap). The
keys don't collide. The checks are the four hidden tests side by side, the
stats task's check that the test was written, the union of the four tasks'
test files, and `tsc`. Checked before any run: the four reference solutions
merged (`reference/long-four-changes.patch`, snapshots regenerated) pass them
all (215 tests passed, 1 skipped; `tsc` clean); at the base commit 16 of the
19 hidden tests fail. The agent gets an hour and $6 (a single task: 30
minutes, $3).

## Memory

The `v1-finish` home, as A of `PREREGISTRATION-v1-lookups.md`: the sealed
local-first memory plus the one-command finish, version 3, sha256 of
`versions/000003.json`
`2a7fb6eb672009857f7f3e0361fe2803996daa0f93a9f7416121630d9b3b44d8`, handed over
by the `workflows-split` setup (two task-start hooks, each under Claude Code's
10,000-character cut).

One change to task start, made for this test (memory itself is unchanged).
The free preview showed local v1 filling each blank from the first value of
its kind anywhere in the prompt: every change got the rulers field, and the
stats change was told to use Alt+N (the second key in the prompt, change 2's).
Now a task that lists several changes is picked and filled change by change
(`partsChoice` in `src/workflows/Cues.ts`): each list item, with what the
prompt says of all of them, picks its workflows and states its own values; a
workflow several changes need is shown once, with each change's values and
the changes it is for; a step only some of them need says which. Hand-overs
for tasks that are one change are unchanged: those of A's measured runs come
out identical, apart from the "keep its last 60 lines" sentence the eighth
session added.

What this task gets: 8 workflows, 18,264 characters in two parts of 8,964 and
9,299, places with excerpts of up to 8 lines. The app-state, toggle-action,
right-click-menu and Preferences workflows are marked for changes 1 and 3,
with each one's field; the view-mode menu step for 1 only; the shortcut
workflow for 1, 2 and 3 with Alt+U, Alt+N and Alt+J; the shortcut change and
the keyboard test, with its `handleKeyboardGlobally` warning, for 4. Known
misfire, as in the single-task runs: "toggle it" in change 2 also marks the
toggle-action workflow for 2, though that setting's action exists.

## Runs

`bash examples/excalidraw/run-long-measurement.sh 0 1` (lane 1) and
`LANE=2 bash examples/excalidraw/run-long-measurement.sh 0 1` (lane 2, started
a few minutes later; it runs the setups in the other order, so the two lanes
don't run the same setup side by side): 4 runs without memory, 4 with it.
Claude Code 2.1.286 (pinned), Sonnet 5.5 at medium effort, below normal
priority, as before.

Cost: the four changes asked one per session cost $1.23 without memory and
$0.81 with it (summed medians, below). In one session every turn rereads
everything before it, so a run should cost more than that sum, perhaps 1.5 to
2 times: about $12-16 for the 8 runs. Each run stops at $6.

The first memory run to finish is checked by hand: both parts of its
hand-over must arrive whole (its transcript keeps them as
`hook_additional_context`). If not, the runs stop, the cause is fixed, and
that run doesn't count.

## What counts

1. **Success**: memory's failed runs no more than no memory's (of 4 each).
2. **Cheaper**: memory's median tokens at least 20% below no memory's, and its
   median dollars at least 10% below.

The answer to the question is yes if both hold.

Why those bars: asked one per session, the same four changes took 2,423k
tokens and $1.23 without memory (summed medians: rulers 563k / $0.32,
presenter 673k / $0.35, midpoint 386k / $0.21, stats 801k / $0.35) and
1,216k / $0.81 with it (rulers 350k / $0.23 and presenter 372k / $0.26 from
A's runs; midpoint 241k / $0.16 and stats 253k / $0.16 from the local-first
runs, on Claude Code 2.1.287). That is 50% fewer tokens and 34% fewer
dollars. Rule 2 asks that at least 40% of the token saving survives in one
long session, and a third of the dollar saving (cached rereads make a long
session's dollars fall less than its tokens).

Reported, no rule (`node examples/excalidraw/score-long.ts
no-memory=runs/excalidraw/long/nomem,runs/excalidraw/long/nomem-lane2
memory=runs/excalidraw/long/memory,runs/excalidraw/long/memory-lane2 -v`):

- per change, whether its hidden test passed, and the turns of its first and
  last edit (an edit belongs to a change when the lines it adds name that
  change's setting or key);
- whether the two toggles were edited side by side or one after the other,
  and in what order the changes were done;
- memory's saving on the long task against its saving on the same changes
  asked one per session (50% of tokens, 34% of dollars; context only: other
  runs, and midpoint and stats on another Claude Code version);
- turns before the first edit and after the last; whether a run wrote the
  stats test without `handleKeyboardGlobally` and paid for it.

Four runs per setup can't tell small differences apart: without memory,
single stats runs alone ranged from 471k to 1,296k tokens. A result inside
the spread of the runs is reported as such.

## Results (2026-10-07)

All 8 runs ran (two lanes, below normal priority) and passed, for $4.29
($3.14 without memory, $1.15 with), well under the estimate: no run worked
through the changes one by one. Scores with the command above
(`score-long.ts`; its first version dropped the first group when `--task`
wasn't given, fixed before scoring).

| Run | Tokens | Dollars | Turns | Before the first edit | Wall |
|---|---|---|---|---|---|
| no memory r0 | 2,194k | $0.93 | 32 | 9 | 805 s |
| no memory r1 | 1,190k | $0.59 | 21 | 8 | 366 s |
| no memory r0, lane 2 | 1,610k | $0.71 | 27 | 7 | 545 s |
| no memory r1, lane 2 | 2,241k | $0.90 | 30 | 10 | 663 s |
| memory r0 | 433k | $0.37 | 9 | 3 | 413 s |
| memory r1 | 293k | $0.18 | 7 | 3 | 322 s |
| memory r0, lane 2 | 498k | $0.33 | 11 | 4 | 419 s |
| memory r1, lane 2 | 413k | $0.26 | 10 | 4 | 260 s |

Medians: no memory 1,902k / $0.81, 28.5 turns, 8.5 before the first edit;
memory 423k / $0.30, 9.5 turns, 3.5 before the first edit.

| Rule | Result | |
|---|---|---|
| 1. Success no worse | 0 of 4 failed in each | holds |
| 2. At least 20% fewer tokens and 10% fewer dollars | -78% tokens, -63% dollars | holds |

**The answer is yes, by a wide margin.** The two setups' runs don't overlap
(no memory 1,190k-2,241k, memory 293k-498k). Every change's hidden test
passed in all 8 runs.

**Against the same changes asked one per session** (context, other runs):
without memory the one long session took 22% fewer tokens and 34% fewer
dollars than the four sessions' summed medians (2,423k / $1.23); with memory,
65% fewer tokens and 63% fewer dollars (1,216k / $0.81). Memory's saving over
no memory grew from 50% of tokens and 34% of dollars to 78% and 63%. Its
runs read for 3-4 turns, edited all four changes in the next 2-3 (the toggles
and the shortcuts together, the places in hand), and finished with the one
command once; the looking and the finish, paid once per change in separate
sessions, were paid once for all four.

**A and C**: in all 8 runs, with memory or without, the agent edited the two
toggles side by side and started all four changes in the same turn. No run
did rulers first and presenter later, so whether an agent learns the first
for the second in-session couldn't be seen: agents batch alike changes by
themselves.

**The keyboard trap again**: all 4 runs without memory wrote the stats test
without `handleKeyboardGlobally`; 3 added it in a later edit, and their edits
of the test file spread over 8-15 turns. With memory, 3 of 4 wrote it with
`handleKeyboardGlobally` from the start; one added it two turns later. Part
of the difference is that trap. Against the cheapest run without memory (r1,
1,190k / $0.59, the least trap-bound), memory's median is still 64% fewer
tokens and 49% fewer dollars.

**One hand-over arrived half** (memory r1, lane 2): only part 1 (8,964
characters, the workflows for the app-state field, the shortcut change, the
toggle action and the keyboard test, with its warning). Part 2's hook had
failed: both task-start hooks note the repo's new path in `subjects.json` (a
run's memory copy knows lane 1's workspace, not lane 2's), both wrote it
through the same temporary file, and the second rename found it gone. The
run counts (the pre-registration checked only the first memory run, whose
hand-over arrived whole, as did the other two). Without it, memory's median
is 433k / $0.33, -77% and -59%; the rules hold either way. Fixed after the
runs: every write now has a temporary file of its own and retries a refused
rename (`src/local/Files.ts`, used by the record, workflow and session
stores; `test/local/files.test.ts` fails with the old write and passes now).
