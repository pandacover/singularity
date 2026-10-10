# Pre-registration: the local-first memory on a long task it only half knows

Written 2026-10-07, before any counted run. Not committed (commits wait for
the user); the hash below pins the memory.

## The question

On the first long task (`PREREGISTRATION-v1-long.md`) memory saved 78% of
tokens and 63% of dollars, but every change there was of a kind memory had
learned (settings and shortcuts). A real long task mixes those with changes
memory never saw. Does the long-session saving hold when memory knows only
some of the changes?

## The task

`long-mixed-changes` (`examples/excalidraw/long.toml`), four changes in one
prompt, as a numbered list, at excalidraw `d29d8648`:

1. **toggle-rulers**: as in the first long task (a kind memory knows).
2. **save-as-in-text**: `suite.toml`'s bug fix (upstream `afed9e6e`):
   Ctrl+Shift+S does nothing while text is being edited.
3. **toggle-presenter**: as in the first long task; 1 and 3 are the similar
   pair.
4. **youtube-live-embed**: a bug fix new to the suite (upstream `974f054b`,
   one changed line and its test): a YouTube live link is embedded as a video
   called "live".

Memory has nothing for 2 and 4: memory learned only from altkey-zen-m and
toggle-minimap, and no bug fix. `d29d8648` is the save-as task's base, three
commits before the first long task's: both bugs are there (fixed by the two
commits after it) and none of the files the toggles change differs. The
checks: the toggles' hidden tests, each fix's own test file at its fix
(copied over the agent's, as for the suite's bug fixes), the toggles' test
files, then `tsc`. Checked before any run: the toggles' reference solutions
merged plus the two upstream fixes (`reference/long-mixed-changes.patch`,
snapshots regenerated) pass them all (346 tests passed, 2 skipped; `tsc`
clean); at the base commit 13 tests in the four hidden files fail (rulers 6,
presenter 5, save-as 1, YouTube 1). The agent gets an hour and $6, as for
the first long task.

## Memory

The first long task's: the `v1-finish` home, version 3, sha256 of
`versions/000003.json`
`2a7fb6eb672009857f7f3e0361fe2803996daa0f93a9f7416121630d9b3b44d8`, handed over
change by change by the `workflows-split` setup, with the fix to the store's
writes made after the first long task (`src/local/Files.ts`), so both parts
arrive.

What this task gets (`workflows handover --at d29d8648`): the app-state,
toggle-action, shortcut, right-click-menu and Preferences workflows, each
marked for changes 1 and 3 with each one's values; the view-mode menu step
for 1 only; the one-command finish. Nothing for 2 or 4, and no workflow
picked by mistake for them. 14,728 characters in two parts of 8,189 and
6,538.

## Runs

`TASK=long-mixed-changes bash examples/excalidraw/run-long-measurement.sh 0 1`
(lane 1) and the same with `LANE=2` (lane 2, a few minutes later, setups in
the other order): 4 runs without memory, 4 with it, into
`runs/excalidraw/long-mixed-changes/`. Claude Code 2.1.286 (pinned), Sonnet 5.5
at medium effort, below normal priority. The first long task's 8 runs cost
$4.29; with two changes memory can't help, about $5-7. Each run stops at $6.

Every memory run's transcript is checked for both parts of its hand-over
(`hook_additional_context`). A run that got less is reported, and counts.

## What counts

The first long task's bar, unchanged:

1. **Success**: memory's failed runs no more than no memory's (of 4 each).
2. **Cheaper**: memory's median tokens at least 20% below no memory's, and its
   median dollars at least 10% below.

The answer to the question is yes if both hold.

Reported, no rule (`node examples/excalidraw/score-long.ts
no-memory=runs/excalidraw/long-mixed-changes/nomem,runs/excalidraw/long-mixed-changes/nomem-lane2
memory=runs/excalidraw/long-mixed-changes/memory,runs/excalidraw/long-mixed-changes/memory-lane2
--task long-mixed-changes -v`):

- per change, whether its test passed, and the turns of its first and last
  edit (a toggle's edits by its names and keys, a fix's by its files);
- memory's saving here against the first long task's (78% of tokens, 63% of
  dollars): how much of it the two changes memory doesn't know take away;
- whether memory's runs spent their turns differently on the bug fixes than
  the runs without memory (looking for them, checking them);
- against the same changes asked one per session, for the three that were:
  rulers 563k / $0.32 and presenter 673k / $0.35 without memory, 350k /
  $0.23 and 372k / $0.26 with it; save-as 396k / $0.21 without memory, and
  398k / $0.17 in runs whose memory had nothing for it (the YouTube fix was
  never run alone).

Four runs per setup can't tell small differences apart; a result inside the
spread of the runs is reported as such.

## Results (2026-10-07)

All 8 runs ran (two lanes, below normal priority) and passed, for $4.15
($2.48 without memory, $1.67 with). Every memory run got both parts of its
hand-over whole (checked in the transcripts), with no hook error, in lane 2
too, where the first long task's run lost one.

| Run | Tokens | Dollars | Turns | Wall |
|---|---|---|---|---|
| no memory r0 | 1,319k | $0.67 | 21 | 425 s |
| no memory r1 | 1,256k | $0.61 | 22 | 465 s |
| no memory r0, lane 2 | 1,423k | $0.67 | 26 | 392 s |
| no memory r1, lane 2 | 1,039k | $0.53 | 19 | 362 s |
| memory r0 | 671k | $0.39 | 15 | 367 s |
| memory r1 | 736k | $0.37 | 15 | 410 s |
| memory r0, lane 2 | 840k | $0.50 | 15 | 441 s |
| memory r1, lane 2 | 920k | $0.41 | 19 | 438 s |

Medians: no memory 1,287k / $0.64, 21.5 turns; memory 788k / $0.40, 15 turns.

| Rule | Result | |
|---|---|---|
| 1. Success no worse | 0 of 4 failed in each | holds |
| 2. At least 20% fewer tokens and 10% fewer dollars | -39% tokens, -38% dollars | holds |

**The answer is yes: the saving holds, at about half the first long task's**
(there -78% / -63%). The runs don't overlap (no memory 1,039k-1,423k, memory
671k-920k). Every change's test passed in all 8 runs.

**What the saving is**: about what memory saves on the two toggles alone.
Asked one per session, the toggles took 1,236k tokens without memory and
722k with it (514k less); in the long session memory saved 499k. So the two
bug fixes cost about the same with memory or without: memory neither gained
nor lost on them (no workflow was handed over for them, none by mistake).
That comes from the totals; the edit spans below can't split a run's cost by
change, since the runs interleave them.

**How the runs went**: memory's runs did the two bug fixes first (their
first edits in turn 6.5, median) and then both toggles in one or two turns
(turns 12-13), the places in hand. Runs without memory fixed the YouTube
link first (turn 3), then interleaved the toggles (turns 10.5-14.5) with the
save-as fix (11-16). In all 8 runs the two toggles were edited side by side.
The first long task's keyboard-test trap isn't part of this task (no change
asks for a test of an action's shortcut), so this gap, unlike that one, owes
nothing to it.

**Against the same changes asked one per session** (context, three of the
four: the YouTube fix was never run alone): rulers, presenter and save-as
summed to 1,632k / $0.87 without memory and 1,120k / $0.67 with it; the long
session, which also did the YouTube fix, took 1,287k / $0.64 and 788k /
$0.40.
