# Pre-registration: learning what runs still looked up (and the finish in one command)

Written 2026-10-06, before any counted run. Not committed (commits wait for
the user); the hashes below pin the two memories.

## What is measured

Two changes to the sealed local-first memory (`memory-local-first`), each a
memory home of its own, both handed over by the `workflows-split` setup:

- **A, the hand-over's format** (`runs/excalidraw/memory/v1-finish`, version 3,
  sha256 of `versions/000003.json`
  `2a7fb6eb672009857f7f3e0361fe2803996daa0f93a9f7416121630d9b3b44d8`): the
  local-first memory, unchanged, plus what each workflow's checks rewrite,
  learned from the snapshot files every run of it regenerated (no model).
  1. **The finish in one command** (option 1, `src/workflows/Finish.ts`): the
     chosen workflows' checks in one line (formatters, typecheck, tests, then
     `git status --short`), the snapshot files earlier runs regenerated, and
     no checks under each workflow; the "update snapshots and verify"
     workflow is folded into it.
  2. **Room for the code**: Claude Code cuts each hook's text at 10,000
     characters. The local-first hand-over for the toggle tasks is about 13.5k
     characters, so it was cut to 3 lines of code per place (the measured runs
     re-read those places). `workflows-split` carries a longer hand-over in
     two parts, from two task-start hooks, each under the cap.
- **B, learning from what runs looked up** (option 2,
  `runs/excalidraw/memory/v1-learned`, version 4, sha256 of
  `versions/000004.json`
  `a6a97c9a5a48946e547bff00d47e18a71c9e42dad945cee3a996777d3105b788`): A after
  one learning round (`workflows evolve`, $0.33 of model calls) on the 12
  local-first runs of toggle-minimap, midpoint-snap-n, page-breaks and
  stats-shortcut-k. The refining model read, for each run, every read and
  search it made before its first edit, told against memory's places and the
  lines of them its hand-over showed (`src/workflows/Lookups.ts`). It
  rewrote steps to carry what runs looked up (the action file's whole shape
  instead of "modelled on the grid-mode toggle"; where to see whether a key
  code exists; that the listed places are all the places), set two places to
  show one whole entry (the shortest existing action file; the last
  Preferences component), dropped the action for a Preferences-only setting,
  and kept every pitfall (plus one new one). The cues were written again for
  the five tasks memory has now learned from, and the gate replayed with them:
  places runs needed that memory shows 162 of 193 (163 before), places shown
  that runs left alone 9 (29 before).

## Tasks

The two toggle tasks no learning round saw: **toggle-rulers** (a twin of
toggle-minimap, which the round learned from: the best case) and
**toggle-presenter** (a variant: not stored, not in view mode). 3 runs each per
setup, Claude Code 2.1.286 (the version of the local-first runs), Sonnet 5.5 at
medium effort, as before.

Compared with the local-first runs of the same tasks (`v1cues-toggles`,
`v1cues-toggles-lane2`, 2.1.286): rulers 394k, 397k, 332k tokens ($0.29, $0.24,
$0.25); presenter 572k, 338k, 538k ($0.32, $0.22, $0.34). Medians: rulers 394k /
$0.25, presenter 538k / $0.32.

## Runs

`bash examples/excalidraw/run-v1-measurement.sh split-finish 0 2` (lane 1, A)
and `LANE=2 bash examples/excalidraw/run-v1-measurement.sh split-learned 0 2`
(lane 2, B, started two minutes later, tasks in the other order so the same
task never starts in both lanes at once). 12 runs, about $4.

## What counts

B against A is the question (option 2: does learning what runs looked up cut
the looking?):

1. **Success**: at most 1 failed run of B's 6.
2. **Less looking**: B's median turns before the first edit below A's on both
   tasks.
3. **Cheaper**: B's median tokens at least 10% below A's on both tasks, and
   B's median dollars no more than 5% above A's on either.

A against local first (the format, no rule, reported): failed runs, turns
after the last edit (option 1's target), turns before the first edit, tokens
and dollars.

Three runs per task can't tell small differences apart: the local-first
presenter runs ranged from 338k to 572k. A result inside that spread is
reported as such.

## Results (2026-10-06)

All 12 runs ran (two lanes, below normal priority) and passed, for $2.90
($1.53 A, $1.37 B); the learning round cost $0.33 (a first round, $0.67, was
thrown away: it dropped memory's pitfalls, see HANDOFF-v1.md). Both parts of
each two-part hand-over arrived whole (checked in the transcripts). Scores with
`node examples/score-phases.ts local-first=runs/excalidraw/v1cues-toggles,runs/excalidraw/v1cues-toggles-lane2
A=runs/excalidraw/v1split-finish B=runs/excalidraw/v1split-learned-lane2
--task toggle-rulers --task toggle-presenter -v`.

Medians (3 runs each):

| Task | Setup | Tokens | Dollars | Turns | Before the first edit | After the last |
|---|---|---|---|---|---|---|
| rulers | local first | 394k | $0.25 | 9 | 3 (102k, 11 lookups) | 3 |
| rulers | A | 350k | $0.23 | 8 | 4 (149k, 11 lookups) | 2 |
| rulers | B | 426k | $0.28 | 10 | 2 (67k, 6 lookups) | 4 |
| presenter | local first | 538k | $0.32 | 11 | 4 (142k, 15 lookups) | 4 |
| presenter | A | 372k | $0.26 | 9 | 4 (149k, 11 lookups) | 3 |
| presenter | B | 288k | $0.13 | 8 | 3 (98k, 3 lookups) | 3 |

| Rule (B against A) | Result | |
|---|---|---|
| 1. At most 1 failed run of 6 | 0 failed | holds |
| 2. Fewer turns before the first edit on both tasks | rulers 2 vs 4, presenter 3 vs 4 | holds |
| 3. Tokens 10% below A on both, dollars at most 5% above on either | presenter -23% tokens, -51% dollars; rulers +22% tokens, +20% dollars | fails |

**What the learning round did:** the looking dropped. B's runs made their
first edit in turn 2-3 instead of 4, after half the lookups. On presenter that
carried through: $0.13 a run against $0.26 (A) and $0.32 (local first), and two
of its runs wrote the whole change in one or two shell commands.

**Why rulers didn't:** the finish. All three of B's rulers runs (and one
presenter run) ran the one command bare; `yarn test:update` prints thousands
of lines, Claude Code saved them to a file, and the run spent one or two more
turns reading it (4-5 turns after the last edit, against 2 for A, whose runs
piped the output through `tail` in 5 of 6). B's rulers runs also read the
places they hadn't read before their first edit in between edits. The hand-over
now says to keep the last 60 lines; it is in the runs of
PREREGISTRATION-v1-new-kinds.md, and in a follow-up below.

**A against local first (the format):** cheaper on both (rulers -11% tokens,
-8% dollars; presenter -31%, -18%), with fewer turns after the last edit (2
and 3 against 3 and 4) and no fewer before the first: with the whole code at
each place, A's runs still read an existing toggle action first (its step
still said "modelled on the grid-mode toggle").

**The whole entries:** B shows the shortest existing action file (midpoint snapping) and the last Preferences component whole. B's runs then read 0-1 other toggle actions, against 1-2 in A. Both setups' runs searched the repository for midpoint snapping (1-5 searches a run in A, 1-3 in B): the new-file place lists it first, as the shortest of its kind, whether or not it is shown.

## Follow-up, not counted: rulers with the finish fixed (3 runs, $0.83)

B's memory again on toggle-rulers, with the hand-over's finish now saying to
keep the last 60 lines (`runs/excalidraw/v1split-learned-followup-lane2`):
410k tokens, $0.30, 9 turns (medians), 1-2 turns after the last edit. The
finish is fixed, and rulers still costs more than A (350k, $0.23): its runs
start editing in turn 1-3 but read the places they edit between edits, so the
reading moved rather than went. On rulers, learning what runs looked up
didn't make the run cheaper; on presenter it halved the dollars. Three runs a
task can't say which is the rule.
