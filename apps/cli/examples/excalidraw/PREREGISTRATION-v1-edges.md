# Pre-registration: what memory's edges say, at task start

Written 2026-10-12, before any counted run, in a cloud session that couldn't
run them: the runs need the sealed memory and the pinned Claude Code on the
user's machine.

## The question

Memory v1 learns a graph: edges between workflows, each with a relation
(`LEADS_TO`, `TRIGGERS`, ...), a condition, guidance and pitfalls. Until now
the hand-over used the edges only to order the workflows the cues picked;
what they say never reached the agent, and a `TRIGGERS` edge brought nothing
in. Do the agents do the long tasks for fewer tokens when the hand-over says
what the edges say?

Two stages, each a commit on branch `edge-handover`:

1. **stage1** (`a0b4331`): under a workflow handed over, a line for each edge
   to a workflow handed over after it (or the finish in the last section):
   its guidance and pitfalls, with the task's values filled in.
2. **stage2** (`05195f0`, on top of stage1): a workflow picked brings in what
   it `TRIGGERS`, hop by hop, marked "only if" when an edge has a condition;
   and the hand-over names, once each and at most three in all, the branches
   with a condition it didn't hand over.

## What the free checks already say

From the memory in `how-v1-works.html` (8 workflows, 16 edges: 13 with a
condition, 3 with guidance, 2 `TRIGGERS`), the hand-overs of the long tasks
and four single tasks rendered by each version, without places (so without
excerpts):

- stage1 adds 449 characters to four of the six (both long tasks and the two
  toggles) and none to stats-shortcut-k and midpoint-snap-n: on toggle-rulers
  the toggle action's "The
  action's perform flips the new field", the context menu's "The
  context-menu test needs the action's shortcut name, so do the shortcut
  workflow first if both are asked", and the snapshots' guidance with the
  `--watch=false` pitfall.
- stage2 picks no other workflow on these tasks: the cues already pick the
  snapshots workflow. It names two branches on midpoint-snap-n (the context
  menu and Preferences), about 250 characters.
- A first stage2 that also said each condition between workflows handed
  over, and listed each branch with its steps under every workflow that
  leads to it, added 1.2k-1.4k characters, some of it contradicting the
  hand-over ("This makes 6 needed, if no Preferences step follows" above
  the Preferences workflow). That was cut before this was written.

To check on the user's machine before the runs, for each version and both
tasks (`workflows handover "<prompt>" --cwd <excalidraw> --at <base> --home
<copy of v1-finish> --parts 2`, run with that version's `cli.ts`): both parts
under 9,800 characters, and the excerpt lines shown against main's (the
added lines take room from the code shown; any place shown shorter is
reported).

## Runs

`bash apps/cli/examples/excalidraw/run-edges-measurement.sh 0 1` (lane 1)
and the same with `LANE=2` a few minutes later: for each of
`long-four-changes` and `long-mixed-changes`, 4 runs of each version (main,
stage1, stage2), the versions taking turns going first, into
`runs/excalidraw/edges/<task>/<version>[-lane2]`. The `v1-finish` home,
sealed (sha256 of `versions/000003.json`
`2a7fb6eb672009857f7f3e0361fe2803996daa0f93a9f7416121630d9b3b44d8`),
`--setup workflows-split`, Claude Code 2.1.286 (pinned), Sonnet 5.5 at medium
effort, below normal priority. `DRY_RUN=1` first.

Cost: the long tasks' earlier memory runs cost $0.18-0.50 each: about $8-10
for the 24 runs. Each run stops at $6.

Main's arm is run again rather than compared with the long tasks' earlier
memory runs: the code has changed since (learning, daily use), and runs made
side by side share whatever else changed.

## What counts

For each stage, against main's runs of the same task:

1. **Success**: no more failed runs than main's (of 4).
2. **No worse**: median tokens no more than 10% above main's on either task.
3. **Better**: median tokens at least 10% below main's on at least one task,
   with 1 and 2 holding.

A stage is kept if 1 and 2 hold, and said to help only if 3 holds too.
stage2 is judged against main and against stage1: it is kept over stage1
only if it is no worse than stage1 by rule 2.

Reported, no rule (from `apps/cli`, with `E=runs/excalidraw/edges/<task>`:
`node examples/excalidraw/score-long.ts main=$E/main,$E/main-lane2
stage1=$E/stage1,$E/stage1-lane2 stage2=$E/stage2,$E/stage2-lane2 --task
<task> -v`, main first as the base): per change, whether its
test passed; turns before the first edit; whether runs did the context-menu
step after the shortcut step (stage1's guidance); whether a run did work a
named branch offered but the task didn't ask for (a context-menu entry or a
Preferences toggle for midpoint snapping in `long-four-changes`); the
hand-over's characters and excerpt lines per version.

Four runs per version can't tell small differences apart: the earlier
memory runs ranged 293k-498k tokens on `long-four-changes` and 671k-920k on
`long-mixed-changes`. A result inside that spread is reported as such.

## Results (2026-10-13, in a cloud session)

Run in a Claude Code cloud container (Linux, 4 cores) instead of the user's
machine, so not as planned in four ways:

- **The memory was rebuilt**, the sealed `v1-finish` being on the user's
  machine only: six new no-memory runs of altkey-zen-m and toggle-minimap (3
  each, all passed, $1.28), then `record import`, `workflows build` (version
  1: 8 workflows, 19 places, 2 pitfalls, 14 edges; $0.13), `workflows cues`
  (version 2, $0.09) and `workflows finish` (version 3), with the code at
  31f0d9a. sha256 of `versions/000003.json`
  `b5b219aad09541d221b849e9f2850d58f44353b03e100fc45347c5ee245e4897`. Its 14
  edges: 13 `LEADS_TO` and 1 `TRIGGERS` (the app state field to the
  snapshots), 9 with a condition, 2 with guidance, 1 with a pitfall.
- **Claude Code 2.1.296**, not 2.1.286, so these runs compare only with each
  other. Its tokens on `long-four-changes` (601k-2,384k across the arms) are far
  above the earlier memory runs' 293k-498k.
- **Lane 2 ran after lane 1**, not beside it, on 4 cores.
- **The container's own settings**: its synced skills and plugins and its
  extra CLAUDE.md folders were kept out (a clean `CLAUDE_CONFIG_DIR`), but
  Claude Code still added the account's context to every session, alike in
  every arm.

The check before the runs: both parts under 9,800 characters for every
version and task (`long-four-changes` 9,494 + 6,947 for main, 9,690 + 6,947
for stage1 and stage2; `long-mixed-changes` 8,141 + 6,114 and 8,337 +
6,114), and the same code lines shown by every version (172 and 148). stage1
added two lines (196 characters) on each task: "On to 4 (Add an app state
field with storage rules): Action perform flips the new field" and "This
makes the last section needed: Regenerate with yarn test:update Avoid there:
Do not pass --watch=false" (main already warns about `--watch=false` under
the shortcut workflow). **stage2's hand-overs are byte-identical to
stage1's** on both tasks: the one workflow a `TRIGGERS` edge brings in was
already picked, and no branch was left out.

All 24 runs passed every hidden test, for $9.15. Median tokens (4 runs each):

| Task | main | stage1 | stage2 |
|---|---|---|---|
| long-four-changes | 984k | 1,277k (+30%) | 1,415k (+44%) |
| long-mixed-changes | 802k | 860k (+7%) | 739k (-8%) |

| Rule | stage1 | stage2 |
|---|---|---|
| 1. Success | 4 of 4 on both tasks | 4 of 4 on both tasks |
| 2. No worse | fails (+30% on long-four-changes) | fails (+44%; +11% over stage1) |
| 3. Better | no | no |

**Neither stage is kept, by the rules.** But the runs after them say the
rules were judging noise.

**Beyond the plan.** A no-memory arm (8 runs, main's code, $3.59): median
1,207k on `long-four-changes` and 1,051k on `long-mixed-changes`, so main
used 19% and 24% fewer tokens. Then `long-four-changes` again, all four arms
taking turns, 16 runs ($6.07, all passed): no memory 1,157k, main 1,258k,
stage1 1,100k, stage2 873k. The order flipped. Over the 8 runs of each arm:

| long-four-changes, 8 runs | Median | Range |
|---|---|---|
| no memory | 1,180k | 601k-1,600k |
| main | 1,188k | 672k-1,467k |
| stage1 | 1,160k | 846k-2,384k |
| stage2 | 1,113k | 720k-1,479k |

All four within 7% of each other. stage1 and stage2, handed over the same
text, differ by 11-21% in each batch of 4. On this machine 4 runs per arm
can't tell 10% apart, and memory itself shows no saving on this task.

**Where memory's runs lose tokens here.** Memory's finish, `(yarn
test:typecheck; yarn test:update; git status --short)`, runs longer than
Claude Code's 120 s Bash timeout on 4 cores, and Claude Code moves it to the
background ("did not complete within its 120s timeout and was moved to the
background"). The agent then spends turns waiting on it, each rereading
40-70k of context. 14 of the 24 memory runs of `long-four-changes` had a
command moved, every one the finish (once also its wait loop); none of the 8
no-memory runs did. Without the waiting turns, the first batch's stage1
median is 1,092k and stage2's 1,261k. The finish could tell the agent to
give that command a longer timeout; not tried. Whether it passes 120 s on
the user's machine isn't known. (The rerun unset `CLAUDE_AUTO_BACKGROUND_TASKS`,
set in the container, thinking it caused the moves; it doesn't.)

Also seen: in the first batch all 8 stage runs debugged the stats test with
`console.log` in the code, against 2 of 4 for main and for no memory; in the
rerun 2 of 4 stage1, 2 of 4 stage2, 3 of 4 main and 2 of 4 no memory. Taken
as chance.

About $20.30 in all, with the memory's rebuild and two small checks of Claude
Code. The runs stayed in the container's `runs/` and were not kept.
