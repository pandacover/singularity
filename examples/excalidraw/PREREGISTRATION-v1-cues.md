# Pre-registration: memory v1 without a model call at task start

Written 2026-10-04, before any counted run.

## What is measured

Memory v1 as measured in `PREREGISTRATION-v1.md`, with two changes at task
start and nothing else:

1. **No model call.** Workflows are picked by cues: phrases written once into
   memory, matched exactly against the task with its negated clauses taken
   out (`src/workflows/Cues.ts`). The model call that picked workflows (1-2
   cents, a few seconds) is gone.
2. **Blanks the task states are filled in.** A blank's value is written into
   the steps when the task states it as written: a name in backticks, a
   quoted name, a key combination, the word after a phrase. The rest stay
   blanks for the agent.

Setup `workflows-cues`, memory `runs/excalidraw/memory/v1-cues`: the measured
memory (`v1-seed`, version 1) plus cues, as version 2. The cues were written
by one model call and a retry ($0.09), from the two tasks memory learned from
(zen shortcut, minimap toggle) and nothing else. Its workflows, places and
pitfalls are the measured memory's, unchanged.

Compared with v1's own runs from the measurement (`v1-existing`, `v1-new-lane2`),
with the same Claude Code versions: 2.1.286 for the toggle tasks, 2.1.287 for
the three new ones.

## What the free checks already say

- **Picking** (`check-v1-places.ts --cues`, no model): on every task the
  cues show the same places the model's picks showed that the task needed.
  Places shown that the task left alone: the same as the model's picks on
  every task except midpoint snapping, 4 against 0. Its prompt says "Alt+N
  should toggle it", and "toggle it" is a cue for creating a new toggle
  action, which that task doesn't need. Picking by plain shared words, for
  comparison, showed page breaks 12 and midpoint snapping 8.
- **The keyboard-test workflow** (and its `handleKeyboardGlobally` warning)
  still reaches the stats task: its prompt says "add a test".
- **Fills** are right on all nine tasks (`runs/excalidraw/previews-v1-cues/`):
  the field, its default and the shortcut on the toggle tasks and page
  breaks, the new shortcut on the shortcut tasks. The label isn't filled: the
  cue model left it to the agent.
- **Size**: hand-overs of 3.0k to 9.6k characters, under the 9.8k budget; the
  same code excerpts as v1's.

## Runs

`bash examples/excalidraw/run-v1-measurement.sh cues 0 2`: 3 runs each of
toggle-minimap, toggle-rulers, toggle-presenter, midpoint-snap-n,
page-breaks, stats-shortcut-k. 18 runs, about $4.

## What counts

Medians per task, memory's own calls included (none here):

1. **Success no worse**: at most 1 failed run of the 18 (v1: 1 of 24 on these
   tasks, a rulers run that labelled its setting "Toggle rulers").
2. **Cost no worse**: tokens and dollars within 15% of v1's on at least 5 of
   the 6 tasks. v1's medians: minimap 441k / $0.29, rulers 531k / $0.33,
   presenter 385k / $0.29, midpoint 312k / $0.16, page breaks 255k / $0.14,
   stats 257k / $0.12.

Rules 1 and 2 holding means v1 doesn't need the model call at task start.
Watched, not ruled on: turns, the turn of the first edit, and whether labels
come out as the task names them.

## Results (2026-10-04)

All 18 runs ran (two lanes, below normal priority), for $3.73; the cues cost
$0.09 to write. Every run's task-start hook handed over the cue-picked,
filled hand-over, with no model call and no hook error. Scores with
`node examples/excalidraw/score-v1.ts cues`.

| Rule | Result | |
|---|---|---|
| 1. At most 1 failed run of 18 | 0 of 18 failed (v1: 1 of 24) | holds |
| 2. Tokens and dollars within +15% of v1 on 5 of 6 tasks | 4 of 6 | fails |

Medians per task (v1 + cues against v1):

| Task | Tokens | Dollars | Turns | First edit |
|---|---|---|---|---|
| toggle-minimap | 364k vs 441k (-17%) | $0.25 vs $0.29 (-11%) | 9 vs 10 | turn 4 vs 3 |
| toggle-rulers | 394k vs 531k (-26%) | $0.25 vs $0.33 (-23%) | 9 vs 12 | turn 4 vs 5 |
| toggle-presenter | 538k vs 385k (+40%) | $0.32 vs $0.29 (+10%) | 11 vs 10 | turn 5 vs 5 |
| midpoint-snap-n | 241k vs 312k (-23%) | $0.16 vs $0.16 (-2%) | 7 vs 9 | turn 4 vs 5 |
| page-breaks | 221k vs 255k (-13%) | $0.13 vs $0.14 (-1%) | 6 vs 7 | turn 3 vs 4 |
| stats-shortcut-k | 253k vs 257k (-2%) | $0.16 vs $0.12 (+26%) | 8 vs 8 | turn 5 vs 4 |

**The goal of rule 2 isn't met.** Why the two tasks came out outside +15%:

- **stats-shortcut-k, dollars only.** Tokens and turns are the same as v1's.
  Two of the three runs started at the same moment in the two lanes, so both
  wrote the start of their prompt to Claude Code's prompt cache (about 19k
  tokens at $4 per million) instead of reading it ($0.20 per million). The
  third run, which found it cached, cost $0.11; four of v1's five stats runs
  ran one after another and found it cached ($0.11-0.12), and its one cold run
  cost $0.19. So this is the runs' schedule, not memory.
- **toggle-presenter, tokens.** Two of the three runs failed the App.tsx
  import-list edit (its text appears in several lists) and spent 3-5 turns
  fixing it; the same edit fails in v1's and no-memory runs. The third run was
  the cheapest presenter run of any v1 setup (8 turns, 338k). v1's own three
  ranged from 381k to 582k, so three runs can't tell these apart.

Also seen:

- All 12 toggle and page-breaks runs labelled the setting as the task names
  it (v1: 13 of 14). Not from the fills: the label isn't filled; the cue model
  left it to the agent.
- midpoint-snap-n was handed the "create a toggle action" workflow it doesn't
  need (its prompt says "toggle it"), as the free check predicted, and still
  came out 23% below v1 in tokens and level in dollars.
- For later measurements: runs of the same task shouldn't start at the same
  moment in two lanes, or dollars depend on which lane reached the cache first.
